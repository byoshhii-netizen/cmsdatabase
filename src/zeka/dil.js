'use strict';
/**
 * src/zeka/dil.js
 * TURKCE DIL ISLEME CEKIRDEGI — harici bagimliligi yoktur.
 *
 * Icerik:
 *   - normalize()        : Turkce'ye duyarli kucuk harf + ASCII katlama
 *   - belirtecler()      : kelime ayirma (sayi, tarih, kisaltma korunur)
 *   - govde()            : hafif Turkce govdeleme (suffix stripping)
 *   - anahtarlar()       : durak sozcukleri atilmis govde listesi
 *   - cumleler()         : Turkce kisaltmalara duyarli cumle ayirma
 *   - benzerlik()        : Jaro-Winkler + Levenshtein karma ad benzerligi
 *   - buyukHarfMi()      : ozel ad sezgisi (Turkce I/i sorunu cozulmus)
 *
 * Govdeleme morfolojik cozumleme DEGILDIR; geri getirme (retrieval) icin
 * "yeterince iyi" bir yaklasimdir: "raporlarinda" -> "rapor", "Ankara'da"
 * -> "ankara". Yanlis govdeleme arama kalitesini dusurur ama bozmaz.
 */

// --------------------------------------------------------------- NORMALIZE

const KATLAMA = {
  'ç': 'c', 'ğ': 'g', 'ı': 'i', 'İ': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u',
  'Ç': 'c', 'Ğ': 'g', 'I': 'i', 'Ö': 'o', 'Ş': 's', 'Ü': 'u',
  'â': 'a', 'î': 'i', 'û': 'u', 'Â': 'a', 'Î': 'i', 'Û': 'u',
  'é': 'e', 'è': 'e', 'ë': 'e', 'á': 'a', 'à': 'a', 'ä': 'a',
  'ó': 'o', 'ò': 'o', 'ô': 'o', 'ú': 'u', 'ù': 'u', 'í': 'i', 'ñ': 'n',
};

/** Turkce'ye duyarli normalizasyon: kucuk harf + aksan katlama. */
function normalize(metin) {
  let s = String(metin || '');
  let c = '';
  for (const k of s) c += KATLAMA[k] !== undefined ? KATLAMA[k] : k;
  return c.toLowerCase();
}

/** Turkce kurallarina gore kucuk harfe cevirir (katlama YAPMAZ). */
function kucuk(metin) {
  return String(metin || '').replace(/I/g, 'ı').replace(/İ/g, 'i').toLowerCase();
}

/** Turkce kurallarina gore buyuk harfe cevirir. */
function buyuk(metin) {
  return String(metin || '').replace(/i/g, 'İ').replace(/ı/g, 'I').toUpperCase();
}

/** Ilk harf buyuk mu? (ozel ad sezgisi icin) */
function buyukHarfMi(kelime) {
  const k = String(kelime || '')[0];
  if (!k) return false;
  return k === buyuk(k) && k !== kucuk(k);
}

// ------------------------------------------------------------- DURAK SOZCUK

const DURAK = new Set(normalize([
  'bir', 'bu', 've', 'ile', 'icin', 'olarak', 'daha', 'cok', 'gibi', 'ama', 'ancak',
  'fakat', 'veya', 'ya', 'da', 'de', 'ki', 'mi', 'mu', 'mi', 'degil', 'kadar', 'sonra',
  'once', 'simdi', 'burada', 'orada', 'her', 'hic', 'tum', 'butun', 'bazi', 'kendi',
  'olan', 'olup', 'oldu', 'olmak', 'var', 'yok', 'ise', 'eger', 'yani', 'hem',
  'ne', 'nasil', 'neden', 'nicin', 'kim', 'hangi', 'nerede', 'nereye', 'nereden',
  'kac', 'ben', 'sen', 'o', 'biz', 'siz', 'onlar', 'bana', 'sana', 'ona', 'bize',
  'size', 'onlara', 'benim', 'senin', 'onun', 'bizim', 'sizin', 'onlarin',
  'su', 'sunu', 'bunu', 'onu', 'bunlar', 'sunlar', 'ayrica', 'yine', 'zaten',
  'ancak', 'ustelik', 'oysa', 'cunku', 'diye', 'rağmen', 'ragmen', 'birlikte',
  'uzere', 'dolayi', 'nedeniyle', 'sebebiyle', 'tarafindan', 'arasinda', 'icinde',
  'uzerine', 'altinda', 'yaninda', 'karsi', 'gore', 'beri', 'dogru', 'bile',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'has',
  'have', 'not', 'but', 'you', 'all', 'can', 'his', 'her', 'its', 'our', 'their',
].join(' ')).split(' '));

function durakMi(kelime) {
  return DURAK.has(normalize(kelime));
}

// ------------------------------------------------------------- BELIRTECLEME

/**
 * Metni kelimelere ayirir. Tarih (15.03.2024), saat (14:30), ondalik sayi,
 * IBAN/plaka gibi birlesik yapilar tek parca kalir.
 */
function belirtecler(metin) {
  const s = String(metin || '');
  const bulunan = s.match(
    /\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}:\d{2}(?::\d{2})?|[A-Za-z]{2}\d{2}[A-Za-z0-9]{10,30}|\d+[.,]\d+|[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu,
  );
  return bulunan || [];
}

// --------------------------------------------------------------- GOVDELEME

// Uzundan kisaya siralanmis Turkce ek listesi. Her tur en fazla bir kez
// soyulur; toplam en fazla UC tur dondurulur.
const EKLER = [
  // birlesik / turetme
  'lerinden', 'larindan', 'lerinde', 'larinda', 'lerine', 'larina', 'lerini', 'larini',
  'leriyle', 'lariyla', 'lerimiz', 'larimiz', 'leriniz', 'lariniz',
  'cilik', 'cilik', 'ciligi', 'siniz', 'siniz', 'sunuz', 'sunuz',
  'leri', 'lari', 'lerin', 'larin', 'leri', 'lari',
  'ligi', 'ligi', 'lugu', 'lugu', 'lik', 'lik', 'luk', 'luk',
  'siz', 'siz', 'suz', 'suz', 'sal', 'sel',
  'ler', 'lar',
  // iyelik (unlu sonrasi -s- kaynastirmali bicimler dahil)
  'sinden', 'sindan', 'sunden', 'sundan', 'sinde', 'sinda', 'sunde', 'sunda',
  'siyle', 'siyla', 'suyle', 'suyla', 'sinin', 'sinin', 'sunun', 'sunun',
  'sini', 'sini', 'sunu', 'sunu', 'sine', 'sina', 'sune', 'suna',
  'si', 'si', 'su', 'su',
  'imiz', 'imiz', 'umuz', 'umuz', 'iniz', 'iniz', 'unuz', 'unuz',
  'miz', 'miz', 'muz', 'muz', 'niz', 'niz', 'nuz', 'nuz',
  // hal
  'ndan', 'nden', 'tan', 'ten', 'dan', 'den', 'nin', 'nin', 'nun', 'nun',
  'in', 'in', 'un', 'un', 'da', 'de', 'ta', 'te', 'na', 'ne',
  'yla', 'yle', 'la', 'le', 'ya', 'ye', 'yi', 'yi', 'yu', 'yu',
  // fiil
  'yordu', 'iyor', 'iyor', 'uyor', 'uyor', 'yor',
  'acak', 'ecek', 'acagi', 'ecegi', 'maktadir', 'mektedir',
  'mis', 'mis', 'mus', 'mus', 'di', 'di', 'du', 'du', 'ti', 'ti', 'tu', 'tu',
  'mak', 'mek', 'mali', 'meli', 'madan', 'meden', 'arak', 'erek',
  'dik', 'dik', 'duk', 'duk', 'digi', 'digi', 'dugu', 'dugu',
  'ince', 'ince', 'unca', 'unce', 'ken',
  'ci', 'ci', 'cu', 'cu', 'li', 'li', 'lu', 'lu',
  // tek harf hal/iyelik (en son)
  'i', 'u', 'a', 'e',
];

const EKLER_SIRALI = [...new Set(EKLER.map(normalize))].sort((a, b) => b.length - a.length);
const MIN_GOVDE = 4;

/** Son sessiz yumusamasini geri alir: kitab -> kitap, agac -> agac. */
function sertlestir(govdeMetni) {
  if (govdeMetni.length <= MIN_GOVDE) return govdeMetni;
  const son = govdeMetni[govdeMetni.length - 1];
  const esle = { b: 'p', c: 'c', d: 't', g: 'k' };
  if (esle[son] && son !== 'c') return govdeMetni.slice(0, -1) + esle[son];
  return govdeMetni;
}

/**
 * Hafif Turkce govdeleme. Normalize edilmis cikti dondurur.
 * Kesme isaretinden sonrasi (Ankara'da -> ankara) dogrudan atilir.
 */
function govde(kelime) {
  let s = normalize(kelime);

  // Kesme isareti: ozel adlardaki ek ayirici
  const kesme = s.search(/['’`]/);
  if (kesme > 0) s = s.slice(0, kesme);

  s = s.replace(/[^\p{L}\p{N}]/gu, '');
  if (s.length <= MIN_GOVDE) return s;
  if (/^\d/.test(s)) return s;

  for (let tur = 0; tur < 3; tur++) {
    let soyuldu = false;
    for (const ek of EKLER_SIRALI) {
      if (s.length - ek.length < MIN_GOVDE) continue;
      if (s.endsWith(ek)) {
        s = s.slice(0, -ek.length);
        soyuldu = true;
        break;
      }
    }
    if (!soyuldu) break;
  }

  return sertlestir(s);
}

/**
 * DIZIN ANAHTARI — geri getirme (retrieval) icin kullanilan asil anahtar.
 *
 * Neden govde() degil: Turkce'de "adres+inde" ve "hucre+sinde" yuzeyde ayni
 * goruntiyu verir; sozluk olmadan hangi cozumlemenin dogru oldugu bilinemez.
 * Bu yuzden dizinde, Turkce bilgi erisimi literaturunde "sabit uzunlukta
 * govde (F5)" diye bilinen ve tam morfolojik cozumlemeye cok yakin basari
 * veren yontem kullanilir: normalize edilmis sozcugun ilk 5 karakteri.
 *
 *   adres / adresinde / adresinden  -> "adres"
 *   hucre / hucresinin              -> "hucre"
 *   rapor / raporlarinda            -> "rapor"
 *
 * Sayilar, tarihler ve kodlar oldugu gibi korunur (kesilmez).
 */
const ANAHTAR_UZUNLUK = 5;

function dizinAnahtari(kelime) {
  let s = normalize(kelime);
  const kesme = s.search(/['’`]/);
  if (kesme > 0) s = s.slice(0, kesme);
  s = s.replace(/[^\p{L}\p{N}]/gu, '');
  if (!s) return '';
  if (/\d/.test(s)) return s.slice(0, 32);
  return s.length <= ANAHTAR_UZUNLUK ? s : s.slice(0, ANAHTAR_UZUNLUK);
}

/**
 * Metni dizin anahtarlarina cevirir (BM25 / vektor icin).
 *
 * Her sozcuk IKI anahtar uretir: sabit uzunluklu govde (ilk 5 karakter) ve
 * morfolojik hafif govde. Ikisi birlikte kullanilinca tek basina her birinin
 * kacirdigi esleme yakalanir:
 *   "adres" / "adresinde"  -> sabit govde ikisinde de "adres"
 *   "arac"  / "aracinin"   -> morfolojik govde ikisinde de "arac"
 * Ayni genisletme hem belgeye hem sorguya uygulandigi icin BM25 puanlari
 * tutarli kalir.
 */
function anahtarlar(metin, { durakAt = true, minUzunluk = 2 } = {}) {
  const sonuc = [];
  for (const b of belirtecler(metin)) {
    const n = normalize(b);
    if (n.length < minUzunluk) continue;
    if (durakAt && DURAK.has(n)) continue;

    const sabit = dizinAnahtari(b);
    if (sabit.length >= minUzunluk && !(durakAt && DURAK.has(sabit))) sonuc.push(sabit);

    const morf = govde(b);
    if (morf !== sabit && morf.length >= minUzunluk && !(durakAt && DURAK.has(morf))) sonuc.push(morf);
  }
  return sonuc;
}

/**
 * Insan tarafindan okunacak anahtar sozcukler: yuzey bicimi korunur,
 * ayni govdeden gelenler teklenir, durak sozcukler atilir.
 */
function sozcukler(metin, { minUzunluk = 3 } = {}) {
  const gorulen = new Map();
  for (const b of belirtecler(metin)) {
    if (b.length < minUzunluk) continue;
    const n = normalize(b);
    if (DURAK.has(n)) continue;
    if (/^\d+$/.test(n)) continue;
    const g = govde(b);
    if (g.length < minUzunluk) continue;
    if (!gorulen.has(g)) gorulen.set(g, { yuzey: b, sayi: 0 });
    gorulen.get(g).sayi++;
  }
  return [...gorulen.values()].sort((a, b) => b.sayi - a.sayi);
}

/** Terim siklik haritasi. */
function terimSikligi(metin, secenek) {
  const harita = new Map();
  for (const t of anahtarlar(metin, secenek)) harita.set(t, (harita.get(t) || 0) + 1);
  return harita;
}

// ------------------------------------------------------------ CUMLE AYIRMA

const KISALTMALAR = new Set([
  'dr', 'prof', 'doc', 'av', 'sn', 'bkz', 'vb', 'vs', 'no', 'nr', 'tel', 'faks',
  'cad', 'sok', 'mah', 'apt', 'bl', 'kat', 'd', 'tc', 'tck', 'md', 'gn', 'ord',
  'alb', 'bnb', 'yzb', 'utg', 'tgm', 'ast', 'uzm', 'müh', 'muh', 'mim', 'ecz',
  'ltd', 'sti', 'as', 'a', 'b', 'c', 'org', 'bsk', 'yrd', 'min', 'maks', 'ort',
  'yy', 'ms', 'mo', 'sy', 'ss', 'cm', 'km', 'mm', 'kg', 'gr', 'tl', 'usd', 'eur',
]);

/** Metni cumlelere ayirir; kisaltma ve tarihlerde yanlis bolmez. */
function cumleler(metin) {
  const s = String(metin || '').replace(/\s+/g, ' ').trim();
  if (!s) return [];

  const sonuc = [];
  let bas = 0;

  for (let i = 0; i < s.length; i++) {
    const k = s[i];
    if (k !== '.' && k !== '!' && k !== '?' && k !== '\n') continue;

    // Sayi icinde nokta: 15.03.2024 / 3.14 / madde 5.
    if (k === '.' && /\d/.test(s[i - 1] || '') && /\d/.test(s[i + 1] || '')) continue;

    // Kisaltma: "Dr." gibi
    if (k === '.') {
      const oncekiKelime = s.slice(Math.max(0, i - 12), i).match(/(\p{L}+)$/u);
      if (oncekiKelime && KISALTMALAR.has(normalize(oncekiKelime[1]))) continue;
      // tek harf + nokta (bas harf): "M. Kaya"
      if (/(?:^|\s)\p{L}$/u.test(s.slice(Math.max(0, i - 3), i))) continue;
    }

    // Cumle sonu: devaminda bosluk + buyuk harf/ rakam olmali
    const sonraki = s.slice(i + 1).match(/^\s*(\S)/);
    if (k === '.' && sonraki && !/[\p{Lu}\d"'(«—-]/u.test(sonraki[1])) continue;

    const cumle = s.slice(bas, i + 1).trim();
    if (cumle.length > 1) sonuc.push(cumle);
    bas = i + 1;
  }

  const kalan = s.slice(bas).trim();
  if (kalan.length > 1) sonuc.push(kalan);
  return sonuc;
}

/** Metni paragraflara ayirir. */
function paragraflar(metin) {
  return String(metin || '').split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 1);
}

// ------------------------------------------------------------- BENZERLIK

/** Levenshtein mesafesi (bellek dostu, tek satir). */
function levenshtein(a, b) {
  const x = String(a);
  const y = String(b);
  if (x === y) return 0;
  if (!x.length) return y.length;
  if (!y.length) return x.length;

  let onceki = new Array(y.length + 1);
  for (let j = 0; j <= y.length; j++) onceki[j] = j;

  for (let i = 1; i <= x.length; i++) {
    const simdiki = new Array(y.length + 1);
    simdiki[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const maliyet = x[i - 1] === y[j - 1] ? 0 : 1;
      simdiki[j] = Math.min(simdiki[j - 1] + 1, onceki[j] + 1, onceki[j - 1] + maliyet);
    }
    onceki = simdiki;
  }
  return onceki[y.length];
}

/** Jaro-Winkler benzerligi (0-1). Ad/soyad eslestirmede guclu. */
function jaroWinkler(a, b) {
  const x = String(a);
  const y = String(b);
  if (!x.length || !y.length) return 0;
  if (x === y) return 1;

  const pencere = Math.max(0, Math.floor(Math.max(x.length, y.length) / 2) - 1);
  const xEslesti = new Array(x.length).fill(false);
  const yEslesti = new Array(y.length).fill(false);
  let eslesme = 0;

  for (let i = 0; i < x.length; i++) {
    const bas = Math.max(0, i - pencere);
    const son = Math.min(y.length - 1, i + pencere);
    for (let j = bas; j <= son; j++) {
      if (yEslesti[j] || x[i] !== y[j]) continue;
      xEslesti[i] = true;
      yEslesti[j] = true;
      eslesme++;
      break;
    }
  }
  if (!eslesme) return 0;

  let yerDegistirme = 0;
  let k = 0;
  for (let i = 0; i < x.length; i++) {
    if (!xEslesti[i]) continue;
    while (!yEslesti[k]) k++;
    if (x[i] !== y[k]) yerDegistirme++;
    k++;
  }

  const jaro = (eslesme / x.length + eslesme / y.length + (eslesme - yerDegistirme / 2) / eslesme) / 3;

  let onek = 0;
  for (let i = 0; i < Math.min(4, x.length, y.length); i++) {
    if (x[i] !== y[i]) break;
    onek++;
  }
  return jaro + onek * 0.1 * (1 - jaro);
}

/**
 * Iki adin benzerligi (0-1). Normalize eder, kelime kumesi kesisimi ile
 * karakter benzerligini harmanlar; "Ahmet Yilmaz" ~ "Yilmaz, Ahmet" yakalanir.
 */
function benzerlik(a, b) {
  const x = normalize(a).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const y = normalize(b).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!x || !y) return 0;
  if (x === y) return 1;

  const xk = new Set(x.split(' ').filter((k) => k.length > 1));
  const yk = new Set(y.split(' ').filter((k) => k.length > 1));
  let kesisim = 0;
  for (const k of xk) if (yk.has(k)) kesisim++;
  const kume = (xk.size && yk.size) ? kesisim / Math.min(xk.size, yk.size) : 0;

  const karakter = jaroWinkler(x.replace(/\s/g, ''), y.replace(/\s/g, ''));
  const mesafe = 1 - levenshtein(x, y) / Math.max(x.length, y.length);

  return Math.max(kume * 0.92, karakter * 0.6 + mesafe * 0.4);
}

/** Metnin n-gram kumesi (karakter tabanli, bulanik arama icin). */
function ngram(metin, n = 3) {
  const s = ` ${normalize(metin).replace(/\s+/g, ' ')} `;
  const kume = new Set();
  for (let i = 0; i + n <= s.length; i++) kume.add(s.slice(i, i + n));
  return kume;
}

/** Jaccard benzerligi (iki kume). */
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let kesisim = 0;
  for (const k of a) if (b.has(k)) kesisim++;
  return kesisim / (a.size + b.size - kesisim);
}

module.exports = {
  normalize, kucuk, buyuk, buyukHarfMi,
  belirtecler, govde, dizinAnahtari, anahtarlar, sozcukler, terimSikligi, durakMi, DURAK,
  cumleler, paragraflar,
  levenshtein, jaroWinkler, benzerlik, ngram, jaccard,
};
