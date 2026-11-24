'use strict';
/**
 * src/services/belgeService.js
 * Dahili metin belgesi editoru: baslik + icerik + "dijital imza" (operator
 * imzasi, PKI degildir) + sunucu tarafinda hesaplanan SHA-256 butunluk
 * parmak izi (belgenin olusturuldugu/son duzenlendigi andaki icerigin
 * degismedigini gostermek icin).
 */

const db = require('../config/db');
const kripto = require('../utils/crypto');
const dogrula = require('../utils/validate');
const log = require('./logService');

function butunlukHesapla({ baslik, icerik, imza, zaman }) {
  return kripto.sha256(`${baslik}\u0000${icerik}\u0000${imza || ''}\u0000${zaman}`);
}

function girdiDogrula({ baslik, icerik }) {
  const temizBaslik = dogrula.metin(baslik, { max: 180 });
  if (!temizBaslik) return { hata: 'Belge basligi bos olamaz.' };
  const temizIcerik = dogrula.metin(icerik, { max: 50000, kirp: false });
  return { baslik: temizBaslik, icerik: temizIcerik };
}

async function olustur({ klasorId, baslik, icerik, imza, yoneticiId }) {
  const temiz = girdiDogrula({ baslik, icerik });
  if (temiz.hata) return { tamam: false, hata: temiz.hata };

  if (klasorId) {
    const klasor = await db.tekSatir('SELECT id FROM klasorler WHERE id = $1 AND silindi = FALSE', [klasorId]);
    if (!klasor) return { tamam: false, hata: 'Hedef sektor bulunamadi.' };
  }

  const temizImza = dogrula.metin(imza, { max: 120 }) || null;
  const zaman = new Date().toISOString();
  const hash = butunlukHesapla({ baslik: temiz.baslik, icerik: temiz.icerik, imza: temizImza, zaman });

  const satir = await db.tekSatir(
    `INSERT INTO belgeler (klasor_id, baslik, icerik, imza, butunluk_hash, olusturan_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, baslik, imza, butunluk_hash, olusturuldu_at`,
    [klasorId || null, temiz.baslik, temiz.icerik, temizImza, hash, yoneticiId || null],
  );

  await log.bilgi({
    kategori: 'depo', olay: 'belge_olusturuldu',
    mesaj: `"${satir.baslik}" belgesi olusturuldu.`, yoneticiId,
    meta: { belge_id: satir.id, klasor_id: klasorId },
  });

  return { tamam: true, belge: satir };
}

async function guncelle({ id, baslik, icerik, imza, yoneticiId }) {
  const mevcut = await db.tekSatir('SELECT id, klasor_id, surum FROM belgeler WHERE id = $1 AND silindi = FALSE', [id]);
  if (!mevcut) return { tamam: false, hata: 'Belge bulunamadi.' };

  const temiz = girdiDogrula({ baslik, icerik });
  if (temiz.hata) return { tamam: false, hata: temiz.hata };

  const temizImza = dogrula.metin(imza, { max: 120 }) || null;
  const zaman = new Date().toISOString();
  const hash = butunlukHesapla({ baslik: temiz.baslik, icerik: temiz.icerik, imza: temizImza, zaman });

  const satir = await db.tekSatir(
    `UPDATE belgeler
        SET baslik = $2, icerik = $3, imza = $4, butunluk_hash = $5, surum = surum + 1
      WHERE id = $1
      RETURNING id, baslik, imza, butunluk_hash, surum, guncellendi_at`,
    [id, temiz.baslik, temiz.icerik, temizImza, hash],
  );

  await log.bilgi({
    kategori: 'depo', olay: 'belge_guncellendi',
    mesaj: `"${satir.baslik}" belgesi guncellendi (surum ${satir.surum}).`,
    yoneticiId, meta: { belge_id: id },
  });

  return { tamam: true, belge: satir };
}

async function listele(klasorId) {
  return db.satirlar(
    `SELECT id, baslik, imza, butunluk_hash, surum, olusturuldu_at, guncellendi_at
       FROM belgeler
      WHERE klasor_id = $1 AND silindi = FALSE
      ORDER BY guncellendi_at DESC`,
    [klasorId],
  );
}

async function getir(id) {
  return db.tekSatir(
    `SELECT id, klasor_id, baslik, icerik, imza, butunluk_hash, surum, olusturan_id,
            olusturuldu_at, guncellendi_at
       FROM belgeler WHERE id = $1 AND silindi = FALSE`,
    [id],
  );
}

async function sil(id, { yoneticiId } = {}) {
  const sonuc = await db.sorgu('UPDATE belgeler SET silindi = TRUE, silindi_at = NOW() WHERE id = $1 AND silindi = FALSE', [id]);
  if (sonuc.rowCount === 0) return { tamam: false, hata: 'Belge bulunamadi.' };

  await log.uyari({ kategori: 'depo', olay: 'belge_silindi', mesaj: `#${id} belgesi silindi.`, yoneticiId });
  return { tamam: true };
}

module.exports = { olustur, guncelle, listele, getir, sil, butunlukHesapla };
