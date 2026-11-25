'use strict';
/**
 * src/zeka/graf.js
 * BAGLANTI ANALIZI — bagimliliksiz graf algoritmalari.
 *
 * Istihbarat arsivinin "kim kimle baglantili" sorusunu yanitlayan katman.
 *
 *  kur()                 : dugum/kenar listesinden graf kurar
 *  cevre()               : n adim uzakliktaki komsuluk (ego agi)
 *  enKisaYol()           : Dijkstra (kenar agirligi = 1 / iliski gucu)
 *  yollar()              : iki dugum arasindaki en fazla k yol
 *  merkeziyet()          : derece, agirlikli derece, yakinlik, aradalik, PageRank
 *  topluluklar()         : etiket yayilimi ile kume bulma
 *  kesimNoktalari()      : grafi parcalayan kritik dugumler (Tarjan)
 *  kopruler()            : kaldirilinca agi bolen kenarlar
 *  baglantiTahmini()     : Adamic-Adar ile "henuz bilinmeyen" iliski onerisi
 *  ucgenler()            : kapali ucgenler (guclu klikler)
 *  bilesenler()          : bagli bilesenler
 */

// ------------------------------------------------------------------- KURMA

/**
 * @param {Array<{id:(number|string)}>} dugumler
 * @param {Array<{kaynak:any, hedef:any, guc?:number, tur?:string, yon?:string}>} kenarlar
 */
function kur(dugumler, kenarlar) {
  const dizin = new Map();
  const liste = [];

  for (const d of dugumler) {
    if (dizin.has(d.id)) continue;
    dizin.set(d.id, liste.length);
    liste.push({ ...d, komsu: [] });
  }

  const temizKenarlar = [];
  for (const k of kenarlar) {
    const a = dizin.get(k.kaynak);
    const b = dizin.get(k.hedef);
    if (a === undefined || b === undefined || a === b) continue;

    const guc = Math.max(1, Math.min(100, Number(k.guc) || 50));
    const kenar = { a, b, guc, tur: k.tur || 'diger', yon: k.yon || 'cift', ham: k };
    temizKenarlar.push(kenar);

    liste[a].komsu.push({ hedef: b, guc, kenar: temizKenarlar.length - 1, ileri: true });
    liste[b].komsu.push({ hedef: a, guc, kenar: temizKenarlar.length - 1, ileri: k.yon !== 'tek' });
  }

  return { dugumler: liste, kenarlar: temizKenarlar, dizin, n: liste.length };
}

function kimlik(graf, dizin) {
  return graf.dugumler[dizin] ? graf.dugumler[dizin].id : null;
}

// ------------------------------------------------------------------- CEVRE

/**
 * Bir dugumun n adimlik cevresini (ego agi) dondurur.
 * @returns {{dugumler:Array, kenarlar:Array, uzaklik:Map}}
 */
function cevre(graf, baslangicId, derinlik = 1, { maxDugum = 300 } = {}) {
  const bas = graf.dizin.get(baslangicId);
  if (bas === undefined) return { dugumler: [], kenarlar: [], uzaklik: new Map() };

  const uzaklik = new Map([[bas, 0]]);
  const kuyruk = [bas];
  const kenarKumesi = new Set();

  while (kuyruk.length && uzaklik.size < maxDugum) {
    const simdi = kuyruk.shift();
    const d = uzaklik.get(simdi);
    if (d >= derinlik) continue;

    for (const komsu of graf.dugumler[simdi].komsu) {
      kenarKumesi.add(komsu.kenar);
      if (!uzaklik.has(komsu.hedef)) {
        uzaklik.set(komsu.hedef, d + 1);
        kuyruk.push(komsu.hedef);
      }
    }
  }

  const dugumler = [...uzaklik.keys()].map((i) => ({ ...graf.dugumler[i], adim: uzaklik.get(i) }));
  const kenarlar = [...kenarKumesi]
    .map((i) => graf.kenarlar[i])
    .filter((k) => uzaklik.has(k.a) && uzaklik.has(k.b))
    .map((k) => ({ ...k, kaynakId: kimlik(graf, k.a), hedefId: kimlik(graf, k.b) }));

  return { dugumler, kenarlar, uzaklik };
}

// --------------------------------------------------------------- EN KISA YOL

/**
 * Dijkstra ile en kisa yol. Kenar maliyeti = 1 / (gucun normalize hali):
 * guclu iliskiler "kisa" sayilir, boylece yol gercekci olur.
 */
function enKisaYol(graf, kaynakId, hedefId) {
  const bas = graf.dizin.get(kaynakId);
  const son = graf.dizin.get(hedefId);
  if (bas === undefined || son === undefined) return null;
  if (bas === son) return { yol: [kimlik(graf, bas)], maliyet: 0, adim: 0, kenarlar: [] };

  const sonsuz = Infinity;
  const maliyet = new Array(graf.n).fill(sonsuz);
  const onceki = new Array(graf.n).fill(-1);
  const oncekiKenar = new Array(graf.n).fill(-1);
  const bitti = new Array(graf.n).fill(false);
  maliyet[bas] = 0;

  for (let adim = 0; adim < graf.n; adim++) {
    let simdi = -1;
    let enIyi = sonsuz;
    for (let i = 0; i < graf.n; i++) {
      if (!bitti[i] && maliyet[i] < enIyi) { enIyi = maliyet[i]; simdi = i; }
    }
    if (simdi < 0 || simdi === son) break;
    bitti[simdi] = true;

    for (const komsu of graf.dugumler[simdi].komsu) {
      if (!komsu.ileri) continue;
      const kenarMaliyeti = 1 / (komsu.guc / 100);
      const yeni = maliyet[simdi] + kenarMaliyeti;
      if (yeni < maliyet[komsu.hedef]) {
        maliyet[komsu.hedef] = yeni;
        onceki[komsu.hedef] = simdi;
        oncekiKenar[komsu.hedef] = komsu.kenar;
      }
    }
  }

  if (maliyet[son] === sonsuz) return null;

  const yol = [];
  const kenarlar = [];
  let simdi = son;
  while (simdi !== -1) {
    yol.unshift(kimlik(graf, simdi));
    if (oncekiKenar[simdi] >= 0) {
      const k = graf.kenarlar[oncekiKenar[simdi]];
      kenarlar.unshift({ ...k, kaynakId: kimlik(graf, k.a), hedefId: kimlik(graf, k.b) });
    }
    simdi = onceki[simdi];
  }

  return {
    yol,
    kenarlar,
    maliyet: Math.round(maliyet[son] * 1000) / 1000,
    adim: yol.length - 1,
  };
}

/**
 * Iki dugum arasindaki en fazla k farkli yolu bulur (derinlik sinirli DFS).
 */
function yollar(graf, kaynakId, hedefId, { maxYol = 5, maxDerinlik = 5 } = {}) {
  const bas = graf.dizin.get(kaynakId);
  const son = graf.dizin.get(hedefId);
  if (bas === undefined || son === undefined) return [];

  const sonuc = [];
  const yol = [bas];
  const ziyaret = new Set([bas]);

  function gez(simdi, derinlik) {
    if (sonuc.length >= maxYol || derinlik > maxDerinlik) return;
    if (simdi === son) {
      let guc = 0;
      for (let i = 0; i + 1 < yol.length; i++) {
        const kenar = graf.dugumler[yol[i]].komsu.find((c) => c.hedef === yol[i + 1]);
        guc += kenar ? kenar.guc : 0;
      }
      sonuc.push({
        yol: yol.map((i) => kimlik(graf, i)),
        adim: yol.length - 1,
        ortalamaGuc: Math.round(guc / Math.max(1, yol.length - 1)),
      });
      return;
    }
    const komsular = [...graf.dugumler[simdi].komsu].sort((a, b) => b.guc - a.guc);
    for (const komsu of komsular) {
      if (!komsu.ileri || ziyaret.has(komsu.hedef)) continue;
      ziyaret.add(komsu.hedef);
      yol.push(komsu.hedef);
      gez(komsu.hedef, derinlik + 1);
      yol.pop();
      ziyaret.delete(komsu.hedef);
    }
  }

  gez(bas, 0);
  return sonuc.sort((a, b) => a.adim - b.adim || b.ortalamaGuc - a.ortalamaGuc);
}

// --------------------------------------------------------------- MERKEZIYET

/** Brandes algoritmasi ile aradalik (betweenness) merkeziyeti. */
function aradalik(graf) {
  const n = graf.n;
  const puan = new Array(n).fill(0);

  for (let s = 0; s < n; s++) {
    const yigin = [];
    const onceki = Array.from({ length: n }, () => []);
    const sayi = new Array(n).fill(0);
    const uzaklik = new Array(n).fill(-1);
    sayi[s] = 1;
    uzaklik[s] = 0;

    const kuyruk = [s];
    while (kuyruk.length) {
      const v = kuyruk.shift();
      yigin.push(v);
      for (const komsu of graf.dugumler[v].komsu) {
        const w = komsu.hedef;
        if (uzaklik[w] < 0) { uzaklik[w] = uzaklik[v] + 1; kuyruk.push(w); }
        if (uzaklik[w] === uzaklik[v] + 1) { sayi[w] += sayi[v]; onceki[w].push(v); }
      }
    }

    const birikim = new Array(n).fill(0);
    while (yigin.length) {
      const w = yigin.pop();
      for (const v of onceki[w]) {
        birikim[v] += (sayi[v] / sayi[w]) * (1 + birikim[w]);
      }
      if (w !== s) puan[w] += birikim[w];
    }
  }

  const bolen = n > 2 ? (n - 1) * (n - 2) : 1;
  return puan.map((p) => p / bolen);
}

/** Yakinlik (closeness) merkeziyeti. */
function yakinlik(graf) {
  const n = graf.n;
  const sonuc = new Array(n).fill(0);

  for (let s = 0; s < n; s++) {
    const uzaklik = new Array(n).fill(-1);
    uzaklik[s] = 0;
    const kuyruk = [s];
    let toplam = 0;
    let ulasilan = 0;

    while (kuyruk.length) {
      const v = kuyruk.shift();
      for (const komsu of graf.dugumler[v].komsu) {
        if (uzaklik[komsu.hedef] >= 0) continue;
        uzaklik[komsu.hedef] = uzaklik[v] + 1;
        toplam += uzaklik[komsu.hedef];
        ulasilan++;
        kuyruk.push(komsu.hedef);
      }
    }

    sonuc[s] = toplam > 0 ? (ulasilan / toplam) * (ulasilan / Math.max(1, n - 1)) : 0;
  }

  return sonuc;
}

/** Agirlikli PageRank. */
function pageRank(graf, { sonumleme = 0.85, tur = 50 } = {}) {
  const n = graf.n;
  if (n === 0) return [];
  let puan = new Array(n).fill(1 / n);
  const agirlikToplam = graf.dugumler.map((d) => d.komsu.reduce((a, c) => a + c.guc, 0) || 1);

  for (let t = 0; t < tur; t++) {
    const yeni = new Array(n).fill((1 - sonumleme) / n);
    for (let v = 0; v < n; v++) {
      if (graf.dugumler[v].komsu.length === 0) {
        for (let i = 0; i < n; i++) yeni[i] += sonumleme * puan[v] / n;
        continue;
      }
      for (const komsu of graf.dugumler[v].komsu) {
        yeni[komsu.hedef] += sonumleme * puan[v] * (komsu.guc / agirlikToplam[v]);
      }
    }
    let fark = 0;
    for (let i = 0; i < n; i++) fark += Math.abs(yeni[i] - puan[i]);
    puan = yeni;
    if (fark < 1e-7) break;
  }

  return puan;
}

/** Yerel kumelenme katsayisi (komsularin birbirine bagliligi). */
function kumelenmeKatsayisi(graf) {
  return graf.dugumler.map((d, i) => {
    const komsular = [...new Set(d.komsu.map((c) => c.hedef))].filter((x) => x !== i);
    const k = komsular.length;
    if (k < 2) return 0;
    let baglanti = 0;
    for (let a = 0; a < k; a++) {
      for (let b = a + 1; b < k; b++) {
        if (graf.dugumler[komsular[a]].komsu.some((c) => c.hedef === komsular[b])) baglanti++;
      }
    }
    return (2 * baglanti) / (k * (k - 1));
  });
}

/**
 * Tum merkeziyet olcutlerini tek seferde hesaplar ve birlesik bir
 * "etki puani" uretir (0-100).
 */
function merkeziyet(graf) {
  const n = graf.n;
  if (n === 0) return [];

  const derece = graf.dugumler.map((d) => new Set(d.komsu.map((c) => c.hedef)).size);
  const agirlikli = graf.dugumler.map((d) => d.komsu.reduce((a, c) => a + c.guc, 0));
  const ara = n <= 1200 ? aradalik(graf) : new Array(n).fill(0);
  const yakin = n <= 1200 ? yakinlik(graf) : new Array(n).fill(0);
  const pr = pageRank(graf);
  const kume = kumelenmeKatsayisi(graf);

  const enb = (dizi) => Math.max(...dizi, 1e-9);
  const dMax = enb(derece);
  const aMax = enb(ara);
  const yMax = enb(yakin);
  const pMax = enb(pr);
  const agMax = enb(agirlikli);

  return graf.dugumler.map((d, i) => {
    const etki = (
      0.30 * (derece[i] / dMax) +
      0.25 * (pr[i] / pMax) +
      0.25 * (ara[i] / aMax) +
      0.10 * (yakin[i] / yMax) +
      0.10 * (agirlikli[i] / agMax)
    ) * 100;

    return {
      id: d.id,
      ad: d.ad,
      tur: d.tur,
      derece: derece[i],
      agirlikliDerece: agirlikli[i],
      aradalik: Math.round(ara[i] * 10000) / 10000,
      yakinlik: Math.round(yakin[i] * 10000) / 10000,
      pageRank: Math.round(pr[i] * 100000) / 100000,
      kumelenme: Math.round(kume[i] * 1000) / 1000,
      etki: Math.round(etki * 10) / 10,
    };
  }).sort((a, b) => b.etki - a.etki);
}

// -------------------------------------------------------------- TOPLULUKLAR

/**
 * Etiket yayilimi (label propagation) ile topluluk bulma.
 * Hizlidir, parametre gerektirmez ve yonsuz agirlikli graflarda iyi calisir.
 */
function topluluklar(graf, { maxTur = 30, tohum = 7 } = {}) {
  const n = graf.n;
  if (n === 0) return { etiketler: [], gruplar: [] };

  const etiket = graf.dugumler.map((_, i) => i);
  let durum = tohum;
  const rast = () => { durum = (durum * 1103515245 + 12345) & 0x7fffffff; return durum / 0x7fffffff; };

  const sira = graf.dugumler.map((_, i) => i);

  for (let t = 0; t < maxTur; t++) {
    // Rastgele sira (Fisher-Yates)
    for (let i = sira.length - 1; i > 0; i--) {
      const j = Math.floor(rast() * (i + 1));
      [sira[i], sira[j]] = [sira[j], sira[i]];
    }

    let degisim = 0;
    for (const v of sira) {
      const sayac = new Map();
      for (const komsu of graf.dugumler[v].komsu) {
        const e = etiket[komsu.hedef];
        sayac.set(e, (sayac.get(e) || 0) + komsu.guc);
      }
      if (sayac.size === 0) continue;

      let enIyi = etiket[v];
      let enIyiAgirlik = -1;
      for (const [e, a] of sayac) {
        if (a > enIyiAgirlik || (a === enIyiAgirlik && e < enIyi)) { enIyiAgirlik = a; enIyi = e; }
      }
      if (enIyi !== etiket[v]) { etiket[v] = enIyi; degisim++; }
    }
    if (degisim === 0) break;
  }

  const gruplar = new Map();
  for (let i = 0; i < n; i++) {
    if (!gruplar.has(etiket[i])) gruplar.set(etiket[i], []);
    gruplar.get(etiket[i]).push(graf.dugumler[i].id);
  }

  const liste = [...gruplar.values()]
    .map((uyeler, i) => ({ no: i + 1, uyeler, boyut: uyeler.length }))
    .sort((a, b) => b.boyut - a.boyut)
    .map((g, i) => ({ ...g, no: i + 1 }));

  return { etiketler: etiket, gruplar: liste };
}

/** Bagli bilesenler. */
function bilesenler(graf) {
  const gorulen = new Array(graf.n).fill(false);
  const sonuc = [];

  for (let s = 0; s < graf.n; s++) {
    if (gorulen[s]) continue;
    const uyeler = [];
    const kuyruk = [s];
    gorulen[s] = true;
    while (kuyruk.length) {
      const v = kuyruk.shift();
      uyeler.push(graf.dugumler[v].id);
      for (const komsu of graf.dugumler[v].komsu) {
        if (gorulen[komsu.hedef]) continue;
        gorulen[komsu.hedef] = true;
        kuyruk.push(komsu.hedef);
      }
    }
    sonuc.push(uyeler);
  }

  return sonuc.sort((a, b) => b.length - a.length);
}

// ------------------------------------------------------- KRITIK NOKTALAR

/**
 * Kesim noktalari (articulation points) ve kopru kenarlar (bridges):
 * kaldirildiginda agi parcalayan kritik dugum/baglantilar. Istihbarat
 * dilinde "sebekenin dugum noktasi" budur.
 */
function kritikNoktalar(graf) {
  const n = graf.n;
  const gorulen = new Array(n).fill(false);
  const kesif = new Array(n).fill(0);
  const enAz = new Array(n).fill(0);
  const ebeveyn = new Array(n).fill(-1);
  const kesimNoktasi = new Array(n).fill(false);
  const kopruler = [];
  let zaman = 0;

  function dfs(kok) {
    const yigin = [{ v: kok, komsuDizin: 0 }];
    gorulen[kok] = true;
    kesif[kok] = enAz[kok] = ++zaman;
    let kokCocuk = 0;

    while (yigin.length) {
      const ust = yigin[yigin.length - 1];
      const v = ust.v;
      const komsular = graf.dugumler[v].komsu;

      if (ust.komsuDizin < komsular.length) {
        const komsu = komsular[ust.komsuDizin++];
        const w = komsu.hedef;
        if (!gorulen[w]) {
          gorulen[w] = true;
          ebeveyn[w] = v;
          kesif[w] = enAz[w] = ++zaman;
          if (v === kok) kokCocuk++;
          yigin.push({ v: w, komsuDizin: 0 });
        } else if (w !== ebeveyn[v]) {
          enAz[v] = Math.min(enAz[v], kesif[w]);
        }
      } else {
        yigin.pop();
        const ebe = ebeveyn[v];
        if (ebe >= 0) {
          enAz[ebe] = Math.min(enAz[ebe], enAz[v]);
          if (enAz[v] > kesif[ebe]) {
            kopruler.push({ a: graf.dugumler[ebe].id, b: graf.dugumler[v].id });
          }
          if (ebe !== kok && enAz[v] >= kesif[ebe]) kesimNoktasi[ebe] = true;
        }
      }
    }

    if (kokCocuk > 1) kesimNoktasi[kok] = true;
  }

  for (let i = 0; i < n; i++) if (!gorulen[i]) dfs(i);

  return {
    kesimNoktalari: graf.dugumler.filter((_, i) => kesimNoktasi[i]).map((d) => ({ id: d.id, ad: d.ad, tur: d.tur })),
    kopruler,
  };
}

/** Kapali ucgenler (uc dugumun birbirine bagli oldugu gruplar). */
function ucgenler(graf, { maxSonuc = 200 } = {}) {
  const sonuc = [];
  const komsuKume = graf.dugumler.map((d) => new Set(d.komsu.map((c) => c.hedef)));

  for (let a = 0; a < graf.n && sonuc.length < maxSonuc; a++) {
    for (const b of komsuKume[a]) {
      if (b <= a) continue;
      for (const c of komsuKume[b]) {
        if (c <= b) continue;
        if (komsuKume[a].has(c)) {
          sonuc.push([graf.dugumler[a].id, graf.dugumler[b].id, graf.dugumler[c].id]);
          if (sonuc.length >= maxSonuc) break;
        }
      }
    }
  }

  return sonuc;
}

// ------------------------------------------------------- BAGLANTI TAHMINI

/**
 * Adamic-Adar ve ortak komsu sayisiyla "muhtemelen var ama kayitli degil"
 * iliskileri oneriler. Istihbarat analizinde bos birakilan halkalari
 * isaret etmek icin kullanilir.
 *
 * @returns {Array<{a:any, b:any, adA:string, adB:string, ortak:number, puan:number}>}
 */
function baglantiTahmini(graf, { adet = 20, enAzOrtak = 2 } = {}) {
  const komsuKume = graf.dugumler.map((d) => new Set(d.komsu.map((c) => c.hedef)));
  const oneriler = [];

  for (let a = 0; a < graf.n; a++) {
    for (let b = a + 1; b < graf.n; b++) {
      if (komsuKume[a].has(b)) continue;

      let ortak = 0;
      let adamic = 0;
      for (const o of komsuKume[a]) {
        if (!komsuKume[b].has(o)) continue;
        ortak++;
        const derece = komsuKume[o].size;
        if (derece > 1) adamic += 1 / Math.log(derece);
      }
      if (ortak < enAzOrtak) continue;

      oneriler.push({
        a: graf.dugumler[a].id,
        b: graf.dugumler[b].id,
        adA: graf.dugumler[a].ad,
        adB: graf.dugumler[b].ad,
        turA: graf.dugumler[a].tur,
        turB: graf.dugumler[b].tur,
        ortak,
        ortakAdlar: [...komsuKume[a]].filter((o) => komsuKume[b].has(o))
          .slice(0, 5).map((o) => graf.dugumler[o].ad),
        puan: Math.round(adamic * 1000) / 1000,
      });
    }
  }

  return oneriler.sort((a, b) => b.puan - a.puan || b.ortak - a.ortak).slice(0, adet);
}

/** Graf hakkinda genel ozet. */
function ozet(graf) {
  const dereceler = graf.dugumler.map((d) => new Set(d.komsu.map((c) => c.hedef)).size);
  const toplamDerece = dereceler.reduce((a, c) => a + c, 0);
  const bilesen = bilesenler(graf);
  const kume = kumelenmeKatsayisi(graf);

  return {
    dugumSayisi: graf.n,
    kenarSayisi: graf.kenarlar.length,
    ortalamaDerece: graf.n ? Math.round((toplamDerece / graf.n) * 100) / 100 : 0,
    enYuksekDerece: Math.max(0, ...dereceler),
    yogunluk: graf.n > 1
      ? Math.round((2 * graf.kenarlar.length / (graf.n * (graf.n - 1))) * 10000) / 10000
      : 0,
    bilesenSayisi: bilesen.length,
    enBuyukBilesen: bilesen.length ? bilesen[0].length : 0,
    yalnizDugum: dereceler.filter((d) => d === 0).length,
    ortalamaKumelenme: graf.n ? Math.round((kume.reduce((a, c) => a + c, 0) / graf.n) * 1000) / 1000 : 0,
  };
}

module.exports = {
  kur, cevre, enKisaYol, yollar, merkeziyet, aradalik, yakinlik, pageRank,
  kumelenmeKatsayisi, topluluklar, bilesenler, kritikNoktalar, ucgenler,
  baglantiTahmini, ozet,
};
