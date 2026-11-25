'use strict';
/**
 * src/zeka/ustveri.js
 * Goruntu ustverisi cikarimi (bagimliliksiz).
 *
 * Istihbarat acisindan en degerli alan budur: bir fotograf genellikle
 * cekildigi CIHAZI, ZAMANI ve GPS KONUMUNU tasir. Burada JPEG EXIF (IFD0 +
 * Exif IFD + GPS IFD), PNG metin parcalari ve temel goruntu olculeri
 * okunur. Hicbir harici kutuphane kullanilmaz.
 */

// ------------------------------------------------------------- TIFF / EXIF

const IFD0_ETIKETLERI = {
  0x010E: 'aciklama',
  0x010F: 'uretici',
  0x0110: 'model',
  0x0112: 'yonelim',
  0x0131: 'yazilim',
  0x0132: 'tarih',
  0x013B: 'sanatci',
  0x8298: 'telif',
};

const EXIF_ETIKETLERI = {
  0x829A: 'poz_suresi',
  0x829D: 'diyafram',
  0x8827: 'iso',
  0x9003: 'cekim_tarihi',
  0x9004: 'sayisallastirma_tarihi',
  0x9286: 'kullanici_notu',
  0x920A: 'odak_uzakligi',
  0xA002: 'genislik',
  0xA003: 'yukseklik',
  0xA430: 'sahip',
  0xA431: 'govde_seri_no',
  0xA433: 'lens_uretici',
  0xA434: 'lens_model',
  0xA435: 'lens_seri_no',
};

const GPS_ETIKETLERI = {
  0x0000: 'gps_surum',
  0x0001: 'enlem_yon',
  0x0002: 'enlem_ham',
  0x0003: 'boylam_yon',
  0x0004: 'boylam_ham',
  0x0005: 'yukseklik_yon',
  0x0006: 'yukseklik',
  0x0007: 'gps_saat',
  0x000B: 'gps_hassasiyet',
  0x0010: 'yon_referansi',
  0x0011: 'goruntu_yonu',
  0x001D: 'gps_tarih',
};

const TIP_BOYUTU = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function okuSayi(tampon, ofset, boyut, kucukUclu) {
  if (ofset + boyut > tampon.length) return 0;
  if (boyut === 2) return kucukUclu ? tampon.readUInt16LE(ofset) : tampon.readUInt16BE(ofset);
  if (boyut === 4) return kucukUclu ? tampon.readUInt32LE(ofset) : tampon.readUInt32BE(ofset);
  return tampon[ofset];
}

/** Bir IFD'yi okur; { etiket -> deger } dondurur. Alt IFD isaretcilerini de verir. */
function ifdOku(tampon, tiffBas, ifdOfset, kucukUclu, etiketler) {
  const sonuc = {};
  const isaretciler = {};
  const girdiOfset = tiffBas + ifdOfset;
  if (girdiOfset + 2 > tampon.length) return { sonuc, isaretciler };

  const sayi = okuSayi(tampon, girdiOfset, 2, kucukUclu);
  if (sayi > 512) return { sonuc, isaretciler };

  for (let i = 0; i < sayi; i++) {
    const p = girdiOfset + 2 + i * 12;
    if (p + 12 > tampon.length) break;

    const etiket = okuSayi(tampon, p, 2, kucukUclu);
    const tip = okuSayi(tampon, p + 2, 2, kucukUclu);
    const adet = okuSayi(tampon, p + 4, 4, kucukUclu);
    const birim = TIP_BOYUTU[tip] || 1;
    const toplam = birim * adet;

    if (etiket === 0x8769) { isaretciler.exif = okuSayi(tampon, p + 8, 4, kucukUclu); continue; }
    if (etiket === 0x8825) { isaretciler.gps = okuSayi(tampon, p + 8, 4, kucukUclu); continue; }

    const ad = etiketler[etiket];
    if (!ad) continue;

    const veriOfset = toplam <= 4 ? p + 8 : tiffBas + okuSayi(tampon, p + 8, 4, kucukUclu);
    if (veriOfset < 0 || veriOfset + toplam > tampon.length || toplam > 4096) continue;

    if (tip === 2) {
      sonuc[ad] = tampon.subarray(veriOfset, veriOfset + Math.max(0, adet - 1))
        .toString('latin1').replace(/\u0000+$/, '').trim();
    } else if (tip === 5 || tip === 10) {
      const oranlar = [];
      for (let j = 0; j < adet && j < 8; j++) {
        const pay = okuSayi(tampon, veriOfset + j * 8, 4, kucukUclu);
        const payda = okuSayi(tampon, veriOfset + j * 8 + 4, 4, kucukUclu);
        oranlar.push(payda ? pay / payda : 0);
      }
      sonuc[ad] = adet === 1 ? oranlar[0] : oranlar;
    } else if (tip === 7 || tip === 1) {
      const ham = tampon.subarray(veriOfset, veriOfset + Math.min(toplam, 256));
      const metin = ham.toString('latin1').replace(/^(ASCII|UNICODE|JIS)\u0000*/, '').replace(/\u0000+/g, '').trim();
      if (metin) sonuc[ad] = metin;
    } else {
      sonuc[ad] = okuSayi(tampon, veriOfset, Math.min(birim, 4), kucukUclu);
    }
  }

  const sonrakiOfset = girdiOfset + 2 + sayi * 12;
  isaretciler.sonraki = sonrakiOfset + 4 <= tampon.length ? okuSayi(tampon, sonrakiOfset, 4, kucukUclu) : 0;
  return { sonuc, isaretciler };
}

/** Derece/dakika/saniye dizisini ondalik dereceye cevirir. */
function dmsOndalik(parcalar, yon) {
  if (!Array.isArray(parcalar) || parcalar.length < 2) {
    if (typeof parcalar === 'number') {
      const d = parcalar;
      return (yon === 'S' || yon === 'W') ? -d : d;
    }
    return null;
  }
  const [derece = 0, dakika = 0, saniye = 0] = parcalar;
  let d = derece + dakika / 60 + saniye / 3600;
  if (yon === 'S' || yon === 'W') d = -d;
  return Math.round(d * 1_000_000) / 1_000_000;
}

/** TIFF blogunu (EXIF govdesi) cozer. */
function tiffCoz(tampon) {
  if (tampon.length < 8) return {};
  const duzen = tampon.toString('latin1', 0, 2);
  if (duzen !== 'II' && duzen !== 'MM') return {};
  const kucukUclu = duzen === 'II';
  const ifd0Ofset = okuSayi(tampon, 4, 4, kucukUclu);

  const ustveri = {};
  const ana = ifdOku(tampon, 0, ifd0Ofset, kucukUclu, IFD0_ETIKETLERI);
  Object.assign(ustveri, ana.sonuc);

  if (ana.isaretciler.exif) {
    const exif = ifdOku(tampon, 0, ana.isaretciler.exif, kucukUclu, EXIF_ETIKETLERI);
    Object.assign(ustveri, exif.sonuc);
  }

  if (ana.isaretciler.gps) {
    const gps = ifdOku(tampon, 0, ana.isaretciler.gps, kucukUclu, GPS_ETIKETLERI);
    const g = gps.sonuc;
    const enlem = dmsOndalik(g.enlem_ham, g.enlem_yon);
    const boylam = dmsOndalik(g.boylam_ham, g.boylam_yon);
    if (enlem !== null && boylam !== null && Number.isFinite(enlem) && Number.isFinite(boylam)) {
      ustveri.gps_enlem = enlem;
      ustveri.gps_boylam = boylam;
    }
    if (Number.isFinite(g.yukseklik)) {
      ustveri.gps_yukseklik = Math.round(g.yukseklik * (g.yukseklik_yon === 1 ? -1 : 1));
    }
    if (g.gps_tarih) ustveri.gps_tarih = g.gps_tarih;
    if (Number.isFinite(g.goruntu_yonu)) ustveri.gps_goruntu_yonu = Math.round(g.goruntu_yonu);
  }

  return ustveri;
}

// ------------------------------------------------------------------- JPEG

function jpegOku(tampon) {
  const ustveri = { bicim: 'JPEG' };
  let i = 2;

  while (i + 4 < tampon.length) {
    if (tampon[i] !== 0xFF) { i++; continue; }
    const isaret = tampon[i + 1];
    if (isaret === 0xD8 || isaret === 0x01 || (isaret >= 0xD0 && isaret <= 0xD7)) { i += 2; continue; }
    if (isaret === 0xD9 || isaret === 0xDA) break;

    const uzunluk = tampon.readUInt16BE(i + 2);
    const govde = tampon.subarray(i + 4, i + 2 + uzunluk);

    if (isaret === 0xE1 && govde.toString('latin1', 0, 6) === 'Exif\u0000\u0000') {
      Object.assign(ustveri, tiffCoz(govde.subarray(6)));
    } else if (isaret === 0xE1 && govde.toString('latin1', 0, 28).includes('ns.adobe.com/xap')) {
      const xmp = govde.toString('utf8');
      const yazar = xmp.match(/<dc:creator>[\s\S]*?<rdf:li[^>]*>([^<]{1,120})</);
      if (yazar) ustveri.xmp_yazar = yazar[1].trim();
    } else if (isaret === 0xFE) {
      const yorum = govde.toString('utf8').replace(/\u0000/g, '').trim();
      if (yorum) ustveri.yorum = yorum.slice(0, 400);
    } else if (isaret >= 0xC0 && isaret <= 0xCF && isaret !== 0xC4 && isaret !== 0xC8 && isaret !== 0xCC) {
      ustveri.yukseklik = tampon.readUInt16BE(i + 5);
      ustveri.genislik = tampon.readUInt16BE(i + 7);
    }

    i += 2 + uzunluk;
  }

  return ustveri;
}

// -------------------------------------------------------------------- PNG

function pngOku(tampon) {
  const ustveri = { bicim: 'PNG' };
  let i = 8;
  const metinler = {};

  while (i + 8 <= tampon.length) {
    const uzunluk = tampon.readUInt32BE(i);
    const tur = tampon.toString('latin1', i + 4, i + 8);
    const govde = tampon.subarray(i + 8, i + 8 + Math.min(uzunluk, 1 << 20));

    if (tur === 'IHDR' && govde.length >= 8) {
      ustveri.genislik = govde.readUInt32BE(0);
      ustveri.yukseklik = govde.readUInt32BE(4);
      ustveri.bit_derinligi = govde[8];
    } else if (tur === 'tEXt' || tur === 'iTXt') {
      const duz = govde.toString('utf8');
      const nul = duz.indexOf('\u0000');
      if (nul > 0) {
        const anahtar = duz.slice(0, nul).trim();
        const deger = duz.slice(nul + 1).replace(/\u0000/g, ' ').trim();
        if (anahtar && deger) metinler[anahtar.slice(0, 40)] = deger.slice(0, 400);
      }
    } else if (tur === 'eXIf') {
      Object.assign(ustveri, tiffCoz(govde));
    } else if (tur === 'IEND') {
      break;
    }

    i += 12 + uzunluk;
    if (uzunluk > tampon.length) break;
  }

  if (Object.keys(metinler).length) ustveri.png_metinleri = metinler;
  return ustveri;
}

// ------------------------------------------------------------ DIGER OLCULER

function gifOku(tampon) {
  return {
    bicim: 'GIF',
    genislik: tampon.length > 8 ? tampon.readUInt16LE(6) : null,
    yukseklik: tampon.length > 10 ? tampon.readUInt16LE(8) : null,
  };
}

function bmpOku(tampon) {
  return {
    bicim: 'BMP',
    genislik: tampon.length > 22 ? tampon.readInt32LE(18) : null,
    yukseklik: tampon.length > 26 ? Math.abs(tampon.readInt32LE(22)) : null,
  };
}

function webpOku(tampon) {
  const ustveri = { bicim: 'WEBP' };
  const etiket = tampon.toString('latin1', 12, 16);
  if (etiket === 'VP8X' && tampon.length > 30) {
    ustveri.genislik = 1 + (tampon[24] | (tampon[25] << 8) | (tampon[26] << 16));
    ustveri.yukseklik = 1 + (tampon[27] | (tampon[28] << 8) | (tampon[29] << 16));
  }
  const exifDizin = tampon.indexOf('EXIF', 12, 'latin1');
  if (exifDizin > 0 && exifDizin + 12 < tampon.length) {
    Object.assign(ustveri, tiffCoz(tampon.subarray(exifDizin + 8)));
  }
  return ustveri;
}

/**
 * Goruntu ustverisini okur.
 * @returns {object} bos nesne = goruntu degil veya ustveri yok
 */
function goruntuUstverisi(tampon) {
  if (!Buffer.isBuffer(tampon) || tampon.length < 12) return {};
  try {
    if (tampon[0] === 0xFF && tampon[1] === 0xD8) return jpegOku(tampon);
    if (tampon.toString('latin1', 1, 4) === 'PNG') return pngOku(tampon);
    if (tampon.toString('latin1', 0, 3) === 'GIF') return gifOku(tampon);
    if (tampon[0] === 0x42 && tampon[1] === 0x4D) return bmpOku(tampon);
    if (tampon.toString('latin1', 0, 4) === 'RIFF' && tampon.toString('latin1', 8, 12) === 'WEBP') return webpOku(tampon);
    if (tampon.toString('latin1', 0, 2) === 'II' || tampon.toString('latin1', 0, 2) === 'MM') {
      const t = tiffCoz(tampon);
      if (Object.keys(t).length) return { bicim: 'TIFF', ...t };
    }
  } catch { /* bozuk ustveri: sessizce gec */ }
  return {};
}

module.exports = { goruntuUstverisi, tiffCoz, dmsOndalik };
