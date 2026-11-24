'use strict';
/**
 * src/services/paylasimService.js
 * "Disariya Ac" is mantigi: bir klasor icin benzersiz, kontrollu bir genel
 * baglanti (/paylas/:token) uretir. Olusturulurken: ozel baslik, sifre
 * (opsiyonel, argon2id), indirme izni ve opsiyonel sure/kota belirlenir.
 */

const db = require('../config/db');
const kripto = require('../utils/crypto');
const dogrula = require('../utils/validate');
const log = require('./logService');

/** Klasor icin yeni bir disa acik baglanti olusturur. */
async function klasorPaylas({
  klasorId, baslik, sifre, indirmeyeIzin, sonKullanmaSaat, maxGoruntuleme, yoneticiId,
}) {
  const klasor = await db.tekSatir('SELECT id, ad FROM klasorler WHERE id = $1 AND silindi = FALSE', [klasorId]);
  if (!klasor) return { tamam: false, hata: 'Sektor bulunamadi.' };

  const temizBaslik = dogrula.metin(baslik, { max: 150 }) || klasor.ad;

  let sifreHash = null;
  const duzSifre = String(sifre || '').trim();
  if (duzSifre) {
    if (duzSifre.length < 4) return { tamam: false, hata: 'Baglanti sifresi en az 4 karakter olmali.' };
    sifreHash = await kripto.sifreHashle(duzSifre);
  }

  let sonKullanmaAt = null;
  const saat = Number(sonKullanmaSaat);
  if (Number.isFinite(saat) && saat > 0) {
    sonKullanmaAt = new Date(Date.now() + saat * 3600 * 1000);
  }

  let kota = null;
  const kotaSayisi = Number(maxGoruntuleme);
  if (Number.isInteger(kotaSayisi) && kotaSayisi > 0) kota = kotaSayisi;

  // Benzersiz token: 24 bayt -> 32 karakter base64url (dogrula.paylasimToken ile uyumlu).
  let token = kripto.token(24);
  for (let deneme = 0; deneme < 5; deneme++) {
    const carpisma = await db.tekSatir('SELECT 1 FROM paylasim_linkleri WHERE token = $1', [token]);
    if (!carpisma) break;
    token = kripto.token(24);
  }

  const satir = await db.tekSatir(
    `INSERT INTO paylasim_linkleri
       (token, tur, klasor_id, baslik, hedef_adi, sifre_hash, indirmeye_izin,
        son_kullanma_at, max_goruntuleme, olusturan_id)
     VALUES ($1,'klasor',$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, token, baslik, indirmeye_izin, son_kullanma_at, max_goruntuleme, olusturuldu_at`,
    [
      token, klasorId, temizBaslik, klasor.ad, sifreHash,
      indirmeyeIzin !== false, sonKullanmaAt, kota, yoneticiId || null,
    ],
  );

  await log.kritik({
    kategori: 'paylasim', olay: 'paylasim_olusturuldu',
    mesaj: `"${klasor.ad}" sektoru icin disa acik baglanti olusturuldu (${sifreHash ? 'sifreli' : 'sifresiz'}).`,
    yoneticiId, meta: { klasor_id: klasorId, link_id: satir.id, indirmeye_izin: satir.indirmeye_izin },
  });

  return { tamam: true, link: satir };
}

/** Bir klasorun tum paylasim baglantilarini (aktif + kapali) listeler. */
async function klasorLinkleri(klasorId) {
  return db.satirlar(
    `SELECT p.id, p.token, p.baslik, p.indirmeye_izin, p.sifre_hash IS NOT NULL AS sifreli,
            p.son_kullanma_at, p.max_goruntuleme, p.goruntuleme_sayisi, p.aktif, p.olusturuldu_at,
            (SELECT COUNT(*)::int FROM paylasim_erisimleri e WHERE e.link_id = p.id) AS erisim_sayisi
       FROM paylasim_linkleri p
      WHERE p.klasor_id = $1 AND p.tur = 'klasor'
      ORDER BY p.olusturuldu_at DESC`,
    [klasorId],
  );
}

/** Tum aktif paylasim baglantilarini listeler (genel bakis/loglar icin). */
async function tumLinkler({ limit = 100 } = {}) {
  return db.satirlar(
    `SELECT p.id, p.token, p.baslik, p.hedef_adi, p.tur, p.indirmeye_izin,
            p.sifre_hash IS NOT NULL AS sifreli, p.son_kullanma_at, p.max_goruntuleme,
            p.goruntuleme_sayisi, p.aktif, p.olusturuldu_at, p.klasor_id,
            (SELECT COUNT(*)::int FROM paylasim_erisimleri e WHERE e.link_id = p.id) AS erisim_sayisi
       FROM paylasim_linkleri p
      ORDER BY p.olusturuldu_at DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), 500)],
  );
}

async function linkGetir(id) {
  return db.tekSatir('SELECT * FROM paylasim_linkleri WHERE id = $1', [id]);
}

async function kapat(id, { yoneticiId } = {}) {
  const sonuc = await db.sorgu('UPDATE paylasim_linkleri SET aktif = FALSE WHERE id = $1', [id]);
  if (sonuc.rowCount === 0) return { tamam: false, hata: 'Baglanti bulunamadi.' };
  await log.kritik({ kategori: 'paylasim', olay: 'paylasim_kapatildi', mesaj: `#${id} baglantisi kapatildi.`, yoneticiId });
  return { tamam: true };
}

async function yenidenAc(id, { yoneticiId } = {}) {
  const sonuc = await db.sorgu('UPDATE paylasim_linkleri SET aktif = TRUE WHERE id = $1', [id]);
  if (sonuc.rowCount === 0) return { tamam: false, hata: 'Baglanti bulunamadi.' };
  await log.bilgi({ kategori: 'paylasim', olay: 'paylasim_yeniden_acildi', mesaj: `#${id} baglantisi yeniden acildi.`, yoneticiId });
  return { tamam: true };
}

module.exports = { klasorPaylas, klasorLinkleri, tumLinkler, linkGetir, kapat, yenidenAc };
