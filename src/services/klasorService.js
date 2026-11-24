'use strict';
/**
 * src/services/klasorService.js
 * Klasor CRUD, hiyerarsi gezinme ve bagimsiz klasor kilidi (argon2id).
 *
 * KILIT MODELI
 *   Her klasorun KENDI sifresi olabilir ("bagimsiz ikincil sifre").
 *   Bir klasore erisim icin KOK'ten o klasore kadar olan TUM ata zincirinde
 *   kilitli olup da oturumda henuz acilmamis ilk klasor bulunur ve once
 *   onun sifresi istenir (savunma derinligi: dogrudan derin URL ile
 *   atlamayi engeller).
 */

const db = require('../config/db');
const fs = require('node:fs/promises');
const kripto = require('../utils/crypto');
const dogrula = require('../utils/validate');
const log = require('./logService');

const KOK_RENK = '#00ff9c';

/** Klasor adini ve temel alanlarini dogrular/temizler. */
function girdiTemizle({ ad, aciklama, renk }) {
  const temizAd = dogrula.metin(ad, { max: 120 });
  if (!temizAd) return { hata: 'Klasor adi bos olamaz.' };
  const temizRenk = /^#[0-9a-fA-F]{6}$/.test(String(renk || '')) ? renk : KOK_RENK;
  return { ad: temizAd, aciklama: dogrula.metin(aciklama, { max: 500 }) || null, renk: temizRenk };
}

/** Yeni klasor olusturur (kok veya bir ebeveynin altinda). */
async function olustur({ ad, aciklama, renk, ebeveynId, yoneticiId }) {
  const temiz = girdiTemizle({ ad, aciklama, renk });
  if (temiz.hata) return { tamam: false, hata: temiz.hata };

  if (ebeveynId) {
    const ebeveyn = await db.tekSatir('SELECT id FROM klasorler WHERE id = $1 AND silindi = FALSE', [ebeveynId]);
    if (!ebeveyn) return { tamam: false, hata: 'Ust sektor bulunamadi.' };
  }

  try {
    const satir = await db.tekSatir(
      `INSERT INTO klasorler (ebeveyn_id, ad, yol, aciklama, renk, olusturan_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, ad`,
      [ebeveynId || null, temiz.ad, '/' + temiz.ad, temiz.aciklama, temiz.renk, yoneticiId || null],
    );
    return { tamam: true, klasor: satir };
  } catch (hata) {
    if (hata.code === '23505') return { tamam: false, hata: 'Bu seviyede ayni isimde bir sektor zaten var.' };
    throw hata;
  }
}

/** Bir klasorun DOGRUDAN alt klasorlerini, dosya/belge sayilariyla listeler. */
async function listele(ebeveynId) {
  return db.satirlar(
    `SELECT k.id, k.ad, k.aciklama, k.renk, k.kilitli, k.olusturuldu_at,
            (SELECT COUNT(*)::int FROM klasorler a WHERE a.ebeveyn_id = k.id AND a.silindi = FALSE) AS alt_klasor_sayisi,
            (SELECT COUNT(*)::int FROM dosyalar d WHERE d.klasor_id = k.id AND d.silindi = FALSE)   AS dosya_sayisi,
            (SELECT COUNT(*)::int FROM belgeler b WHERE b.klasor_id = k.id AND b.silindi = FALSE)   AS belge_sayisi,
            (SELECT COUNT(*)::int FROM paylasim_linkleri p WHERE p.klasor_id = k.id AND p.aktif = TRUE) AS aktif_paylasim
       FROM klasorler k
      WHERE silindi = FALSE AND ebeveyn_id IS NOT DISTINCT FROM $1
      ORDER BY siralama, ad`,
    [ebeveynId || null],
  );
}

async function getir(id) {
  return db.tekSatir(
    `SELECT id, ebeveyn_id, ad, aciklama, renk, kilitli, olusturuldu_at
       FROM klasorler WHERE id = $1 AND silindi = FALSE`,
    [id],
  );
}

/** Kok'ten verilen klasore kadar olan tam zinciri dondurur (ilk eleman kok). */
async function yolZinciri(id) {
  if (!id) return [];
  return db.satirlar(
    `WITH RECURSIVE zincir AS (
       SELECT id, ebeveyn_id, ad, kilitli, 0 AS derinlik
         FROM klasorler WHERE id = $1 AND silindi = FALSE
       UNION ALL
       SELECT k.id, k.ebeveyn_id, k.ad, k.kilitli, z.derinlik + 1
         FROM klasorler k
         JOIN zincir z ON k.id = z.ebeveyn_id
        WHERE k.silindi = FALSE
     )
     SELECT id, ad, kilitli FROM zincir ORDER BY derinlik DESC`,
    [id],
  );
}

/**
 * Oturumdaki acik klasor listesine gore, zincirde ilk KILITLI VE ACILMAMIS
 * klasoru bulur. Yoksa null doner (erisim serbest).
 */
async function erisimDenetle(klasorId, acikKlasorIdler = []) {
  if (!klasorId) return null;
  const zincir = await yolZinciri(klasorId);
  const acikSet = new Set((acikKlasorIdler || []).map(Number));
  for (const halka of zincir) {
    if (halka.kilitli && !acikSet.has(Number(halka.id))) {
      return { id: halka.id, ad: halka.ad };
    }
  }
  return null;
}

/** Klasore bagimsiz ikincil sifre koyar/degistirir. */
async function kilitAyarla({ klasorId, yeniSifre, mevcutSifre, yoneticiId }) {
  const klasor = await db.tekSatir('SELECT id, kilitli, sifre_hash FROM klasorler WHERE id = $1 AND silindi = FALSE', [klasorId]);
  if (!klasor) return { tamam: false, hata: 'Sektor bulunamadi.' };

  // Zaten kilitliyse once mevcut sifre dogrulanir (sifre degistirme/kaldirma icin de).
  if (klasor.kilitli && klasor.sifre_hash) {
    const uygun = await kripto.sifreDogrula(klasor.sifre_hash, String(mevcutSifre || ''));
    if (!uygun) return { tamam: false, hata: 'Mevcut klasor sifresi hatali.' };
  }

  const duzSifre = String(yeniSifre || '');
  if (duzSifre.length < 4) return { tamam: false, hata: 'Klasor sifresi en az 4 karakter olmali.' };
  if (duzSifre.length > 200) return { tamam: false, hata: 'Klasor sifresi cok uzun.' };

  const hash = await kripto.sifreHashle(duzSifre);
  await db.sorgu('UPDATE klasorler SET kilitli = TRUE, sifre_hash = $2 WHERE id = $1', [klasorId, hash]);

  await log.kritik({
    kategori: 'depo', olay: 'klasor_kilitlendi',
    mesaj: `#${klasorId} sektorune ikincil sifre tanimlandi.`, yoneticiId,
  });
  return { tamam: true };
}

/** Klasorun kilidini tamamen kaldirir (mevcut sifre dogrulanarak). */
async function kilitKaldir({ klasorId, mevcutSifre, yoneticiId }) {
  const klasor = await db.tekSatir('SELECT id, kilitli, sifre_hash FROM klasorler WHERE id = $1 AND silindi = FALSE', [klasorId]);
  if (!klasor) return { tamam: false, hata: 'Sektor bulunamadi.' };
  if (!klasor.kilitli) return { tamam: true };

  const uygun = await kripto.sifreDogrula(klasor.sifre_hash, String(mevcutSifre || ''));
  if (!uygun) return { tamam: false, hata: 'Klasor sifresi hatali.' };

  await db.sorgu('UPDATE klasorler SET kilitli = FALSE, sifre_hash = NULL WHERE id = $1', [klasorId]);
  await log.kritik({
    kategori: 'depo', olay: 'klasor_kilidi_kaldirildi',
    mesaj: `#${klasorId} sektorunun ikincil sifresi kaldirildi.`, yoneticiId,
  });
  return { tamam: true };
}

/** Tek bir klasorun sifresini dogrular (oturum acma icin). */
async function kilitDogrula({ klasorId, sifre }) {
  const klasor = await db.tekSatir('SELECT id, ad, kilitli, sifre_hash FROM klasorler WHERE id = $1 AND silindi = FALSE', [klasorId]);
  if (!klasor) return { tamam: false, hata: 'Sektor bulunamadi.' };
  if (!klasor.kilitli) return { tamam: true, klasor };

  const uygun = await kripto.sifreDogrula(klasor.sifre_hash, String(sifre || ''));
  if (!uygun) return { tamam: false, hata: 'Sifre hatali.' };
  return { tamam: true, klasor };
}

/**
 * Klasoru ve TUM alt agacini (klasor/dosya/belge) ozyinelemeli siler.
 * Dosyalarin sifreli diskteki blob'lari GUVENLI sekilde silinir (geri
 * donusu yoktur); veritabaninda adli iz icin "silindi" bayragi birakilir.
 */
async function silRecursive(klasorId, { yoneticiId, depoYolu } = {}) {
  const altAgac = await db.satirlar(
    `WITH RECURSIVE agac AS (
       SELECT id FROM klasorler WHERE id = $1 AND silindi = FALSE
       UNION ALL
       SELECT k.id FROM klasorler k JOIN agac a ON k.ebeveyn_id = a.id WHERE k.silindi = FALSE
     )
     SELECT id FROM agac`,
    [klasorId],
  );
  const idler = altAgac.map((s) => s.id);
  if (idler.length === 0) return { tamam: false, hata: 'Sektor bulunamadi.' };

  // Blob'lari diskten sil (en iyi gayret; eksik dosya hata vermez).
  const dosyalar = await db.satirlar(
    `SELECT id, depolama_adi FROM dosyalar WHERE klasor_id = ANY($1::bigint[]) AND silindi = FALSE`,
    [idler],
  );
  for (const d of dosyalar) {
    if (d.depolama_adi && depoYolu) {
      await fs.unlink(require('node:path').join(depoYolu, d.depolama_adi)).catch(() => {});
    }
  }

  await db.islem(async (istemci) => {
    await istemci.query(
      `UPDATE dosyalar SET silindi = TRUE, silindi_at = NOW() WHERE klasor_id = ANY($1::bigint[]) AND silindi = FALSE`,
      [idler],
    );
    await istemci.query(
      `UPDATE belgeler SET silindi = TRUE, silindi_at = NOW() WHERE klasor_id = ANY($1::bigint[]) AND silindi = FALSE`,
      [idler],
    );
    await istemci.query(
      `UPDATE paylasim_linkleri SET aktif = FALSE WHERE klasor_id = ANY($1::bigint[])`,
      [idler],
    );
    await istemci.query(
      `UPDATE klasorler SET silindi = TRUE, silindi_at = NOW() WHERE id = ANY($1::bigint[])`,
      [idler],
    );
  });

  await log.kritik({
    kategori: 'depo', olay: 'klasor_silindi',
    mesaj: `#${klasorId} sektoru ve ${idler.length - 1} alt sektoru, ${dosyalar.length} dosyasiyla birlikte silindi.`,
    yoneticiId,
  });

  return { tamam: true, silinenKlasor: idler.length, silinenDosya: dosyalar.length };
}

/**
 * Bir klasorun kilit yonetimi islemleri (sifre koyma/kaldirma) icin ATA
 * zincirini denetler; klasorun KENDI kilidi bu kontrolun disindadir
 * (o, ilgili uctaki sifre dogrulamasiyla ayrica korunur). Boylece bir alt
 * sektorun kilidini yonetmek icin once ustundeki kilitli sektorlerden
 * gecilmis (oturumda acilmis) olmasi sart kosulur.
 */
async function ataZinciriDenetle(klasorId, acikKlasorIdler = []) {
  const zincir = await yolZinciri(klasorId);
  const atalar = zincir.slice(0, -1); // son eleman klasorun kendisi
  const acikSet = new Set((acikKlasorIdler || []).map(Number));
  for (const halka of atalar) {
    if (halka.kilitli && !acikSet.has(Number(halka.id))) {
      return { id: halka.id, ad: halka.ad };
    }
  }
  return null;
}

module.exports = {
  olustur, listele, getir, yolZinciri, erisimDenetle, ataZinciriDenetle,
  kilitAyarla, kilitKaldir, kilitDogrula, silRecursive,
};
