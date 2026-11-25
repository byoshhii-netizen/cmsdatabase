'use strict';
/**
 * src/zeka/istatistik.js
 * ISTATISTIK VE ANOMALI TESPITI — bagimliliksiz.
 *
 *  zamanSerisi()     : olaylari gun/hafta/ay/saat kovalarina dagitir
 *  patlama()         : hareketlilik artislarini (burst) tespit eder
 *  sessizlik()       : beklenmeyen hareketsizlik araliklarini bulur
 *  aykirilar()       : z-puani ve MAD (saglam) yontemiyle uc degerler
 *  egilim()          : dogrusal egilim + yon ve guc
 *  mevsimsellik()    : haftanin gunu / gunun saati dagilimi
 *  ongoru()          : Holt dogrusal yumusatma ile kisa vadeli tahmin
 *  benford()         : ilk basamak dagilimi (mali veri tutarlilik testi)
 *  korelasyon()      : Pearson korelasyonu
 */

// ------------------------------------------------------------ TEMEL OLCUMLER

function ortalama(dizi) {
  if (!dizi.length) return 0;
  return dizi.reduce((a, c) => a + c, 0) / dizi.length;
}

function standartSapma(dizi, ort) {
  if (dizi.length < 2) return 0;
  const o = ort !== undefined ? ort : ortalama(dizi);
  const kare = dizi.reduce((a, c) => a + (c - o) ** 2, 0) / (dizi.length - 1);
  return Math.sqrt(kare);
}

function medyan(dizi) {
  if (!dizi.length) return 0;
  const s = [...dizi].sort((a, b) => a - b);
  const orta = Math.floor(s.length / 2);
  return s.length % 2 ? s[orta] : (s[orta - 1] + s[orta]) / 2;
}

/** Medyan Mutlak Sapma: uc degerlere dayanikli yayilim olcusu. */
function mad(dizi) {
  if (!dizi.length) return 0;
  const m = medyan(dizi);
  return medyan(dizi.map((x) => Math.abs(x - m)));
}

function yuzdelik(dizi, p) {
  if (!dizi.length) return 0;
  const s = [...dizi].sort((a, b) => a - b);
  const konum = (s.length - 1) * p;
  const alt = Math.floor(konum);
  const ust = Math.ceil(konum);
  return alt === ust ? s[alt] : s[alt] + (s[ust] - s[alt]) * (konum - alt);
}

// ------------------------------------------------------------- ZAMAN SERISI

const KOVA_MS = {
  saat: 3_600_000,
  gun: 86_400_000,
  hafta: 604_800_000,
};

/**
 * Zaman damgalarini kovalara dagitir; bos kovalar 0 ile doldurulur.
 * @param {Array<Date|string|number>} zamanlar
 * @param {'saat'|'gun'|'hafta'|'ay'} granularite
 */
function zamanSerisi(zamanlar, granularite = 'gun') {
  const damgalar = zamanlar
    .map((z) => (z instanceof Date ? z.getTime() : new Date(z).getTime()))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  if (damgalar.length === 0) return { kovalar: [], granularite, toplam: 0 };

  if (granularite === 'ay') {
    const sayac = new Map();
    for (const t of damgalar) {
      const d = new Date(t);
      const anahtar = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      sayac.set(anahtar, (sayac.get(anahtar) || 0) + 1);
    }
    const ilk = new Date(damgalar[0]);
    const son = new Date(damgalar[damgalar.length - 1]);
    const kovalar = [];
    const imlec = new Date(ilk.getFullYear(), ilk.getMonth(), 1);
    while (imlec <= son) {
      const anahtar = `${imlec.getFullYear()}-${String(imlec.getMonth() + 1).padStart(2, '0')}`;
      kovalar.push({ etiket: anahtar, zaman: imlec.getTime(), deger: sayac.get(anahtar) || 0 });
      imlec.setMonth(imlec.getMonth() + 1);
    }
    return { kovalar, granularite, toplam: damgalar.length };
  }

  const adim = KOVA_MS[granularite] || KOVA_MS.gun;
  const bas = Math.floor(damgalar[0] / adim) * adim;
  const son = Math.floor(damgalar[damgalar.length - 1] / adim) * adim;
  const kovaSayisi = Math.min(Math.floor((son - bas) / adim) + 1, 2000);

  const kovalar = [];
  for (let i = 0; i < kovaSayisi; i++) {
    kovalar.push({ zaman: bas + i * adim, deger: 0, etiket: null });
  }
  for (const t of damgalar) {
    const i = Math.floor((t - bas) / adim);
    if (i >= 0 && i < kovalar.length) kovalar[i].deger++;
  }
  for (const k of kovalar) {
    const d = new Date(k.zaman);
    k.etiket = granularite === 'saat'
      ? `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`
      : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  }

  return { kovalar, granularite, toplam: damgalar.length };
}

// ---------------------------------------------------------------- AYKIRILAR

/**
 * Aykiri deger tespiti. Hem klasik z-puani hem de saglam (MAD tabanli)
 * z-puani hesaplanir; MAD kullanilir cunku birkac buyuk uc deger klasik
 * standart sapmayi sisirip kendi kendini gizler.
 */
function aykirilar(degerler, { esik = 3 } = {}) {
  if (degerler.length < 4) return [];
  const m = medyan(degerler);
  const sapma = mad(degerler);
  const ort = ortalama(degerler);
  const ss = standartSapma(degerler, ort);

  return degerler.map((deger, dizin) => {
    const saglamZ = sapma > 0 ? (0.6745 * (deger - m)) / sapma : 0;
    const klasikZ = ss > 0 ? (deger - ort) / ss : 0;
    return { dizin, deger, saglamZ: Math.round(saglamZ * 100) / 100, z: Math.round(klasikZ * 100) / 100 };
  }).filter((x) => Math.abs(x.saglamZ) >= esik || Math.abs(x.z) >= esik + 0.5);
}

// ------------------------------------------------------------------ PATLAMA

/**
 * Hareketlilik patlamasi (burst) tespiti: her kova, kendisinden onceki
 * "temel donem" ile karsilastirilir. Ani ve kalici artislar isaretlenir.
 */
function patlama(kovalar, { pencere = 7, esik = 2.2 } = {}) {
  const degerler = kovalar.map((k) => k.deger);
  if (degerler.length < pencere + 2) return [];

  const sonuc = [];
  for (let i = pencere; i < degerler.length; i++) {
    const temel = degerler.slice(Math.max(0, i - pencere), i);
    const ort = ortalama(temel);
    const ss = standartSapma(temel, ort) || Math.sqrt(Math.max(ort, 0.5));
    const z = (degerler[i] - ort) / (ss || 1);

    if (z >= esik && degerler[i] >= Math.max(3, ort * 1.5)) {
      sonuc.push({
        dizin: i,
        etiket: kovalar[i].etiket,
        zaman: kovalar[i].zaman,
        deger: degerler[i],
        temelOrtalama: Math.round(ort * 100) / 100,
        z: Math.round(z * 100) / 100,
        kat: ort > 0 ? Math.round((degerler[i] / ort) * 100) / 100 : null,
      });
    }
  }

  return sonuc;
}

/**
 * Sessizlik araliklari: daha once duzenli hareket varken aniden duran
 * donemler. Istihbaratta "iletisim kesildi" sinyalidir.
 */
function sessizlik(kovalar, { enAzUzunluk = 3 } = {}) {
  const degerler = kovalar.map((k) => k.deger);
  const aktifOrt = ortalama(degerler.filter((d) => d > 0)) || 1;
  if (degerler.length < enAzUzunluk * 2) return [];

  const araliklar = [];
  let bas = -1;

  for (let i = 0; i < degerler.length; i++) {
    if (degerler[i] === 0) {
      if (bas < 0) bas = i;
    } else if (bas >= 0) {
      if (i - bas >= enAzUzunluk) {
        araliklar.push({ bas, son: i - 1, uzunluk: i - bas, basEtiket: kovalar[bas].etiket, sonEtiket: kovalar[i - 1].etiket });
      }
      bas = -1;
    }
  }
  if (bas >= 0 && degerler.length - bas >= enAzUzunluk) {
    araliklar.push({
      bas, son: degerler.length - 1, uzunluk: degerler.length - bas,
      basEtiket: kovalar[bas].etiket, sonEtiket: kovalar[degerler.length - 1].etiket, suruyor: true,
    });
  }

  return araliklar.map((a) => ({ ...a, beklenenHareket: Math.round(aktifOrt * a.uzunluk) }));
}

// ------------------------------------------------------------------ EGILIM

/** En kucuk kareler dogrusal egilim. */
function egilim(degerler) {
  const n = degerler.length;
  if (n < 3) return null;

  const xOrt = (n - 1) / 2;
  const yOrt = ortalama(degerler);
  let ustPay = 0;
  let altPay = 0;
  for (let i = 0; i < n; i++) {
    ustPay += (i - xOrt) * (degerler[i] - yOrt);
    altPay += (i - xOrt) ** 2;
  }
  const egim = altPay ? ustPay / altPay : 0;
  const kesisim = yOrt - egim * xOrt;

  // Belirleme katsayisi (R^2)
  let toplamKare = 0;
  let kalanKare = 0;
  for (let i = 0; i < n; i++) {
    toplamKare += (degerler[i] - yOrt) ** 2;
    kalanKare += (degerler[i] - (egim * i + kesisim)) ** 2;
  }
  const r2 = toplamKare ? 1 - kalanKare / toplamKare : 0;

  const yuzde = yOrt ? (egim / yOrt) * 100 : 0;
  const yon = Math.abs(yuzde) < 1 ? 'yatay' : yuzde > 0 ? 'artiyor' : 'azaliyor';

  return {
    egim: Math.round(egim * 10000) / 10000,
    kesisim: Math.round(kesisim * 100) / 100,
    r2: Math.round(Math.max(0, r2) * 1000) / 1000,
    kovaBasinaYuzde: Math.round(yuzde * 100) / 100,
    yon,
    guven: r2 > 0.6 ? 'yuksek' : r2 > 0.3 ? 'orta' : 'dusuk',
  };
}

// ------------------------------------------------------------- MEVSIMSELLIK

const GUN_ADLARI = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];

/** Haftanin gunu ve gunun saati dagilimi. */
function mevsimsellik(zamanlar) {
  const gun = new Array(7).fill(0);
  const saat = new Array(24).fill(0);
  let toplam = 0;

  for (const z of zamanlar) {
    const d = z instanceof Date ? z : new Date(z);
    if (Number.isNaN(d.getTime())) continue;
    gun[d.getDay()]++;
    saat[d.getHours()]++;
    toplam++;
  }
  if (!toplam) return null;

  const enYogunGun = gun.indexOf(Math.max(...gun));
  const enYogunSaat = saat.indexOf(Math.max(...saat));
  const geceToplam = saat.slice(0, 6).reduce((a, c) => a + c, 0) + saat[23];
  const haftaSonu = gun[0] + gun[6];

  return {
    gunler: gun.map((deger, i) => ({ ad: GUN_ADLARI[i], deger, oran: Math.round((deger / toplam) * 1000) / 10 })),
    saatler: saat.map((deger, i) => ({ saat: i, deger })),
    enYogunGun: GUN_ADLARI[enYogunGun],
    enYogunSaat: `${String(enYogunSaat).padStart(2, '0')}:00`,
    geceOrani: Math.round((geceToplam / toplam) * 1000) / 10,
    haftaSonuOrani: Math.round((haftaSonu / toplam) * 1000) / 10,
    toplam,
  };
}

// ------------------------------------------------------------------- ONGORU

/**
 * Holt dogrusal yumusatma ile kisa vadeli tahmin.
 * Harici bir model gerekmez; seri kendi egilimini tasir.
 */
function ongoru(degerler, { adim = 7, alfa = 0.4, beta = 0.2 } = {}) {
  if (degerler.length < 4) return null;

  let seviye = degerler[0];
  let trend = degerler[1] - degerler[0];
  const uyum = [];

  for (let i = 1; i < degerler.length; i++) {
    const oncekiSeviye = seviye;
    seviye = alfa * degerler[i] + (1 - alfa) * (seviye + trend);
    trend = beta * (seviye - oncekiSeviye) + (1 - beta) * trend;
    uyum.push(seviye);
  }

  const tahmin = [];
  for (let h = 1; h <= adim; h++) {
    tahmin.push(Math.max(0, Math.round((seviye + h * trend) * 100) / 100));
  }

  // Ortalama mutlak yuzde hata (MAPE)
  let hata = 0;
  let sayac = 0;
  for (let i = 1; i < degerler.length; i++) {
    if (degerler[i] === 0) continue;
    hata += Math.abs(degerler[i] - uyum[i - 1]) / degerler[i];
    sayac++;
  }

  return {
    tahmin,
    seviye: Math.round(seviye * 100) / 100,
    trend: Math.round(trend * 1000) / 1000,
    mape: sayac ? Math.round((hata / sayac) * 1000) / 10 : null,
  };
}

// ------------------------------------------------------------------ BENFORD

const BENFORD_BEKLENEN = [0.301, 0.176, 0.125, 0.097, 0.079, 0.067, 0.058, 0.051, 0.046];

/**
 * Benford yasasi testi: dogal mali verilerde ilk basamak dagilimi bilinen
 * bir egri izler. Buyuk sapma, uydurulmus/duzenlenmis sayilara isaret eder.
 * Anlamli sonuc icin en az ~50 sayi gerekir.
 */
function benford(sayilar) {
  const basamaklar = new Array(9).fill(0);
  let toplam = 0;

  for (const s of sayilar) {
    const n = Math.abs(Number(s));
    if (!Number.isFinite(n) || n < 1) continue;
    const ilk = Number(String(Math.floor(n)).replace(/^0+/, '')[0]);
    if (ilk >= 1 && ilk <= 9) { basamaklar[ilk - 1]++; toplam++; }
  }

  if (toplam < 20) {
    return { yeterliVeri: false, toplam, mesaj: 'Anlamli bir Benford testi icin en az 50 sayi onerilir.' };
  }

  const gozlenen = basamaklar.map((b) => b / toplam);
  let kiKare = 0;
  let maxSapma = 0;
  for (let i = 0; i < 9; i++) {
    const beklenenSayi = BENFORD_BEKLENEN[i] * toplam;
    kiKare += ((basamaklar[i] - beklenenSayi) ** 2) / beklenenSayi;
    maxSapma = Math.max(maxSapma, Math.abs(gozlenen[i] - BENFORD_BEKLENEN[i]));
  }

  // 8 serbestlik derecesi, p=0.05 kritik deger 15.507
  const sapiyor = kiKare > 15.507;

  return {
    yeterliVeri: true,
    toplam,
    basamaklar: basamaklar.map((sayi, i) => ({
      basamak: i + 1, sayi,
      gozlenen: Math.round(gozlenen[i] * 1000) / 10,
      beklenen: Math.round(BENFORD_BEKLENEN[i] * 1000) / 10,
    })),
    kiKare: Math.round(kiKare * 100) / 100,
    kritikDeger: 15.507,
    sapiyor,
    enBuyukSapma: Math.round(maxSapma * 1000) / 10,
    yorum: sapiyor
      ? 'Ilk basamak dagilimi Benford egrisinden anlamli olcude sapiyor: veri elle duzenlenmis olabilir.'
      : 'Ilk basamak dagilimi Benford egrisiyle uyumlu.',
  };
}

// --------------------------------------------------------------- KORELASYON

/** Pearson korelasyon katsayisi. */
function korelasyon(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const aOrt = ortalama(a.slice(0, n));
  const bOrt = ortalama(b.slice(0, n));
  let ust = 0;
  let aKare = 0;
  let bKare = 0;
  for (let i = 0; i < n; i++) {
    ust += (a[i] - aOrt) * (b[i] - bOrt);
    aKare += (a[i] - aOrt) ** 2;
    bKare += (b[i] - bOrt) ** 2;
  }
  const bolen = Math.sqrt(aKare * bKare);
  const r = bolen ? ust / bolen : 0;
  return {
    r: Math.round(r * 1000) / 1000,
    guc: Math.abs(r) > 0.7 ? 'guclu' : Math.abs(r) > 0.4 ? 'orta' : 'zayif',
    yon: r > 0 ? 'ayni yonlu' : 'ters yonlu',
    n,
  };
}

/** Shannon entropisi ile cesitlilik (0 = tek tur, yuksek = dagilmis). */
function cesitlilik(sayac) {
  const degerler = sayac instanceof Map ? [...sayac.values()] : Object.values(sayac);
  const toplam = degerler.reduce((a, c) => a + c, 0);
  if (!toplam) return { entropi: 0, normalize: 0, tur: degerler.length };
  let h = 0;
  for (const d of degerler) {
    if (!d) continue;
    const p = d / toplam;
    h -= p * Math.log2(p);
  }
  const enFazla = Math.log2(Math.max(degerler.length, 2));
  return {
    entropi: Math.round(h * 1000) / 1000,
    normalize: Math.round((h / enFazla) * 1000) / 1000,
    tur: degerler.length,
  };
}

module.exports = {
  ortalama, standartSapma, medyan, mad, yuzdelik,
  zamanSerisi, patlama, sessizlik, aykirilar, egilim, mevsimsellik,
  ongoru, benford, korelasyon, cesitlilik, GUN_ADLARI,
};
