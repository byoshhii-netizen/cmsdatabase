'use strict';
/**
 * src/utils/hesapMakinesi.js
 * Guvenli matematik ifade degerlendiricisi (eval/Function KULLANILMAZ).
 * Basit recursive-descent parser: + - * / % ^ () ve temel fonksiyonlar.
 * Cambaz'in cevrimdisi (API anahtarsiz) motorunda matematik sorularini
 * cozmek icin kullanilir.
 */

const FONKSIYONLAR = {
  sqrt: Math.sqrt,
  karekok: Math.sqrt,
  abs: Math.abs,
  mutlak: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  ln: Math.log,
  log: Math.log10,
  log2: Math.log2,
  exp: Math.exp,
  floor: Math.floor,
  taban: Math.floor,
  ceil: Math.ceil,
  tavan: Math.ceil,
  round: Math.round,
  yuvarla: Math.round,
  sign: Math.sign,
};

const SABITLER = { pi: Math.PI, e: Math.E };

class AyristirmaHatasi extends Error {}

/** Metni token dizisine ayirir. */
function tokenlaştir(ifade) {
  const tokenlar = [];
  let i = 0;
  const s = ifade;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      let noktaGorundu = false;
      while (j < s.length && (/[0-9]/.test(s[j]) || (s[j] === '.' && !noktaGorundu))) {
        if (s[j] === '.') noktaGorundu = true;
        j++;
      }
      const parca = s.slice(i, j);
      if (!/^[0-9]*\.?[0-9]+$|^[0-9]+\.?$/.test(parca)) throw new AyristirmaHatasi('Gecersiz sayi: ' + parca);
      tokenlar.push({ tur: 'sayi', deger: Number(parca) });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++;
      tokenlar.push({ tur: 'ad', deger: s.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ('+-*/%^(),'.includes(c)) {
      tokenlar.push({ tur: 'op', deger: c });
      i++;
      continue;
    }
    throw new AyristirmaHatasi('Taninmayan karakter: ' + c);
  }
  return tokenlar;
}

/** Recursive-descent parser + anlik degerlendirme. */
function ayristirVeDegerlendir(tokenlar) {
  let pos = 0;
  const bak = () => tokenlar[pos];
  const yut = (beklenen) => {
    const t = tokenlar[pos];
    if (!t || (beklenen && t.deger !== beklenen)) {
      throw new AyristirmaHatasi(`Beklenen "${beklenen}", bulunan "${t ? t.deger : 'son'}"`);
    }
    pos++;
    return t;
  };

  function ifade() {
    let deger = terim();
    while (bak() && bak().tur === 'op' && (bak().deger === '+' || bak().deger === '-')) {
      const op = yut().deger;
      const sag = terim();
      deger = op === '+' ? deger + sag : deger - sag;
    }
    return deger;
  }

  function terim() {
    let deger = birliOncesi();
    while (bak() && bak().tur === 'op' && (bak().deger === '*' || bak().deger === '/' || bak().deger === '%')) {
      const op = yut().deger;
      const sag = birliOncesi();
      if (op === '*') deger *= sag;
      else if (op === '/') {
        if (sag === 0) throw new AyristirmaHatasi('Sifira bolme');
        deger /= sag;
      } else deger %= sag;
    }
    return deger;
  }

  function birliOncesi() {
    if (bak() && bak().tur === 'op' && (bak().deger === '-' || bak().deger === '+')) {
      const op = yut().deger;
      const deger = birliOncesi();
      return op === '-' ? -deger : deger;
    }
    return us();
  }

  function us() {
    const taban = atom();
    if (bak() && bak().tur === 'op' && bak().deger === '^') {
      yut();
      const usDeger = birliOncesi(); // sagdan birlesir
      return Math.pow(taban, usDeger);
    }
    return taban;
  }

  function atom() {
    const t = bak();
    if (!t) throw new AyristirmaHatasi('Beklenmeyen ifade sonu');

    if (t.tur === 'sayi') { yut(); return t.deger; }

    if (t.tur === 'op' && t.deger === '(') {
      yut('(');
      const deger = ifade();
      yut(')');
      return deger;
    }

    if (t.tur === 'ad') {
      const ad = t.deger;
      yut();
      if (bak() && bak().tur === 'op' && bak().deger === '(') {
        yut('(');
        const args = [ifade()];
        while (bak() && bak().tur === 'op' && bak().deger === ',') { yut(','); args.push(ifade()); }
        yut(')');
        const fn = FONKSIYONLAR[ad];
        if (!fn) throw new AyristirmaHatasi('Bilinmeyen fonksiyon: ' + ad);
        return fn(...args);
      }
      if (ad in SABITLER) return SABITLER[ad];
      throw new AyristirmaHatasi('Bilinmeyen sembol: ' + ad);
    }

    throw new AyristirmaHatasi('Beklenmeyen simge: ' + t.deger);
  }

  const sonuc = ifade();
  if (pos !== tokenlar.length) throw new AyristirmaHatasi('Ifade sonunda fazladan icerik var.');
  return sonuc;
}

/**
 * Bir matematik ifadesini guvenli sekilde degerlendirir.
 * @returns {{tamam:boolean, sonuc?:number, hata?:string}}
 */
function hesapla(ifadeMetni) {
  const ifade = String(ifadeMetni || '').trim();
  if (!ifade) return { tamam: false, hata: 'Bos ifade.' };
  if (ifade.length > 200) return { tamam: false, hata: 'Ifade cok uzun.' };
  try {
    const tokenlar = tokenlaştir(ifade);
    if (tokenlar.length === 0) return { tamam: false, hata: 'Bos ifade.' };
    const sonuc = ayristirVeDegerlendir(tokenlar);
    if (!Number.isFinite(sonuc)) return { tamam: false, hata: 'Sonuc sonsuz veya tanimsiz (NaN).' };
    return { tamam: true, sonuc: Math.round(sonuc * 1e10) / 1e10 };
  } catch (hata) {
    return { tamam: false, hata: hata.message || 'Ifade cozumlenemedi.' };
  }
}

/**
 * Serbest metin icinde bir aritmetik ifade olup olmadigini kaba sekilde
 * tespit eder (Cambaz'in "bunu hesapla" niyetini anlamasi icin).
 */
function metindeIfadeVarMi(metin) {
  const s = String(metin || '');
  // En az bir rakam + en az bir islem operatoru veya bilinen fonksiyon adi.
  const operatorVar = /[0-9][\s]*[+\-*/^%][\s]*[0-9(]/.test(s) || /\b(sqrt|karekok|sin|cos|tan|log|ln)\s*\(/i.test(s);
  return operatorVar;
}

/** Metin icinden en olasi aritmetik alt-ifadeyi cikarir (kaba sezgisel). */
function ifadeCikar(metin) {
  const s = String(metin || '')
    .replace(/kac\s*eder/gi, '')
    .replace(/hesapla/gi, '')
    .replace(/[?=]/g, '')
    .trim();
  // Izin verilen karakterlerden olusan en uzun blogu bul.
  const eslesmeler = s.match(/[0-9a-zA-Z_.,()+\-*/^%\s]+/g) || [];
  let enIyi = '';
  for (const e of eslesmeler) {
    if (/[0-9]/.test(e) && e.trim().length > enIyi.length) enIyi = e.trim();
  }
  return enIyi;
}

module.exports = { hesapla, metindeIfadeVarMi, ifadeCikar };
