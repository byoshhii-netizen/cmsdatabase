'use strict';
/**
 * src/routes/api/sistem.js   ->  /api/sistem/*
 * Panel gostergeleri icin hafif JSON uclari.
 */

const express = require('express');
const db = require('../../config/db');
const log = require('../../services/logService');
const kilitService = require('../../services/kilitService');
const { girisGerekli } = require('../../middleware/auth');

const yonlendirici = express.Router();

yonlendirici.get('/ozet', girisGerekli, async (req, res, next) => {
  try {
    const [sayimlar, ozet, kilitler] = await Promise.all([
      db.tekSatir(`
        SELECT
          (SELECT COUNT(*)::int FROM klasorler WHERE silindi = FALSE) AS klasor,
          (SELECT COUNT(*)::int FROM dosyalar  WHERE silindi = FALSE) AS dosya,
          (SELECT COUNT(*)::int FROM panolar   WHERE silindi = FALSE) AS pano,
          (SELECT COUNT(*)::int FROM paylasim_linkleri WHERE aktif = TRUE) AS paylasim
      `),
      log.ozet(),
      kilitService.aktifKilitler(),
    ]);
    res.json({ tamam: true, sayimlar, ozet, aktifKilit: kilitler.length, zaman: new Date().toISOString() });
  } catch (hata) { next(hata); }
});

yonlendirici.get('/loglar', girisGerekli, async (req, res, next) => {
  try {
    const liste = await log.listele({
      seviye: req.query.seviye,
      kategori: req.query.kategori,
      arama: req.query.arama,
      limit: req.query.limit || 50,
      ofset: req.query.ofset || 0,
    });
    res.json({ tamam: true, ...liste });
  } catch (hata) { next(hata); }
});

module.exports = yonlendirici;
