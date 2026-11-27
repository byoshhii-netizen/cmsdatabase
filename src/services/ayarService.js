'use strict';
/**
 * src/services/ayarService.js
 * Sistem ayarlari (anahtar/deger) ve API anahtari kasasi.
 * API anahtarlari AES-256-GCM ile sifreli saklanir; duz deger yalnizca
 * sunucu belleginde, kullanildigi anda cozulur.
 */

const db = require('../config/db');
const kripto = require('../utils/crypto');
const log = require('./logService');

// --- Sistem ayarlari ------------------------------------------------------

async function tumAyarlar() {
  const satirlar = await db.satirlar(
    `SELECT anahtar, deger, tur, aciklama, guncellendi_at FROM ayarlar ORDER BY anahtar`,
  );
  return satirlar;
}

async function ayarAl(anahtar, varsayilan = null) {
  const satir = await db.tekSatir('SELECT deger, tur FROM ayarlar WHERE anahtar = $1', [anahtar]);
  if (!satir) return varsayilan;
  if (satir.tur === 'mantik') return satir.deger === 'true';
  if (satir.tur === 'sayi') return Number(satir.deger);
  if (satir.tur === 'json') { try { return JSON.parse(satir.deger); } catch { return varsayilan; } }
  return satir.deger;
}

const GECERLI_TURLER = new Set(['metin', 'sayi', 'mantik', 'json', 'gizli']);

async function ayarYaz(anahtar, deger, tur = 'metin') {
  // Saglamlastirma: yanlislikla obje/gecersiz bir "tur" gelirse (eski cagri
  // sekilleri), veritabani CHECK kisitini ihlal edip tum kaydi dusurmesin.
  if (typeof tur !== 'string' || !GECERLI_TURLER.has(tur)) tur = 'metin';
  const metinDeger = tur === 'json' ? JSON.stringify(deger) : String(deger);
  await db.sorgu(
    `INSERT INTO ayarlar (anahtar, deger, tur)
          VALUES ($1, $2, $3)
     ON CONFLICT (anahtar) DO UPDATE SET deger = EXCLUDED.deger, tur = EXCLUDED.tur`,
    [anahtar, metinDeger, tur],
  );
  return true;
}

/** Arayuzun ihtiyaci olan ayarlari tek seferde getirir. */
async function arayuzAyarlari() {
  const satirlar = await db.satirlar(
    `SELECT anahtar, deger, tur FROM ayarlar
      WHERE anahtar IN ('sistem_adi','sistem_kodu','ses_aktif','matrix_aktif',
                        'gecis_animasyonu','bakim_modu','arayuz_temasi',
                        'arsiv_tasnif_bandi','arsiv_varsayilan_tasnif','zeka_motor')`,
  );
  const sonuc = {
    sistem_adi: 'CMS VERI MERKEZI',
    sistem_kodu: 'KARTRIDEX',
    ses_aktif: true,
    matrix_aktif: true,
    gecis_animasyonu: true,
    bakim_modu: false,
    arayuz_temasi: 'istihbarat',
    arsiv_tasnif_bandi: true,
    arsiv_varsayilan_tasnif: 'hizmete_ozel',
    zeka_motor: 'dahili',
  };
  for (const s of satirlar) {
    sonuc[s.anahtar] = s.tur === 'mantik' ? s.deger === 'true'
      : s.tur === 'sayi' ? Number(s.deger)
      : s.deger;
  }
  return sonuc;
}

// --- API anahtarlari ------------------------------------------------------

/** Anahtarlari maskeli listeler (duz deger ASLA donmez). */
async function apiAnahtarlariListele() {
  return db.satirlar(
    `SELECT id, saglayici, etiket, maske, aktif, son_kullanim_at, olusturuldu_at, guncellendi_at
       FROM api_anahtarlari
      ORDER BY saglayici, etiket`,
  );
}

/** Anahtari sifreleyip kaydeder/guncellestirir. */
async function apiAnahtarKaydet({ saglayici, etiket = 'varsayilan', deger, yoneticiId }) {
  const temizSaglayici = String(saglayici || '').trim().toLowerCase().slice(0, 40);
  const temizEtiket = String(etiket || 'varsayilan').trim().slice(0, 60) || 'varsayilan';
  const duz = String(deger || '').trim();

  if (!temizSaglayici) return { tamam: false, hata: 'Saglayici adi gerekli.' };
  if (duz.length < 8) return { tamam: false, hata: 'Anahtar cok kisa gorunuyor.' };
  if (duz.length > 500) return { tamam: false, hata: 'Anahtar cok uzun.' };

  const paket = kripto.sifrele(duz);

  await db.sorgu(
    `INSERT INTO api_anahtarlari
        (saglayici, etiket, sifreli_deger, sifre_iv, sifre_etiketi, maske, olusturan_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (saglayici, etiket) DO UPDATE SET
        sifreli_deger = EXCLUDED.sifreli_deger,
        sifre_iv      = EXCLUDED.sifre_iv,
        sifre_etiketi = EXCLUDED.sifre_etiketi,
        maske         = EXCLUDED.maske,
        aktif         = TRUE`,
    [temizSaglayici, temizEtiket, paket.deger, paket.iv, paket.etiket, kripto.maskele(duz), yoneticiId || null],
  );

  await log.kritik({
    kategori: 'ayarlar', olay: 'api_anahtari_kaydedildi',
    mesaj: `${temizSaglayici}/${temizEtiket} anahtari guncellendi.`,
    yoneticiId: yoneticiId || null,
    meta: { saglayici: temizSaglayici, etiket: temizEtiket },
  });

  return { tamam: true };
}

/** Sunucu tarafinda kullanmak uzere duz anahtari cozer. */
async function apiAnahtarCoz(saglayici, etiket = 'varsayilan') {
  const satir = await db.tekSatir(
    `SELECT id, sifreli_deger, sifre_iv, sifre_etiketi
       FROM api_anahtarlari
      WHERE saglayici = $1 AND etiket = $2 AND aktif = TRUE`,
    [String(saglayici || '').toLowerCase(), etiket],
  );
  if (!satir) return null;
  try {
    const duz = kripto.coz({ deger: satir.sifreli_deger, iv: satir.sifre_iv, etiket: satir.sifre_etiketi });
    await db.sorgu('UPDATE api_anahtarlari SET son_kullanim_at = NOW() WHERE id = $1', [satir.id]);
    return duz;
  } catch (hata) {
    console.error('[AYARLAR] API anahtari cozulemedi (ENCRYPTION_KEY degismis olabilir):', hata.message);
    return null;
  }
}

/** Anahtari silmeden aktif/pasif yapar (devre disi birakma). */
async function apiAnahtarAktifAyarla(id, aktif, yoneticiId) {
  const satir = await db.tekSatir(
    'UPDATE api_anahtarlari SET aktif = $2 WHERE id = $1 RETURNING saglayici, etiket, aktif',
    [id, Boolean(aktif)],
  );
  if (satir) {
    await log.bilgi({
      kategori: 'ayarlar', olay: 'api_anahtari_durum_degisti',
      mesaj: `${satir.saglayici}/${satir.etiket} anahtari ${satir.aktif ? 'aktif edildi' : 'devre disi birakildi'}.`,
      yoneticiId: yoneticiId || null,
    });
  }
  return satir;
}

async function apiAnahtarSil(id, yoneticiId) {
  const sonuc = await db.sorgu('DELETE FROM api_anahtarlari WHERE id = $1', [id]);
  if (sonuc.rowCount > 0) {
    await log.kritik({
      kategori: 'ayarlar', olay: 'api_anahtari_silindi',
      mesaj: `#${id} numarali anahtar silindi.`, yoneticiId: yoneticiId || null,
    });
  }
  return sonuc.rowCount > 0;
}

module.exports = {
  tumAyarlar, ayarAl, ayarYaz, arayuzAyarlari,
  apiAnahtarlariListele, apiAnahtarKaydet, apiAnahtarCoz, apiAnahtarSil, apiAnahtarAktifAyarla,
};
