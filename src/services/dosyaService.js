'use strict';
/**
 * src/services/dosyaService.js
 * Dosya yukleme, sifreli depolama, akis (stream) olarak sunma (Range destekli),
 * indirme/goruntuleme sayaclari ve guvenli silme.
 *
 * SIFRELEME: her dosya AES-256-GCM ile sifrelenir; duz hali diskte HIC
 * yazilmaz. Oynatma/indirme isteginde dosya tamamen cozulup bellege alinir
 * (GCM dogrulama etiketi butun govdeyi kapsadigindan kismi cozme guvenli
 * degildir); Range istekleri bu cozulmus arabellek uzerinden karsilanir.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const mime = require('mime-types');

const db = require('../config/db');
const ayar = require('../config/env');
const kripto = require('../utils/crypto');
const dogrula = require('../utils/validate');
const log = require('./logService');

/** Tarayicida dogrudan goruntulenebilecek (inline) MIME on ekleri. */
const ONIZLENEBILIR_ON_EK = ['image/', 'video/', 'audio/'];
const ONIZLENEBILIR_TAM = new Set(['application/pdf', 'text/plain']);

function onizlenebilirMi(mimeTuru) {
  const m = String(mimeTuru || '');
  if (ONIZLENEBILIR_TAM.has(m)) return true;
  return ONIZLENEBILIR_ON_EK.some((on) => m.startsWith(on));
}

function medyaTuru(mimeTuru) {
  const m = String(mimeTuru || '');
  if (m.startsWith('image/')) return 'resim';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'ses';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('text/')) return 'metin';
  return 'dosya';
}

/**
 * Yuklenen dosyayi sifreleyip diske yazar, veritabanina kaydeder.
 * @param {object} secenek
 * @param {number} secenek.klasorId
 * @param {{originalname:string, mimetype:string, size:number, buffer:Buffer}} secenek.dosya multer dosyasi
 */
async function yukle({ klasorId, dosya, aciklama, yoneticiId }) {
  if (!klasorId) return { tamam: false, hata: 'Hedef sektor belirtilmedi.' };
  if (!dosya || !dosya.buffer || !dosya.buffer.length) return { tamam: false, hata: 'Bos dosya yuklenemez.' };

  const klasor = await db.tekSatir('SELECT id FROM klasorler WHERE id = $1 AND silindi = FALSE', [klasorId]);
  if (!klasor) return { tamam: false, hata: 'Hedef sektor bulunamadi.' };

  const temizAd = dogrula.dosyaAdi(dosya.originalname);
  const mimeTuru = dosya.mimetype && dosya.mimetype !== 'application/octet-stream'
    ? dosya.mimetype
    : (mime.lookup(temizAd) || 'application/octet-stream');

  const sha256 = kripto.sha256(dosya.buffer);
  const depolamaAdi = `${kripto.token(16)}.blob`;

  const { govde, iv, etiket } = kripto.tamponSifrele(dosya.buffer);

  await fs.mkdir(ayar.depo.yol, { recursive: true });
  const hedefYol = path.join(ayar.depo.yol, depolamaAdi);
  await fs.writeFile(hedefYol, govde, { mode: 0o600 });

  try {
    const satir = await db.tekSatir(
      `INSERT INTO dosyalar
         (klasor_id, ad, orijinal_ad, mime_turu, boyut_bayt, depolama_adi, sha256,
          sifreli, sifre_iv, sifre_etiketi, aciklama, yukleyen_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8,$9,$10,$11)
       RETURNING id, ad, mime_turu, boyut_bayt`,
      [
        klasorId, temizAd, dosya.originalname.slice(0, 255), mimeTuru, dosya.buffer.length,
        depolamaAdi, sha256, iv, etiket, dogrula.metin(aciklama, { max: 500 }) || null, yoneticiId || null,
      ],
    );

    await log.bilgi({
      kategori: 'depo', olay: 'dosya_yuklendi',
      mesaj: `${satir.ad} (${(satir.boyut_bayt / 1024).toFixed(1)} KB) yuklendi.`,
      yoneticiId, meta: { dosya_id: satir.id, klasor_id: klasorId },
    });

    return { tamam: true, dosya: satir };
  } catch (hata) {
    // DB kaydi basarisizsa yetim blob birakma.
    await fs.unlink(hedefYol).catch(() => {});
    throw hata;
  }
}

async function listele(klasorId) {
  return db.satirlar(
    `SELECT id, ad, orijinal_ad, mime_turu, boyut_bayt, sifreli,
            indirme_sayisi, goruntuleme_sayisi, etiketler, olusturuldu_at
       FROM dosyalar
      WHERE klasor_id = $1 AND silindi = FALSE
      ORDER BY olusturuldu_at DESC`,
    [klasorId],
  );
}

async function getir(id) {
  return db.tekSatir(
    `SELECT id, klasor_id, ad, orijinal_ad, mime_turu, boyut_bayt, depolama_adi,
            sha256, sifreli, sifre_iv, sifre_etiketi, indirme_sayisi, goruntuleme_sayisi,
            yukleyen_id, olusturuldu_at
       FROM dosyalar WHERE id = $1 AND silindi = FALSE`,
    [id],
  );
}

/** Diskten okuyup AES-256-GCM ile cozer; bellekte Buffer olarak dondurur. */
async function coz(dosyaSatiri) {
  const yol = path.join(ayar.depo.yol, dosyaSatiri.depolama_adi);
  const sifreliGovde = await fs.readFile(yol);
  if (!dosyaSatiri.sifreli) return sifreliGovde;
  return kripto.tamponCoz(sifreliGovde, dosyaSatiri.sifre_iv, dosyaSatiri.sifre_etiketi);
}

async function indirmeSayaciArtir(id) {
  await db.sorgu('UPDATE dosyalar SET indirme_sayisi = indirme_sayisi + 1 WHERE id = $1', [id]);
}

async function goruntulemeSayaciArtir(id) {
  await db.sorgu('UPDATE dosyalar SET goruntuleme_sayisi = goruntuleme_sayisi + 1 WHERE id = $1', [id]);
}

/**
 * Cozulmus dosya arabellegini HTTP yanitina yazar. Range basligi varsa
 * 206 Partial Content ile kismi gonderim yapar (video/ses "ileri sar").
 */
function akisGonder(res, req, dosyaSatiri, arabellek, { indir = false } = {}) {
  const toplamBoyut = arabellek.length;
  const guvenliAd = encodeURIComponent(dosyaSatiri.ad).replace(/['()]/g, escape);

  res.setHeader('Content-Type', dosyaSatiri.mime_turu || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Disposition',
    `${indir ? 'attachment' : 'inline'}; filename="belge"; filename*=UTF-8''${guvenliAd}`,
  );

  const aralik = req.headers.range;
  if (aralik) {
    const uyum = /^bytes=(\d*)-(\d*)$/.exec(aralik);
    if (uyum) {
      let baslangic = uyum[1] ? parseInt(uyum[1], 10) : 0;
      let bitis = uyum[2] ? parseInt(uyum[2], 10) : toplamBoyut - 1;
      if (Number.isFinite(baslangic) && Number.isFinite(bitis) && baslangic <= bitis && bitis < toplamBoyut) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${baslangic}-${bitis}/${toplamBoyut}`);
        res.setHeader('Content-Length', bitis - baslangic + 1);
        return res.end(arabellek.subarray(baslangic, bitis + 1));
      }
    }
    res.status(416).setHeader('Content-Range', `bytes */${toplamBoyut}`);
    return res.end();
  }

  res.setHeader('Content-Length', toplamBoyut);
  return res.end(arabellek);
}

/** Dosyayi guvenli sekilde siler: blob diskten kaldirilir, DB kaydi isaretlenir. */
async function sil(id, { yoneticiId } = {}) {
  const dosya = await getir(id);
  if (!dosya) return { tamam: false, hata: 'Dosya bulunamadi.' };

  if (dosya.depolama_adi) {
    await fs.unlink(path.join(ayar.depo.yol, dosya.depolama_adi)).catch(() => {});
  }
  await db.sorgu('UPDATE dosyalar SET silindi = TRUE, silindi_at = NOW() WHERE id = $1', [id]);

  await log.uyari({
    kategori: 'depo', olay: 'dosya_silindi',
    mesaj: `${dosya.ad} guvenli sekilde silindi (blob diskten kaldirildi).`,
    yoneticiId, meta: { dosya_id: id },
  });
  return { tamam: true };
}

module.exports = {
  yukle, listele, getir, coz, indirmeSayaciArtir, goruntulemeSayaciArtir,
  akisGonder, sil, onizlenebilirMi, medyaTuru,
};
