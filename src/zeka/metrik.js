'use strict';
/**
 * src/zeka/metrik.js
 * VEKTOR UZAYI, OZETLEME VE KUMELEME — bagimliliksiz.
 *
 *  - idfHesapla / tfIdf     : klasik vektor uzayi modeli
 *  - kosinus / oklit        : benzerlik olcutleri
 *  - ozetle                 : TextRank tabanli cikarimsal ozetleme
 *                             (istege bagli SORGU ODAKLI)
 *  - anahtarKelimeler       : es-gecis grafigi uzerinde TextRank + obek birlestirme
 *  - kumele                 : k-ortalama (kosinus) + otomatik k secimi
 *  - mmr                    : cesitlilik korumali secim (Maximal Marginal Relevance)
 *  - okunabilirlik          : Atesman Turkce okunabilirlik puani
 *
 * Tum fonksiyonlar Map<terim, sayi> bicimindeki seyrek vektorlerle calisir;
 * bu sayede binlerce belgede bile bellek tuketimi dusuk kalir.
 */

const dil = require('./dil');

// ------------------------------------------------------------------- IDF

/**
 * Ters belge sikligi.
 * @param {Array<Map<string,number>|Array<string>>} belgeler
 * @returns {{idf:Map<string,number>, n:number, ortUzunluk:number}}
 */
function idfHesapla(belgeler) {
  const belgeSayisi = belgeler.length || 1;
  const gecis = new Map();
  let toplamUzunluk = 0;

  for (const b of belgeler) {
    const terimler = b instanceof Map ? [...b.keys()] : [...new Set(b)];
    toplamUzunluk += b instanceof Map
      ? [...b.values()].reduce((a, c) => a + c, 0)
      : b.length;
    for (const t of terimler) gecis.set(t, (gecis.get(t) || 0) + 1);
  }

  const idf = new Map();
  for (const [t, n] of gecis) {
    idf.set(t, Math.log(1 + (belgeSayisi - n + 0.5) / (n + 0.5)));
  }

  return { idf, n: belgeSayisi, ortUzunluk: toplamUzunluk / belgeSayisi, gecis };
}

/** Terim sayilarindan L2-normalize edilmis tf-idf vektoru uretir. */
function tfIdf(terimSayilari, idf) {
  const vektor = new Map();
  let kare = 0;
  for (const [t, s] of terimSayilari) {
    const agirlik = (1 + Math.log(s)) * (idf.get(t) || Math.log(2));
    vektor.set(t, agirlik);
    kare += agirlik * agirlik;
  }
  const norm = Math.sqrt(kare) || 1;
  for (const [t, a] of vektor) vektor.set(t, a / norm);
  return vektor;
}

/** Seyrek vektorler arasi kosinus benzerligi (vektorler normalize varsayilir). */
function kosinus(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  const [kucuk, buyuk] = a.size <= b.size ? [a, b] : [b, a];
  let toplam = 0;
  for (const [t, x] of kucuk) {
    const y = buyuk.get(t);
    if (y !== undefined) toplam += x * y;
  }
  return toplam;
}

/** Normalize edilmemis vektorler icin kosinus. */
function kosinusHam(a, b) {
  let nokta = 0;
  let aKare = 0;
  let bKare = 0;
  for (const [, x] of a) aKare += x * x;
  for (const [, y] of b) bKare += y * y;
  const [kucuk, buyuk] = a.size <= b.size ? [a, b] : [b, a];
  for (const [t, x] of kucuk) {
    const y = buyuk.get(t);
    if (y !== undefined) nokta += x * y;
  }
  const bolen = Math.sqrt(aKare) * Math.sqrt(bKare);
  return bolen ? nokta / bolen : 0;
}

// ------------------------------------------------------------- BM25 PUANI

/**
 * Tek bir belge icin BM25 puani (bellek ici kullanim).
 * @param {Map<string,number>} belgeTerimleri
 * @param {Array<string>} sorguTerimleri
 */
function bm25(belgeTerimleri, sorguTerimleri, { idf, ortUzunluk }, k1 = 1.4, b = 0.72) {
  const uzunluk = [...belgeTerimleri.values()].reduce((a, c) => a + c, 0) || 1;
  let puan = 0;
  for (const t of sorguTerimleri) {
    const f = belgeTerimleri.get(t);
    if (!f) continue;
    const ters = idf.get(t) || Math.log(2);
    puan += ters * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (uzunluk / (ortUzunluk || uzunluk))));
  }
  return puan;
}

// --------------------------------------------------------------- TEXTRANK

/** Guc yontemiyle PageRank (yonsuz, agirlikli grafik). */
function pageRank(komsuluk, { sonumleme = 0.85, tur = 40, esik = 1e-6 } = {}) {
  const n = komsuluk.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  const toplamlar = komsuluk.map((satir) => satir.reduce((a, c) => a + c, 0) || 1e-9);
  let puan = new Array(n).fill(1 / n);

  for (let t = 0; t < tur; t++) {
    const yeni = new Array(n).fill((1 - sonumleme) / n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j || komsuluk[j][i] === 0) continue;
        yeni[i] += sonumleme * puan[j] * (komsuluk[j][i] / toplamlar[j]);
      }
    }
    let fark = 0;
    for (let i = 0; i < n; i++) fark += Math.abs(yeni[i] - puan[i]);
    puan = yeni;
    if (fark < esik) break;
  }

  return puan;
}

/**
 * CIKARIMSAL OZETLEME (TextRank + konum ve uzunluk duzeltmeleri).
 *
 * @param {string} metin
 * @param {object} secenek
 * @param {number} secenek.cumleSayisi  kac cumle dondurulecek
 * @param {string} secenek.sorgu        verilirse ozet bu sorguya odaklanir
 * @param {number} secenek.maxKarakter  ozet ust siniri
 * @returns {{ozet:string, cumleler:Array<{metin:string,puan:number,sira:number}>}}
 */
function ozetle(metin, { cumleSayisi = 4, sorgu = '', maxKarakter = 1400 } = {}) {
  const tumCumleler = dil.cumleler(metin).filter((c) => c.length >= 25 && c.length <= 1200);
  if (tumCumleler.length === 0) {
    const kirpik = String(metin || '').trim().slice(0, maxKarakter);
    return { ozet: kirpik, cumleler: kirpik ? [{ metin: kirpik, puan: 1, sira: 0 }] : [] };
  }
  if (tumCumleler.length <= cumleSayisi) {
    return {
      ozet: tumCumleler.join(' ').slice(0, maxKarakter),
      cumleler: tumCumleler.map((c, i) => ({ metin: c, puan: 1, sira: i })),
    };
  }

  // Hiz icin en fazla 400 cumle degerlendirilir.
  const cumle = tumCumleler.slice(0, 400);
  const terimler = cumle.map((c) => dil.terimSikligi(c));
  const { idf } = idfHesapla(terimler);
  const vektorler = terimler.map((t) => tfIdf(t, idf));

  const n = vektorler.length;
  const komsuluk = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const benzer = kosinus(vektorler[i], vektorler[j]);
      if (benzer > 0.08) { komsuluk[i][j] = benzer; komsuluk[j][i] = benzer; }
    }
  }

  const temelPuan = pageRank(komsuluk);

  // Sorgu odagi: sorgu vektorune benzerlik puani harmanlanir.
  let sorguVektor = null;
  if (sorgu && sorgu.trim()) {
    sorguVektor = tfIdf(dil.terimSikligi(sorgu), idf);
  }

  const puanlar = temelPuan.map((p, i) => {
    let puan = p;
    // Konum duzeltmesi: ilk ve son cumleler genellikle bilgi yoguntur.
    if (i === 0) puan *= 1.35;
    else if (i === 1) puan *= 1.15;
    else if (i === n - 1) puan *= 1.08;
    // Cok kisa cumleleri biraz cezalandir
    if (cumle[i].length < 60) puan *= 0.85;
    // Sayisal/ozel ad yogunlugu bonusu
    if (/\d{2,}/.test(cumle[i])) puan *= 1.08;
    if (sorguVektor) puan = puan * 0.45 + kosinus(sorguVektor, vektorler[i]) * 0.55;
    return { metin: cumle[i], puan, sira: i };
  });

  // Cesitlilik korumali secim
  const secilenler = mmr(puanlar, vektorler, { n: cumleSayisi, lambda: 0.72 });
  secilenler.sort((a, b) => a.sira - b.sira);

  let ozet = '';
  for (const s of secilenler) {
    if (ozet.length + s.metin.length + 1 > maxKarakter) break;
    ozet += (ozet ? ' ' : '') + s.metin;
  }

  return { ozet: ozet || secilenler[0].metin.slice(0, maxKarakter), cumleler: secilenler };
}

/**
 * Maximal Marginal Relevance: hem yuksek puanli hem birbirine benzemeyen
 * ogeleri secer (ozet ve arama sonuclarinda tekrari onler).
 */
function mmr(adaylar, vektorler, { n = 5, lambda = 0.7 } = {}) {
  const kalan = adaylar.map((a, i) => ({ ...a, dizin: a.dizin !== undefined ? a.dizin : i }));
  kalan.sort((a, b) => b.puan - a.puan);

  const secilen = [];
  while (secilen.length < n && kalan.length) {
    let enIyi = 0;
    let enIyiDeger = -Infinity;

    for (let i = 0; i < kalan.length; i++) {
      let enBenzer = 0;
      for (const s of secilen) {
        const v1 = vektorler[kalan[i].dizin];
        const v2 = vektorler[s.dizin];
        if (v1 && v2) enBenzer = Math.max(enBenzer, kosinus(v1, v2));
      }
      const deger = lambda * kalan[i].puan - (1 - lambda) * enBenzer;
      if (deger > enIyiDeger) { enIyiDeger = deger; enIyi = i; }
    }

    secilen.push(kalan[enIyi]);
    kalan.splice(enIyi, 1);
  }

  return secilen;
}

// ---------------------------------------------------------- ANAHTAR KELIME

/**
 * Anahtar kelime/obek cikarimi: es-gecis grafigi uzerinde TextRank, ardindan
 * metinde yan yana gecen yuksek puanli sozcukleri obek haline getirir.
 *
 * @returns {Array<{obek:string, puan:number}>}
 */
function anahtarKelimeler(metin, { adet = 12, pencere = 4 } = {}) {
  const ham = String(metin || '');
  const belirtec = dil.belirtecler(ham)
    .filter((k) => k.length > 2 && !dil.durakMi(k) && !/^\d+$/.test(k));
  if (belirtec.length < 4) return [];

  // Govde -> en sik yuzey bicimi
  const yuzey = new Map();
  const govdeler = belirtec.map((k) => {
    const g = dil.govde(k);
    if (!yuzey.has(g)) yuzey.set(g, new Map());
    const sayac = yuzey.get(g);
    sayac.set(k, (sayac.get(k) || 0) + 1);
    return g;
  });

  const dugumler = [...new Set(govdeler)];
  if (dugumler.length < 2) return [];
  const dizin = new Map(dugumler.map((d, i) => [d, i]));

  const komsuluk = Array.from({ length: dugumler.length }, () => new Array(dugumler.length).fill(0));
  for (let i = 0; i < govdeler.length; i++) {
    for (let j = i + 1; j < Math.min(i + pencere, govdeler.length); j++) {
      const a = dizin.get(govdeler[i]);
      const b = dizin.get(govdeler[j]);
      if (a === b) continue;
      komsuluk[a][b] += 1;
      komsuluk[b][a] += 1;
    }
  }

  const puan = pageRank(komsuluk, { tur: 30 });
  const puanHarita = new Map(dugumler.map((d, i) => [d, puan[i]]));

  // Yan yana gecen yuksek puanli sozcukleri obekle (en fazla 3 sozcuk)
  const esik = [...puanHarita.values()].sort((a, b) => b - a)[Math.min(dugumler.length - 1, Math.floor(dugumler.length / 3))] || 0;
  const obekler = new Map();

  let gecerliObek = [];
  for (let i = 0; i < govdeler.length; i++) {
    const g = govdeler[i];
    if ((puanHarita.get(g) || 0) >= esik && gecerliObek.length < 3) {
      gecerliObek.push({ govde: g, yuzey: belirtec[i] });
    } else {
      if (gecerliObek.length) {
        const anahtar = gecerliObek.map((o) => o.govde).join(' ');
        const gosterim = gecerliObek.map((o) => o.yuzey).join(' ');
        const toplam = gecerliObek.reduce((a, o) => a + (puanHarita.get(o.govde) || 0), 0);
        const mevcut = obekler.get(anahtar);
        if (mevcut) mevcut.sayi++;
        else obekler.set(anahtar, { obek: gosterim, puan: toplam, sayi: 1 });
      }
      gecerliObek = [];
    }
  }
  if (gecerliObek.length) {
    const anahtar = gecerliObek.map((o) => o.govde).join(' ');
    if (!obekler.has(anahtar)) {
      obekler.set(anahtar, {
        obek: gecerliObek.map((o) => o.yuzey).join(' '),
        puan: gecerliObek.reduce((a, o) => a + (puanHarita.get(o.govde) || 0), 0),
        sayi: 1,
      });
    }
  }

  return [...obekler.values()]
    .map((o) => ({ obek: o.obek, puan: o.puan * (1 + Math.log(o.sayi)) }))
    .sort((a, b) => b.puan - a.puan)
    .slice(0, adet);
}

// --------------------------------------------------------------- KUMELEME

/** Seyrek vektorlerin agirlikli ortalamasi (kume merkezi). */
function merkezHesapla(vektorler) {
  const toplam = new Map();
  for (const v of vektorler) {
    for (const [t, a] of v) toplam.set(t, (toplam.get(t) || 0) + a);
  }
  let kare = 0;
  for (const [, a] of toplam) kare += a * a;
  const norm = Math.sqrt(kare) || 1;
  for (const [t, a] of toplam) toplam.set(t, a / norm);
  return toplam;
}

/**
 * k-ortalama kumeleme (kosinus uzakligi, k-means++ tohumlama).
 * @returns {{kumeler:Array<{merkez:Map, uyeler:number[], baslik:string[]}>, atama:number[], k:number}}
 */
function kumele(vektorler, { k = 0, maxTur = 25, tohum = 12345, tekrar = 5 } = {}) {
  const n = vektorler.length;
  if (n === 0) return { kumeler: [], atama: [], k: 0 };
  if (n <= 2) {
    return {
      kumeler: [{ merkez: merkezHesapla(vektorler), uyeler: vektorler.map((_, i) => i), baslik: [] }],
      atama: new Array(n).fill(0), k: 1,
    };
  }

  // Farkli tohumlarla birkac kez dene, en tutarli (en yuksek ic benzerlik)
  // sonucu dondur. k-ortalama yerel en iyilere takilabildigi icin gereklidir.
  if (tekrar > 1) {
    let enIyi = null;
    let enIyiPuan = -Infinity;
    for (let d = 0; d < tekrar; d++) {
      const aday = kumele(vektorler, { k, maxTur, tohum: tohum + d * 7919, tekrar: 1 });
      let puan = 0;
      for (const c of aday.kumeler) {
        for (const u of c.uyeler) puan += kosinus(vektorler[u], c.merkez);
      }
      puan /= n;
      if (puan > enIyiPuan) { enIyiPuan = puan; enIyi = aday; }
    }
    return { ...enIyi, tutarlilik: Math.round(enIyiPuan * 1000) / 1000 };
  }

  const kume = k > 0 ? Math.min(k, n) : Math.max(2, Math.min(8, Math.round(Math.sqrt(n / 2))));

  // Tekrarlanabilir rastgelelik
  let durum = tohum;
  const rast = () => { durum = (durum * 1103515245 + 12345) & 0x7fffffff; return durum / 0x7fffffff; };

  // k-means++ tohumlama
  const merkezler = [vektorler[Math.floor(rast() * n)]];
  while (merkezler.length < kume) {
    const uzakliklar = vektorler.map((v) => {
      let enYakin = 0;
      for (const m of merkezler) enYakin = Math.max(enYakin, kosinus(v, m));
      return (1 - enYakin) ** 2;
    });
    const toplam = uzakliklar.reduce((a, c) => a + c, 0) || 1;
    let hedef = rast() * toplam;
    let secim = 0;
    for (let i = 0; i < n; i++) {
      hedef -= uzakliklar[i];
      if (hedef <= 0) { secim = i; break; }
    }
    merkezler.push(vektorler[secim]);
  }

  let atama = new Array(n).fill(0);
  for (let tur = 0; tur < maxTur; tur++) {
    let degisim = 0;
    for (let i = 0; i < n; i++) {
      let enIyi = 0;
      let enIyiBenzer = -1;
      for (let c = 0; c < merkezler.length; c++) {
        const benzer = kosinus(vektorler[i], merkezler[c]);
        if (benzer > enIyiBenzer) { enIyiBenzer = benzer; enIyi = c; }
      }
      if (atama[i] !== enIyi) { atama[i] = enIyi; degisim++; }
    }
    for (let c = 0; c < merkezler.length; c++) {
      const uyeler = vektorler.filter((_, i) => atama[i] === c);
      if (uyeler.length) merkezler[c] = merkezHesapla(uyeler);
    }
    if (degisim === 0) break;
  }

  const kumeler = merkezler.map((merkez, c) => {
    const uyeler = [];
    for (let i = 0; i < n; i++) if (atama[i] === c) uyeler.push(i);
    const baslik = [...merkez.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
    return { merkez, uyeler, baslik };
  }).filter((c) => c.uyeler.length > 0);

  return { kumeler, atama, k: kumeler.length };
}

// ----------------------------------------------------------- OKUNABILIRLIK

/** Turkce hece sayisi (unlu sayisi). */
function heceSayisi(kelime) {
  const m = String(kelime).match(/[aeıioöuüAEIİOÖUÜ]/g);
  return m ? m.length : 1;
}

/**
 * Atesman Turkce okunabilirlik puani (0-100; yuksek = kolay).
 * puan = 198.825 - 40.175*(hece/kelime) - 2.610*(kelime/cumle)
 */
function okunabilirlik(metin) {
  const cumle = dil.cumleler(metin);
  const kelimeler = String(metin || '').match(/\S+/g) || [];
  if (!cumle.length || !kelimeler.length) return null;

  const hece = kelimeler.reduce((a, k) => a + heceSayisi(k), 0);
  const puan = 198.825 - 40.175 * (hece / kelimeler.length) - 2.610 * (kelimeler.length / cumle.length);
  const sinirli = Math.max(0, Math.min(100, puan));

  const seviye = sinirli >= 90 ? 'cok kolay' : sinirli >= 70 ? 'kolay'
    : sinirli >= 50 ? 'orta' : sinirli >= 30 ? 'zor' : 'cok zor';

  return {
    puan: Math.round(sinirli * 10) / 10,
    seviye,
    cumleSayisi: cumle.length,
    kelimeSayisi: kelimeler.length,
    ortCumleUzunlugu: Math.round((kelimeler.length / cumle.length) * 10) / 10,
  };
}

module.exports = {
  idfHesapla, tfIdf, kosinus, kosinusHam, bm25, pageRank,
  ozetle, mmr, anahtarKelimeler, kumele, merkezHesapla, okunabilirlik,
};
