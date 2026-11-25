'use strict';
/**
 * src/zeka/kodlama.js
 * Metin kodlama/kod cozme yardimcilari. Hicbir harici bagimlilik yoktur.
 *
 *  - BOM tespiti (UTF-8 / UTF-16LE / UTF-16BE)
 *  - Gecersiz UTF-8 durumunda Windows-1254 (Turkce) ve CP1252 geri donusu
 *  - Quoted-Printable, Base64, ASCII85, ASCIIHex kod cozme
 *  - RFC 2047 basliklari (=?UTF-8?B?...?=) cozme
 *  - PDF/WinAnsi karakter haritalari
 */

// ---------------------------------------------------------------- CP1254
// Windows-1254 (Turkce). 0x00-0x7F ASCII ile ayni, 0x80-0xFF asagidaki tablo.
const CP1254 = [
  '€', '\u0081', '‚', 'ƒ', '„', '…', '†', '‡',
  'ˆ', '‰', 'Š', '‹', 'Œ', '\u008D', '\u008E', '\u008F',
  '\u0090', '‘', '’', '“', '”', '•', '–', '—',
  '˜', '™', 'š', '›', 'œ', '\u009D', '\u009E', 'Ÿ',
  ' ', '¡', '¢', '£', '¤', '¥', '¦', '§',
  '¨', '©', 'ª', '«', '¬', '­', '®', '¯',
  '°', '±', '²', '³', '´', 'µ', '¶', '·',
  '¸', '¹', 'º', '»', '¼', '½', '¾', '¿',
  'À', 'Á', 'Â', 'Ã', 'Ä', 'Å', 'Æ', 'Ç',
  'È', 'É', 'Ê', 'Ë', 'Ì', 'Í', 'Î', 'Ï',
  'Ğ', 'Ñ', 'Ò', 'Ó', 'Ô', 'Õ', 'Ö', '×',
  'Ø', 'Ù', 'Ú', 'Û', 'Ü', 'İ', 'Ş', 'ß',
  'à', 'á', 'â', 'ã', 'ä', 'å', 'æ', 'ç',
  'è', 'é', 'ê', 'ë', 'ì', 'í', 'î', 'ï',
  'ğ', 'ñ', 'ò', 'ó', 'ô', 'õ', 'ö', '÷',
  'ø', 'ù', 'ú', 'û', 'ü', 'ı', 'ş', 'ÿ',
];

// Windows-1252 (Batili metinler icin). 0x80-0x9F farkli, gerisi Latin-1.
const CP1252_UST = [
  '€', '\u0081', '‚', 'ƒ', '„', '…', '†', '‡',
  'ˆ', '‰', 'Š', '‹', 'Œ', '\u008D', 'Ž', '\u008F',
  '\u0090', '‘', '’', '“', '”', '•', '–', '—',
  '˜', '™', 'š', '›', 'œ', '\u009D', 'ž', 'Ÿ',
];

/** Tamponu Windows-1254 varsayarak cozer. */
function cp1254Coz(tampon) {
  let s = '';
  for (let i = 0; i < tampon.length; i++) {
    const b = tampon[i];
    s += b < 0x80 ? String.fromCharCode(b) : CP1254[b - 0x80];
  }
  return s;
}

/** Tamponu Windows-1252 varsayarak cozer. */
function cp1252Coz(tampon) {
  let s = '';
  for (let i = 0; i < tampon.length; i++) {
    const b = tampon[i];
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b < 0xA0) s += CP1252_UST[b - 0x80];
    else s += String.fromCharCode(b);
  }
  return s;
}

/** Tek bir baytin WinAnsi (CP1252) karakter karsiligi — PDF icin. */
function winAnsiKarakter(b) {
  if (b < 0x80) return String.fromCharCode(b);
  if (b < 0xA0) return CP1252_UST[b - 0x80];
  return String.fromCharCode(b);
}

/** Tamponun gecerli UTF-8 olup olmadigini kontrol eder. */
function gecerliUtf8Mi(tampon) {
  let i = 0;
  const n = tampon.length;
  while (i < n) {
    const b = tampon[i];
    if (b < 0x80) { i++; continue; }
    let ek;
    let altSinir = 0x80;
    let ustSinir = 0xBF;
    if (b >= 0xC2 && b <= 0xDF) ek = 1;
    else if (b >= 0xE0 && b <= 0xEF) {
      ek = 2;
      if (b === 0xE0) altSinir = 0xA0;      // asiri uzun kodlama
      if (b === 0xED) ustSinir = 0x9F;      // UTF-16 vekil alani
    } else if (b >= 0xF0 && b <= 0xF4) {
      ek = 3;
      if (b === 0xF0) altSinir = 0x90;
      if (b === 0xF4) ustSinir = 0x8F;
    } else return false;

    if (i + ek > n - 1) return false;       // eksik devam bayti
    for (let j = 1; j <= ek; j++) {
      const s = tampon[i + j];
      const alt = j === 1 ? altSinir : 0x80;
      const ust = j === 1 ? ustSinir : 0xBF;
      if (s < alt || s > ust) return false;
    }
    i += ek + 1;
  }
  return true;
}

/**
 * Tamponu metne cevirir: BOM'a, gecerli UTF-8 olup olmamasina ve Turkce
 * karakter yogunluguna gore en olasi kodlamayi secer.
 * @returns {{metin:string, kodlama:string}}
 */
function metneCevir(tampon) {
  if (!tampon || tampon.length === 0) return { metin: '', kodlama: 'bos' };

  // --- BOM ---
  if (tampon.length >= 3 && tampon[0] === 0xEF && tampon[1] === 0xBB && tampon[2] === 0xBF) {
    return { metin: tampon.subarray(3).toString('utf8'), kodlama: 'utf-8 (BOM)' };
  }
  if (tampon.length >= 2 && tampon[0] === 0xFF && tampon[1] === 0xFE) {
    return { metin: tampon.subarray(2).toString('utf16le'), kodlama: 'utf-16le' };
  }
  if (tampon.length >= 2 && tampon[0] === 0xFE && tampon[1] === 0xFF) {
    const ters = Buffer.from(tampon.subarray(2));
    ters.swap16();
    return { metin: ters.toString('utf16le'), kodlama: 'utf-16be' };
  }

  // --- BOM'suz UTF-16 sezgisi: bol miktarda NUL bayt ---
  const ornek = tampon.subarray(0, Math.min(tampon.length, 4096));
  let nul = 0;
  for (let i = 0; i < ornek.length; i++) if (ornek[i] === 0) nul++;
  if (nul > ornek.length * 0.25) {
    let tekNul = 0;
    for (let i = 1; i < ornek.length; i += 2) if (ornek[i] === 0) tekNul++;
    if (tekNul > ornek.length * 0.2) {
      return { metin: tampon.toString('utf16le'), kodlama: 'utf-16le (BOM yok)' };
    }
    const ters = Buffer.from(tampon);
    ters.swap16();
    return { metin: ters.toString('utf16le'), kodlama: 'utf-16be (BOM yok)' };
  }

  if (gecerliUtf8Mi(tampon)) return { metin: tampon.toString('utf8'), kodlama: 'utf-8' };

  // Gecersiz UTF-8: Turkce mi Batili mi? Turkce'ye ozgu bayt konumlarina bak.
  let turkceIsaret = 0;
  for (let i = 0; i < tampon.length; i++) {
    const b = tampon[i];
    if (b === 0xF0 || b === 0xFD || b === 0xFE || b === 0xD0 || b === 0xDD || b === 0xDE) turkceIsaret++;
  }
  const yogunluk = turkceIsaret / Math.max(tampon.length, 1);
  if (yogunluk > 0.002) return { metin: cp1254Coz(tampon), kodlama: 'windows-1254' };
  return { metin: cp1252Coz(tampon), kodlama: 'windows-1252' };
}

// -------------------------------------------------------- QUOTED-PRINTABLE

function quotedPrintableCoz(metin) {
  const birlesik = String(metin).replace(/=\r?\n/g, '');
  const baytlar = [];
  for (let i = 0; i < birlesik.length; i++) {
    const k = birlesik[i];
    if (k === '=' && i + 2 < birlesik.length && /^[0-9A-Fa-f]{2}$/.test(birlesik.substr(i + 1, 2))) {
      baytlar.push(parseInt(birlesik.substr(i + 1, 2), 16));
      i += 2;
    } else {
      baytlar.push(birlesik.charCodeAt(i) & 0xFF);
    }
  }
  return Buffer.from(baytlar);
}

// ---------------------------------------------------------------- BASE64

function base64Coz(metin) {
  const temiz = String(metin).replace(/[^A-Za-z0-9+/=]/g, '');
  try { return Buffer.from(temiz, 'base64'); } catch { return Buffer.alloc(0); }
}

// --------------------------------------------------------------- ASCII85

/** PDF ASCII85Decode (<~ ... ~>) */
function ascii85Coz(metin) {
  let s = String(metin).replace(/\s+/g, '');
  s = s.replace(/^<~/, '').replace(/~>$/, '');
  const cikti = [];
  let grup = [];
  for (let i = 0; i < s.length; i++) {
    const k = s[i];
    if (k === 'z' && grup.length === 0) { cikti.push(0, 0, 0, 0); continue; }
    const d = k.charCodeAt(0) - 33;
    if (d < 0 || d > 84) continue;
    grup.push(d);
    if (grup.length === 5) {
      let n = 0;
      for (const g of grup) n = n * 85 + g;
      cikti.push((n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF);
      grup = [];
    }
  }
  if (grup.length > 1) {
    const eksik = 5 - grup.length;
    for (let i = 0; i < eksik; i++) grup.push(84);
    let n = 0;
    for (const g of grup) n = n * 85 + g;
    const dort = [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
    for (let i = 0; i < 4 - eksik; i++) cikti.push(dort[i]);
  }
  return Buffer.from(cikti);
}

/** PDF ASCIIHexDecode */
function asciiHexCoz(metin) {
  const s = String(metin).replace(/[^0-9A-Fa-f>]/g, '').replace(/>.*$/, '');
  const d = s.length % 2 ? s + '0' : s;
  return Buffer.from(d, 'hex');
}

// ------------------------------------------------------------- RFC 2047

/** "=?UTF-8?B?...?=" bicimli e-posta basliklarini cozer. */
function rfc2047Coz(metin) {
  return String(metin || '').replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (tam, karakterSeti, yontem, govde) => {
      try {
        const tampon = yontem.toUpperCase() === 'B'
          ? base64Coz(govde)
          : quotedPrintableCoz(govde.replace(/_/g, ' '));
        const ks = karakterSeti.toLowerCase();
        if (ks.includes('1254') || ks.includes('8859-9')) return cp1254Coz(tampon);
        if (ks.includes('1252') || ks.includes('8859-1')) return cp1252Coz(tampon);
        return tampon.toString('utf8');
      } catch { return tam; }
    },
  ).replace(/\?=\s*=\?/g, '');
}

// ------------------------------------------------------------- ENTROPI

/** Shannon entropisi (bayt basina bit, 0-8). Sifreli/sikistirilmis veri ~7.9. */
function entropi(tampon) {
  if (!tampon || tampon.length === 0) return 0;
  const sayim = new Uint32Array(256);
  const n = Math.min(tampon.length, 1024 * 256);
  for (let i = 0; i < n; i++) sayim[tampon[i]]++;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    if (!sayim[i]) continue;
    const p = sayim[i] / n;
    h -= p * Math.log2(p);
  }
  return Math.round(h * 1000) / 1000;
}

module.exports = {
  metneCevir, gecerliUtf8Mi, cp1254Coz, cp1252Coz, winAnsiKarakter,
  quotedPrintableCoz, base64Coz, ascii85Coz, asciiHexCoz, rfc2047Coz, entropi,
};
