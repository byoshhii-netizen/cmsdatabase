'use strict';
/**
 * src/zeka/siniflandirici.js
 * COKLU TERIM NAIVE BAYES SINIFLANDIRICISI — bagimliliksiz, yerel egitimli.
 *
 * Bu, sistemin "ogrenen" parcasidir: arsivdeki etiketli kayitlardan (tur,
 * tasnif, vaka, tema) ogrenir ve yeni bir kayit/belge geldiginde onu
 * siniflandirir. Egitim tamamen bu makinede yapilir, hicbir dis servise
 * veri gitmez. Model JSON olarak zeka_modelleri tablosunda saklanir.
 *
 * Ozellikler:
 *   - Laplace (add-alpha) duzeltmesi
 *   - Log-uzayinda toplama (tasma yok)
 *   - Terim basina ayirt edicilik puani -> KARAR GEREKCESI uretilebilir
 *   - k-katmanli capraz dogrulama ile basari olcumu
 */

const dil = require('./dil');

const ALFA = 0.35;          // Laplace duzeltme katsayisi
const MAX_DAGARCIK = 40_000;

/**
 * Modeli egitir.
 * @param {Array<{metin:string, etiket:string}>} ornekler
 * @returns {object} serilestirilmeye hazir model
 */
function egit(ornekler) {
  const siniflar = new Map();
  const dagarcik = new Map();

  for (const ornek of ornekler) {
    const etiket = String(ornek.etiket || '').trim();
    if (!etiket) continue;
    const terimler = dil.anahtarlar(ornek.metin || '');
    if (terimler.length === 0) continue;

    if (!siniflar.has(etiket)) {
      siniflar.set(etiket, { belge: 0, toplamTerim: 0, sayac: new Map() });
    }
    const sinif = siniflar.get(etiket);
    sinif.belge++;

    for (const t of terimler) {
      sinif.sayac.set(t, (sinif.sayac.get(t) || 0) + 1);
      sinif.toplamTerim++;
      dagarcik.set(t, (dagarcik.get(t) || 0) + 1);
    }
  }

  if (siniflar.size < 2) {
    return { hazir: false, sebep: 'Egitim icin en az iki farkli etiket gerekli.', sinifSayisi: siniflar.size };
  }

  // Cok seyrek terimleri at (gurultu) ve dagarcigi sinirla.
  // Kucuk derlemlerde budama yapilmaz: 12 ornekli bir egitimde "en az iki
  // kez gecen terim" kuralı dagarcigi neredeyse tamamen bosaltir.
  const enAzGecis = ornekler.length >= 60 ? 2 : 1;
  const secilenTerimler = [...dagarcik.entries()]
    .filter(([, n]) => n >= enAzGecis)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DAGARCIK)
    .map(([t]) => t);
  const secilen = new Set(secilenTerimler);

  const toplamBelge = [...siniflar.values()].reduce((a, c) => a + c.belge, 0);
  const cikti = { hazir: true, dagarcik: secilenTerimler, toplamBelge, alfa: ALFA, siniflar: {} };

  for (const [etiket, sinif] of siniflar) {
    const sayac = {};
    let toplam = 0;
    for (const [t, n] of sinif.sayac) {
      if (!secilen.has(t)) continue;
      sayac[t] = n;
      toplam += n;
    }
    cikti.siniflar[etiket] = {
      belge: sinif.belge,
      onOlasilik: Math.log(sinif.belge / toplamBelge),
      toplamTerim: toplam,
      sayac,
    };
  }

  return cikti;
}

/**
 * Metni siniflandirir.
 * @returns {{etiket:string|null, guven:number, siralama:Array, gerekce:Array}}
 */
function tahmin(model, metin, { gerekceAdet = 6 } = {}) {
  if (!model || !model.hazir) return { etiket: null, guven: 0, siralama: [], gerekce: [] };

  const terimler = dil.anahtarlar(metin || '');
  if (terimler.length === 0) return { etiket: null, guven: 0, siralama: [], gerekce: [] };

  const dagarcikBoyu = model.dagarcik.length || 1;
  const alfa = model.alfa || ALFA;

  // Dagarcikta OLMAYAN terimler puanlamaya katilmaz. Katilsalardi, her
  // sinifta ayni sekilde "gorulmemis" olmalarina ragmen bolen (sinifin
  // toplam terim sayisi) farkli oldugu icin kucuk sinifa haksiz avantaj
  // verirlerdi; bu da az kelimeli bir sinifin her seyi kapmasina yol acar.
  const dagarcikKumesi = model._kume || new Set(model.dagarcik);
  if (!model._kume) {
    Object.defineProperty(model, '_kume', { value: dagarcikKumesi, enumerable: false, configurable: true });
  }

  const sayac = new Map();
  for (const t of terimler) {
    if (!dagarcikKumesi.has(t)) continue;
    sayac.set(t, (sayac.get(t) || 0) + 1);
  }
  if (sayac.size === 0) {
    return { etiket: null, guven: 0, siralama: [], gerekce: [], sebep: 'Metindeki terimler modelin dagarciginda yok.' };
  }

  const puanlar = [];
  const katkilar = new Map();

  for (const [etiket, sinif] of Object.entries(model.siniflar)) {
    let puan = sinif.onOlasilik;
    const bolen = sinif.toplamTerim + alfa * dagarcikBoyu;

    for (const [t, f] of sayac) {
      const n = sinif.sayac[t] || 0;
      const olasilik = Math.log((n + alfa) / bolen);
      puan += f * olasilik;
      if (!katkilar.has(t)) katkilar.set(t, {});
      katkilar.get(t)[etiket] = olasilik;
    }
    puanlar.push({ etiket, puan });
  }

  puanlar.sort((a, b) => b.puan - a.puan);

  // Log puanlari olasiliga cevir (log-sum-exp)
  const enYuksek = puanlar[0].puan;
  const expler = puanlar.map((p) => Math.exp(p.puan - enYuksek));
  const toplam = expler.reduce((a, c) => a + c, 0) || 1;
  const siralama = puanlar.map((p, i) => ({
    etiket: p.etiket,
    olasilik: Math.round((expler[i] / toplam) * 1000) / 1000,
  }));

  // Gerekce: kazanan sinifi, ikinciye kiyasla en cok destekleyen terimler
  const kazanan = puanlar[0].etiket;
  const ikinci = puanlar[1] ? puanlar[1].etiket : null;
  const gerekce = [];
  if (ikinci) {
    for (const [t, oran] of katkilar) {
      const fark = (oran[kazanan] || 0) - (oran[ikinci] || 0);
      if (fark > 0) gerekce.push({ terim: t, agirlik: Math.round(fark * 1000) / 1000, gecis: sayac.get(t) });
    }
    gerekce.sort((a, b) => b.agirlik - a.agirlik);
  }

  return {
    etiket: kazanan,
    guven: siralama[0].olasilik,
    siralama: siralama.slice(0, 6),
    gerekce: gerekce.slice(0, gerekceAdet),
  };
}

/**
 * k-katmanli capraz dogrulama ile basari olcer.
 * @returns {{basari:number, kat:number, karmasikliMatris:object, ornek:number}}
 */
function caprazDogrula(ornekler, { kat = 5 } = {}) {
  const gecerli = ornekler.filter((o) => o.etiket && String(o.metin || '').trim());
  if (gecerli.length < kat * 2) {
    return { basari: null, kat, ornek: gecerli.length, sebep: 'Yeterli ornek yok.' };
  }

  // Tekrarlanabilir karistirma
  let durum = 20240316;
  const rast = () => { durum = (durum * 1103515245 + 12345) & 0x7fffffff; return durum / 0x7fffffff; };
  const karisik = [...gecerli];
  for (let i = karisik.length - 1; i > 0; i--) {
    const j = Math.floor(rast() * (i + 1));
    [karisik[i], karisik[j]] = [karisik[j], karisik[i]];
  }

  let dogru = 0;
  let toplam = 0;
  const matris = {};

  for (let k = 0; k < kat; k++) {
    const test = karisik.filter((_, i) => i % kat === k);
    const egitim = karisik.filter((_, i) => i % kat !== k);
    const model = egit(egitim);
    if (!model.hazir) continue;

    for (const o of test) {
      const t = tahmin(model, o.metin);
      toplam++;
      if (t.etiket === o.etiket) dogru++;
      const anahtar = `${o.etiket}>${t.etiket || '?'}`;
      matris[anahtar] = (matris[anahtar] || 0) + 1;
    }
  }

  return {
    basari: toplam ? Math.round((dogru / toplam) * 1000) / 10 : null,
    kat,
    ornek: toplam,
    dogru,
    karmasiklikMatrisi: matris,
  };
}

/**
 * Bir sinifi en guclu ayirt eden terimleri dondurur (log-oran).
 * Modelin NEYI ogrendigini gostermek icin kullanilir.
 */
function ayirtEdiciler(model, etiket, { adet = 15 } = {}) {
  if (!model || !model.hazir || !model.siniflar[etiket]) return [];

  const hedef = model.siniflar[etiket];
  const alfa = model.alfa || ALFA;
  const dagarcikBoyu = model.dagarcik.length || 1;
  const hedefBolen = hedef.toplamTerim + alfa * dagarcikBoyu;

  const digerSayac = {};
  let digerToplam = 0;
  for (const [e, s] of Object.entries(model.siniflar)) {
    if (e === etiket) continue;
    for (const [t, n] of Object.entries(s.sayac)) digerSayac[t] = (digerSayac[t] || 0) + n;
    digerToplam += s.toplamTerim;
  }
  const digerBolen = digerToplam + alfa * dagarcikBoyu;

  const sonuc = [];
  for (const [t, n] of Object.entries(hedef.sayac)) {
    if (n < 2) continue;
    const pHedef = (n + alfa) / hedefBolen;
    const pDiger = ((digerSayac[t] || 0) + alfa) / digerBolen;
    sonuc.push({ terim: t, logOran: Math.round(Math.log(pHedef / pDiger) * 1000) / 1000, gecis: n });
  }

  return sonuc.sort((a, b) => b.logOran - a.logOran).slice(0, adet);
}

/** Modelin ozetini verir (arayuzde gostermek icin). */
function modelOzeti(model) {
  if (!model || !model.hazir) return { hazir: false, sebep: model ? model.sebep : 'Model yok' };
  const siniflar = Object.entries(model.siniflar)
    .map(([etiket, s]) => ({ etiket, belge: s.belge, terim: s.toplamTerim }))
    .sort((a, b) => b.belge - a.belge);
  return {
    hazir: true,
    sinifSayisi: siniflar.length,
    dagarcik: model.dagarcik.length,
    toplamBelge: model.toplamBelge,
    siniflar,
  };
}

module.exports = { egit, tahmin, caprazDogrula, ayirtEdiciler, modelOzeti };
