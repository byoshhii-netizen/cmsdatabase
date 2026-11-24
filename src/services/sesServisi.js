'use strict';
/**
 * src/services/sesServisi.js
 * Cambaz'in sesini uretir (metin->konusma). Kademeli motor secimi:
 *   1) ElevenLabs  (API anahtari VE klonlanmis ozel ses ornegi varsa)
 *   2) OpenAI TTS  (API anahtari varsa, hazir ses on-ayarlariyla)
 *   3) Tarayici    (hicbir anahtar yoksa: istemci Web Speech API kullanir)
 *
 * Ozel ses ornegi dosyasi AES-256-GCM ile veritabaninda (tek satir,
 * cambaz_ses_profili) sifreli saklanir; duz hali yalnizca saglayiciya
 * gonderilirken bellekte cozulur.
 */

const db = require('../config/db');
const ayar = require('../config/env');
const kripto = require('../utils/crypto');
const log = require('./logService');

async function zamanAsimliFetch(url, secenekler = {}) {
  const denetleyici = new AbortController();
  const zamanlayici = setTimeout(() => denetleyici.abort(), ayar.cambaz.httpZamanAsimiMs);
  try {
    return await fetch(url, { ...secenekler, signal: denetleyici.signal });
  } finally {
    clearTimeout(zamanlayici);
  }
}

// --------------------------------------------------------- SES ORNEGI (CRUD)

async function sesOrnekBilgisi() {
  const satir = await db.tekSatir(
    `SELECT dosya_adi, mime, bayt_boyutu, elevenlabs_ses_id, guncellendi_at
       FROM cambaz_ses_profili WHERE id = 1`,
  );
  return satir || null;
}

async function sesOrnekKaydet({ tampon, mime, dosyaAdi }) {
  const { govde, iv, etiket } = kripto.tamponSifrele(tampon);
  await db.sorgu(
    `INSERT INTO cambaz_ses_profili (id, dosya_adi, mime, sifreli_veri, sifre_iv, sifre_etiketi, bayt_boyutu, elevenlabs_ses_id, guncellendi_at)
          VALUES (1, $1, $2, $3, $4, $5, $6, NULL, NOW())
     ON CONFLICT (id) DO UPDATE SET
       dosya_adi = EXCLUDED.dosya_adi, mime = EXCLUDED.mime,
       sifreli_veri = EXCLUDED.sifreli_veri, sifre_iv = EXCLUDED.sifre_iv,
       sifre_etiketi = EXCLUDED.sifre_etiketi, bayt_boyutu = EXCLUDED.bayt_boyutu,
       elevenlabs_ses_id = NULL, guncellendi_at = NOW()`,
    [dosyaAdi, mime, govde.toString('base64'), iv, etiket, tampon.length],
  );
  return { tamam: true };
}

async function sesOrnekSil() {
  const sonuc = await db.sorgu('DELETE FROM cambaz_ses_profili WHERE id = 1');
  return sonuc.rowCount > 0;
}

async function sesOrnekCoz() {
  const satir = await db.tekSatir(
    `SELECT dosya_adi, mime, sifreli_veri, sifre_iv, sifre_etiketi FROM cambaz_ses_profili WHERE id = 1`,
  );
  if (!satir || !satir.sifreli_veri) return null;
  const tampon = kripto.tamponCoz(Buffer.from(satir.sifreli_veri, 'base64'), satir.sifre_iv, satir.sifre_etiketi);
  return { tampon, mime: satir.mime, dosyaAdi: satir.dosya_adi };
}

/** ElevenLabs'a ornegi gonderip kalici bir klon ses kimligi olusturur. */
async function elevenlabsKlonOlustur(apiKey) {
  const ornek = await sesOrnekCoz();
  if (!ornek) return { tamam: false, hata: 'Once bir ses ornegi yukleyin.' };

  try {
    const form = new FormData();
    form.append('name', 'cambaz-ozel-ses');
    form.append('files', new Blob([ornek.tampon], { type: ornek.mime || 'audio/mpeg' }), ornek.dosyaAdi || 'ornek.mp3');

    const yanit = await zamanAsimliFetch('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    });
    const veri = await yanit.json().catch(() => null);
    if (!yanit.ok || !veri || !veri.voice_id) {
      return { tamam: false, hata: (veri && veri.detail && veri.detail.message) || `ElevenLabs HTTP ${yanit.status}` };
    }

    await db.sorgu('UPDATE cambaz_ses_profili SET elevenlabs_ses_id = $1 WHERE id = 1', [veri.voice_id]);
    await log.bilgi({ kategori: 'cambaz', olay: 'elevenlabs_klon_olusturuldu', mesaj: 'Ozel ses klonlandi.' });
    return { tamam: true, sesId: veri.voice_id };
  } catch (hata) {
    return { tamam: false, hata: 'ElevenLabs klonlama basarisiz: ' + hata.message };
  }
}

// --------------------------------------------------------------------- TTS

async function elevenlabsSentezle(apiKey, sesId, metin) {
  const yanit = await zamanAsimliFetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(sesId)}`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text: metin, model_id: 'eleven_multilingual_v2' }),
  });
  if (!yanit.ok) return { tamam: false, hata: `ElevenLabs TTS HTTP ${yanit.status}` };
  const tampon = Buffer.from(await yanit.arrayBuffer());
  return { tamam: true, tampon, mime: 'audio/mpeg' };
}

const OPENAI_SESLERI = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);

async function openaiSentezle(apiKey, sesAdi, metin) {
  const ses = OPENAI_SESLERI.has(sesAdi) ? sesAdi : 'onyx';
  const yanit = await zamanAsimliFetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'tts-1', voice: ses, input: metin }),
  });
  if (!yanit.ok) return { tamam: false, hata: `OpenAI TTS HTTP ${yanit.status}` };
  const tampon = Buffer.from(await yanit.arrayBuffer());
  return { tamam: true, tampon, mime: 'audio/mpeg' };
}

/**
 * Kademeli TTS: elevenlabs (klon varsa) -> openai -> yoksa istemciye birak.
 * @returns {{tamam:boolean, tampon?:Buffer, mime?:string, kod?:string, hata?:string}}
 */
async function sentezle({ metin, elevenlabsApiKey, openaiApiKey, sesAdi }) {
  const temiz = String(metin || '').trim().slice(0, 2000);
  if (!temiz) return { tamam: false, hata: 'Bos metin.' };

  try {
    if (elevenlabsApiKey) {
      const profil = await sesOrnekBilgisi();
      if (profil && profil.elevenlabs_ses_id) {
        const sonuc = await elevenlabsSentezle(elevenlabsApiKey, profil.elevenlabs_ses_id, temiz);
        if (sonuc.tamam) return sonuc;
      }
    }
    if (openaiApiKey) {
      const sonuc = await openaiSentezle(openaiApiKey, sesAdi, temiz);
      if (sonuc.tamam) return sonuc;
    }
    return { tamam: false, kod: 'TARAYICI', hata: 'Sunucu tarafi ses motoru yapilandirilmadi; tarayici sesi kullanilacak.' };
  } catch (hata) {
    if (hata.name === 'AbortError') return { tamam: false, kod: 'TARAYICI', hata: 'Ses sentezleme zaman asimina ugradi.' };
    return { tamam: false, kod: 'TARAYICI', hata: 'Ses sentezlenemedi: ' + hata.message };
  }
}

module.exports = {
  sesOrnekBilgisi, sesOrnekKaydet, sesOrnekSil, sesOrnekCoz,
  elevenlabsKlonOlustur, sentezle, OPENAI_SESLERI,
};
