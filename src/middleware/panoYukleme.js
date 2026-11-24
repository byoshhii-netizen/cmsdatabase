'use strict';
/**
 * src/middleware/panoYukleme.js
 * /pano icin iki ayri multer ornegi (bellek deposu):
 *   1) panoResimYukleyici -> tuvale surukle-birakilan tek bir resim
 *      (yalnizca gercek raster resim turleri; SVG kasitli olarak HARIC -
 *      gomulu script/olay tutabilir, bu yuzden kabul edilmez).
 *   2) panoYedekYukleyici -> "Yedekten İçe Aktar" icin tek bir .json dosyasi.
 *
 * Her iki akis da genel express.json() govde sinirini (bkz. app.js) devre
 * disi birakir; multer multipart govdeyi kendi okur, boylece buyuk
 * resim/yedek dosyalari genel JSON limitine takilmaz.
 */

const multer = require('multer');
const ayar = require('../config/env');

const depolama = multer.memoryStorage();

const RESIM_MIME_IZIN = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const panoResimYukleyici = multer({
  storage: depolama,
  limits: {
    fileSize: ayar.pano.resimMaxMb * 1024 * 1024,
    files: 1,
    fields: 10,
    fieldSize: 4 * 1024,
  },
  fileFilter(req, dosya, geriCagri) {
    if (!RESIM_MIME_IZIN.has(dosya.mimetype)) {
      return geriCagri(new Error('Yalnizca PNG, JPEG, GIF veya WEBP resimleri kabul edilir.'));
    }
    return geriCagri(null, true);
  },
});

const panoYedekYukleyici = multer({
  storage: depolama,
  limits: {
    fileSize: ayar.pano.yedekMaxMb * 1024 * 1024,
    files: 1,
    fields: 10,
    fieldSize: 4 * 1024,
  },
  fileFilter(req, dosya, geriCagri) {
    const adUygun = /\.json$/i.test(dosya.originalname || '');
    const mimeUygun = dosya.mimetype === 'application/json' || dosya.mimetype === 'text/plain' || dosya.mimetype === 'application/octet-stream';
    if (!adUygun && !mimeUygun) {
      return geriCagri(new Error('Yalnizca .json yedek dosyasi kabul edilir.'));
    }
    return geriCagri(null, true);
  },
});

/** multer hatalarini Turkce, kullanici dostu JSON mesaja cevirir (pano API'si tamamen JSON tabanli). */
function panoYuklemeHatasiYakala(hata, req, res, next) {
  if (!hata) return next();

  let mesaj = 'Dosya yuklenemedi.';
  if (hata instanceof multer.MulterError) {
    if (hata.code === 'LIMIT_FILE_SIZE') {
      mesaj = 'Dosya cok buyuk.';
    } else if (hata.code === 'LIMIT_FILE_COUNT') {
      mesaj = 'Tek seferde yalnizca bir dosya yuklenebilir.';
    } else {
      mesaj = 'Yukleme istegi gecersiz.';
    }
  } else if (hata.message) {
    mesaj = hata.message;
  }

  return res.status(400).json({ tamam: false, kod: 'YUKLEME_HATASI', hata: mesaj });
}

module.exports = { panoResimYukleyici, panoYedekYukleyici, panoYuklemeHatasiYakala };
