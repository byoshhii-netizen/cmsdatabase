'use strict';
/**
 * src/routes/pano.js   ->  /pano
 * Cizim ve strateji panosu: sonsuz tuval (Excalidraw tarzi), oge/tum-pano
 * kilidi, PostgreSQL'e anlik kaydetme, JSON yedek alma/geri yukleme.
 *
 * /pano          -> kayitli panolarin listesi
 * /pano/:id      -> tam ekran tuval editoru (JS motoru public/js/pano.js)
 * /pano/:id/veri -> editorun ilk yuklemede okudugu JSON (pano + ogeler)
 *
 * Tuval verisi (ogeler) buyuk olabilecegi icin (serbest kalem noktalari,
 * gomulu resim base64'u) bu modulun JSON govdesi app.js'teki genel
 * express.json() sinirina tabidir (bkz. app.js yorum satiri); resim
 * yuklemesi ve yedek ice aktarma ise multipart uzerinden, o sinirin
 * tamamen disinda, ayri (daha genis) kendi sinirlariyla calisir.
 */

const express = require('express');
const ayar = require('../config/env');

const panoService = require('../services/panoService');
const log = require('../services/logService');

const { girisGerekli, jsonIster } = require('../middleware/auth');
const { onbellekYok } = require('../middleware/security');
const { csrfKoru } = require('../middleware/csrf');
const { yazmaSiniri } = require('../middleware/rateLimit');
const { panoResimYukleyici, panoYedekYukleyici, panoYuklemeHatasiYakala } = require('../middleware/panoYukleme');
const dogrula = require('../utils/validate');

const yonlendirici = express.Router();

const DURUM_MESAJLARI = {
  pano_olusturuldu: 'Yeni pano olusturuldu.',
  pano_silindi: 'Pano silindi.',
  yedek_yuklendi: 'Yedekten yeni pano olusturuldu.',
};

function basarisizYanit(req, res, { durum = 400, hata, geriYol = '/pano' } = {}) {
  if (jsonIster(req)) return res.status(durum).json({ tamam: false, hata });
  return res.redirect(303, `${geriYol}${geriYol.includes('?') ? '&' : '?'}hata=${encodeURIComponent(hata)}`);
}

function basariliYanit(req, res, { govde = {}, geriYol = '/pano', durumKodu } = {}) {
  if (jsonIster(req)) return res.json({ tamam: true, ...govde });
  const ayrac = geriYol.includes('?') ? '&' : '?';
  return res.redirect(303, durumKodu ? `${geriYol}${ayrac}durum=${durumKodu}` : geriYol);
}

// ============================================================== GET /pano
yonlendirici.get('/pano', onbellekYok, girisGerekli, async (req, res, next) => {
  try {
    const panolar = await panoService.listele();
    res.render('pano', {
      baslik: 'STRATEJI PANOSU', rota: '/pano',
      panolar,
      durum: DURUM_MESAJLARI[String(req.query.durum || '')] || null,
      hata: req.query.hata ? decodeURIComponent(req.query.hata) : null,
      pano: ayar.pano,
    });
  } catch (hata) { next(hata); }
});

// =========================================================== POST /pano
yonlendirici.post('/pano', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const sonuc = await panoService.olustur({ ad: req.body.ad, aciklama: req.body.aciklama, yoneticiId: req.yonetici.id });
    await log.bilgi({ kategori: 'pano', olay: 'pano_olusturuldu', mesaj: `"${sonuc.pano.ad}" panosu olusturuldu.`, yoneticiId: req.yonetici.id, req });
    if (jsonIster(req)) return res.json({ tamam: true, pano: sonuc.pano });
    return res.redirect(303, `/pano/${sonuc.pano.id}`);
  } catch (hata) { next(hata); }
});

// ==================================================== GET /pano/:id (editor)
yonlendirici.get('/pano/:id', onbellekYok, girisGerekli, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) {
      return res.status(404).render('hata/genel', {
        baslik: 'PANO BULUNAMADI', kod: 404, mesaj: 'Gecersiz pano kimligi.', rota: req.path,
      });
    }
    const pano = await panoService.getir(id);
    if (!pano) {
      return res.status(404).render('hata/genel', {
        baslik: 'PANO BULUNAMADI', kod: 404, mesaj: 'Istenen pano kayitli degil veya silinmis.', rota: req.path,
      });
    }
    res.render('pano-editor', {
      baslik: pano.ad, rota: '/pano', tamEkran: true,
      pano,
      panoAyar: ayar.pano,
    });
  } catch (hata) { next(hata); }
});

// ============================================================== VERI (JSON)
yonlendirici.get('/pano/:id/veri', girisGerekli, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return res.status(400).json({ tamam: false, hata: 'Gecersiz pano kimligi.' });

    const okunan = await panoService.tamOku(id);
    if (!okunan) return res.status(404).json({ tamam: false, hata: 'Pano bulunamadi.' });

    return res.json({ tamam: true, pano: okunan.pano, ogeler: okunan.ogeler });
  } catch (hata) { next(hata); }
});

// ============================================================== KAYDET
yonlendirici.post('/pano/:id/kaydet', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return res.status(400).json({ tamam: false, hata: 'Gecersiz pano kimligi.' });

    if (!Array.isArray(req.body.ogeler) && req.body.ogeler !== undefined) {
      return res.status(400).json({ tamam: false, hata: 'Gecersiz oge listesi.' });
    }

    const sonuc = await panoService.kaydet({
      id,
      ad: req.body.ad,
      tuval: req.body.tuval,
      onizleme: req.body.onizleme,
      ogeler: req.body.ogeler,
      beklenenSurum: req.body.beklenenSurum,
      zorla: req.body.zorla === true,
    });

    if (!sonuc.tamam) {
      const durumKodu = sonuc.kod === 'CELISKI' ? 409 : (sonuc.kod === 'YOK' ? 404 : 400);
      return res.status(durumKodu).json(sonuc);
    }

    return res.json(sonuc);
  } catch (hata) { next(hata); }
});

// ============================================================ TUM PANO KILIDI
yonlendirici.post('/pano/:id/kilit', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return res.status(400).json({ tamam: false, hata: 'Gecersiz pano kimligi.' });

    const sonuc = await panoService.kilitAyarla(id, req.body.kilitli === true);
    if (!sonuc.tamam) return res.status(404).json(sonuc);

    await log.bilgi({
      kategori: 'pano', olay: sonuc.kilitli ? 'pano_kilitlendi' : 'pano_kilidi_kaldirildi',
      mesaj: `#${id} panosu ${sonuc.kilitli ? 'kilitlendi' : 'kilidi kaldirildi'}.`, yoneticiId: req.yonetici.id, req,
    });

    return res.json(sonuc);
  } catch (hata) { next(hata); }
});

// ================================================================ SIL
yonlendirici.post('/pano/:id/sil', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return basarisizYanit(req, res, { hata: 'Gecersiz pano kimligi.' });

    const sonuc = await panoService.silSoft(id);
    if (!sonuc.tamam) return basarisizYanit(req, res, { hata: 'Pano bulunamadi.' });

    await log.bilgi({ kategori: 'pano', olay: 'pano_silindi', mesaj: `#${id} panosu silindi.`, yoneticiId: req.yonetici.id, req });
    return basariliYanit(req, res, { durumKodu: 'pano_silindi' });
  } catch (hata) { next(hata); }
});

// =============================================================== RESIM EKLE
yonlendirici.post(
  '/pano/:id/resim', onbellekYok, girisGerekli, yazmaSiniri,
  panoResimYukleyici.single('resim'), panoYuklemeHatasiYakala, csrfKoru,
  async (req, res, next) => {
    try {
      const id = dogrula.kimlik(req.params.id);
      if (!id) return res.status(400).json({ tamam: false, hata: 'Gecersiz pano kimligi.' });
      if (!req.file) return res.status(400).json({ tamam: false, hata: 'Resim secilmedi.' });

      const sonuc = await panoService.resimEkle({
        panoId: id, dosya: req.file, x: req.body.x, y: req.body.y, yoneticiId: req.yonetici.id,
      });
      if (!sonuc.tamam) return res.status(400).json(sonuc);

      return res.json(sonuc);
    } catch (hata) { next(hata); }
  },
);

// ============================================================== DISA AKTAR
yonlendirici.get('/pano/:id/disa-aktar', girisGerekli, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return res.status(400).end();

    const yedek = await panoService.disaAktar(id);
    if (!yedek) return res.status(404).end();

    await log.bilgi({ kategori: 'pano', olay: 'pano_disa_aktarildi', mesaj: `#${id} panosu JSON olarak disa aktarildi.`, yoneticiId: req.yonetici.id, req });

    const guvenliAd = String(yedek.pano.ad || 'pano').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60) || 'pano';
    const tarihDamgasi = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pano-${guvenliAd}-${tarihDamgasi}.json"`);
    return res.send(JSON.stringify(yedek, null, 2));
  } catch (hata) { next(hata); }
});

// ============================================================== ICE AKTAR
yonlendirici.post(
  '/pano/ice-aktar', onbellekYok, girisGerekli, yazmaSiniri,
  panoYedekYukleyici.single('yedek'), panoYuklemeHatasiYakala, csrfKoru,
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ tamam: false, hata: 'Yedek dosyasi secilmedi.' });

      let govde;
      try {
        govde = JSON.parse(req.file.buffer.toString('utf8'));
      } catch (_) {
        return res.status(400).json({ tamam: false, hata: 'Dosya gecerli bir JSON degil.' });
      }

      const sonuc = await panoService.iceAktar({ govde, yoneticiId: req.yonetici.id });
      if (!sonuc.tamam) return res.status(400).json(sonuc);

      await log.bilgi({
        kategori: 'pano', olay: 'pano_ice_aktarildi',
        mesaj: `Yedekten "${sonuc.pano.ad}" panosu olusturuldu (${sonuc.ogeSayisi} oge).`,
        yoneticiId: req.yonetici.id, req,
      });

      return res.json({ tamam: true, pano: sonuc.pano });
    } catch (hata) { next(hata); }
  },
);

module.exports = yonlendirici;
