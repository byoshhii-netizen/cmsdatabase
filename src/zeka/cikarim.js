'use strict';
/**
 * src/zeka/cikarim.js
 * CEKIRDEK ZEKA — API'siz, tamamen yerel calisan akil yurutme katmani.
 *
 * NE YAPAR
 *   Operatorun Turkce sorusunu alir, NIYETINI cozer, arsivden KANIT toplar,
 *   topladigi kaniti isler (geri getirme + graf + istatistik + ozetleme) ve
 *   KAYNAK GOSTEREREK cevap yazar.
 *
 * NE YAPMAZ
 *   Bilmedigi seyi uydurmaz. Her cumlesi arsivdeki bir kayda, belgeye ya da
 *   hesaplanmis bir degere dayanir; dayanak yoksa "dayanak yok" der. Bu,
 *   dil modeli taklidi degil; dogrulanabilir bir analiz motorudur.
 *
 * NIYETLER
 *   varlik_dosyesi | baglanti | ag | zaman_cizgisi | anomali | risk | celiski
 *   bosluk | ozet | siniflandir | istatistik | arama | hesap | zaman | kimlik
 */

const db = require('../config/db');
const dil = require('./dil');
const nd = require('./dogalDil');
const dizin = require('./dizin');
const metrik = require('./metrik');
const graf = require('./graf');
const ist = require('./istatistik');
const siniflandirici = require('./siniflandirici');
const varlikCikarim = require('./varlikCikarim');
const hesapMakinesi = require('../utils/hesapMakinesi');

// ------------------------------------------------------------ NIYET COZUMU

const NIYET_DESENLERI = [
  { niyet: 'kimlik', desen: /\b(sen kimsin|nesin|kendini tanit|neler? yapabil\w*|yetenek\w*|nasil calis\w*|ne ise yarar\w*|komut\w* (listesi|neler))\b/, puan: 10 },
  { niyet: 'selam', desen: /^\s*(merhaba|selam|gunaydin|iyi aksamlar|iyi geceler|hey|alo|nasilsin)\b/, puan: 10 },
  { niyet: 'zaman', desen: /\b(saat kac|bugun gunlerden|tarih ne|hangi gundeyiz|bugunun tarihi)\b/, puan: 9 },

  { niyet: 'baglanti', desen: /\b(.+)\s+(?:ile|ve)\s+(.+)\s+(?:arasinda|arasindaki)\b/, puan: 8 },
  { niyet: 'baglanti', desen: /\b(baglanti\w*|iliski\w*|nasil bagli|ortak nokta\w*|kesisim\w*|yol\w* var)\b/, puan: 4 },

  { niyet: 'ag', desen: /\b(ag yapisi|ag analizi|sebeke\w*|merkez(i|deki) aktor\w*|en etkili|kilit (kisi|aktor|dugum)\w*|kopru\w*|kesim nokta\w*|topluluk\w*|kume\w* (bul|cikar|goster)|kim onemli|baglanti analizi)\b/, puan: 7 },

  { niyet: 'zaman_cizgisi', desen: /\b(zaman ciz\w*|kronoloji\w*|son \d+ (gun|hafta|ay|yil)|gecen (hafta|ay|yil)|bu (hafta|ay|yil)|ne oldu|neler oldu|hareketlilik\w*|gelismeler)\b/, puan: 7 },

  { niyet: 'anomali', desen: /\b(anomali\w*|anormal\w*|olagandisi|sira disi|patlama\w*|ani artis\w*|sapma\w*|supheli hareket\w*|benford|aykiri\w*|sessizlik\w*)\b/, puan: 8 },

  { niyet: 'risk', desen: /\b(risk\w*|en onemli|oncelik\w*|tehdit\w*|kritik varlik\w*|izlenmeli|takip edilmeli)\b/, puan: 7 },

  { niyet: 'celiski', desen: /\b(celiski\w*|celisen|tutarsiz\w*|uyusmayan|birbirini tutmayan|cakisma\w*|mukerrer|tekrarli kayit\w*)\b/, puan: 8 },

  { niyet: 'bosluk', desen: /\b(bosluk\w*|eksik\w*|ne bilmiyoruz|neyi kacir\w*|tamamlanmamis|dogrulanmamis|acik uc\w*|yapilacak\w*)\b/, puan: 8 },

  { niyet: 'ozet', desen: /\b(ozetle\w*|ozet (cikar|ver)|ozeti|kisaca|ne diyor|ne anlatiyor|ozetini)\b/, puan: 8 },

  { niyet: 'siniflandir', desen: /\b(siniflandir\w*|hangi kategori\w*|hangi tur\w*|tasnif et|kategorize)\b/, puan: 8 },

  { niyet: 'istatistik', desen: /\b(kac (tane|adet|kayit|varlik|dosya|olay|vaka|kaynak)|toplam kac|dagilim\w*|istatistik\w*|ne kadar var|durum ozeti|genel durum|arsiv durumu|rakam\w*)\b/, puan: 6 },

  { niyet: 'varlik_dosyesi', desen: /\b(kimdir|kim bu|nedir|hakkinda|dosyesi|dosyasi|profil\w*|ne biliyoruz|bilgi ver|anlat|kim o)\b/, puan: 5 },
];

const ZAMAN_DESENLERI = [
  { desen: /son\s+(\d+)\s*gun/, carpan: 1 },
  { desen: /son\s+(\d+)\s*hafta/, carpan: 7 },
  { desen: /son\s+(\d+)\s*ay/, carpan: 30 },
  { desen: /son\s+(\d+)\s*yil/, carpan: 365 },
  { desen: /gecen\s+hafta/, sabit: 14 },
  { desen: /gecen\s+ay/, sabit: 60 },
  { desen: /bu\s+hafta/, sabit: 7 },
  { desen: /bu\s+ay/, sabit: 30 },
  { desen: /bu\s+yil/, sabit: 365 },
  { desen: /dun/, sabit: 2 },
  { desen: /bugun/, sabit: 1 },
];

/** Sorudan gun cinsinden zaman araligi cikarir. */
function zamanAraligi(normalSoru) {
  for (const z of ZAMAN_DESENLERI) {
    const m = normalSoru.match(z.desen);
    if (!m) continue;
    if (z.sabit) return z.sabit;
    const sayi = Number(m[1]);
    if (Number.isFinite(sayi) && sayi > 0 && sayi < 3650) return sayi * z.carpan;
  }
  return null;
}

/**
 * Niyet cozumu: desen puanlarini toplar, en yuksek puanli niyeti secer.
 * Hicbiri tutmazsa arama niyetine duser (en guvenli varsayilan).
 */
function niyetCoz(soru) {
  const normal = dil.normalize(soru);
  const puanlar = new Map();

  for (const n of NIYET_DESENLERI) {
    if (!n.desen.test(normal)) continue;
    puanlar.set(n.niyet, (puanlar.get(n.niyet) || 0) + n.puan);
  }

  // Matematik ifadesi sorunun tamamina yakinsa hesap niyeti
  if (hesapMakinesi.metindeIfadeVarMi(soru)) {
    const ifade = hesapMakinesi.ifadeCikar(soru);
    if (ifade && ifade.replace(/\s/g, '').length >= soru.replace(/\s/g, '').length * 0.45) {
      puanlar.set('hesap', (puanlar.get('hesap') || 0) + 9);
    }
  }

  if (puanlar.size === 0) return { niyet: 'arama', puan: 0, siralama: [] };

  const siralama = [...puanlar.entries()].sort((a, b) => b[1] - a[1]);
  return { niyet: siralama[0][0], puan: siralama[0][1], siralama };
}

// -------------------------------------------------------- VARLIK COZUMLEME

const SORU_SOZCUKLERI = new Set(dil.normalize([
  'kim', 'kimdir', 'kimin', 'kime', 'kimle', 'ne', 'nedir', 'neyi', 'neden', 'nicin',
  'nasil', 'nerede', 'nereye', 'nereden', 'hangi', 'kac', 'kacta', 'mi', 'mu',
  'hakkinda', 'ile', 'ilgili', 'dosyasi', 'dosyesi', 'profil', 'bilgi', 'ver',
  'anlat', 'goster', 'bul', 'ara', 'listele', 'ozetle', 'ozet', 'var', 'yok',
  'arasinda', 'arasindaki', 'baglanti', 'iliski', 'lutfen', 'bana', 'biraz',
].join(' ')).split(' '));

/** Sorudan muhtemel varlik adlarini ayiklar. */
function adAdaylari(soru) {
  const adaylar = [];

  // 1) Tirnak icindekiler kesin aday
  for (const m of soru.matchAll(/["'«»“”]([^"'«»“”]{2,80})["'«»“”]/g)) {
    adaylar.push({ metin: m[1].trim(), guven: 1 });
  }

  // 2) Kod referanslari: VRL-00012, KYT-000123, VAK-0003
  for (const m of soru.matchAll(/\b(VRL|KYT|OLY|VAK|KYN)-?(\d{3,6})\b/gi)) {
    adaylar.push({ metin: `${m[1].toUpperCase()}-${m[2].padStart(m[1].toUpperCase() === 'VAK' ? 4 : 5, '0')}`, guven: 1, kod: true });
  }

  // 3) Buyuk harfle baslayan sozcuk dizileri (soru sozcukleri atilir)
  const desen = /(?:[A-ZÇĞİÖŞÜ][\p{Ll}çğıöşü]{1,20}|[A-ZÇĞİÖŞÜ]{2,})(?:[ ](?:[A-ZÇĞİÖŞÜ][\p{Ll}çğıöşü]{1,20}|[A-ZÇĞİÖŞÜ]{2,})){0,4}/gu;
  for (const m of soru.matchAll(desen)) {
    const parcalar = m[0].split(/\s+/).filter((k) => !SORU_SOZCUKLERI.has(dil.normalize(k)));
    if (!parcalar.length) continue;
    const temiz = parcalar.join(' ').replace(/['’](?:de|da|te|ta|den|dan|ten|tan|nin|nın|in|ın|un|ün|ya|ye|yi|yı|la|le|yla|yle)$/i, '');
    if (temiz.length >= 3) adaylar.push({ metin: temiz, guven: 0.8 });
  }

  // 4) Hicbiri yoksa: soru sozcukleri atilmis tum anlamli sozcukler
  if (adaylar.length === 0) {
    const kalan = dil.belirtecler(soru).filter((k) => !SORU_SOZCUKLERI.has(dil.normalize(k)) && k.length > 2);
    if (kalan.length) adaylar.push({ metin: kalan.join(' '), guven: 0.4 });
  }

  return adaylar.sort((a, b) => b.guven - a.guven || b.metin.length - a.metin.length);
}

/**
 * Adi arsivdeki varlikla eslestirir. Once tam/kod eslesmesi, sonra
 * normalize eslesme, sonra bulanik ad benzerligi denenir.
 */
async function varlikBul(ad) {
  const temiz = String(ad || '').trim();
  if (!temiz) return null;

  // Kod ile
  if (/^(VRL|KYT|OLY|VAK|KYN)-\d+$/i.test(temiz)) {
    const kodlu = await db.tekSatir('SELECT * FROM varliklar WHERE upper(kod) = upper($1) AND silindi = FALSE', [temiz]);
    if (kodlu) return { varlik: kodlu, benzerlik: 1, yontem: 'kod' };
  }

  // Normalize tam eslesme (ad veya takma ad)
  const tam = await db.tekSatir(
    `SELECT * FROM varliklar
      WHERE silindi = FALSE
        AND (arsiv_normalize(ad) = arsiv_normalize($1)
             OR EXISTS (SELECT 1 FROM UNNEST(takma_adlar) t WHERE arsiv_normalize(t) = arsiv_normalize($1)))
      ORDER BY onem DESC LIMIT 1`,
    [temiz],
  );
  if (tam) return { varlik: tam, benzerlik: 1, yontem: 'tam' };

  // Parcali eslesme
  const parcali = await db.satirlar(
    `SELECT * FROM varliklar
      WHERE silindi = FALSE AND arsiv_normalize(ad) LIKE '%' || arsiv_normalize($1) || '%'
      ORDER BY length(ad) ASC, onem DESC LIMIT 5`,
    [temiz],
  );
  if (parcali.length) return { varlik: parcali[0], benzerlik: 0.9, yontem: 'icerir', digerleri: parcali.slice(1) };

  // Bulanik: aday kumesini daraltip JS tarafinda benzerlik olc
  const ilkHarf = dil.normalize(temiz)[0] || '';
  const havuz = await db.satirlar(
    `SELECT * FROM varliklar
      WHERE silindi = FALSE AND arsiv_normalize(ad) LIKE $1
      LIMIT 500`,
    [`${ilkHarf}%`],
  );
  let enIyi = null;
  for (const v of havuz) {
    const puan = Math.max(
      dil.benzerlik(temiz, v.ad),
      ...(v.takma_adlar || []).map((t) => dil.benzerlik(temiz, t)),
    );
    if (!enIyi || puan > enIyi.benzerlik) enIyi = { varlik: v, benzerlik: puan, yontem: 'bulanik' };
  }
  return enIyi && enIyi.benzerlik >= 0.72 ? enIyi : null;
}

// --------------------------------------------------------------- YARDIMCI

function kaynakYolu(kaynakTur, kaynakId) {
  const yollar = {
    kayit: `/arsiv/kayit/${kaynakId}`,
    varlik: `/arsiv/varlik/${kaynakId}`,
    olay: `/arsiv/olay/${kaynakId}`,
    vaka: `/arsiv/vaka/${kaynakId}`,
    belge: `/depo/belge/${kaynakId}`,
    dosya: `/depo/dosya/${kaynakId}/goruntule`,
    hafiza: '/cambaz',
  };
  return yollar[kaynakTur] || '/arsiv';
}

const KAYNAK_TUR_ADI = {
  kayit: 'kayıt', varlik: 'varlık', olay: 'olay', vaka: 'vaka',
  belge: 'belge', dosya: 'dosya', hafiza: 'hafıza notu',
};

/** Arama sonuclarini standart bulgu nesnelerine cevirir. */
function bulgulariBicimle(sonuclar) {
  return sonuclar.map((s) => ({
    kaynakTur: s.kaynak_tur,
    kaynakId: Number(s.kaynak_id),
    baslik: s.baslik,
    alinti: s.alinti,
    // Tam parca metni: dogrudan cevap cikarimi kirpilmis alintiyla degil,
    // parcanin tamamiyla calisir — aksi halde cevap alintinin disinda kalirsa
    // hic bulunamaz.
    metin: s.metin || s.alinti,
    puan: s.puan,
    eslesen: s.eslesen,
    tasnif: s.tasnif,
    yol: kaynakYolu(s.kaynak_tur, s.kaynak_id),
    etiket: KAYNAK_TUR_ADI[s.kaynak_tur] || s.kaynak_tur,
    agirlik: 1,
  }));
}

// --------------------------------------------------------- KANIT AGIRLIGI

// Admiralty derecelendirmesini sayisal agirliga cevirir. Bir bilgi, hangi
// kaynaktan geldigi ve dogrulanip dogrulanmadigina gore farkli agirlik tasir;
// aksi halde YALANLANMIS bir kayit, dogrulanmis bir kayitla ayni sesle
// konusur. Istihbarat urununde bu kabul edilemez.
const DURUM_AGIRLIGI = {
  dogrulandi: 1.35, incelemede: 1.0, yeni: 0.9, arsiv: 0.8, yalanlandi: 0.1,
};
const GUVEN_AGIRLIGI = { A: 1.25, B: 1.12, C: 1.0, D: 0.78, E: 0.55, F: 0.7 };
const DOGRULUK_AGIRLIGI = { 1: 1.25, 2: 1.12, 3: 1.0, 4: 0.82, 5: 0.4, 6: 0.75 };

function kanitAgirligi({ durum, guvenilirlik, dogruluk }) {
  return (DURUM_AGIRLIGI[durum] ?? 1)
    * (GUVEN_AGIRLIGI[guvenilirlik] ?? 1)
    * (DOGRULUK_AGIRLIGI[dogruluk] ?? 1);
}

/**
 * Bulgulari kaynak kaydin guvenilirlik/durum bilgisiyle zenginlestirir.
 * Yalanlanmis ya da dusuk dereceli kaynaklardan gelen alintilar, cevap
 * uretiminde ve ozetlemede daha az agirlik tasir.
 */
async function bulgulariZenginlestir(bulgular) {
  const kayitIdleri = bulgular.filter((b) => b.kaynakTur === 'kayit').map((b) => b.kaynakId);
  const olayIdleri = bulgular.filter((b) => b.kaynakTur === 'olay').map((b) => b.kaynakId);

  const [kayitlar, olaylar] = await Promise.all([
    kayitIdleri.length
      ? db.satirlar('SELECT id, durum, guvenilirlik, dogruluk, kod FROM kayitlar WHERE id = ANY($1::bigint[])', [kayitIdleri])
      : [],
    olayIdleri.length
      ? db.satirlar('SELECT id, guvenilirlik, dogruluk, kod FROM olaylar WHERE id = ANY($1::bigint[])', [olayIdleri])
      : [],
  ]);

  const kayitHarita = new Map(kayitlar.map((k) => [Number(k.id), k]));
  const olayHarita = new Map(olaylar.map((o) => [Number(o.id), o]));

  for (const b of bulgular) {
    const kaynak = b.kaynakTur === 'kayit' ? kayitHarita.get(b.kaynakId)
      : b.kaynakTur === 'olay' ? olayHarita.get(b.kaynakId) : null;
    if (!kaynak) continue;
    b.durum = kaynak.durum || null;
    b.guvenilirlik = kaynak.guvenilirlik;
    b.dogruluk = kaynak.dogruluk;
    b.agirlik = Math.round(kanitAgirligi(kaynak) * 1000) / 1000;
    if (kaynak.durum === 'yalanlandi') b.uyari = 'Bu kayit YALANLANDI olarak isaretli.';
  }

  return bulgular;
}

// --------------------------------------------------- SORU ODAKLI CIKARIM

// Odak turleri SIRALI listelerdir: listenin basindaki tur, cevap secilirken
// daha agir tartilir. "Ne zaman" sorusuna saat yerine TARIH donmesi boyle
// saglanir.
const ODAK_TURLERI = {
  nerede: ['konum', 'koordinat'],
  ne_zaman: ['tarih', 'saat'],
  saat: ['saat', 'tarih'],
  kim: ['kisi', 'kurum'],
  ne_kadar: ['para'],
  hangi_kurum: ['kurum', 'kisi'],
  iletisim: ['telefon', 'eposta', 'sosyal'],
  hesap: ['iban', 'cuzdan', 'kart'],
  arac: ['plaka'],
  kimlik: ['tckn', 'vkn'],
};

/** Sorunun hangi tur bilgiyi aradigini belirler. */
function odakTuru(normalSoru) {
  if (/\bsaat\s*(kac|kacta)\b|\bkacta\b/.test(normalSoru)) return ODAK_TURLERI.saat;
  if (/\bne\s*zaman\b|\bhangi\s*(tarih|gun|ay|yil|saat)\b|\bkac(inci)?\s*(tarih|gun)\b/.test(normalSoru)) return ODAK_TURLERI.ne_zaman;
  if (/\bnere(de|ye|den)\b|\bhangi\s*(sehir|il|ilce|adres|konum|ulke|liman|bolge)\b|\bkonumu?\s*(ne|nedir|neresi)\b/.test(normalSoru)) return ODAK_TURLERI.nerede;
  if (/\bne\s*kadar\b|\bkac\s*(tl|lira|dolar|euro|avro|para)\b|\btutar\w*\b|\bmiktar\w*\b|\bodeme\w*\s*(ne|kac)\b/.test(normalSoru)) return ODAK_TURLERI.ne_kadar;
  if (/\bhangi\s*(kurum|sirket|firma|kurulus|dernek|vakif|banka)\w*\b/.test(normalSoru)) return ODAK_TURLERI.hangi_kurum;
  // DIKKAT: "kimle?" yazimi 'l' harfini ZORUNLU kilar ve "kim" sorularini
  // tamamen kacirir. Bicimler tek tek yazilmali.
  if (/\b(kim|kime|kimi|kimin|kimle|kimler|kimlerle|kimdi)\b/.test(normalSoru)) return ODAK_TURLERI.kim;
  // Ozel tanimlayicilar GENEL "numara" kalibindan ONCE denenir; aksi halde
  // "iban numarasi ne" sorusu telefon odagina duser.
  if (/\b(iban|hesap\s*numara\w*|banka\s*hesab\w*|cuzdan|kart\s*numara\w*)\b/.test(normalSoru)) return ODAK_TURLERI.hesap;
  if (/\b(plaka\w*|arac\s*(ne|hangi|kim))\b/.test(normalSoru)) return ODAK_TURLERI.arac;
  if (/\b(tckn|t\.?c\.?\s*kimlik|kimlik\s*numara\w*|vergi\s*numara\w*)\b/.test(normalSoru)) return ODAK_TURLERI.kimlik;
  if (/\b(telefon\w*|cep\s*numara\w*|hat\s*numara\w*|eposta|e-posta|mail|irtibat)\b/.test(normalSoru)) return ODAK_TURLERI.iletisim;
  return null;
}

/**
 * Bulgulardan sorunun cevabini CIKARIR (extractive QA):
 *  - sorunun odak turune uygun varliklari bulgulardan toplar
 *  - en cok gecen / en yuksek puanli adayi one cikarir
 */
function dogrudanCevap(soru, bulgular) {
  const odak = odakTuru(dil.normalize(soru));
  if (!odak || bulgular.length === 0) return null;

  const sayac = new Map();
  for (const b of bulgular.slice(0, 10)) {
    const cikarim = varlikCikarim.cikar(b.metin || b.alinti || '', { minGuven: 0.6 });
    for (const bulgu of cikarim.bulgular) {
      if (!odak.includes(bulgu.tur)) continue;
      const anahtar = bulgu.normal || bulgu.deger;
      const mevcut = sayac.get(anahtar);
      // Kanit agirligi: yalanlanmis ya da dusuk dereceli kaynaktan gelen
      // aday, dogrulanmis kaynaktan gelenle ayni agirlikta olamaz.
      // Odak listesindeki siraya gore tur onceligi de uygulanir.
      const turOnceligi = 1 + 0.6 * (odak.length - 1 - odak.indexOf(bulgu.tur)) / Math.max(1, odak.length - 1);
      const agirlik = bulgu.guven * (1 + Math.log(1 + b.puan)) * (b.agirlik ?? 1) * turOnceligi;
      // Ayni basliga sahip kaynaklar (tekrarli kayitlar) bir kez sayilir;
      // aksi halde arsivdeki mukerrer giris bir adayi yapay olarak guclendirir.
      const kaynakAnahtari = `${b.kaynakTur}|${dil.normalize(b.baslik || '').replace(/^\S+\s/, '')}`;
      if (mevcut) {
        if (!mevcut.kaynakAnahtarlari.has(kaynakAnahtari)) {
          mevcut.kaynakAnahtarlari.add(kaynakAnahtari);
          mevcut.agirlik += agirlik;
          mevcut.sayi++;
          mevcut.kaynaklar.push(b);
        }
      } else {
        sayac.set(anahtar, {
          deger: bulgu.deger, tur: bulgu.tur, agirlik, sayi: 1, kaynaklar: [b],
          kaynakAnahtarlari: new Set([kaynakAnahtari]),
        });
      }
    }
  }

  if (sayac.size === 0) return null;
  const siralama = [...sayac.values()].sort((a, b) => b.agirlik - a.agirlik);
  const en = siralama[0];

  const enIyiKaynak = [...en.kaynaklar].sort((a, b) => (b.agirlik ?? 1) - (a.agirlik ?? 1))[0];

  return {
    deger: en.deger,
    tur: en.tur,
    gecis: en.sayi,
    kaynaklar: en.kaynaklar.slice(0, 3),
    adaylar: siralama.slice(0, 5).map((s) => ({
      deger: s.deger, gecis: s.sayi,
      agirlik: Math.round(s.agirlik * 100) / 100,
    })),
    kesinlik: siralama.length === 1 ? 'tek aday'
      : en.agirlik > siralama[1].agirlik * 1.8 ? 'baskin aday' : 'birden fazla aday',
    // Cevap yalnizca zayif kanitla destekleniyorsa bunu acikca soyle
    zayifKanit: en.kaynaklar.every((k) => (k.agirlik ?? 1) < 0.6),
    kaynakDurumu: enIyiKaynak ? enIyiKaynak.durum || null : null,
    kaynakDerecesi: enIyiKaynak && enIyiKaynak.guvenilirlik
      ? `${enIyiKaynak.guvenilirlik}${enIyiKaynak.dogruluk ?? ''}` : null,
  };
}

// ======================================================================
//                            NIYET ISLEYICILERI
// ======================================================================

/** ARAMA: BM25 + sorgu odakli ozet + dogrudan cevap cikarimi. */
async function islemArama(soru, baglam) {
  const { sonuclar, terimler } = await dizin.ara(soru, {
    limit: 14,
    enUstTasnif: baglam.enUstTasnif,
  });

  if (sonuclar.length === 0) {
    return {
      cevap: `Arşivde "${soru.trim()}" ile eşleşen kayıt bulamadım. ` +
        'Dizin güncel olmayabilir; Ayarlar ekranından dizini yeniden kurmayı deneyebilir ' +
        'ya da aramayı daha genel sözcüklerle tekrarlayabilirsin.',
      bulgular: [],
      veri: { terimler },
      eylemler: [{ etiket: 'Dizini yeniden kur', yol: '/ayarlar#zeka' }],
    };
  }

  const bulgular = await bulgulariZenginlestir(bulgulariBicimle(sonuclar));

  // Kanit agirligini siralamaya da yansit: yalanlanmis kayit, BM25 puani
  // yuksek olsa bile cevabin tepesine cikmamali.
  bulgular.sort((a, b) => (b.puan * (b.agirlik ?? 1)) - (a.puan * (a.agirlik ?? 1)));

  const dogrudan = dogrudanCevap(soru, bulgular);

  // Ozet, yalnizca kanit degeri makul olan alintilardan kurulur.
  const guvenilirBulgular = bulgular.filter((b) => (b.agirlik ?? 1) >= 0.5);
  const havuz = (guvenilirBulgular.length ? guvenilirBulgular : bulgular)
    .slice(0, 8).map((b) => b.alinti).filter(Boolean).join(' ');
  const ozet = metrik.ozetle(havuz, { cumleSayisi: 3, sorgu: soru, maxKarakter: 900 });

  const satirlar = [];
  if (dogrudan) {
    const derece = dogrudan.kaynakDerecesi ? ` · kaynak derecesi ${dogrudan.kaynakDerecesi}` : '';
    satirlar.push(`**${dogrudan.deger}**  —  ${nd.sayili(dogrudan.gecis, 'kaynakta')} geçiyor (${dogrudan.kesinlik}${derece}).`);
    if (dogrudan.zayifKanit) {
      satirlar.push('> ⚠ Bu cevabı yalnızca **yalanlanmış ya da düşük dereceli** kaynaklar destekliyor; doğrulanmadan kullanılmamalı.');
    } else if (dogrudan.kaynakDurumu === 'yalanlandi') {
      satirlar.push('> ⚠ En güçlü eşleşme yalanlanmış bir kayıttan geliyor.');
    }
    if (dogrudan.adaylar.length > 1) {
      satirlar.push(`Diğer adaylar: ${dogrudan.adaylar.slice(1).map((a) => `${a.deger} (${a.gecis})`).join(', ')}.`);
    }
    satirlar.push('');
  }

  satirlar.push(ozet.ozet || bulgular[0].alinti);
  satirlar.push('');
  const yalanlanan = bulgular.filter((b) => b.durum === 'yalanlandi').length;
  satirlar.push(
    `${nd.sayili(sonuclar.length, 'kaynak')} tarandı; en güçlü eşleşmeler aşağıda.`
    + (yalanlanan ? ` ${nd.sayili(yalanlanan, 'tanesi')} yalanlanmış kayıt olduğu için ağırlığı düşürüldü.` : ''),
  );

  return {
    cevap: satirlar.join('\n'),
    bulgular,
    veri: { terimler, dogrudan, ozetCumleleri: ozet.cumleler.length },
    eylemler: bulgular.slice(0, 4).map((b) => ({ etiket: b.baslik.slice(0, 60), yol: b.yol })),
  };
}

/** VARLIK DOSYESI: bir varlik hakkinda toplanmis her seyi sentezler. */
async function islemVarlikDosyesi(soru, baglam) {
  const adaylar = adAdaylari(soru);
  let eslesme = null;
  for (const aday of adaylar) {
    eslesme = await varlikBul(aday.metin);
    if (eslesme) break;
  }

  if (!eslesme) {
    // Varlik bulunamadi: serbest aramaya dus
    const arama = await islemArama(soru, baglam);
    arama.cevap = `Bu adla kayıtlı bir varlık bulamadım, bu yüzden serbest arama yaptım.\n\n${arama.cevap}`;
    return arama;
  }

  const v = eslesme.varlik;

  // --- Iliskiler ---
  const iliskiler = await db.satirlar(
    `SELECT i.*,
            k.ad AS kaynak_ad, k.tur AS kaynak_tur_varlik, k.kod AS kaynak_kod,
            h.ad AS hedef_ad, h.tur AS hedef_tur_varlik, h.kod AS hedef_kod
       FROM varlik_iliskileri i
       JOIN varliklar k ON k.id = i.kaynak_varlik_id
       JOIN varliklar h ON h.id = i.hedef_varlik_id
      WHERE (i.kaynak_varlik_id = $1 OR i.hedef_varlik_id = $1)
        AND k.silindi = FALSE AND h.silindi = FALSE
      ORDER BY i.guc DESC LIMIT 60`,
    [v.id],
  );

  // --- Kayitlar ---
  const kayitlar = await db.satirlar(
    `SELECT k.id, k.kod, k.baslik, k.govde, k.ozet, k.tur, k.tasnif, k.guvenilirlik,
            k.dogruluk, k.durum, COALESCE(k.olay_zamani, k.olusturuldu_at) AS zaman,
            kv.rol
       FROM kayit_varliklari kv
       JOIN kayitlar k ON k.id = kv.kayit_id
      WHERE kv.varlik_id = $1 AND k.silindi = FALSE
      ORDER BY zaman DESC LIMIT 60`,
    [v.id],
  );

  // --- Olaylar ---
  const olaylar = await db.satirlar(
    `SELECT o.id, o.kod, o.baslik, o.zaman, o.tur, o.konum, o.onem, ov.rol
       FROM olay_varliklari ov
       JOIN olaylar o ON o.id = ov.olay_id
      WHERE ov.varlik_id = $1 AND o.silindi = FALSE
      ORDER BY o.zaman DESC LIMIT 60`,
    [v.id],
  );

  // --- Ekler ve vakalar ---
  const [ekler, vakalar] = await Promise.all([
    db.satirlar('SELECT oge_tur, oge_id, not_metni FROM varlik_ekleri WHERE varlik_id = $1 LIMIT 40', [v.id]),
    db.satirlar(
      `SELECT va.id, va.kod, va.ad, va.durum, va.oncelik
         FROM vaka_ogeleri vo JOIN vakalar va ON va.id = vo.vaka_id
        WHERE vo.oge_tur = 'varlik' AND vo.oge_id = $1 AND va.silindi = FALSE`,
      [v.id],
    ),
  ]);

  // --- Kayit govdelerinden sentez ozeti ---
  const govdeHavuzu = kayitlar.map((k) => `${k.baslik}. ${k.ozet || k.govde || ''}`).join('\n');
  const sentez = govdeHavuzu.trim()
    ? metrik.ozetle(govdeHavuzu, { cumleSayisi: 4, maxKarakter: 1100 })
    : { ozet: '', cumleler: [] };

  // --- Zaman serisi ve egilim ---
  const zamanlar = [
    ...kayitlar.map((k) => new Date(k.zaman)),
    ...olaylar.map((o) => new Date(o.zaman)),
  ].filter((d) => !Number.isNaN(d.getTime()));
  const seri = zamanlar.length >= 3 ? ist.zamanSerisi(zamanlar, 'hafta') : null;
  const egilim = seri && seri.kovalar.length >= 4 ? ist.egilim(seri.kovalar.map((k) => k.deger)) : null;
  const patlamalar = seri ? ist.patlama(seri.kovalar, { pencere: 4, esik: 2 }) : [];

  // --- Kaynak guvenilirligi dagilimi ---
  const guvenDagilim = new Map();
  for (const k of kayitlar) guvenDagilim.set(k.guvenilirlik, (guvenDagilim.get(k.guvenilirlik) || 0) + 1);

  // --- Anlatimi kur ---
  const satirlar = [];
  const turAdi = nd.VARLIK_TUR_ADI[v.tur] || v.tur;

  satirlar.push(`### ${v.ad}  ·  ${v.kod}`);
  satirlar.push(
    `${nd.basBuyut(turAdi)} · durum **${nd.DURUM_ADI[v.durum] || v.durum}** · ` +
    `tasnif **${nd.TASNIF_ADI[v.tasnif] || v.tasnif}** · önem **${v.onem}/100** · ` +
    `kaynak güvenilirliği **${v.guvenilirlik}** (${nd.GUVENILIRLIK_ADI[v.guvenilirlik] || '—'})`,
  );
  if (eslesme.yontem === 'bulanik') {
    satirlar.push(`> Sorduğun adla tam eşleşme yoktu; en yakın kayıt bu (benzerlik %${Math.round(eslesme.benzerlik * 100)}).`);
  }
  satirlar.push('');

  if (v.takma_adlar && v.takma_adlar.length) {
    satirlar.push(`**Bilinen diğer adlar:** ${nd.listele(v.takma_adlar)}`);
  }
  if (v.ozet) satirlar.push(v.ozet);
  satirlar.push('');

  satirlar.push('**Arşivdeki ayak izi**');
  satirlar.push(
    `- ${nd.sayili(kayitlar.length, 'kayıt')}, ${nd.sayili(olaylar.length, 'olay')}, ` +
    `${nd.sayili(iliskiler.length, 'ilişki')}, ${nd.sayili(ekler.length, 'ek dosya')}` +
    (vakalar.length ? `, ${nd.sayili(vakalar.length, 'vaka')}` : ''),
  );
  if (kayitlar.length) {
    const ilk = new Date(kayitlar[kayitlar.length - 1].zaman);
    const son = new Date(kayitlar[0].zaman);
    satirlar.push(`- İlk kayıt ${nd.tarihSozcuk(ilk, { gunAdi: false })}, son kayıt ${nd.tarihSozcuk(son, { gunAdi: false })} (${nd.gorece(son)}).`);
  }
  if (guvenDagilim.size) {
    satirlar.push(`- Kaynak dereceleri: ${[...guvenDagilim.entries()].sort().map(([g, n]) => `${g}×${n}`).join(', ')}`);
  }
  if (egilim && egilim.guven !== 'dusuk') {
    satirlar.push(`- Haftalık hareketlilik **${egilim.yon}** (kova başına %${egilim.kovaBasinaYuzde}, R²=${egilim.r2}).`);
  }
  if (patlamalar.length) {
    const p = patlamalar[patlamalar.length - 1];
    satirlar.push(`- Son hareketlilik sıçraması: **${p.etiket}** haftası (${p.deger} kayıt, temel ortalamanın ${p.kat} katı).`);
  }
  satirlar.push('');

  if (iliskiler.length) {
    satirlar.push('**En güçlü bağlantılar**');
    for (const i of iliskiler.slice(0, 8)) {
      const karsi = Number(i.kaynak_varlik_id) === Number(v.id)
        ? { ad: i.hedef_ad, tur: i.hedef_tur_varlik, kod: i.hedef_kod }
        : { ad: i.kaynak_ad, tur: i.kaynak_tur_varlik, kod: i.kaynak_kod };
      satirlar.push(
        `- ${karsi.ad} _(${nd.VARLIK_TUR_ADI[karsi.tur] || karsi.tur})_ — ` +
        `${nd.ILISKI_TUR_ADI[i.tur] || i.tur}${i.etiket ? `, ${i.etiket}` : ''}, güç ${i.guc}/100` +
        (i.otomatik ? ' _(otomatik çıkarım)_' : ''),
      );
    }
    satirlar.push('');
  }

  if (sentez.ozet) {
    satirlar.push('**Kayıtlardan sentez**');
    satirlar.push(sentez.ozet);
    satirlar.push('');
  }

  if (olaylar.length) {
    satirlar.push('**Son olaylar**');
    for (const o of olaylar.slice(0, 5)) {
      satirlar.push(`- ${nd.tarihSozcuk(o.zaman, { gunAdi: false })} — ${o.baslik}${o.konum ? ` (${o.konum})` : ''}`);
    }
    satirlar.push('');
  }

  // --- Degerlendirme ---
  const degerlendirme = [];
  if (v.onem >= 70) degerlendirme.push('yüksek önem puanı');
  if (iliskiler.length >= 6) degerlendirme.push(`geniş bağlantı ağı (${iliskiler.length} bağ)`);
  if (kayitlar.filter((k) => k.durum === 'dogrulandi').length >= 2) degerlendirme.push('birden fazla doğrulanmış kayıt');
  if (kayitlar.filter((k) => ['A', 'B'].includes(k.guvenilirlik)).length >= 2) degerlendirme.push('güvenilir kaynak desteği');
  if (patlamalar.length) degerlendirme.push('son dönemde artan hareketlilik');

  const zayif = [];
  if (!kayitlar.length) zayif.push('hiç kayıt bağlanmamış');
  if (!iliskiler.length) zayif.push('hiç ilişki tanımlanmamış');
  if (kayitlar.length && kayitlar.every((k) => k.durum === 'yeni')) zayif.push('kayıtların hiçbiri incelenmemiş');
  if (kayitlar.filter((k) => ['D', 'E', 'F'].includes(k.guvenilirlik)).length > kayitlar.length / 2) {
    zayif.push('kaynakların yarısından çoğu düşük güvenilirlikte');
  }

  satirlar.push('**Değerlendirme**');
  if (degerlendirme.length) satirlar.push(`- Güçlü yanlar: ${nd.listele(degerlendirme)}.`);
  if (zayif.length) satirlar.push(`- Boşluklar: ${nd.listele(zayif)}.`);
  if (!degerlendirme.length && !zayif.length) satirlar.push('- Kayıt yoğunluğu değerlendirme için henüz yetersiz.');

  return {
    cevap: satirlar.join('\n'),
    bulgular: [
      ...kayitlar.slice(0, 6).map((k) => ({
        kaynakTur: 'kayit', kaynakId: k.id, baslik: `${k.kod} ${k.baslik}`,
        alinti: (k.ozet || k.govde || '').slice(0, 300), puan: 1,
        tasnif: k.tasnif, yol: `/arsiv/kayit/${k.id}`, etiket: 'kayıt',
      })),
      ...olaylar.slice(0, 4).map((o) => ({
        kaynakTur: 'olay', kaynakId: o.id, baslik: `${o.kod} ${o.baslik}`,
        alinti: o.konum || '', puan: 1, yol: `/arsiv/olay/${o.id}`, etiket: 'olay',
      })),
    ],
    veri: {
      varlik: v,
      iliskiSayisi: iliskiler.length,
      kayitSayisi: kayitlar.length,
      olaySayisi: olaylar.length,
      egilim,
      patlamalar,
      vakalar,
      seri: seri ? seri.kovalar : null,
    },
    eylemler: [
      { etiket: 'Varlık dosyesini aç', yol: `/arsiv/varlik/${v.id}` },
      { etiket: 'Bağlantı grafiğinde göster', yol: `/analiz/graf?varlik=${v.id}` },
    ],
  };
}

/** BAGLANTI: iki varlik arasindaki yollar ve ortak noktalar. */
async function islemBaglanti(soru, baglam = {}) {
  const adaylar = adAdaylari(soru);
  const eslesmeler = [];
  for (const aday of adaylar) {
    const e = await varlikBul(aday.metin);
    if (e && !eslesmeler.some((x) => x.varlik.id === e.varlik.id)) eslesmeler.push(e);
    if (eslesmeler.length === 2) break;
  }

  // Iki taraf bulunamadiysa sessizce pes etme: elde ne varsa onunla devam et.
  if (eslesmeler.length === 1) {
    const dosye = await islemVarlikDosyesi(`${eslesmeler[0].varlik.ad} hakkinda`, baglam);
    dosye.cevap = `Soruda yalnızca **${eslesmeler[0].varlik.ad}** adlı varlığı tanıyabildim; ` +
      'ikinci tarafı bulamadığım için bunun yerine varlık dosyesini çıkardım. ' +
      'İki adı birlikte yazarsan yol analizi de yapabilirim.\n\n' + dosye.cevap;
    return dosye;
  }
  if (eslesmeler.length === 0) {
    const arama = await islemArama(soru, baglam);
    arama.cevap = 'Soruda arşivde kayıtlı iki varlık tanıyamadım, bu yüzden serbest arama yaptım. ' +
      'Bağlantı analizi için iki adı da açıkça yazabilirsin (örnek: "Ahmet Yılmaz ile ACRO Lojistik arasındaki bağlantı").' +
      `\n\n${arama.cevap}`;
    return arama;
  }

  const [a, b] = eslesmeler.map((e) => e.varlik);

  const dugumler = await db.satirlar(
    'SELECT id, ad, tur, onem, durum FROM varliklar WHERE silindi = FALSE LIMIT 6000',
  );
  const kenarlar = await db.satirlar(
    `SELECT kaynak_varlik_id AS kaynak, hedef_varlik_id AS hedef, guc, tur, yon
       FROM varlik_iliskileri LIMIT 40000`,
  );
  const g = graf.kur(dugumler, kenarlar);

  const kisaYol = graf.enKisaYol(g, a.id, b.id);
  const tumYollar = graf.yollar(g, a.id, b.id, { maxYol: 4, maxDerinlik: 5 });
  const adHarita = new Map(dugumler.map((d) => [Number(d.id), d]));

  const cevreA = graf.cevre(g, a.id, 1);
  const cevreB = graf.cevre(g, b.id, 1);
  const kumeA = new Set(cevreA.dugumler.map((d) => Number(d.id)));
  const ortak = cevreB.dugumler
    .filter((d) => kumeA.has(Number(d.id)) && Number(d.id) !== Number(a.id) && Number(d.id) !== Number(b.id))
    .map((d) => adHarita.get(Number(d.id)))
    .filter(Boolean);

  // Ortak kayitlar
  const ortakKayitlar = await db.satirlar(
    `SELECT k.id, k.kod, k.baslik, k.ozet, k.govde, k.tasnif,
            COALESCE(k.olay_zamani, k.olusturuldu_at) AS zaman
       FROM kayitlar k
      WHERE k.silindi = FALSE
        AND EXISTS (SELECT 1 FROM kayit_varliklari v WHERE v.kayit_id = k.id AND v.varlik_id = $1)
        AND EXISTS (SELECT 1 FROM kayit_varliklari v WHERE v.kayit_id = k.id AND v.varlik_id = $2)
      ORDER BY zaman DESC LIMIT 12`,
    [a.id, b.id],
  );

  const satirlar = [];
  satirlar.push(`### ${a.ad}  ↔  ${b.ad}`);
  satirlar.push('');

  if (kisaYol) {
    const yolAdlari = kisaYol.yol.map((id) => (adHarita.get(Number(id)) || { ad: `#${id}` }).ad);
    satirlar.push(`**En kısa bağ:** ${yolAdlari.join('  →  ')}`);
    satirlar.push(`${nd.sayili(kisaYol.adim, 'adım')} uzaklıkta; ara düğüm sayısı ${Math.max(0, kisaYol.adim - 1)}.`);
    if (kisaYol.adim === 1) {
      const kenar = kisaYol.kenarlar[0];
      satirlar.push(`Doğrudan bağlı: **${nd.ILISKI_TUR_ADI[kenar.tur] || kenar.tur}**, güç ${kenar.guc}/100.`);
    }
  } else {
    satirlar.push('**Kayıtlı ilişkiler üzerinden iki varlık arasında yol yok.** Aynı ağ parçasında değiller.');
  }
  satirlar.push('');

  if (tumYollar.length > 1) {
    satirlar.push('**Diğer yollar**');
    for (const y of tumYollar.slice(1, 4)) {
      satirlar.push(`- ${y.yol.map((id) => (adHarita.get(Number(id)) || { ad: `#${id}` }).ad).join(' → ')} _(${y.adim} adım, ortalama güç ${y.ortalamaGuc})_`);
    }
    satirlar.push('');
  }

  if (ortak.length) {
    satirlar.push(`**Ortak bağlantılar (${ortak.length})**`);
    satirlar.push(ortak.slice(0, 10).map((o) => `${o.ad} _(${nd.VARLIK_TUR_ADI[o.tur] || o.tur})_`).join(', '));
    satirlar.push('');
  }

  if (ortakKayitlar.length) {
    satirlar.push(`**İkisinin birlikte geçtiği kayıtlar (${ortakKayitlar.length})**`);
    for (const k of ortakKayitlar.slice(0, 6)) {
      satirlar.push(`- ${k.kod} · ${nd.tarihSozcuk(k.zaman, { gunAdi: false })} — ${k.baslik}`);
    }
    const birlesik = ortakKayitlar.map((k) => k.ozet || k.govde || '').join(' ');
    if (birlesik.trim().length > 120) {
      const o = metrik.ozetle(birlesik, { cumleSayisi: 2, maxKarakter: 600 });
      if (o.ozet) { satirlar.push(''); satirlar.push(`_Ortak kayıtlardan:_ ${o.ozet}`); }
    }
  } else {
    satirlar.push('_İkisinin aynı kayıtta birlikte geçtiği bir belge yok._');
  }

  // Degerlendirme
  satirlar.push('');
  satirlar.push('**Değerlendirme**');
  if (!kisaYol) {
    satirlar.push('- Aralarında kurulu bir bağ yok; ortak bir kayıt da bulunmuyorsa bu bağlantı şu an bir varsayımdır.');
  } else if (kisaYol.adim <= 2 && ortakKayitlar.length) {
    satirlar.push('- Hem kısa bir ağ yolu hem ortak belge var: bağlantı **belgelenmiş** sayılabilir.');
  } else if (kisaYol.adim <= 2) {
    satirlar.push('- Ağ yolu kısa ama ortak belge yok: bağ **yapısal**, içerik dayanağı zayıf.');
  } else {
    satirlar.push(`- ${kisaYol.adim} adımlık dolaylı bir bağ; bu uzaklıkta ilişki tek başına anlamlı sayılmaz.`);
  }
  if (ortak.length >= 3) satirlar.push(`- ${nd.sayili(ortak.length, 'ortak bağlantı')} var; bu, aynı çevrede hareket ettiklerine işaret eder.`);

  return {
    cevap: satirlar.join('\n'),
    bulgular: ortakKayitlar.map((k) => ({
      kaynakTur: 'kayit', kaynakId: k.id, baslik: `${k.kod} ${k.baslik}`,
      alinti: (k.ozet || k.govde || '').slice(0, 280), puan: 1, tasnif: k.tasnif,
      yol: `/arsiv/kayit/${k.id}`, etiket: 'kayıt',
    })),
    veri: { a, b, kisaYol, tumYollar, ortak: ortak.slice(0, 20), ortakKayitSayisi: ortakKayitlar.length },
    eylemler: [
      { etiket: 'Grafikte göster', yol: `/analiz/graf?varlik=${a.id}&hedef=${b.id}` },
      { etiket: `${a.ad} dosyesi`, yol: `/arsiv/varlik/${a.id}` },
      { etiket: `${b.ad} dosyesi`, yol: `/arsiv/varlik/${b.id}` },
    ],
  };
}

/** AG: sebekenin genel yapisi, kilit aktorler, topluluklar, kopruler. */
async function islemAg() {
  const dugumler = await db.satirlar(
    'SELECT id, ad, tur, onem, durum FROM varliklar WHERE silindi = FALSE LIMIT 6000',
  );
  const kenarlar = await db.satirlar(
    'SELECT kaynak_varlik_id AS kaynak, hedef_varlik_id AS hedef, guc, tur, yon FROM varlik_iliskileri LIMIT 40000',
  );

  if (dugumler.length < 3) {
    return {
      cevap: 'Ağ analizi için en az üç varlık gerekiyor. Arşivde henüz yeterli varlık yok.',
      bulgular: [], veri: {}, eylemler: [{ etiket: 'Varlık ekle', yol: '/arsiv/varliklar' }],
    };
  }

  const g = graf.kur(dugumler, kenarlar);
  const ozet = graf.ozet(g);
  const merkeziyet = graf.merkeziyet(g);
  const { gruplar } = graf.topluluklar(g);
  const kritik = graf.kritikNoktalar(g);
  const tahminler = graf.baglantiTahmini(g, { adet: 8 });

  const satirlar = [];
  satirlar.push('### Ağ yapısı');
  satirlar.push(
    `${nd.sayili(ozet.dugumSayisi, 'varlık')}, ${nd.sayili(ozet.kenarSayisi, 'ilişki')} · ` +
    `ortalama derece ${ozet.ortalamaDerece} · yoğunluk ${ozet.yogunluk} · ` +
    `${nd.sayili(ozet.bilesenSayisi, 'ayrı parça')} (en büyüğü ${ozet.enBuyukBilesen} varlık)`,
  );
  if (ozet.yalnizDugum) satirlar.push(`${nd.sayili(ozet.yalnizDugum, 'varlık')} hiçbir ilişkiye bağlı değil.`);
  satirlar.push('');

  satirlar.push('**Kilit aktörler** _(derece, aradalık, PageRank ve bağ gücü birleşik puanı)_');
  for (const m of merkeziyet.slice(0, 8)) {
    satirlar.push(`- **${m.ad}** _(${nd.VARLIK_TUR_ADI[m.tur] || m.tur})_ — etki ${m.etki}, ${m.derece} bağ, aradalık ${m.aradalik}`);
  }
  satirlar.push('');

  const anlamliGruplar = gruplar.filter((gr) => gr.boyut >= 2);
  if (anlamliGruplar.length) {
    satirlar.push(`**Topluluklar (${anlamliGruplar.length})**`);
    const adHarita = new Map(dugumler.map((d) => [Number(d.id), d.ad]));
    for (const gr of anlamliGruplar.slice(0, 6)) {
      const adlar = gr.uyeler.slice(0, 6).map((id) => adHarita.get(Number(id))).filter(Boolean);
      satirlar.push(`- Küme ${gr.no} (${gr.boyut} varlık): ${adlar.join(', ')}${gr.boyut > 6 ? ' …' : ''}`);
    }
    satirlar.push('');
  }

  if (kritik.kesimNoktalari.length) {
    satirlar.push('**Kritik düğümler** _(çıkarılırsa ağ parçalanır)_');
    satirlar.push(kritik.kesimNoktalari.slice(0, 10).map((k) => k.ad).join(', '));
    satirlar.push('');
  }

  if (tahminler.length) {
    satirlar.push('**Henüz kurulmamış olası bağlantılar** _(ortak komşu analizi)_');
    for (const t of tahminler.slice(0, 6)) {
      satirlar.push(`- ${t.adA} ↔ ${t.adB} — ${nd.sayili(t.ortak, 'ortak bağlantı')} (${t.ortakAdlar.slice(0, 3).join(', ')}), puan ${t.puan}`);
    }
    satirlar.push('');
    satirlar.push('_Bu satırlar bir iddia değil, incelenmesi gereken hipotezlerdir: iki varlığın çok sayıda ortak bağlantısı olup aralarında kayıtlı ilişki bulunmuyor._');
  }

  return {
    cevap: satirlar.join('\n'),
    bulgular: merkeziyet.slice(0, 6).map((m) => ({
      kaynakTur: 'varlik', kaynakId: Number(m.id), baslik: m.ad,
      alinti: `etki ${m.etki} · ${m.derece} bağ · aradalık ${m.aradalik}`,
      puan: m.etki, yol: `/arsiv/varlik/${m.id}`, etiket: 'varlık',
    })),
    veri: { ozet, merkeziyet: merkeziyet.slice(0, 25), gruplar: anlamliGruplar.slice(0, 10), kritik, tahminler },
    eylemler: [{ etiket: 'Bağlantı grafiğini aç', yol: '/analiz/graf' }],
  };
}

/** ZAMAN CIZGISI: belirli bir aralikta ne oldu. */
async function islemZamanCizgisi(soru) {
  const normal = dil.normalize(soru);
  const gun = zamanAraligi(normal) || 30;

  const [olaylar, kayitlar] = await Promise.all([
    db.satirlar(
      `SELECT id, kod, baslik, zaman, tur, konum, onem, tasnif
         FROM olaylar
        WHERE silindi = FALSE AND zaman > NOW() - ($1 || ' days')::interval
        ORDER BY zaman DESC LIMIT 400`,
      [String(gun)],
    ),
    db.satirlar(
      `SELECT id, kod, baslik, ozet, govde, tur, tasnif, durum, guvenilirlik,
              COALESCE(olay_zamani, olusturuldu_at) AS zaman
         FROM kayitlar
        WHERE silindi = FALSE
          AND COALESCE(olay_zamani, olusturuldu_at) > NOW() - ($1 || ' days')::interval
        ORDER BY zaman DESC LIMIT 400`,
      [String(gun)],
    ),
  ]);

  const tumZamanlar = [...olaylar.map((o) => new Date(o.zaman)), ...kayitlar.map((k) => new Date(k.zaman))];
  if (tumZamanlar.length === 0) {
    return {
      cevap: `Son ${nd.sayili(gun, 'gün')} içinde arşive giren olay veya kayıt yok.`,
      bulgular: [], veri: { gun }, eylemler: [{ etiket: 'Kayıt ekle', yol: '/arsiv/kayitlar' }],
    };
  }

  const granularite = gun <= 3 ? 'saat' : gun <= 60 ? 'gun' : gun <= 400 ? 'hafta' : 'ay';
  const seri = ist.zamanSerisi(tumZamanlar, granularite);
  const degerler = seri.kovalar.map((k) => k.deger);
  const egilim = ist.egilim(degerler);
  const patlamalar = ist.patlama(seri.kovalar, { pencere: Math.min(7, Math.max(3, Math.floor(seri.kovalar.length / 4))), esik: 2 });
  const mevsim = ist.mevsimsellik(tumZamanlar);

  // Konu kumeleri
  const metinler = kayitlar.map((k) => `${k.baslik} ${k.ozet || k.govde || ''}`);
  let kumeler = [];
  if (metinler.length >= 4) {
    const sayilar = metinler.map((m) => dil.terimSikligi(m));
    const { idf } = metrik.idfHesapla(sayilar);
    const vektorler = sayilar.map((s) => metrik.tfIdf(s, idf));
    const k = metrik.kumele(vektorler, { k: Math.min(5, Math.max(2, Math.round(metinler.length / 4))) });
    kumeler = k.kumeler.map((c) => ({
      baslik: c.baslik.slice(0, 4),
      ornekler: c.uyeler.slice(0, 3).map((u) => kayitlar[u].baslik),
      boyut: c.uyeler.length,
    })).sort((a, b) => b.boyut - a.boyut);
  }

  const satirlar = [];
  satirlar.push(`### Son ${nd.sayili(gun, 'gün')}`);
  satirlar.push(`${nd.sayili(kayitlar.length, 'kayıt')} ve ${nd.sayili(olaylar.length, 'olay')} · ${granularite} bazında ${seri.kovalar.length} kova`);
  if (egilim) satirlar.push(`Eğilim: **${egilim.yon}** (kova başına %${egilim.kovaBasinaYuzde}, güven ${egilim.guven}).`);
  satirlar.push('');

  if (patlamalar.length) {
    satirlar.push('**Hareketlilik sıçramaları**');
    for (const p of patlamalar.slice(-4)) {
      satirlar.push(`- **${p.etiket}** — ${p.deger} giriş (temel ortalama ${p.temelOrtalama}, ${p.kat}× ; z=${p.z})`);
    }
    satirlar.push('');
  }

  if (kumeler.length) {
    satirlar.push('**Dönemin konu kümeleri**');
    for (const k of kumeler.slice(0, 4)) {
      satirlar.push(`- ${k.baslik.join(' · ')} _(${k.boyut} kayıt)_ — örn. ${k.ornekler[0]}`);
    }
    satirlar.push('');
  }

  const onemliOlaylar = [...olaylar].sort((a, b) => (b.onem || 0) - (a.onem || 0)).slice(0, 6);
  if (onemliOlaylar.length) {
    satirlar.push('**Öne çıkan olaylar**');
    for (const o of onemliOlaylar) {
      satirlar.push(`- ${nd.tarihSozcuk(o.zaman, { gunAdi: false })} — ${o.baslik}${o.konum ? ` · ${o.konum}` : ''} _(önem ${o.onem})_`);
    }
    satirlar.push('');
  }

  if (mevsim) {
    satirlar.push(
      `**Zamanlama örüntüsü:** en yoğun gün ${mevsim.enYogunGun}, en yoğun saat ${mevsim.enYogunSaat}; ` +
      `gece saatleri payı %${mevsim.geceOrani}, hafta sonu payı %${mevsim.haftaSonuOrani}.`,
    );
  }

  return {
    cevap: satirlar.join('\n'),
    bulgular: [
      ...onemliOlaylar.slice(0, 4).map((o) => ({
        kaynakTur: 'olay', kaynakId: o.id, baslik: `${o.kod} ${o.baslik}`,
        alinti: `${nd.tarihSozcuk(o.zaman, { gunAdi: false })}${o.konum ? ' · ' + o.konum : ''}`,
        puan: o.onem || 0, tasnif: o.tasnif, yol: `/arsiv/olay/${o.id}`, etiket: 'olay',
      })),
      ...kayitlar.slice(0, 4).map((k) => ({
        kaynakTur: 'kayit', kaynakId: k.id, baslik: `${k.kod} ${k.baslik}`,
        alinti: (k.ozet || k.govde || '').slice(0, 220), puan: 1, tasnif: k.tasnif,
        yol: `/arsiv/kayit/${k.id}`, etiket: 'kayıt',
      })),
    ],
    veri: { gun, seri: seri.kovalar, egilim, patlamalar, mevsim, kumeler },
    eylemler: [{ etiket: 'Zaman çizgisini aç', yol: `/analiz/zaman?gun=${gun}` }],
  };
}

/** ANOMALI: patlama, sessizlik, uc degerler, Benford. */
async function islemAnomali(soru) {
  const gun = zamanAraligi(dil.normalize(soru)) || 180;

  const kayitlar = await db.satirlar(
    `SELECT id, kod, baslik, govde, ozet, guvenilirlik, dogruluk, tasnif,
            COALESCE(olay_zamani, olusturuldu_at) AS zaman
       FROM kayitlar
      WHERE silindi = FALSE AND COALESCE(olay_zamani, olusturuldu_at) > NOW() - ($1 || ' days')::interval
      ORDER BY zaman LIMIT 3000`,
    [String(gun)],
  );
  const olaylar = await db.satirlar(
    `SELECT id, kod, baslik, zaman, onem FROM olaylar
      WHERE silindi = FALSE AND zaman > NOW() - ($1 || ' days')::interval ORDER BY zaman LIMIT 3000`,
    [String(gun)],
  );

  const zamanlar = [...kayitlar.map((k) => new Date(k.zaman)), ...olaylar.map((o) => new Date(o.zaman))];
  const satirlar = ['### Anomali taraması'];

  if (zamanlar.length < 8) {
    satirlar.push(`Son ${nd.sayili(gun, 'gün')} içinde yalnızca ${zamanlar.length} giriş var; istatistiksel anomali taraması için yetersiz.`);
    return { cevap: satirlar.join('\n'), bulgular: [], veri: { gun }, eylemler: [] };
  }

  const seri = ist.zamanSerisi(zamanlar, gun <= 60 ? 'gun' : 'hafta');
  const degerler = seri.kovalar.map((k) => k.deger);
  const patlamalar = ist.patlama(seri.kovalar, { pencere: 7, esik: 2 });
  const sessizlikler = ist.sessizlik(seri.kovalar, { enAzUzunluk: 3 });
  const ucDegerler = ist.aykirilar(degerler, { esik: 3 });

  satirlar.push(`Taranan dönem: son ${nd.sayili(gun, 'gün')} · ${nd.sayili(zamanlar.length, 'giriş')} · ${seri.kovalar.length} kova`);
  satirlar.push('');

  let bulguVar = false;

  if (patlamalar.length) {
    bulguVar = true;
    satirlar.push(`**Hareketlilik patlaması (${patlamalar.length})**`);
    for (const p of patlamalar.slice(-5)) {
      satirlar.push(`- ${p.etiket}: ${p.deger} giriş, temel ortalama ${p.temelOrtalama} (${p.kat}×, z=${p.z})`);
    }
    satirlar.push('');
  }

  if (sessizlikler.length) {
    bulguVar = true;
    satirlar.push(`**Beklenmeyen sessizlik (${sessizlikler.length})**`);
    for (const s of sessizlikler.slice(-4)) {
      satirlar.push(`- ${s.basEtiket} → ${s.sonEtiket}: ${nd.sayili(s.uzunluk, 'kova')} boyunca hiç giriş yok (beklenen ≈ ${s.beklenenHareket})${s.suruyor ? ' · **hâlâ sürüyor**' : ''}`);
    }
    satirlar.push('');
  }

  if (ucDegerler.length) {
    bulguVar = true;
    satirlar.push(`**Uç değerler (${ucDegerler.length})** _(medyan mutlak sapma tabanlı)_`);
    for (const u of ucDegerler.slice(0, 5)) {
      const kova = seri.kovalar[u.dizin];
      satirlar.push(`- ${kova ? kova.etiket : u.dizin}: ${u.deger} giriş (sağlam z = ${u.saglamZ})`);
    }
    satirlar.push('');
  }

  // Benford: kayit govdelerindeki para tutarlari
  const tutarlar = [];
  for (const k of kayitlar) {
    const cikarim = varlikCikarim.cikar(`${k.baslik} ${k.govde || ''}`, { minGuven: 0.8 });
    for (const b of cikarim.bulgular) {
      if (b.tur !== 'para') continue;
      const sayi = Number(String(b.deger).replace(/[^\d,.]/g, '').replace(/\./g, '').replace(',', '.'));
      if (Number.isFinite(sayi) && sayi >= 1) tutarlar.push(sayi);
    }
  }
  const benford = ist.benford(tutarlar);
  if (benford.yeterliVeri) {
    bulguVar = true;
    satirlar.push('**Mali tutar tutarlılığı (Benford yasası)**');
    satirlar.push(`${nd.sayili(benford.toplam, 'tutar')} incelendi · χ² = ${benford.kiKare} (kritik ${benford.kritikDeger}) · en büyük sapma %${benford.enBuyukSapma}`);
    satirlar.push(benford.sapiyor ? `⚠ ${benford.yorum}` : benford.yorum);
    satirlar.push('');
  } else if (tutarlar.length) {
    satirlar.push(`_Kayıtlarda ${nd.sayili(tutarlar.length, 'para tutarı')} bulundu; Benford testi için en az 50 tutar gerekiyor._`);
    satirlar.push('');
  }

  // Dusuk guvenilirlik + yuksek tasnif celiskisi
  const riskliTasnif = kayitlar.filter((k) => ['gizli', 'cok_gizli'].includes(k.tasnif) && ['D', 'E', 'F'].includes(k.guvenilirlik));
  if (riskliTasnif.length) {
    bulguVar = true;
    satirlar.push(`**Tasnif/güvenilirlik uyuşmazlığı (${riskliTasnif.length})**`);
    satirlar.push('Yüksek tasnifli ama kaynak güvenilirliği düşük kayıtlar — yayılmadan önce doğrulanmalı:');
    for (const k of riskliTasnif.slice(0, 5)) {
      satirlar.push(`- ${k.kod} (${nd.TASNIF_ADI[k.tasnif]}, kaynak ${k.guvenilirlik}) — ${k.baslik}`);
    }
    satirlar.push('');
  }

  if (!bulguVar) satirlar.push('Taramada istatistiksel olarak dikkat çeken bir sapma bulunmadı.');

  return {
    cevap: satirlar.join('\n'),
    bulgular: riskliTasnif.slice(0, 5).map((k) => ({
      kaynakTur: 'kayit', kaynakId: k.id, baslik: `${k.kod} ${k.baslik}`,
      alinti: `${nd.TASNIF_ADI[k.tasnif]} · kaynak ${k.guvenilirlik}`,
      puan: 1, tasnif: k.tasnif, yol: `/arsiv/kayit/${k.id}`, etiket: 'kayıt',
    })),
    veri: { gun, seri: seri.kovalar, patlamalar, sessizlikler, ucDegerler, benford },
    eylemler: [{ etiket: 'Analiz panosu', yol: '/analiz' }],
  };
}

/** RISK: onem puani, ag etkisi ve kayit yogunlugunu birlestiren siralama. */
async function islemRisk() {
  const varliklar = await db.satirlar(
    `SELECT v.id, v.kod, v.ad, v.tur, v.onem, v.durum, v.tasnif,
            (SELECT COUNT(*)::int FROM kayit_varliklari kv JOIN kayitlar k ON k.id = kv.kayit_id
              WHERE kv.varlik_id = v.id AND k.silindi = FALSE) AS kayit_sayisi,
            (SELECT COUNT(*)::int FROM varlik_iliskileri i
              WHERE i.kaynak_varlik_id = v.id OR i.hedef_varlik_id = v.id) AS iliski_sayisi,
            (SELECT COUNT(*)::int FROM kayit_varliklari kv JOIN kayitlar k ON k.id = kv.kayit_id
              WHERE kv.varlik_id = v.id AND k.silindi = FALSE AND k.durum = 'dogrulandi') AS dogrulanan,
            (SELECT MAX(COALESCE(k.olay_zamani, k.olusturuldu_at)) FROM kayit_varliklari kv
               JOIN kayitlar k ON k.id = kv.kayit_id WHERE kv.varlik_id = v.id) AS son_hareket
       FROM varliklar v
      WHERE v.silindi = FALSE
      LIMIT 4000`,
  );

  if (varliklar.length === 0) {
    return { cevap: 'Arşivde değerlendirilecek varlık yok.', bulgular: [], veri: {}, eylemler: [] };
  }

  const esikSatir = await db.tekSatir("SELECT deger FROM ayarlar WHERE anahtar = 'risk_esigi'");
  const esik = Number(esikSatir && esikSatir.deger) || 70;

  const simdi = Date.now();
  const puanli = varliklar.map((v) => {
    const tazelik = v.son_hareket
      ? Math.max(0, 1 - (simdi - new Date(v.son_hareket).getTime()) / (180 * 86_400_000))
      : 0;
    const puan =
      0.34 * (v.onem / 100) +
      0.22 * Math.min(1, v.kayit_sayisi / 10) +
      0.18 * Math.min(1, v.iliski_sayisi / 12) +
      0.14 * Math.min(1, v.dogrulanan / 4) +
      0.12 * tazelik;

    const gerekce = [];
    if (v.onem >= esik) gerekce.push(`önem ${v.onem}`);
    if (v.kayit_sayisi >= 5) gerekce.push(`${v.kayit_sayisi} kayıt`);
    if (v.iliski_sayisi >= 6) gerekce.push(`${v.iliski_sayisi} bağ`);
    if (v.dogrulanan >= 2) gerekce.push(`${v.dogrulanan} doğrulanmış kayıt`);
    if (tazelik > 0.6) gerekce.push('son dönemde hareketli');
    if (v.durum === 'izlemede') gerekce.push('izlemede');

    return { ...v, risk: Math.round(puan * 1000) / 10, gerekce };
  }).sort((a, b) => b.risk - a.risk);

  const satirlar = ['### Risk sıralaması'];
  satirlar.push(
    '_Puan = önem (%34) + kayıt yoğunluğu (%22) + ağ genişliği (%18) + doğrulanmış kayıt (%14) + tazelik (%12)_',
  );
  satirlar.push('');

  for (const v of puanli.slice(0, 10)) {
    satirlar.push(
      `- **${v.ad}** _(${nd.VARLIK_TUR_ADI[v.tur] || v.tur})_ — risk **${v.risk}** · ` +
      (v.gerekce.length ? v.gerekce.join(', ') : 'belirgin gerekçe yok'),
    );
  }

  const esikUstu = puanli.filter((v) => v.onem >= esik);
  satirlar.push('');
  satirlar.push(`Önem eşiği ${esik} üzerinde ${nd.sayili(esikUstu.length, 'varlık')} var.`);

  const sessizAmaOnemli = puanli.filter((v) => v.onem >= esik && (!v.son_hareket || simdi - new Date(v.son_hareket).getTime() > 120 * 86_400_000));
  if (sessizAmaOnemli.length) {
    satirlar.push('');
    satirlar.push('**Önemli ama uzun süre hareketsiz** _(takip boşluğu olabilir)_');
    satirlar.push(sessizAmaOnemli.slice(0, 6).map((v) => `${v.ad}${v.son_hareket ? ` (${nd.gorece(v.son_hareket)})` : ' (hiç kayıt yok)'}`).join(', '));
  }

  return {
    cevap: satirlar.join('\n'),
    bulgular: puanli.slice(0, 6).map((v) => ({
      kaynakTur: 'varlik', kaynakId: v.id, baslik: `${v.kod} ${v.ad}`,
      alinti: `risk ${v.risk} · ${v.gerekce.join(', ')}`, puan: v.risk,
      tasnif: v.tasnif, yol: `/arsiv/varlik/${v.id}`, etiket: 'varlık',
    })),
    veri: { esik, siralama: puanli.slice(0, 30), esikUstuSayi: esikUstu.length },
    eylemler: [{ etiket: 'Varlık listesi', yol: '/arsiv/varliklar?sirala=onem' }],
  };
}

/** CELISKI: birbirini tutmayan kayitlari arar. */
async function islemCeliski() {
  const satirlar = ['### Çelişki taraması'];
  const bulgular = [];
  let sayac = 0;

  // 1) Ayni varlik icin dogrulanmis / yalanlanmis kayitlar
  const zit = await db.satirlar(
    `SELECT v.id AS varlik_id, v.ad, v.kod,
            COUNT(*) FILTER (WHERE k.durum = 'dogrulandi')::int AS dogrulanan,
            COUNT(*) FILTER (WHERE k.durum = 'yalanlandi')::int AS yalanlanan
       FROM kayit_varliklari kv
       JOIN kayitlar k ON k.id = kv.kayit_id AND k.silindi = FALSE
       JOIN varliklar v ON v.id = kv.varlik_id AND v.silindi = FALSE
      GROUP BY v.id, v.ad, v.kod
     HAVING COUNT(*) FILTER (WHERE k.durum = 'dogrulandi') > 0
        AND COUNT(*) FILTER (WHERE k.durum = 'yalanlandi') > 0
      ORDER BY (COUNT(*) FILTER (WHERE k.durum = 'yalanlandi')) DESC LIMIT 20`,
  );
  if (zit.length) {
    sayac += zit.length;
    satirlar.push('');
    satirlar.push(`**Hem doğrulanmış hem yalanlanmış kayıt taşıyan varlıklar (${zit.length})**`);
    for (const z of zit.slice(0, 8)) {
      satirlar.push(`- ${z.ad} — ${z.dogrulanan} doğrulanmış, ${z.yalanlanan} yalanlanmış kayıt`);
      bulgular.push({
        kaynakTur: 'varlik', kaynakId: z.varlik_id, baslik: `${z.kod} ${z.ad}`,
        alinti: `${z.dogrulanan} doğrulanmış / ${z.yalanlanan} yalanlanmış`,
        puan: z.yalanlanan, yol: `/arsiv/varlik/${z.varlik_id}`, etiket: 'varlık',
      });
    }
  }

  // 2) Ayni gun, farkli sehirde gorulen varliklar (fiziksel imkansizlik)
  const cakisma = await db.satirlar(
    `SELECT v.id AS varlik_id, v.ad, v.kod, date_trunc('day', o1.zaman) AS gun,
            o1.konum AS konum1, o2.konum AS konum2,
            o1.id AS olay1, o2.id AS olay2, o1.baslik AS baslik1, o2.baslik AS baslik2
       FROM olay_varliklari ov1
       JOIN olay_varliklari ov2 ON ov1.varlik_id = ov2.varlik_id AND ov1.olay_id < ov2.olay_id
       JOIN olaylar o1 ON o1.id = ov1.olay_id AND o1.silindi = FALSE
       JOIN olaylar o2 ON o2.id = ov2.olay_id AND o2.silindi = FALSE
       JOIN varliklar v ON v.id = ov1.varlik_id AND v.silindi = FALSE
      WHERE o1.konum IS NOT NULL AND o2.konum IS NOT NULL
        AND arsiv_normalize(o1.konum) <> arsiv_normalize(o2.konum)
        AND date_trunc('day', o1.zaman) = date_trunc('day', o2.zaman)
        AND o1.belirsizlik = 'kesin' AND o2.belirsizlik = 'kesin'
      LIMIT 20`,
  );
  if (cakisma.length) {
    sayac += cakisma.length;
    satirlar.push('');
    satirlar.push(`**Aynı gün iki ayrı konumda görünen varlıklar (${cakisma.length})**`);
    for (const c of cakisma.slice(0, 8)) {
      satirlar.push(`- ${c.ad} · ${nd.tarihSozcuk(c.gun, { gunAdi: false })} — "${c.konum1}" ve "${c.konum2}"`);
    }
    satirlar.push('_İkisi de "kesin" zaman damgalı; en az biri hatalı ya da aynı adı taşıyan iki ayrı varlık var._');
  }

  // 3) Ayni kimlik degerini paylasan farkli varliklar (tekrarli kayit)
  const tekrar = await db.satirlar(
    `SELECT a.ozellikler->>'normal' AS deger, COUNT(*)::int AS adet,
            ARRAY_AGG(a.ad) AS adlar, ARRAY_AGG(a.id) AS kimlikler
       FROM varliklar a
      WHERE a.silindi = FALSE
        AND a.ozellikler->>'normal' IS NOT NULL
        AND a.tur IN ('telefon','eposta','hesap','cihaz','arac')
      GROUP BY a.ozellikler->>'normal'
     HAVING COUNT(*) > 1
      LIMIT 20`,
  );
  if (tekrar.length) {
    sayac += tekrar.length;
    satirlar.push('');
    satirlar.push(`**Aynı tanımlayıcıya sahip birden fazla varlık (${tekrar.length})**`);
    for (const t of tekrar.slice(0, 8)) {
      satirlar.push(`- \`${t.deger}\` → ${t.adlar.join(', ')} _(birleştirilmeli)_`);
    }
  }

  // 4) Benzer adli varliklar (ayni kisi iki kez girilmis olabilir)
  const adaylar = await db.satirlar(
    "SELECT id, kod, ad, tur FROM varliklar WHERE silindi = FALSE AND tur IN ('kisi','kurum') LIMIT 3000",
  );
  const kopyalar = [];
  for (let i = 0; i < adaylar.length; i++) {
    for (let j = i + 1; j < adaylar.length; j++) {
      if (adaylar[i].tur !== adaylar[j].tur) continue;
      const p = dil.benzerlik(adaylar[i].ad, adaylar[j].ad);
      if (p >= 0.88 && adaylar[i].ad !== adaylar[j].ad) {
        kopyalar.push({ a: adaylar[i], b: adaylar[j], benzerlik: Math.round(p * 100) });
      }
      if (kopyalar.length >= 20) break;
    }
    if (kopyalar.length >= 20) break;
  }
  if (kopyalar.length) {
    sayac += kopyalar.length;
    satirlar.push('');
    satirlar.push(`**Birbirine çok benzeyen varlık adları (${kopyalar.length})**`);
    for (const k of kopyalar.slice(0, 8)) {
      satirlar.push(`- "${k.a.ad}" ↔ "${k.b.ad}" — %${k.benzerlik} benzer _(aynı varlık olabilir)_`);
    }
  }

  if (sayac === 0) {
    satirlar.push('');
    satirlar.push('Taranan dört çelişki türünde (zıt kayıt durumu, aynı gün çakışan konum, tekrarlı tanımlayıcı, benzer ad) bulgu yok.');
  } else {
    satirlar.push('');
    satirlar.push(`Toplam **${sayac}** olası çelişki işaretlendi. Hiçbiri tek başına hata kanıtı değildir; her biri doğrulama gerektirir.`);
  }

  return {
    cevap: satirlar.join('\n'),
    bulgular,
    veri: { zit, cakisma, tekrar, kopyalar: kopyalar.slice(0, 20), toplam: sayac },
    eylemler: [{ etiket: 'Varlıkları incele', yol: '/arsiv/varliklar' }],
  };
}

/** BOSLUK: eksik veri ve takip edilmeyen uclar. */
async function islemBosluk() {
  const [kaynaksiz, incelenmeyen, ilgisizVarlik, cozumlenmemis, kayitsizVarlik, eskiVaka] = await Promise.all([
    db.tekSatir('SELECT COUNT(*)::int AS n FROM kayitlar WHERE silindi = FALSE AND kaynak_id IS NULL'),
    db.satirlar(
      `SELECT id, kod, baslik, tasnif, olusturuldu_at FROM kayitlar
        WHERE silindi = FALSE AND durum = 'yeni' AND olusturuldu_at < NOW() - INTERVAL '14 days'
        ORDER BY olusturuldu_at LIMIT 20`,
    ),
    db.satirlar(
      `SELECT v.id, v.kod, v.ad, v.tur, v.onem FROM varliklar v
        WHERE v.silindi = FALSE AND v.onem >= 60
          AND NOT EXISTS (SELECT 1 FROM varlik_iliskileri i WHERE i.kaynak_varlik_id = v.id OR i.hedef_varlik_id = v.id)
        ORDER BY v.onem DESC LIMIT 20`,
    ),
    db.tekSatir(
      `SELECT COUNT(*)::int AS n FROM dosyalar d
        WHERE d.silindi = FALSE AND NOT EXISTS (SELECT 1 FROM belge_cozumleme c WHERE c.dosya_id = d.id AND c.durum IN ('tamam','kismi'))`,
    ),
    db.satirlar(
      `SELECT v.id, v.kod, v.ad, v.tur, v.onem FROM varliklar v
        WHERE v.silindi = FALSE AND v.onem >= 50
          AND NOT EXISTS (SELECT 1 FROM kayit_varliklari kv WHERE kv.varlik_id = v.id)
        ORDER BY v.onem DESC LIMIT 20`,
    ),
    db.satirlar(
      `SELECT id, kod, ad, oncelik, guncellendi_at FROM vakalar
        WHERE silindi = FALSE AND durum = 'acik' AND guncellendi_at < NOW() - INTERVAL '30 days'
        ORDER BY guncellendi_at LIMIT 10`,
    ),
  ]);

  const satirlar = ['### Bilgi boşlukları'];
  satirlar.push('_Arşivin kendisi hakkında ne bilmediğimizi gösteren tarama._');
  satirlar.push('');
  let bulguVar = false;

  if (kaynaksiz.n > 0) {
    bulguVar = true;
    satirlar.push(`- **${nd.sayili(kaynaksiz.n, 'kayıt')}** hiçbir kaynağa bağlı değil: güvenilirlik derecesi anlamsız kalıyor.`);
  }
  if (cozumlenmemis.n > 0) {
    bulguVar = true;
    satirlar.push(`- **${nd.sayili(cozumlenmemis.n, 'dosya')}** henüz çözümlenmedi: içeriği aramaya ve zekâya görünmüyor.`);
  }
  if (incelenmeyen.length) {
    bulguVar = true;
    satirlar.push(`- **${nd.sayili(incelenmeyen.length, 'kayıt')}** iki haftadan uzun süredir "yeni" durumunda bekliyor.`);
    satirlar.push(`  En eskisi: ${incelenmeyen[0].kod} — ${incelenmeyen[0].baslik} (${nd.gorece(incelenmeyen[0].olusturuldu_at)})`);
  }
  if (ilgisizVarlik.length) {
    bulguVar = true;
    satirlar.push(`- **${nd.sayili(ilgisizVarlik.length, 'önemli varlık')}** (önem ≥ 60) hiçbir ilişkiye bağlı değil: ${ilgisizVarlik.slice(0, 5).map((v) => v.ad).join(', ')}`);
  }
  if (kayitsizVarlik.length) {
    bulguVar = true;
    satirlar.push(`- **${nd.sayili(kayitsizVarlik.length, 'varlık')}** (önem ≥ 50) hiçbir kayıtta geçmiyor: ${kayitsizVarlik.slice(0, 5).map((v) => v.ad).join(', ')}`);
  }
  if (eskiVaka.length) {
    bulguVar = true;
    satirlar.push(`- **${nd.sayili(eskiVaka.length, 'açık vaka')}** bir aydan uzun süredir güncellenmedi: ${eskiVaka.slice(0, 4).map((v) => v.ad).join(', ')}`);
  }

  if (!bulguVar) satirlar.push('Taranan altı boşluk türünde eksik bulunmadı — arşiv tutarlı görünüyor.');
  else {
    satirlar.push('');
    satirlar.push('**Önerilen sıra:** çözümlenmemiş dosyalar → bekleyen kayıtlar → ilişkisiz önemli varlıklar.');
  }

  return {
    cevap: satirlar.join('\n'),
    bulgular: [
      ...incelenmeyen.slice(0, 4).map((k) => ({
        kaynakTur: 'kayit', kaynakId: k.id, baslik: `${k.kod} ${k.baslik}`,
        alinti: `${nd.gorece(k.olusturuldu_at)} · hâlâ "yeni"`, puan: 1,
        tasnif: k.tasnif, yol: `/arsiv/kayit/${k.id}`, etiket: 'kayıt',
      })),
      ...ilgisizVarlik.slice(0, 4).map((v) => ({
        kaynakTur: 'varlik', kaynakId: v.id, baslik: `${v.kod} ${v.ad}`,
        alinti: `önem ${v.onem} · hiç ilişki yok`, puan: v.onem,
        yol: `/arsiv/varlik/${v.id}`, etiket: 'varlık',
      })),
    ],
    veri: { kaynaksiz: kaynaksiz.n, cozumlenmemis: cozumlenmemis.n, incelenmeyen: incelenmeyen.length, ilgisizVarlik: ilgisizVarlik.length, kayitsizVarlik: kayitsizVarlik.length, eskiVaka: eskiVaka.length },
    eylemler: [
      { etiket: 'Çözümlenmeyen dosyalar', yol: '/depo' },
      { etiket: 'Bekleyen kayıtlar', yol: '/arsiv/kayitlar?durum=yeni' },
    ],
  };
}

/** OZET: bir kaydi, belgeyi ya da serbest metni ozetler. */
async function islemOzet(soru, baglam) {
  // Kod referansi var mi?
  const kod = (soru.match(/\b(KYT|VRL|OLY|VAK)-?(\d{3,6})\b/i) || [])[0];
  let hedefMetin = '';
  let hedefBaslik = '';
  let hedefYol = null;
  let bulgular = [];

  if (kod) {
    const duzgun = kod.toUpperCase().replace(/^(\w{3})-?/, '$1-');
    const kayit = await db.tekSatir(
      'SELECT id, kod, baslik, govde, ozet FROM kayitlar WHERE upper(kod) LIKE $1 AND silindi = FALSE',
      [`${duzgun.split('-')[0]}%${Number(duzgun.split('-')[1])}`],
    ) || await db.tekSatir(
      'SELECT id, kod, baslik, govde, ozet FROM kayitlar WHERE upper(kod) = $1 AND silindi = FALSE',
      [duzgun],
    );
    if (kayit) {
      hedefMetin = kayit.govde || '';
      hedefBaslik = `${kayit.kod} — ${kayit.baslik}`;
      hedefYol = `/arsiv/kayit/${kayit.id}`;
      bulgular = [{
        kaynakTur: 'kayit', kaynakId: kayit.id, baslik: hedefBaslik,
        alinti: (kayit.govde || '').slice(0, 240), puan: 1, yol: hedefYol, etiket: 'kayıt',
      }];
    }
  }

  // Kod yoksa: arama yapip en iyi eslesmeyi ozetle
  if (!hedefMetin) {
    const temizSoru = soru.replace(/\b(ozetle|ozet|kisaca|cikar|ver)\b/gi, ' ').trim();
    const { sonuclar } = await dizin.ara(temizSoru || soru, { limit: 6, enUstTasnif: baglam.enUstTasnif });
    if (sonuclar.length === 0) {
      return {
        cevap: 'Özetlenecek bir kaynak bulamadım. Kayıt kodunu (örn. KYT-000123) yazabilir ya da metni doğrudan yapıştırabilirsin.',
        bulgular: [], veri: {}, eylemler: [],
      };
    }
    hedefMetin = sonuclar.map((s) => s.metin || s.alinti).join('\n\n');
    hedefBaslik = sonuclar[0].baslik;
    hedefYol = kaynakYolu(sonuclar[0].kaynak_tur, sonuclar[0].kaynak_id);
    bulgular = await bulgulariZenginlestir(bulgulariBicimle(sonuclar));
  }

  const ozet = metrik.ozetle(hedefMetin, { cumleSayisi: 5, maxKarakter: 1500 });
  const anahtar = metrik.anahtarKelimeler(hedefMetin, { adet: 8 });
  const okuma = metrik.okunabilirlik(hedefMetin);
  const cikarim = varlikCikarim.cikar(hedefMetin, { minGuven: 0.7 });

  const satirlar = [`### Özet — ${hedefBaslik}`];
  satirlar.push('');
  satirlar.push(ozet.ozet || '_Özetlenecek yeterli metin yok._');
  satirlar.push('');
  if (anahtar.length) satirlar.push(`**Anahtar kavramlar:** ${anahtar.map((a) => a.obek).join(' · ')}`);
  if (okuma) satirlar.push(`**Metin ölçüsü:** ${okuma.kelimeSayisi} kelime, ${okuma.cumleSayisi} cümle · okunabilirlik ${okuma.puan}/100 (${okuma.seviye})`);

  const onemliTurler = ['kisi', 'kurum', 'konum', 'tarih', 'para', 'telefon', 'iban', 'tckn', 'plaka'];
  const cikanlar = onemliTurler
    .filter((t) => cikarim.gruplar[t])
    .map((t) => `${nd.VARLIK_TUR_ADI[t] || t}: ${cikarim.gruplar[t].slice(0, 5).map((b) => b.deger).join(', ')}`);
  if (cikanlar.length) {
    satirlar.push('');
    satirlar.push('**Metinden çıkarılan varlıklar**');
    for (const c of cikanlar) satirlar.push(`- ${c}`);
  }
  if (cikarim.temalar.length) {
    satirlar.push('');
    satirlar.push(`**Tematik ağırlık:** ${cikarim.temalar.slice(0, 4).map((t) => `${t.tema} (${t.puan})`).join(', ')}`);
  }

  return {
    cevap: satirlar.join('\n'),
    bulgular,
    veri: { ozetCumleSayisi: ozet.cumleler.length, anahtar, okuma, cikarim: cikarim.ozet },
    eylemler: hedefYol ? [{ etiket: 'Kaynağı aç', yol: hedefYol }] : [],
  };
}

/** SINIFLANDIR: egitilmis yerel modelle metni etiketler. */
async function islemSiniflandir(soru) {
  const modelSatiri = await db.tekSatir("SELECT veri, ornek_sayisi, basari, guncellendi_at FROM zeka_modelleri WHERE ad = 'kayit_turu'");
  const metin = soru.replace(/\b(siniflandir|hangi kategori|hangi tur|tasnif et|kategorize)\b/gi, ' ').trim();

  if (!modelSatiri || !modelSatiri.veri || !modelSatiri.veri.hazir) {
    return {
      cevap: 'Sınıflandırma modeli henüz eğitilmedi. Arşivde en az iki farklı türde yeterli kayıt olduğunda ' +
        'Ayarlar → Çekirdek Zekâ ekranından "Modeli eğit" diyebilirsin; eğitim bu makinede yapılır, dışarıya veri gitmez.',
      bulgular: [], veri: {}, eylemler: [{ etiket: 'Çekirdek Zekâ ayarları', yol: '/ayarlar#zeka' }],
    };
  }

  if (metin.length < 12) {
    return {
      cevap: 'Sınıflandırmak için bir metin ver: "şunu sınıflandır: <metin>" biçiminde yazabilirsin.',
      bulgular: [], veri: {}, eylemler: [],
    };
  }

  const sonuc = siniflandirici.tahmin(modelSatiri.veri, metin);
  const satirlar = ['### Sınıflandırma'];
  if (!sonuc.etiket) {
    satirlar.push('Metindeki terimler modelin dağarcığında yok; güvenilir bir tahmin üretemedim.');
  } else {
    satirlar.push(`Tahmin: **${nd.KAYIT_TUR_ADI[sonuc.etiket] || sonuc.etiket}** · güven %${Math.round(sonuc.guven * 100)}`);
    satirlar.push('');
    satirlar.push('**Olasılık dağılımı**');
    for (const s of sonuc.siralama) {
      satirlar.push(`- ${nd.KAYIT_TUR_ADI[s.etiket] || s.etiket}: %${Math.round(s.olasilik * 100)}`);
    }
    if (sonuc.gerekce.length) {
      satirlar.push('');
      satirlar.push(`**Kararı belirleyen terimler:** ${sonuc.gerekce.map((g) => `\`${g.terim}\``).join(', ')}`);
    }
    satirlar.push('');
    satirlar.push(
      `_Model ${nd.sayili(modelSatiri.ornek_sayisi || 0, 'örnekle')} eğitildi` +
      (modelSatiri.basari ? `, çapraz doğrulama başarısı %${modelSatiri.basari}` : '') +
      `; son güncelleme ${nd.gorece(modelSatiri.guncellendi_at)}._`,
    );
  }

  return { cevap: satirlar.join('\n'), bulgular: [], veri: { sonuc }, eylemler: [] };
}

/** ISTATISTIK: arsivin sayisal durumu. */
async function islemIstatistik() {
  const [genel, varlikTur, kayitTur, tasnif, guven, dizinDurum] = await Promise.all([
    db.tekSatir(`
      SELECT (SELECT COUNT(*)::int FROM varliklar WHERE silindi = FALSE) AS varlik,
             (SELECT COUNT(*)::int FROM kayitlar WHERE silindi = FALSE) AS kayit,
             (SELECT COUNT(*)::int FROM olaylar WHERE silindi = FALSE) AS olay,
             (SELECT COUNT(*)::int FROM vakalar WHERE silindi = FALSE) AS vaka,
             (SELECT COUNT(*)::int FROM varlik_iliskileri) AS iliski,
             (SELECT COUNT(*)::int FROM kaynaklar WHERE silindi = FALSE) AS kaynak,
             (SELECT COUNT(*)::int FROM dosyalar WHERE silindi = FALSE) AS dosya,
             (SELECT COUNT(*)::int FROM belge_cozumleme WHERE durum IN ('tamam','kismi')) AS cozumleme,
             (SELECT COUNT(*)::int FROM uyarilar WHERE okundu = FALSE) AS uyari`),
    db.satirlar('SELECT tur, COUNT(*)::int AS n FROM varliklar WHERE silindi = FALSE GROUP BY tur ORDER BY n DESC'),
    db.satirlar('SELECT tur, COUNT(*)::int AS n FROM kayitlar WHERE silindi = FALSE GROUP BY tur ORDER BY n DESC'),
    db.satirlar('SELECT tasnif, COUNT(*)::int AS n FROM kayitlar WHERE silindi = FALSE GROUP BY tasnif ORDER BY n DESC'),
    db.satirlar('SELECT guvenilirlik, COUNT(*)::int AS n FROM kayitlar WHERE silindi = FALSE GROUP BY guvenilirlik ORDER BY guvenilirlik'),
    dizin.durum(),
  ]);

  const satirlar = ['### Arşiv durumu'];
  satirlar.push('');
  satirlar.push(
    `${nd.sayili(genel.varlik, 'varlık')} · ${nd.sayili(genel.kayit, 'kayıt')} · ` +
    `${nd.sayili(genel.olay, 'olay')} · ${nd.sayili(genel.iliski, 'ilişki')} · ` +
    `${nd.sayili(genel.vaka, 'vaka')} · ${nd.sayili(genel.kaynak, 'kaynak')}`,
  );
  satirlar.push(`Depo: ${nd.sayili(genel.dosya, 'dosya')}, bunlardan ${genel.cozumleme} tanesi çözümlendi.`);
  satirlar.push(`Dizin: ${nd.sayili(dizinDurum.kaynak || 0, 'kaynak')} → ${nd.bicimliSayi(dizinDurum.parca || 0)} parça, ${nd.bicimliSayi(dizinDurum.tekil || 0)} tekil terim.`);
  if (genel.uyari) satirlar.push(`**${nd.sayili(genel.uyari, 'okunmamış uyarı')}** var.`);
  satirlar.push('');

  if (varlikTur.length) {
    satirlar.push('**Varlık türleri**');
    satirlar.push(varlikTur.map((v) => `${nd.VARLIK_TUR_ADI[v.tur] || v.tur}: ${v.n}`).join(' · '));
    satirlar.push('');
  }
  if (kayitTur.length) {
    satirlar.push('**Kayıt türleri**');
    satirlar.push(kayitTur.map((k) => `${nd.KAYIT_TUR_ADI[k.tur] || k.tur}: ${k.n}`).join(' · '));
    satirlar.push('');
  }
  if (tasnif.length) {
    satirlar.push('**Tasnif dağılımı**');
    satirlar.push(tasnif.map((t) => `${nd.TASNIF_ADI[t.tasnif] || t.tasnif}: ${t.n}`).join(' · '));
    satirlar.push('');
  }
  if (guven.length) {
    const cesit = ist.cesitlilik(new Map(guven.map((g) => [g.guvenilirlik, g.n])));
    satirlar.push('**Kaynak güvenilirliği**');
    satirlar.push(guven.map((g) => `${g.guvenilirlik} (${nd.GUVENILIRLIK_ADI[g.guvenilirlik] || '—'}): ${g.n}`).join(' · '));
    satirlar.push(`Çeşitlilik: ${cesit.normalize} (1'e yakın = dengeli dağılım)`);
  }

  return {
    cevap: satirlar.join('\n'),
    bulgular: [],
    veri: { genel, varlikTur, kayitTur, tasnif, guven, dizin: dizinDurum },
    eylemler: [{ etiket: 'Analiz panosu', yol: '/analiz' }],
  };
}

/** HESAP: matematik ifadesi. */
function islemHesap(soru) {
  const ifade = hesapMakinesi.ifadeCikar(soru);
  const sonuc = hesapMakinesi.hesapla(ifade);
  if (!sonuc.tamam) {
    return { cevap: `Bu ifadeyi hesaplayamadım: ${sonuc.hata || 'geçersiz ifade'}`, bulgular: [], veri: {}, eylemler: [] };
  }
  return {
    cevap: `\`${ifade.trim()}\` = **${sonuc.sonuc}**`,
    bulgular: [], veri: { ifade, sonuc: sonuc.sonuc }, eylemler: [],
  };
}

/** KIMLIK: motor kendini anlatir. */
async function islemKimlik() {
  const [durum, model] = await Promise.all([
    dizin.durum().catch(() => ({})),
    db.tekSatir("SELECT ornek_sayisi, basari FROM zeka_modelleri WHERE ad = 'kayit_turu'").catch(() => null),
  ]);

  const satirlar = [];
  satirlar.push('### CAMBAZ — Çekirdek Zekâ');
  satirlar.push('');
  satirlar.push(
    'Bu veri merkezinin dahili analiz motoruyum. Dışarıdaki hiçbir servise bağlanmam: ' +
    'bütün çıkarımı bu makinedeki arşivin üzerinde yaparım. Bir dil modeli taklidi değilim; ' +
    '**arşivden kanıt toplayıp kaynak göstererek** konuşurum. Dayanağım yoksa bunu söylerim.',
  );
  satirlar.push('');
  satirlar.push('**Yapabildiklerim**');
  satirlar.push('- `Ahmet Yılmaz kimdir?` → varlık dosyesi: ilişkiler, kayıtlar, olaylar, hareketlilik eğilimi, değerlendirme');
  satirlar.push('- `X ile Y arasındaki bağlantı ne?` → en kısa yol, alternatif yollar, ortak bağlantılar, ortak belgeler');
  satirlar.push('- `ağ yapısı` → kilit aktörler, topluluklar, kritik düğümler, kurulmamış olası bağlantılar');
  satirlar.push('- `son 30 günde ne oldu?` → zaman çizgisi, eğilim, sıçramalar, konu kümeleri, zamanlama örüntüsü');
  satirlar.push('- `anomali var mı?` → patlama, sessizlik, uç değer, Benford testi, tasnif/güvenilirlik uyuşmazlığı');
  satirlar.push('- `en riskli varlıklar` → gerekçeli risk sıralaması');
  satirlar.push('- `çelişki var mı?` → zıt kayıtlar, aynı gün farklı konum, tekrarlı tanımlayıcı, benzer adlar');
  satirlar.push('- `hangi boşluklar var?` → çözümlenmemiş dosya, bekleyen kayıt, ilişkisiz varlık');
  satirlar.push('- `KYT-000123 özetle` → çıkarımsal özet, anahtar kavramlar, çıkarılan varlıklar');
  satirlar.push('- `şunu sınıflandır: <metin>` → yerel eğitimli Naive Bayes ile tür tahmini + gerekçe');
  satirlar.push('- serbest arama: BM25 sıralaması + soru odaklı özet + doğrudan cevap çıkarımı');
  satirlar.push('');
  satirlar.push('**Nasıl çalışıyorum**');
  satirlar.push('- Türkçe çözümleme: sabit uzunluklu + morfolojik çift gövdeleme, durak sözcük ayıklama');
  satirlar.push('- Geri getirme: Okapi BM25, parçalı dizin (cümle düzeyinde kanıt)');
  satirlar.push('- Özetleme: cümle benzerlik grafiği üzerinde TextRank, soru odaklı ağırlıklandırma');
  satirlar.push('- Bağlantı analizi: Dijkstra, Brandes aradalığı, PageRank, etiket yayılımı, Adamic-Adar');
  satirlar.push('- İstatistik: z/MAD uç değer, patlama tespiti, Holt öngörüsü, Benford testi');
  satirlar.push('- Öğrenme: arşivin kendi etiketlerinden eğitilen çok terimli Naive Bayes');
  satirlar.push('');
  satirlar.push(
    `**Şu anki durum:** dizinde ${nd.bicimliSayi(durum.parca || 0)} parça / ` +
    `${nd.bicimliSayi(durum.tekil || 0)} tekil terim` +
    (model && model.ornek_sayisi ? `; sınıflandırıcı ${model.ornek_sayisi} örnekle eğitilmiş` : '; sınıflandırıcı henüz eğitilmemiş') +
    (model && model.basari ? ` (başarı %${model.basari})` : '') + '.',
  );

  return { cevap: satirlar.join('\n'), bulgular: [], veri: { durum, model }, eylemler: [{ etiket: 'Çekirdek Zekâ ayarları', yol: '/ayarlar#zeka' }] };
}

// ======================================================================
//                                GIRIS
// ======================================================================

/**
 * Ana giris: soruyu isler ve yapilandirilmis cevap dondurur.
 *
 * @param {string} soru
 * @param {object} secenek
 * @param {number} [secenek.yoneticiId]
 * @param {string} [secenek.enUstTasnif]  bu seviyeye kadar kaynak gorunur
 * @param {boolean} [secenek.kaydet]      sorgu gecmisine yazilsin mi
 */
async function sor(soru, { yoneticiId = null, enUstTasnif = null, kaydet = true } = {}) {
  const basla = Date.now();
  const temizSoru = String(soru || '').trim().slice(0, 1200);
  if (!temizSoru) {
    return {
      niyet: 'bos', cevap: 'Bir soru ya da komut yaz; arşivi senin için tarayayım.',
      bulgular: [], veri: {}, eylemler: [], sureMs: 0,
    };
  }

  const { niyet, siralama } = niyetCoz(temizSoru);
  const baglam = { yoneticiId, enUstTasnif };
  let sonuc;

  try {
    switch (niyet) {
      case 'kimlik': sonuc = await islemKimlik(); break;
      case 'selam': sonuc = {
        cevap: 'Selam operatör. Çekirdek Zekâ hazır. Arşivde ne arıyorsun?\n\n' +
          'Örnek: `son 30 günde ne oldu`, `en riskli varlıklar`, `anomali var mı`, `<ad> kimdir`.',
        bulgular: [], veri: {}, eylemler: [],
      }; break;
      case 'zaman': sonuc = {
        cevap: `Şu an: **${nd.tarihSozcuk(new Date(), { saat: true })}**`,
        bulgular: [], veri: {}, eylemler: [],
      }; break;
      case 'hesap': sonuc = islemHesap(temizSoru); break;
      case 'varlik_dosyesi': sonuc = await islemVarlikDosyesi(temizSoru, baglam); break;
      case 'baglanti': sonuc = await islemBaglanti(temizSoru, baglam); break;
      case 'ag': sonuc = await islemAg(); break;
      case 'zaman_cizgisi': sonuc = await islemZamanCizgisi(temizSoru); break;
      case 'anomali': sonuc = await islemAnomali(temizSoru); break;
      case 'risk': sonuc = await islemRisk(); break;
      case 'celiski': sonuc = await islemCeliski(); break;
      case 'bosluk': sonuc = await islemBosluk(); break;
      case 'ozet': sonuc = await islemOzet(temizSoru, baglam); break;
      case 'siniflandir': sonuc = await islemSiniflandir(temizSoru); break;
      case 'istatistik': sonuc = await islemIstatistik(); break;
      default: sonuc = await islemArama(temizSoru, baglam);
    }
  } catch (hata) {
    return {
      niyet, cevap: `Bu soruyu işlerken bir hata aldım: ${hata.message}`,
      bulgular: [], veri: { hata: hata.message }, eylemler: [], sureMs: Date.now() - basla,
    };
  }

  const sureMs = Date.now() - basla;

  if (kaydet) {
    db.sorgu(
      'INSERT INTO zeka_sorgulari (soru, niyet, bulgu_sayisi, sure_ms, yonetici_id) VALUES ($1,$2,$3,$4,$5)',
      [temizSoru, niyet, (sonuc.bulgular || []).length, sureMs, yoneticiId],
    ).catch(() => { /* gecmis yazimi cevabi engellemez */ });
  }

  return { niyet, niyetSiralamasi: siralama, ...sonuc, sureMs };
}

module.exports = { sor, niyetCoz, adAdaylari, varlikBul, zamanAraligi, kaynakYolu, kanitAgirligi };
