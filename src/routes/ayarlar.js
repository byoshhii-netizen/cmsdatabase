'use strict';
/**
 * src/routes/ayarlar.js   ->  /ayarlar
 * Ana sifre degistirme ve API anahtari yonetimi.
 */

const express = require('express');
const ayarService = require('../services/ayarService');
const authService = require('../services/authService');
const sesServisi = require('../services/sesServisi');
const { girisGerekli, jsonIster } = require('../middleware/auth');
const { onbellekYok } = require('../middleware/security');
const { csrfKoru } = require('../middleware/csrf');
const { sifreSiniri, yazmaSiniri } = require('../middleware/rateLimit');
const { sesOrnekYukleyici, sesYuklemeHatasiYakala } = require('../middleware/sesYukleme');
const dogrula = require('../utils/validate');
const log = require('../services/logService');

const yonlendirici = express.Router();

/** Yonlendirme sonrasi gosterilecek bildirim metinleri. */
const DURUM_MESAJLARI = {
  sifre_tamam:     'Ana sifre guncellendi. Diger tum oturumlar kapatildi.',
  anahtar_tamam:   'API anahtari sifrelenerek kaydedildi.',
  anahtar_silindi: 'API anahtari silindi.',
  anahtar_yok:     'Silinecek anahtar bulunamadi.',
  arayuz_tamam:    'Arayuz ayarlari kaydedildi.',
  anahtar_durum:   'Anahtar durumu guncellendi.',
  ses_tamam:       'Cambaz ses ayarlari kaydedildi.',
  ses_ornek_tamam: 'Ozel ses ornegi yuklendi.',
  ses_ornek_silindi: 'Ozel ses ornegi silindi.',
};

const DURUM_HATALARI = {
  anahtar_hata: 'Anahtar kaydedilemedi. Degeri kontrol edin.',
  ses_ornek_hata: 'Ses ornegi kaydedilemedi.',
};

// ------------------------------------------------------------- GET /ayarlar
yonlendirici.get('/ayarlar', onbellekYok, girisGerekli, async (req, res, next) => {
  try {
    const [anahtarlar, ayarlar, hesap, sesOrnegi] = await Promise.all([
      ayarService.apiAnahtarlariListele(),
      ayarService.tumAyarlar(),
      authService.yoneticiGetir(req.yonetici.id),
      sesServisi.sesOrnekBilgisi(),
    ]);

    res.render('ayarlar', {
      baslik: 'SISTEM AYARLARI',
      rota: '/ayarlar',
      anahtarlar,
      ayarlar,
      hesap,
      sesOrnegi,
      bildirim: DURUM_MESAJLARI[String(req.query.durum || '')] || null,
      hata: DURUM_HATALARI[String(req.query.durum || '')] || null,
    });
  } catch (hata) { next(hata); }
});

// --------------------------------------------- POST /ayarlar/sifre (degistir)
yonlendirici.post(
  '/ayarlar/sifre',
  onbellekYok,
  girisGerekli,
  sifreSiniri,
  csrfKoru,
  async (req, res, next) => {
    try {
      const sonuc = await authService.sifreDegistir({
        yoneticiId: req.yonetici.id,
        mevcutSifre: req.body.mevcut_sifre,
        yeniSifre: req.body.yeni_sifre,
        yeniSifreTekrar: req.body.yeni_sifre_tekrar,
        ip: log.ipCikar(req),
        userAgent: req.get('user-agent'),
      });

      if (!sonuc.tamam) {
        if (jsonIster(req)) {
          return res.status(400).json({ tamam: false, kod: sonuc.kod, hata: sonuc.hata, hatalar: sonuc.hatalar || [] });
        }
        return res.status(400).render('ayarlar', {
          baslik: 'SISTEM AYARLARI',
          rota: '/ayarlar',
          anahtarlar: await ayarService.apiAnahtarlariListele(),
          ayarlar: await ayarService.tumAyarlar(),
          hesap: await authService.yoneticiGetir(req.yonetici.id),
          bildirim: null,
          hata: sonuc.hata,
        });
      }

      // Diger cihazlardaki oturumlari dusur, mevcut oturumu guncel surume tasi.
      const dusen = await authService.digerOturumlariKapat(req.yonetici.id, req.sessionID);
      req.session.yonetici.oturumSurumu = sonuc.oturumSurumu;
      req.session.surumKontrolZamani = Date.now();

      if (jsonIster(req)) {
        return res.json({
          tamam: true,
          mesaj: 'Ana sifre guncellendi. Diger tum oturumlar kapatildi.',
          kapatilanOturum: dusen,
          guc: sonuc.guc,
        });
      }
      return res.redirect(303, '/ayarlar?durum=sifre_tamam');
    } catch (hata) { next(hata); }
  },
);

// ----------------------------------------------- POST /ayarlar/api-anahtari
yonlendirici.post(
  '/ayarlar/api-anahtari',
  onbellekYok,
  girisGerekli,
  yazmaSiniri,
  csrfKoru,
  async (req, res, next) => {
    try {
      const sonuc = await ayarService.apiAnahtarKaydet({
        saglayici: req.body.saglayici,
        etiket: req.body.etiket,
        deger: req.body.deger,
        yoneticiId: req.yonetici.id,
      });

      if (!sonuc.tamam) {
        if (jsonIster(req)) return res.status(400).json({ tamam: false, hata: sonuc.hata });
        return res.redirect(303, '/ayarlar?durum=anahtar_hata');
      }

      if (jsonIster(req)) return res.json({ tamam: true, mesaj: 'Anahtar sifrelenerek kaydedildi.' });
      return res.redirect(303, '/ayarlar?durum=anahtar_tamam');
    } catch (hata) { next(hata); }
  },
);

// ------------------------------------- POST /ayarlar/api-anahtari/:id/aktif
yonlendirici.post(
  '/ayarlar/api-anahtari/:id/aktif',
  onbellekYok,
  girisGerekli,
  yazmaSiniri,
  csrfKoru,
  async (req, res, next) => {
    try {
      const id = dogrula.kimlik(req.params.id);
      if (!id) {
        if (jsonIster(req)) return res.status(400).json({ tamam: false, hata: 'Gecersiz kimlik.' });
        return res.redirect(303, '/ayarlar');
      }
      const aktif = req.body.aktif === true || req.body.aktif === 'true';
      const satir = await ayarService.apiAnahtarAktifAyarla(id, aktif, req.yonetici.id);
      if (jsonIster(req)) return res.json({ tamam: Boolean(satir), satir: satir || null });
      return res.redirect(303, '/ayarlar?durum=anahtar_durum');
    } catch (hata) { next(hata); }
  },
);

// --------------------------------------- POST /ayarlar/api-anahtari/:id/sil
yonlendirici.post(
  '/ayarlar/api-anahtari/:id/sil',
  onbellekYok,
  girisGerekli,
  yazmaSiniri,
  csrfKoru,
  async (req, res, next) => {
    try {
      const id = dogrula.kimlik(req.params.id);
      if (!id) {
        if (jsonIster(req)) return res.status(400).json({ tamam: false, hata: 'Gecersiz kimlik.' });
        return res.redirect(303, '/ayarlar');
      }
      const silindi = await ayarService.apiAnahtarSil(id, req.yonetici.id);
      if (jsonIster(req)) return res.json({ tamam: silindi });
      return res.redirect(303, '/ayarlar?durum=' + (silindi ? 'anahtar_silindi' : 'anahtar_yok'));
    } catch (hata) { next(hata); }
  },
);

// -------------------------------------------------- POST /ayarlar/arayuz
yonlendirici.post(
  '/ayarlar/arayuz',
  onbellekYok,
  girisGerekli,
  yazmaSiniri,
  csrfKoru,
  async (req, res, next) => {
    try {
      const mantikAyarlar = ['ses_aktif', 'matrix_aktif', 'gecis_animasyonu'];
      for (const anahtar of mantikAyarlar) {
        const deger = req.body[anahtar] === 'true' || req.body[anahtar] === 'on' || req.body[anahtar] === true;
        await ayarService.ayarYaz(anahtar, deger ? 'true' : 'false', 'mantik');
      }
      await log.bilgi({
        kategori: 'ayarlar', olay: 'arayuz_ayarlari_guncellendi',
        yoneticiId: req.yonetici.id, req,
      });

      if (jsonIster(req)) return res.json({ tamam: true, mesaj: 'Arayuz ayarlari kaydedildi.' });
      return res.redirect(303, '/ayarlar?durum=arayuz_tamam');
    } catch (hata) { next(hata); }
  },
);

// ======================================================================
//  CAMBAZ SES AYARLARI
// ======================================================================

const SES_TUR_IZIN = new Set(['tarayici', 'openai', 'elevenlabs']);

// ----------------------------------------------------- POST /ayarlar/cambaz-ses
yonlendirici.post(
  '/ayarlar/cambaz-ses',
  onbellekYok,
  girisGerekli,
  yazmaSiniri,
  csrfKoru,
  async (req, res, next) => {
    try {
      const tur = SES_TUR_IZIN.has(req.body.tur) ? req.body.tur : 'tarayici';
      const ad = dogrula.metin(req.body.ad, { max: 80 });
      const hiz = Math.max(0.5, Math.min(2, Number(req.body.hiz) || 1));
      const perde = Math.max(0.5, Math.min(2, Number(req.body.perde) || 1));

      await Promise.all([
        ayarService.ayarYaz('cambaz_ses_turu', tur, 'metin'),
        ayarService.ayarYaz('cambaz_ses_ad', ad, 'metin'),
        ayarService.ayarYaz('cambaz_ses_hiz', String(hiz), 'metin'),
        ayarService.ayarYaz('cambaz_ses_perde', String(perde), 'metin'),
      ]);

      await log.bilgi({ kategori: 'cambaz', olay: 'ses_ayarlari_guncellendi', yoneticiId: req.yonetici.id, req });

      if (jsonIster(req)) return res.json({ tamam: true });
      return res.redirect(303, '/ayarlar?durum=ses_tamam');
    } catch (hata) { next(hata); }
  },
);

// ------------------------------------------- POST /ayarlar/cambaz-ses-ornegi
yonlendirici.post(
  '/ayarlar/cambaz-ses-ornegi',
  onbellekYok,
  girisGerekli,
  yazmaSiniri,
  csrfKoru,
  sesOrnekYukleyici.single('ornek'),
  sesYuklemeHatasiYakala,
  async (req, res, next) => {
    try {
      if (!req.file) {
        if (jsonIster(req)) return res.status(400).json({ tamam: false, hata: 'Dosya bulunamadi.' });
        return res.redirect(303, '/ayarlar?durum=ses_ornek_hata');
      }

      await sesServisi.sesOrnekKaydet({
        tampon: req.file.buffer, mime: req.file.mimetype, dosyaAdi: req.file.originalname,
      });

      // ElevenLabs anahtari varsa, ornegi hemen klonlamayi dene (en iyi efor;
      // basarisiz olursa kullanici /ayarlar'da anahtar/dosya durumunu gorur).
      const elevenlabsKey = await ayarService.apiAnahtarCoz('elevenlabs');
      let klonSonucu = null;
      if (elevenlabsKey) klonSonucu = await sesServisi.elevenlabsKlonOlustur(elevenlabsKey);

      await log.bilgi({ kategori: 'cambaz', olay: 'ses_ornegi_yuklendi', yoneticiId: req.yonetici.id, req });

      if (jsonIster(req)) return res.json({ tamam: true, klon: klonSonucu });
      return res.redirect(303, '/ayarlar?durum=ses_ornek_tamam');
    } catch (hata) { next(hata); }
  },
);

// --------------------------------------- POST /ayarlar/cambaz-ses-ornegi/sil
yonlendirici.post(
  '/ayarlar/cambaz-ses-ornegi/sil',
  onbellekYok,
  girisGerekli,
  yazmaSiniri,
  csrfKoru,
  async (req, res, next) => {
    try {
      const silindi = await sesServisi.sesOrnekSil();
      if (jsonIster(req)) return res.json({ tamam: silindi });
      return res.redirect(303, '/ayarlar?durum=ses_ornek_silindi');
    } catch (hata) { next(hata); }
  },
);

module.exports = yonlendirici;
