'use strict';
/**
 * src/routes/api/kimlik.js   ->  /api/kimlik/*
 * Arayuzun oturum durumunu yoklamasi ve CSRF belirteci tazelemesi icin.
 */

const express = require('express');
const ayar = require('../../config/env');
const { girisGerekli } = require('../../middleware/auth');

const yonlendirici = express.Router();

/** Oturum canli mi? Arayuz bunu periyodik olarak yoklar. */
yonlendirici.get('/durum', (req, res) => {
  const acik = Boolean(req.session && req.session.yonetici && req.session.yonetici.id);
  res.json({
    tamam: true,
    oturumAcik: acik,
    operator: acik ? req.session.yonetici.gorunenAd : null,
    kullaniciAdi: acik ? req.session.yonetici.kullaniciAdi : null,
    bostaDakika: ayar.oturum.bostaDakika,
    kalanSaniye: acik && req.session.girisZamani
      ? Math.max(0, Math.round((ayar.oturum.mutlakDakika * 60_000 - (Date.now() - req.session.girisZamani)) / 1000))
      : 0,
  });
});

/** Yeni CSRF belirteci (uzun acik kalan sekmeler icin). */
yonlendirici.get('/belirtec', girisGerekli, (req, res) => {
  res.json({ tamam: true, csrf: req.session.csrfSirri });
});

module.exports = yonlendirici;
