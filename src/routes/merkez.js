'use strict';
/**
 * src/routes/merkez.js   ->  /merkez
 * Ana kontrol paneli: modul durumlari ve ozet gostergeler.
 */

const express = require('express');
const db = require('../config/db');
const log = require('../services/logService');
const kilitService = require('../services/kilitService');
const { girisGerekli } = require('../middleware/auth');
const { onbellekYok } = require('../middleware/security');

const yonlendirici = express.Router();

yonlendirici.get('/merkez', onbellekYok, girisGerekli, async (req, res, next) => {
  try {
    const [sayimlar, ozet, kilitler] = await Promise.all([
      db.tekSatir(`
        SELECT
          (SELECT COUNT(*)::int FROM klasorler WHERE silindi = FALSE)         AS klasor,
          (SELECT COUNT(*)::int FROM dosyalar  WHERE silindi = FALSE)         AS dosya,
          (SELECT COALESCE(SUM(boyut_bayt),0)::bigint FROM dosyalar WHERE silindi = FALSE) AS toplam_bayt,
          (SELECT COUNT(*)::int FROM panolar   WHERE silindi = FALSE)         AS pano,
          (SELECT COUNT(*)::int FROM cambaz_oturumlari WHERE arsivlendi = FALSE) AS cambaz,
          (SELECT COUNT(*)::int FROM paylasim_linkleri WHERE aktif = TRUE)    AS paylasim
      `),
      log.ozet(),
      kilitService.aktifKilitler(),
    ]);

    const sonLoglar = await log.listele({ limit: 8 });

    res.render('merkez', {
      baslik: 'KONTROL MERKEZI',
      rota: '/merkez',
      sayimlar: sayimlar || {},
      ozet: ozet || {},
      kilitSayisi: kilitler.length,
      sonLoglar: sonLoglar.kayitlar,
    });
  } catch (hata) { next(hata); }
});

module.exports = yonlendirici;
