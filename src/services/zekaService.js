'use strict';
/**
 * src/services/zekaService.js
 * CEKIRDEK ZEKA SERVISI — motorun uygulama cephesi.
 *
 * Bu servis, src/zeka altindaki algoritma katmanini uygulamaya baglar:
 *   sor()            : soruyu cozumleyip kaynak gostererek yanitlar
 *   dizinKur()       : tum arsivi yerel BM25 dizinine yeniden yazar
 *   modelEgit()      : arsivin kendi etiketlerinden siniflandirici egitir
 *   modelGetir()     : egitilmis modeli dondurur
 *   siniflandir()    : serbest metni egitilmis modelle etiketler
 *   ozetle()         : serbest metni ozetler
 *   metinCozumle()   : serbest metinden varlik cikarir
 *   grafVerisi()     : baglantI grafigi icin dugum/kenar seti
 *   zamanVerisi()    : zaman cizgisi + istatistik
 *   haritaVerisi()   : koordinatli ogeler
 *   durum()          : motorun saglik gostergeleri
 *
 * API ANAHTARI GEREKTIRMEZ. Tum hesaplama bu surecte yapilir.
 */

const db = require('../config/db');
const log = require('./logService');
const ayarService = require('./ayarService');
const arsivService = require('./arsivService');

const cikarim = require('../zeka/cikarim');
const dizin = require('../zeka/dizin');
const siniflandirici = require('../zeka/siniflandirici');
const metrik = require('../zeka/metrik');
const varlikCikarim = require('../zeka/varlikCikarim');
const graf = require('../zeka/graf');
const ist = require('../zeka/istatistik');
const dil = require('../zeka/dil');
const nd = require('../zeka/dogalDil');

// ------------------------------------------------------------------- SORU

/**
 * Soruyu motora verir.
 * @returns {Promise<object>} { niyet, cevap, bulgular, veri, eylemler, sureMs }
 */
async function sor(soru, { yoneticiId = null, enUstTasnif = null } = {}) {
  return cikarim.sor(soru, { yoneticiId, enUstTasnif });
}

// ------------------------------------------------------------------ DIZIN

/** Dizini sifirdan kurar. */
async function dizinKur({ yoneticiId = null } = {}) {
  const basla = Date.now();
  const adimlar = [];
  const sayim = await dizin.yenidenKur((bilgi) => adimlar.push(bilgi));
  const sure = Date.now() - basla;

  await log.bilgi({
    kategori: 'zeka', olay: 'dizin_kuruldu',
    mesaj: `${sayim.parca} parca · ${nd.sure(sure)}`,
    yoneticiId, meta: sayim,
  });

  return { tamam: true, sayim, sureMs: sure, adimlar };
}

async function dizinDurumu() {
  return dizin.durum();
}

async function benzerler(kaynakTur, kaynakId, secenek) {
  return dizin.benzerler(kaynakTur, kaynakId, secenek);
}

async function ara(sorgu, secenek) {
  return dizin.ara(sorgu, secenek);
}

// ------------------------------------------------------------------ MODEL

const MODEL_ADLARI = {
  kayit_turu: { alan: 'tur', tablo: 'kayitlar', aciklama: 'Kayit turu (ihbar / rapor / analiz ...)' },
  kayit_tasnifi: { alan: 'tasnif', tablo: 'kayitlar', aciklama: 'Tasnif seviyesi' },
  kayit_vakasi: { alan: 'vaka_id', tablo: 'kayitlar', aciklama: 'Ilgili vaka' },
};

/**
 * Arsivdeki etiketli kayitlardan siniflandirici egitir.
 * Egitim verisi tamamen yereldir: kayitlarin basligi + govdesi girdi,
 * operatorun verdigi tur/tasnif/vaka etiketi cikti olarak kullanilir.
 */
async function modelEgit(modelAdi = 'kayit_turu', { yoneticiId = null, enAzOrnek = 8 } = {}) {
  const tanim = MODEL_ADLARI[modelAdi];
  if (!tanim) return { tamam: false, hata: 'Bilinmeyen model adi.' };

  const satirlar = await db.satirlar(
    `SELECT baslik, govde, ozet, ${tanim.alan} AS etiket
       FROM kayitlar
      WHERE silindi = FALSE AND ${tanim.alan} IS NOT NULL
        AND length(COALESCE(govde, '') || COALESCE(ozet, '')) > 20
      LIMIT 20000`,
  );

  const ornekler = satirlar.map((s) => ({
    metin: `${s.baslik}\n${s.ozet || ''}\n${s.govde || ''}`,
    etiket: String(s.etiket),
  }));

  if (ornekler.length < enAzOrnek) {
    return {
      tamam: false,
      hata: `Egitim icin en az ${enAzOrnek} etiketli kayit gerekiyor; su an ${ornekler.length} var.`,
      ornek: ornekler.length,
    };
  }

  const etiketler = new Set(ornekler.map((o) => o.etiket));
  if (etiketler.size < 2) {
    return { tamam: false, hata: 'Egitim icin en az iki farkli etiket gerekiyor.', ornek: ornekler.length };
  }

  const model = siniflandirici.egit(ornekler);
  if (!model.hazir) return { tamam: false, hata: model.sebep || 'Model egitilemedi.' };

  const dogrulama = siniflandirici.caprazDogrula(ornekler, { kat: Math.min(5, Math.max(2, Math.floor(ornekler.length / 4))) });

  await db.sorgu(
    `INSERT INTO zeka_modelleri (ad, tur, veri, ornek_sayisi, basari, guncellendi_at)
     VALUES ($1,'bayes',$2,$3,$4,NOW())
     ON CONFLICT (ad) DO UPDATE SET
       veri = EXCLUDED.veri, ornek_sayisi = EXCLUDED.ornek_sayisi,
       basari = EXCLUDED.basari, guncellendi_at = NOW()`,
    [modelAdi, JSON.stringify(model), ornekler.length, dogrulama.basari],
  );

  await log.bilgi({
    kategori: 'zeka', olay: 'model_egitildi',
    mesaj: `${modelAdi}: ${ornekler.length} ornek, ${etiketler.size} sinif, basari %${dogrulama.basari ?? '—'}`,
    yoneticiId,
  });

  return {
    tamam: true,
    modelAdi,
    ozet: siniflandirici.modelOzeti(model),
    dogrulama,
    ayirtEdiciler: Object.fromEntries(
      [...etiketler].slice(0, 8).map((e) => [e, siniflandirici.ayirtEdiciler(model, e, { adet: 8 })]),
    ),
  };
}

async function modelGetir(modelAdi = 'kayit_turu') {
  const satir = await db.tekSatir(
    'SELECT ad, tur, veri, ornek_sayisi, basari, guncellendi_at FROM zeka_modelleri WHERE ad = $1',
    [modelAdi],
  );
  if (!satir) return null;
  return {
    ...satir,
    ozet: siniflandirici.modelOzeti(satir.veri),
    aciklama: MODEL_ADLARI[modelAdi] ? MODEL_ADLARI[modelAdi].aciklama : null,
  };
}

async function modelListesi() {
  const satirlar = await db.satirlar('SELECT ad, ornek_sayisi, basari, guncellendi_at FROM zeka_modelleri ORDER BY ad');
  const harita = new Map(satirlar.map((s) => [s.ad, s]));
  return Object.entries(MODEL_ADLARI).map(([ad, tanim]) => ({
    ad, aciklama: tanim.aciklama, ...(harita.get(ad) || { ornek_sayisi: 0, basari: null, guncellendi_at: null }),
    egitildi: harita.has(ad),
  }));
}

async function modelSil(modelAdi) {
  await db.sorgu('DELETE FROM zeka_modelleri WHERE ad = $1', [modelAdi]);
  return { tamam: true };
}

/** Serbest metni egitilmis modelle siniflandirir. */
async function siniflandir(metin, modelAdi = 'kayit_turu') {
  const satir = await db.tekSatir('SELECT veri, ornek_sayisi, basari FROM zeka_modelleri WHERE ad = $1', [modelAdi]);
  if (!satir || !satir.veri || !satir.veri.hazir) {
    return { tamam: false, hata: 'Model henuz egitilmedi.' };
  }
  const sonuc = siniflandirici.tahmin(satir.veri, metin);
  return { tamam: true, ...sonuc, model: { ornek: satir.ornek_sayisi, basari: satir.basari } };
}

// --------------------------------------------------------------- METIN ARACLARI

/** Serbest metni ozetler ve cozumler (yapistir-cozumle ekrani icin). */
function metinCozumle(metin, { cumleSayisi = 5, sorgu = '' } = {}) {
  const ham = String(metin || '').slice(0, 500_000);
  if (!ham.trim()) return { tamam: false, hata: 'Metin bos.' };

  const ozet = metrik.ozetle(ham, { cumleSayisi, sorgu, maxKarakter: 1800 });
  const anahtar = metrik.anahtarKelimeler(ham, { adet: 14 });
  const okuma = metrik.okunabilirlik(ham);
  const cikarilan = varlikCikarim.cikar(ham, { minGuven: 0.55 });
  const temalar = cikarilan.temalar;

  return {
    tamam: true,
    ozet: ozet.ozet,
    ozetCumleleri: ozet.cumleler.map((c) => ({ metin: c.metin, puan: Math.round(c.puan * 10000) / 10000 })),
    anahtar: anahtar.map((a) => ({ obek: a.obek, puan: Math.round(a.puan * 10000) / 10000 })),
    okuma,
    temalar,
    varliklar: cikarilan.gruplar,
    varlikOzeti: cikarilan.ozet,
    oneriler: varlikCikarim.varlikOnerileri(cikarilan),
    dil: require('../zeka/belgeOkur').dilTahmin(ham),
  };
}

function ozetle(metin, secenek) {
  return metrik.ozetle(String(metin || ''), secenek);
}

// ----------------------------------------------------------------- GRAF

/**
 * Baglanti grafigi verisi. Belirli bir varlik verilirse onun cevresi,
 * verilmezse en etkili dugumlerden olusan ag dondurulur.
 */
async function grafVerisi({ varlikId = null, derinlik = 2, enAzGuc = 0, tur = null, maxDugum = 400, enUstTasnif = null } = {}) {
  const kosullar = ['silindi = FALSE'];
  const parametreler = [];
  if (tur) { parametreler.push(tur); kosullar.push(`tur = $${parametreler.length}`); }
  const tk = arsivService.tasnifKosulu(enUstTasnif, 'tasnif');
  if (tk) { parametreler.push(tk.deger); kosullar.push(tk.sql.replace('$#', `$${parametreler.length}`)); }

  const dugumler = await db.satirlar(
    `SELECT id, kod, ad, tur, onem, durum, renk, tasnif FROM varliklar
      WHERE ${kosullar.join(' AND ')} LIMIT 6000`,
    parametreler,
  );

  const kenarlar = await db.satirlar(
    `SELECT i.id, i.kaynak_varlik_id AS kaynak, i.hedef_varlik_id AS hedef,
            i.guc, i.tur, i.yon, i.etiket, i.otomatik
       FROM varlik_iliskileri i
      WHERE i.guc >= $1 LIMIT 40000`,
    [Math.max(0, Number(enAzGuc) || 0)],
  );

  const g = graf.kur(dugumler, kenarlar);
  const merkeziyet = graf.merkeziyet(g);
  const merkezHarita = new Map(merkeziyet.map((m) => [Number(m.id), m]));
  const { gruplar, etiketler } = graf.topluluklar(g);
  const toplulukHarita = new Map();
  gruplar.forEach((gr) => gr.uyeler.forEach((u) => toplulukHarita.set(Number(u), gr.no)));

  let secilenDugumler = dugumler;
  let secilenKenarlar = kenarlar;

  if (varlikId) {
    const c = graf.cevre(g, Number(varlikId), Math.min(Math.max(Number(derinlik) || 2, 1), 4), { maxDugum });
    const kume = new Set(c.dugumler.map((d) => Number(d.id)));
    secilenDugumler = dugumler.filter((d) => kume.has(Number(d.id)))
      .map((d) => ({ ...d, adim: c.uzaklik.get(g.dizin.get(d.id)) ?? null }));
    secilenKenarlar = kenarlar.filter((k) => kume.has(Number(k.kaynak)) && kume.has(Number(k.hedef)));
  } else if (dugumler.length > maxDugum) {
    // Cok buyuk ag: en etkili dugumleri ve aralarindaki kenarlari al
    const enEtkili = new Set(merkeziyet.slice(0, maxDugum).map((m) => Number(m.id)));
    secilenDugumler = dugumler.filter((d) => enEtkili.has(Number(d.id)));
    secilenKenarlar = kenarlar.filter((k) => enEtkili.has(Number(k.kaynak)) && enEtkili.has(Number(k.hedef)));
  }

  return {
    dugumler: secilenDugumler.map((d) => {
      const m = merkezHarita.get(Number(d.id)) || {};
      return {
        id: Number(d.id), kod: d.kod, ad: d.ad, tur: d.tur, onem: d.onem,
        durum: d.durum, renk: d.renk, tasnif: d.tasnif,
        derece: m.derece || 0, etki: m.etki || 0, aradalik: m.aradalik || 0,
        topluluk: toplulukHarita.get(Number(d.id)) || 0,
        adim: d.adim ?? null,
      };
    }),
    kenarlar: secilenKenarlar.map((k) => ({
      id: Number(k.id), kaynak: Number(k.kaynak), hedef: Number(k.hedef),
      guc: k.guc, tur: k.tur, yon: k.yon, etiket: k.etiket, otomatik: k.otomatik,
    })),
    ozet: graf.ozet(g),
    merkeziyet: merkeziyet.slice(0, 20),
    topluluklar: gruplar.slice(0, 20),
    kritik: graf.kritikNoktalar(g),
    tahminler: graf.baglantiTahmini(g, { adet: 12 }),
    toplamDugum: dugumler.length,
    kirpildi: secilenDugumler.length < dugumler.length,
  };
}

/** Iki varlik arasindaki yollar. */
async function yolBul(aId, bId) {
  const dugumler = await db.satirlar('SELECT id, ad, tur, onem FROM varliklar WHERE silindi = FALSE LIMIT 6000');
  const kenarlar = await db.satirlar('SELECT kaynak_varlik_id AS kaynak, hedef_varlik_id AS hedef, guc, tur, yon FROM varlik_iliskileri LIMIT 40000');
  const g = graf.kur(dugumler, kenarlar);
  const adHarita = new Map(dugumler.map((d) => [Number(d.id), d]));

  const kisa = graf.enKisaYol(g, Number(aId), Number(bId));
  const tumu = graf.yollar(g, Number(aId), Number(bId), { maxYol: 6, maxDerinlik: 6 });

  const adlandir = (yol) => yol.map((id) => adHarita.get(Number(id)) || { id, ad: `#${id}` });

  return {
    kisaYol: kisa ? { ...kisa, dugumler: adlandir(kisa.yol) } : null,
    yollar: tumu.map((y) => ({ ...y, dugumler: adlandir(y.yol) })),
  };
}

// ------------------------------------------------------------- ZAMAN / HARITA

/** Zaman cizgisi verisi + istatistik. */
async function zamanVerisi({ gun = 90, vakaId = null, varlikId = null, granularite = null, enUstTasnif = null } = {}) {
  const gunSayisi = Math.min(Math.max(Number(gun) || 90, 1), 3650);

  const [olaylar, kayitlar] = await Promise.all([
    arsivService.olayListele({ gun: gunSayisi, vakaId, varlikId, enUstTasnif, limit: 500 }),
    arsivService.kayitListele({
      vakaId, varlikId, enUstTasnif, limit: 500,
      baslangic: new Date(Date.now() - gunSayisi * 86_400_000).toISOString(),
    }),
  ]);

  const ogeler = [
    ...olaylar.olaylar.map((o) => ({
      tur: 'olay', id: o.id, kod: o.kod, baslik: o.baslik, zaman: o.zaman,
      konum: o.konum, onem: o.onem, tasnif: o.tasnif, altTur: o.tur,
      belirsizlik: o.belirsizlik, varlikAdlari: o.varlik_adlari || [],
      yol: `/arsiv/olay/${o.id}`,
    })),
    ...kayitlar.kayitlar.map((k) => ({
      tur: 'kayit', id: k.id, kod: k.kod, baslik: k.baslik, zaman: k.zaman,
      konum: k.konum, onem: 50, tasnif: k.tasnif, altTur: k.tur,
      durum: k.durum, guvenilirlik: k.guvenilirlik, yol: `/arsiv/kayit/${k.id}`,
    })),
  ].sort((a, b) => new Date(b.zaman) - new Date(a.zaman));

  const zamanlar = ogeler.map((o) => new Date(o.zaman)).filter((d) => !Number.isNaN(d.getTime()));
  const secilenGranularite = granularite
    || (gunSayisi <= 3 ? 'saat' : gunSayisi <= 70 ? 'gun' : gunSayisi <= 500 ? 'hafta' : 'ay');

  const seri = zamanlar.length ? ist.zamanSerisi(zamanlar, secilenGranularite) : { kovalar: [], toplam: 0 };
  const degerler = seri.kovalar.map((k) => k.deger);

  return {
    gun: gunSayisi,
    ogeler: ogeler.slice(0, 400),
    seri: seri.kovalar,
    granularite: secilenGranularite,
    egilim: degerler.length >= 3 ? ist.egilim(degerler) : null,
    patlamalar: seri.kovalar.length > 8 ? ist.patlama(seri.kovalar, { pencere: 7, esik: 2 }) : [],
    sessizlikler: seri.kovalar.length > 8 ? ist.sessizlik(seri.kovalar, { enAzUzunluk: 3 }) : [],
    mevsimsellik: zamanlar.length >= 10 ? ist.mevsimsellik(zamanlar) : null,
    ongoru: degerler.length >= 6 ? ist.ongoru(degerler, { adim: Math.min(7, Math.ceil(degerler.length / 4)) }) : null,
    sayim: { olay: olaylar.olaylar.length, kayit: kayitlar.kayitlar.length },
  };
}

async function haritaVerisi(secenek) {
  const noktalar = await arsivService.haritaNoktalari(secenek);
  // Yogunluk kumeleri: yakin noktalari grupla (basit izgara kumeleme)
  const izgara = new Map();
  for (const n of noktalar) {
    const anahtar = `${Math.round(Number(n.enlem) * 2) / 2}|${Math.round(Number(n.boylam) * 2) / 2}`;
    if (!izgara.has(anahtar)) izgara.set(anahtar, { sayi: 0, enlem: 0, boylam: 0 });
    const k = izgara.get(anahtar);
    k.sayi++;
    k.enlem += Number(n.enlem);
    k.boylam += Number(n.boylam);
  }

  return {
    noktalar,
    yogunluk: [...izgara.values()]
      .map((k) => ({ sayi: k.sayi, enlem: k.enlem / k.sayi, boylam: k.boylam / k.sayi }))
      .sort((a, b) => b.sayi - a.sayi)
      .slice(0, 60),
  };
}

// -------------------------------------------------------------- KUMELEME

/**
 * Kayitlari konu kumelerine ayirir (denetimsiz ogrenme).
 * Hangi konularin birlikte hareket ettigini gormek icin.
 */
async function konuKumeleri({ limit = 400, kume = 0, gun = null } = {}) {
  const kosullar = ['silindi = FALSE'];
  const parametreler = [];
  if (gun) {
    parametreler.push(String(Math.min(Math.max(Number(gun), 1), 3650)));
    kosullar.push(`COALESCE(olay_zamani, olusturuldu_at) > NOW() - ($${parametreler.length} || ' days')::interval`);
  }
  parametreler.push(Math.min(Math.max(Number(limit) || 400, 4), 2000));

  const kayitlar = await db.satirlar(
    `SELECT id, kod, baslik, ozet, govde, tur, tasnif,
            COALESCE(olay_zamani, olusturuldu_at) AS zaman
       FROM kayitlar WHERE ${kosullar.join(' AND ')}
      ORDER BY COALESCE(olay_zamani, olusturuldu_at) DESC
      LIMIT $${parametreler.length}`,
    parametreler,
  );

  if (kayitlar.length < 4) {
    return { tamam: false, hata: 'Kumeleme icin en az dort kayit gerekiyor.', kayitSayisi: kayitlar.length };
  }

  const metinler = kayitlar.map((k) => `${k.baslik} ${k.ozet || ''} ${(k.govde || '').slice(0, 4000)}`);
  const sayimlar = metinler.map((m) => dil.terimSikligi(m));
  const { idf } = metrik.idfHesapla(sayimlar);
  const vektorler = sayimlar.map((s) => metrik.tfIdf(s, idf));

  const sonuc = metrik.kumele(vektorler, { k: Number(kume) || 0 });

  return {
    tamam: true,
    kayitSayisi: kayitlar.length,
    tutarlilik: sonuc.tutarlilik,
    kumeler: sonuc.kumeler.map((c, i) => ({
      no: i + 1,
      boyut: c.uyeler.length,
      baslik: c.baslik,
      kayitlar: c.uyeler.slice(0, 12).map((u) => ({
        id: kayitlar[u].id, kod: kayitlar[u].kod, baslik: kayitlar[u].baslik,
        tur: kayitlar[u].tur, zaman: kayitlar[u].zaman,
      })),
    })).sort((a, b) => b.boyut - a.boyut),
  };
}

// ------------------------------------------------------------------- DURUM

/** Motorun genel saglik ve kapasite gostergeleri. */
async function durum() {
  const [dizinDurum, modeller, sorguSayim, sikTerim, motorAyari] = await Promise.all([
    dizin.durum(),
    modelListesi(),
    db.tekSatir(`
      SELECT COUNT(*)::int AS toplam,
             COUNT(*) FILTER (WHERE olusturuldu_at > NOW() - INTERVAL '7 days')::int AS hafta,
             COALESCE(ROUND(AVG(sure_ms))::int, 0) AS ort_sure
        FROM zeka_sorgulari`),
    dizin.sikTerimler(24),
    ayarService.ayarAl('zeka_motor', 'dahili'),
  ]);

  const niyetDagilim = await db.satirlar(`
    SELECT niyet, COUNT(*)::int AS n FROM zeka_sorgulari
     WHERE niyet IS NOT NULL GROUP BY niyet ORDER BY n DESC LIMIT 14`);

  return {
    motor: motorAyari,
    dizin: dizinDurum,
    modeller,
    sorgu: sorguSayim || {},
    niyetDagilim,
    sikTerimler: sikTerim,
    yetenekler: [
      { ad: 'Turkce cozumleme', detay: 'cift gövdeleme (sabit + morfolojik), durak sozcuk, cumle ayirma' },
      { ad: 'Geri getirme', detay: 'Okapi BM25, parcali dizin, alinti cikarma' },
      { ad: 'Ozetleme', detay: 'TextRank + MMR, sorgu odakli agirlik' },
      { ad: 'Varlik cikarimi', detay: 'TCKN/VKN/IBAN/Luhn dogrulamali 20+ tur' },
      { ad: 'Baglanti analizi', detay: 'Dijkstra, Brandes, PageRank, etiket yayilimi, Adamic-Adar' },
      { ad: 'Istatistik', detay: 'MAD uc deger, patlama, Holt ongoru, Benford' },
      { ad: 'Ogrenme', detay: 'coklu terim Naive Bayes, k-kat capraz dogrulama' },
      { ad: 'Belge okuma', detay: 'PDF/DOCX/XLSX/PPTX/ODF/RTF/EML/ZIP + EXIF GPS' },
    ],
  };
}

/** Son sorgular (ogrenme ve kullanim analizi). */
async function sorguGecmisi({ limit = 40 } = {}) {
  return db.satirlar(
    `SELECT z.*, y.kullanici_adi FROM zeka_sorgulari z
       LEFT JOIN yoneticiler y ON y.id = z.yonetici_id
      ORDER BY z.olusturuldu_at DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 40, 1), 200)],
  );
}

/** Operator cevabi yararli/yararsiz isaretler — kullanim analizine girdi. */
async function sorguGeriBildirim(id, yararli) {
  await db.sorgu('UPDATE zeka_sorgulari SET yararli = $2 WHERE id = $1', [Number(id), Boolean(yararli)]);
  return { tamam: true };
}

module.exports = {
  sor, ara, benzerler,
  dizinKur, dizinDurumu,
  modelEgit, modelGetir, modelListesi, modelSil, siniflandir,
  metinCozumle, ozetle,
  grafVerisi, yolBul, zamanVerisi, haritaVerisi, konuKumeleri,
  durum, sorguGecmisi, sorguGeriBildirim,
  MODEL_ADLARI,
};
