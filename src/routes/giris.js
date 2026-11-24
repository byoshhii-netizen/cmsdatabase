'use strict';
/**
 * src/routes/giris.js   ->  /giris
 * Sifreli terminal giris ekrani ve POST ile kimlik dogrulama.
 */

const express = require('express');
const ayar = require('../config/env');
const authService = require('../services/authService');
const kilitService = require('../services/kilitService');
const { misafirGerekli, oturumBaslat, oturumBitir, jsonIster } = require('../middleware/auth');
const { girisSiniri } = require('../middleware/rateLimit');
const { csrfKoru } = require('../middleware/csrf');
const { onbellekYok } = require('../middleware/security');
const dogrula = require('../utils/validate');
const log = require('../services/logService');

const yonlendirici = express.Router();

const SEBEP_MESAJLARI = {
  mutlak: 'Oturum suresi doldu. Yeniden kimlik dogrulamasi gerekiyor.',
  bosta: 'Hareketsizlik nedeniyle baglanti kesildi.',
  surum: 'Ana sifre degistirildi. Tum oturumlar sifirlandi.',
  cikis: 'Baglanti guvenli sekilde kapatildi.',
};

// ---------------------------------------------------------------- GET /giris
yonlendirici.get('/giris', onbellekYok, misafirGerekli, async (req, res, next) => {
  try {
    const ip = log.ipCikar(req);
    const kilit = await kilitService.durum(ip);
    const sebep = String(req.query.sebep || '');

    res.render('giris', {
      baslik: 'KIMLIK DOGRULAMA',
      rota: '/giris',
      hedef: dogrula.dahiliHedef(req.query.hedef, '/merkez'),
      bildirim: SEBEP_MESAJLARI[sebep] || null,
      kilit,
      varsayilanKullanici: ayar.uretim ? '' : ayar.varsayilan.kullanici,
    });
  } catch (hata) { next(hata); }
});

// --------------------------------------------------------------- POST /giris
yonlendirici.post('/giris', onbellekYok, girisSiniri, csrfKoru, async (req, res, next) => {
  try {
    const ip = log.ipCikar(req);
    const userAgent = req.get('user-agent');
    const hedef = dogrula.dahiliHedef(req.body.hedef, '/merkez');

    const sonuc = await authService.girisYap({
      kullaniciAdi: req.body.kullanici_adi,
      sifre: req.body.sifre,
      ip,
      userAgent,
    });

    if (!sonuc.tamam) {
      if (jsonIster(req)) {
        return res.status(sonuc.kod === 'KILITLI' ? 429 : 401).json({
          tamam: false,
          kod: sonuc.kod,
          hata: sonuc.hata,
          kalanDeneme: sonuc.kalanDeneme ?? null,
          kalanSaniye: sonuc.kalanSaniye ?? null,
        });
      }
      const kilit = await kilitService.durum(ip);
      return res.status(401).render('giris', {
        baslik: 'KIMLIK DOGRULAMA',
        rota: '/giris',
        hedef,
        hata: sonuc.hata,
        kalanDeneme: sonuc.kalanDeneme ?? null,
        kilit,
        varsayilanKullanici: '',
        bildirim: null,
      });
    }

    // Oturum sabitleme (session fixation) korumasi: oturum kimligi yenilenir.
    await oturumBaslat(req, sonuc.yonetici);

    if (jsonIster(req)) {
      return res.json({ tamam: true, yonlendir: hedef, operator: sonuc.yonetici.gorunenAd });
    }
    return res.redirect(303, hedef);
  } catch (hata) { next(hata); }
});

// --------------------------------------------------------------- POST /cikis
yonlendirici.post('/cikis', onbellekYok, csrfKoru, async (req, res, next) => {
  try {
    const yoneticiId = req.session && req.session.yonetici ? req.session.yonetici.id : null;
    if (yoneticiId) {
      await log.bilgi({ kategori: 'kimlik', olay: 'cikis', mesaj: 'Oturum kapatildi.', yoneticiId, req });
    }
    await oturumBitir(req, res);

    if (jsonIster(req)) return res.json({ tamam: true, yonlendir: '/giris?sebep=cikis' });
    return res.redirect(303, '/giris?sebep=cikis');
  } catch (hata) { next(hata); }
});

module.exports = yonlendirici;
