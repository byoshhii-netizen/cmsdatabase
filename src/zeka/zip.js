'use strict';
/**
 * src/zeka/zip.js
 * Kendi ZIP okuyucumuz. DOCX / XLSX / PPTX / ODT / ODS / ODP ve duz .zip
 * arsivleri harici bir kutuphane olmadan acmak icin yazildi; yalnizca Node
 * cekirdegindeki zlib kullanilir.
 *
 * Desteklenen sikistirma: 0 (store) ve 8 (deflate). ZIP64 boyut alanlari
 * (0xFFFFFFFF) ek alandan okunur.
 *
 * GUVENLIK: arsiv icerigi dizine ACILMAZ, yalnizca bellege okunur; bu yuzden
 * "zip slip" (../ ile dizin disina yazma) riski yoktur. Yine de girdi
 * guvensiz kabul edilir: toplam cikti boyutu ve girdi sayisi sinirlidir
 * (zip bombasi korumasi).
 */

const zlib = require('node:zlib');

const EOCD_IMZA = 0x06054b50;
const EOCD64_BULUCU = 0x07064b50;
const EOCD64_IMZA = 0x06064b50;
const MERKEZ_IMZA = 0x02014b50;

const MAX_GIRDI = 4096;                      // en fazla kayit sayisi
const MAX_TOPLAM_CIKTI = 160 * 1024 * 1024;  // acilmis toplam ust sinir

/** EOCD (merkezi dizin sonu) kaydini sondan geriye tarayarak bulur. */
function eocdBul(tampon) {
  const enAz = Math.max(0, tampon.length - 66_000);
  for (let i = tampon.length - 22; i >= enAz; i--) {
    if (tampon.readUInt32LE(i) === EOCD_IMZA) return i;
  }
  return -1;
}

/** Ek alanda (extra field) ZIP64 boyutlarini arar. */
function zip64Boyutlari(ek, sikistirilmis, acilmis, yerelOfset) {
  let i = 0;
  const sonuc = { sikistirilmis, acilmis, yerelOfset };
  while (i + 4 <= ek.length) {
    const kimlik = ek.readUInt16LE(i);
    const uzunluk = ek.readUInt16LE(i + 2);
    if (kimlik === 0x0001) {
      let j = i + 4;
      if (acilmis === 0xFFFFFFFF && j + 8 <= ek.length) { sonuc.acilmis = Number(ek.readBigUInt64LE(j)); j += 8; }
      if (sikistirilmis === 0xFFFFFFFF && j + 8 <= ek.length) { sonuc.sikistirilmis = Number(ek.readBigUInt64LE(j)); j += 8; }
      if (yerelOfset === 0xFFFFFFFF && j + 8 <= ek.length) { sonuc.yerelOfset = Number(ek.readBigUInt64LE(j)); j += 8; }
      break;
    }
    i += 4 + uzunluk;
  }
  return sonuc;
}

/**
 * ZIP arsivinin icerik listesini cikarir (veriyi daha acmaz).
 * @returns {Array<{ad:string, yontem:number, sikistirilmis:number, acilmis:number, yerelOfset:number}>}
 */
function listele(tampon) {
  if (!Buffer.isBuffer(tampon) || tampon.length < 22) return [];
  const eocd = eocdBul(tampon);
  if (eocd < 0) return [];

  let girdiSayisi = tampon.readUInt16LE(eocd + 10);
  let merkezOfset = tampon.readUInt32LE(eocd + 16);

  // ZIP64 varsa gercek degerleri oradan al.
  if (girdiSayisi === 0xFFFF || merkezOfset === 0xFFFFFFFF) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (tampon.readUInt32LE(i) === EOCD64_BULUCU) {
        const eocd64 = Number(tampon.readBigUInt64LE(i + 8));
        if (eocd64 >= 0 && eocd64 + 56 <= tampon.length && tampon.readUInt32LE(eocd64) === EOCD64_IMZA) {
          girdiSayisi = Number(tampon.readBigUInt64LE(eocd64 + 32));
          merkezOfset = Number(tampon.readBigUInt64LE(eocd64 + 48));
        }
        break;
      }
    }
  }

  const girdiler = [];
  let p = merkezOfset;
  const sinir = Math.min(girdiSayisi, MAX_GIRDI);

  for (let k = 0; k < sinir; k++) {
    if (p + 46 > tampon.length || tampon.readUInt32LE(p) !== MERKEZ_IMZA) break;

    const yontem = tampon.readUInt16LE(p + 10);
    const sikistirilmisHam = tampon.readUInt32LE(p + 20);
    const acilmisHam = tampon.readUInt32LE(p + 24);
    const adUzunluk = tampon.readUInt16LE(p + 28);
    const ekUzunluk = tampon.readUInt16LE(p + 30);
    const yorumUzunluk = tampon.readUInt16LE(p + 32);
    const yerelHam = tampon.readUInt32LE(p + 42);

    const ad = tampon.subarray(p + 46, p + 46 + adUzunluk).toString('utf8');
    const ek = tampon.subarray(p + 46 + adUzunluk, p + 46 + adUzunluk + ekUzunluk);
    const boyut = zip64Boyutlari(ek, sikistirilmisHam, acilmisHam, yerelHam);

    girdiler.push({
      ad,
      yontem,
      sikistirilmis: boyut.sikistirilmis,
      acilmis: boyut.acilmis,
      yerelOfset: boyut.yerelOfset,
    });

    p += 46 + adUzunluk + ekUzunluk + yorumUzunluk;
  }

  return girdiler;
}

/** Tek bir girdinin icerigini acar. Basarisizsa null doner. */
function girdiAc(tampon, girdi) {
  const o = girdi.yerelOfset;
  if (o < 0 || o + 30 > tampon.length) return null;
  if (tampon.readUInt32LE(o) !== 0x04034b50) return null;

  const adUzunluk = tampon.readUInt16LE(o + 26);
  const ekUzunluk = tampon.readUInt16LE(o + 28);
  const veriBas = o + 30 + adUzunluk + ekUzunluk;

  // Yerel baslikta boyut 0 olabilir (veri tanimlayici kullanilmis):
  // merkezi dizinden gelen boyuta guveniyoruz.
  let uzunluk = girdi.sikistirilmis;
  if (!uzunluk || veriBas + uzunluk > tampon.length) uzunluk = tampon.length - veriBas;
  if (uzunluk <= 0) return Buffer.alloc(0);

  const govde = tampon.subarray(veriBas, veriBas + uzunluk);
  try {
    if (girdi.yontem === 0) return Buffer.from(govde);
    if (girdi.yontem === 8) {
      return zlib.inflateRawSync(govde, { maxOutputLength: MAX_TOPLAM_CIKTI });
    }
    return null;
  } catch {
    // Bazi uretici programlar bozuk uzunluk yazar: parcali acmayi dene.
    try {
      return zlib.inflateRawSync(govde, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_TOPLAM_CIKTI });
    } catch { return null; }
  }
}

/**
 * Arsivi acip { ad -> Buffer } haritasi dondurur.
 * @param {Buffer} tampon
 * @param {(ad:string) => boolean} [suzgec] yalnizca secili dosyalari ac
 */
function ac(tampon, suzgec) {
  const sonuc = new Map();
  const girdiler = listele(tampon);
  let toplam = 0;

  for (const g of girdiler) {
    if (g.ad.endsWith('/')) continue;
    if (suzgec && !suzgec(g.ad)) continue;
    if (toplam + (g.acilmis || 0) > MAX_TOPLAM_CIKTI) break;

    const veri = girdiAc(tampon, g);
    if (!veri) continue;
    toplam += veri.length;
    sonuc.set(g.ad, veri);
  }

  return sonuc;
}

/** Tampon bir ZIP arsivi gibi mi gorunuyor? */
function zipMi(tampon) {
  return Buffer.isBuffer(tampon) && tampon.length > 4 &&
    tampon[0] === 0x50 && tampon[1] === 0x4B &&
    (tampon[2] === 0x03 || tampon[2] === 0x05 || tampon[2] === 0x07);
}

module.exports = { listele, girdiAc, ac, zipMi };
