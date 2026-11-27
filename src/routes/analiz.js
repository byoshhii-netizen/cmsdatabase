'use strict';
/**
 * src/routes/analiz.js   ->  /analiz/*
 * ANALIZ MODULU — cekirdek zekanin gorsel cephesi.
 *
 *   GET  /analiz                 analiz panosu (ozet gostergeler)
 *   GET  /analiz/graf            baglanti grafigi (kuvvet yerlesimli tuval)
 *   GET  /analiz/zaman           zaman cizgisi + istatistik
 *   GET  /analiz/harita          koordinatli ogelerin haritasi
 *   GET  /analiz/kumeler         konu kumeleri (denetimsiz ogrenme)
 *   GET  /analiz/metin           serbest metin cozumleyici
 *   POST /analiz/metin           metni cozumle
 *   GET  /analiz/api/graf        graf verisi (JSON)
 *   GET  /analiz/api/zaman       zaman verisi (JSON)
 *   GET  /analiz/api/harita      harita verisi (JSON)
 *   GET  /analiz/api/yol         iki varlik arasi yollar (JSON)
 *   POST /analiz/api/sor         motora soru (JSON)
 */

const express = require('express');

const zeka = require('../services/zekaService');
const arsiv = require('../services/arsivService');
const cozumleme = require('../services/cozumlemeService');
const isaretService = require('../services/isaretService');
const nd = require('../zeka/dogalDil');
const log = require('../services/logService');

const { girisGerekli } = require('../middleware/auth');
const { onbellekYok } = require('../middleware/security');
const { csrfKoru } = require('../middleware/csrf');
const { yazmaSiniri } = require('../middleware/rateLimit');

const yonlendirici = express.Router();

yonlendirici.use('/analiz', onbellekYok, girisGerekli);

function kimlik(deger) {
  const n = Number(deger);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ============================================================ ANALIZ PANOSU

yonlendirici.get('/analiz', async (req, res, next) => {
  try {
    const [motorDurum, grafVeri, zamanVeri, cozDurum, riskli] = await Promise.all([
      zeka.durum(),
      zeka.grafVerisi({ maxDugum: 200 }).catch(() => null),
      zeka.zamanVerisi({ gun: 90 }).catch(() => null),
      cozumleme.durum(),
      cozumleme.riskliBelgeler({ limit: 10 }),
    ]);

    // Motorun kendi uretttigi uc analiz: risk, anomali, bosluk
    const [risk, anomali, bosluk] = await Promise.all([
      zeka.sor('en riskli varliklar', { yoneticiId: req.yonetici.id, kaydet: false }).catch(() => null),
      zeka.sor('anomali var mi', { yoneticiId: req.yonetici.id, kaydet: false }).catch(() => null),
      zeka.sor('hangi bosluklar var', { yoneticiId: req.yonetici.id, kaydet: false }).catch(() => null),
    ]);

    res.render('analiz/pano', {
      baslik: 'ANALIZ',
      rota: '/analiz',
      betikler: ['/js/hud.js', '/js/analiz.js'],
      motorDurum, grafVeri, zamanVeri, cozDurum, riskli,
      risk, anomali, bosluk,
      sozluk: nd,
    });
  } catch (hata) { next(hata); }
});

// ================================================================== GRAF

yonlendirici.get('/analiz/graf', async (req, res, next) => {
  try {
    const varlikId = kimlik(req.query.varlik);
    const hedefId = kimlik(req.query.hedef);

    const grafVeri = await zeka.grafVerisi({
      varlikId,
      derinlik: Number(req.query.derinlik) || 2,
      enAzGuc: Number(req.query.guc) || 0,
      tur: req.query.tur || null,
      maxDugum: Number(req.query.limit) || 400,
    });

    const yol = varlikId && hedefId ? await zeka.yolBul(varlikId, hedefId).catch(() => null) : null;
    const odak = varlikId ? await arsiv.varlikGetir(varlikId) : null;
    const hedef = hedefId ? await arsiv.varlikGetir(hedefId) : null;

    res.render('analiz/graf', {
      baslik: 'BAGLANTI GRAFIGI',
      rota: '/analiz/graf',
      betikler: ['/js/graf.js'],
      grafVeri, yol, odak, hedef, sorgu: req.query,
      varlikTurleri: arsiv.VARLIK_TURLERI,
      sozluk: nd,
    });
  } catch (hata) { next(hata); }
});

yonlendirici.get('/analiz/api/graf', async (req, res, next) => {
  try {
    const veri = await zeka.grafVerisi({
      varlikId: kimlik(req.query.varlik),
      derinlik: Number(req.query.derinlik) || 2,
      enAzGuc: Number(req.query.guc) || 0,
      tur: req.query.tur || null,
      maxDugum: Number(req.query.limit) || 400,
    });
    res.json({ tamam: true, ...veri });
  } catch (hata) { next(hata); }
});

yonlendirici.get('/analiz/api/yol', async (req, res, next) => {
  try {
    const a = kimlik(req.query.a);
    const b = kimlik(req.query.b);
    if (!a || !b) return res.status(400).json({ tamam: false, hata: 'Iki varlik kimligi gerekli.' });
    const veri = await zeka.yolBul(a, b);
    res.json({ tamam: true, ...veri });
  } catch (hata) { next(hata); }
});

// ================================================================= ZAMAN

yonlendirici.get('/analiz/zaman', async (req, res, next) => {
  try {
    const gun = Number(req.query.gun) || 90;
    const [zamanVeri, vakalar] = await Promise.all([
      zeka.zamanVerisi({
        gun,
        vakaId: kimlik(req.query.vaka),
        varlikId: kimlik(req.query.varlik),
        granularite: req.query.granularite || null,
      }),
      arsiv.vakaListele({ limit: 40 }),
    ]);

    res.render('analiz/zaman', {
      baslik: 'ZAMAN ANALIZI',
      rota: '/analiz/zaman',
      betikler: ['/js/zaman.js'],
      zamanVeri, vakalar, sorgu: req.query, gun,
      sozluk: nd,
    });
  } catch (hata) { next(hata); }
});

yonlendirici.get('/analiz/api/zaman', async (req, res, next) => {
  try {
    const veri = await zeka.zamanVerisi({
      gun: Number(req.query.gun) || 90,
      vakaId: kimlik(req.query.vaka),
      varlikId: kimlik(req.query.varlik),
      granularite: req.query.granularite || null,
    });
    res.json({ tamam: true, ...veri });
  } catch (hata) { next(hata); }
});

// ================================================================ HARITA

yonlendirici.get('/analiz/harita', async (req, res, next) => {
  try {
    const veri = await zeka.haritaVerisi({ limit: 800 });
    res.render('analiz/harita', {
      baslik: 'KONUM HARITASI',
      rota: '/analiz/harita',
      betikler: ['/js/harita.js'],
      veri, sozluk: nd,
    });
  } catch (hata) { next(hata); }
});

yonlendirici.get('/analiz/api/harita', async (req, res, next) => {
  try {
    const veri = await zeka.haritaVerisi({ limit: 800 });
    res.json({ tamam: true, ...veri });
  } catch (hata) { next(hata); }
});

// ============================================== MUKTEBES / KURE (UYDU TAKIP)

/**
 * Konumlu varliklar arasindaki iliskileri buyuk-daire yaylarina cevirir.
 * Yalnizca iki ucu da koordinatli olan varlik iliskileri dahil edilir.
 */
async function baglantiYaylari(noktalar) {
  const koord = new Map();
  for (const n of noktalar) {
    if (n.kaynak === 'varlik' && Number.isFinite(Number(n.enlem)) && Number.isFinite(Number(n.boylam))) {
      koord.set(Number(n.id), { lon: Number(n.boylam), lat: Number(n.enlem) });
    }
  }
  if (koord.size < 2) return [];
  try {
    const graf = await zeka.grafVerisi({ maxDugum: 1200, enAzGuc: 0 });
    const yaylar = [];
    for (const k of (graf.kenarlar || [])) {
      const a = koord.get(Number(k.kaynak));
      const b = koord.get(Number(k.hedef));
      if (a && b) {
        yaylar.push({ a, b, guc: Number(k.guc) || 1 });
        if (yaylar.length >= 400) break;
      }
    }
    return yaylar;
  } catch { return []; }
}

yonlendirici.get('/analiz/kure', async (req, res, next) => {
  try {
    const [haritaVeri, isaretler] = await Promise.all([
      zeka.haritaVerisi({ limit: 1500 }),
      isaretService.listele(),
    ]);
    const baglantilar = await baglantiYaylari(haritaVeri.noktalar || []);

    res.render('analiz/kure', {
      baslik: 'MUKTEBES // KÜRE',
      rota: '/analiz/kure',
      tamEkran: true,
      veri: {
        noktalar: haritaVeri.noktalar || [],
        yogunluk: haritaVeri.yogunluk || [],
        baglantilar,
        isaretler,
      },
      sozluk: nd,
    });
  } catch (hata) { next(hata); }
});

// ----- Operator isaretleri (ekle / sil) -----
yonlendirici.post('/analiz/api/isaret', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const sonuc = await isaretService.olustur({
      baslik: req.body.baslik,
      not: req.body.not,
      tasnif: req.body.tasnif,
      enlem: req.body.enlem,
      boylam: req.body.boylam,
      renk: req.body.renk,
      varlikId: req.body.varlik_id,
      yoneticiId: req.yonetici && req.yonetici.id,
    });
    if (!sonuc.tamam) return res.status(400).json({ tamam: false, hata: sonuc.hata });
    await log.bilgi({
      kategori: 'analiz', olay: 'harita_isareti_eklendi',
      mesaj: `Küre işareti: ${sonuc.isaret.baslik}`,
      yoneticiId: req.yonetici && req.yonetici.id, req,
    }).catch(() => {});
    res.json({ tamam: true, isaret: sonuc.isaret });
  } catch (hata) { next(hata); }
});

yonlendirici.post('/analiz/api/isaret/:id/sil', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const silindi = await isaretService.sil(req.params.id);
    res.json({ tamam: silindi });
  } catch (hata) { next(hata); }
});

// =============================================================== KUMELER

yonlendirici.get('/analiz/kumeler', async (req, res, next) => {
  try {
    const kumeler = await zeka.konuKumeleri({
      limit: Number(req.query.limit) || 400,
      kume: Number(req.query.k) || 0,
      gun: req.query.gun || null,
    });
    res.render('analiz/kumeler', {
      baslik: 'KONU KUMELERI',
      rota: '/analiz/kumeler',
      betikler: ['/js/analiz.js'],
      kumeler, sorgu: req.query,
      sozluk: nd,
    });
  } catch (hata) { next(hata); }
});

// ============================================================ SIFRE KIRICI

yonlendirici.get('/analiz/sifre', (req, res, next) => {
  try {
    res.render('analiz/sifre', {
      baslik: 'ŞİFRE KIRICI',
      rota: '/analiz/sifre',
      betikler: ['/js/sifre-kirici.js'],
      sozluk: nd,
    });
  } catch (hata) { next(hata); }
});

// ============================================================ METIN ARACI

yonlendirici.get('/analiz/metin', async (req, res, next) => {
  try {
    res.render('analiz/metin', {
      baslik: 'METIN COZUMLEYICI',
      rota: '/analiz/metin',
      betikler: ['/js/analiz.js'],
      cozum: null, girdi: '',
      sozluk: nd,
    });
  } catch (hata) { next(hata); }
});

yonlendirici.post('/analiz/metin', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const girdi = String(req.body.metin || '').slice(0, 400_000);
    const cozum = girdi.trim() ? zeka.metinCozumle(girdi, { sorgu: req.body.sorgu || '' }) : null;

    res.render('analiz/metin', {
      baslik: 'METIN COZUMLEYICI',
      rota: '/analiz/metin',
      betikler: ['/js/analiz.js'],
      cozum, girdi, sorgu: req.body.sorgu || '',
      sozluk: nd,
    });
  } catch (hata) { next(hata); }
});

/** Cozumlenen serbest metni dogrudan arsiv kaydina cevirir. */
yonlendirici.post('/analiz/metin/kaydet', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const metin = String(req.body.metin || '').slice(0, 200_000);
    if (!metin.trim()) return res.redirect(303, '/analiz/metin?hata=Metin+bos');

    const cozum = zeka.metinCozumle(metin);
    const sonuc = await arsiv.kayitOlustur({
      baslik: req.body.baslik || (cozum.ozet || metin).slice(0, 120),
      govde: metin,
      tur: req.body.tur || 'rapor',
      tasnif: req.body.tasnif || 'hizmete_ozel',
      ozet: cozum.ozet,
      anahtar_kelimeler: (cozum.anahtar || []).slice(0, 12).map((a) => a.obek),
      etiketler: ['metin-cozumleyici'],
    }, { yoneticiId: req.yonetici.id });

    if (!sonuc.tamam) return res.redirect(303, `/analiz/metin?hata=${encodeURIComponent(sonuc.hata)}`);
    res.redirect(303, `/arsiv/kayit/${sonuc.kayit.id}?bildirim=${encodeURIComponent(sonuc.kayit.kod + ' olusturuldu.')}`);
  } catch (hata) { next(hata); }
});

// ============================================================== MOTOR UCU

/** Motora soru sor (JSON) — Cambaz arayuzu ve analiz ekranlari kullanir. */
yonlendirici.post('/analiz/api/sor', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const soru = String(req.body.soru || '').slice(0, 1200);
    if (!soru.trim()) return res.status(400).json({ tamam: false, hata: 'Soru bos olamaz.' });

    const sonuc = await zeka.sor(soru, { yoneticiId: req.yonetici.id });
    res.json({ tamam: true, ...sonuc });
  } catch (hata) { next(hata); }
});

module.exports = yonlendirici;
