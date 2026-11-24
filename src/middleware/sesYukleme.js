'use strict';
/**
 * src/middleware/sesYukleme.js
 * /ayarlar/cambaz-ses-ornegi icin tek multer ornegi: Cambaz'in ozel ses
 * klonlamasinda referans olarak kullanilacak kisa ses dosyasi yuklemesi.
 */

const multer = require('multer');
const ayar = require('../config/env');

const depolama = multer.memoryStorage();

const SES_MIME_IZIN = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/webm',
  'audio/ogg', 'audio/m4a', 'audio/mp4', 'audio/x-m4a', 'audio/aac',
]);

const sesOrnekYukleyici = multer({
  storage: depolama,
  limits: {
    fileSize: ayar.cambaz.sesOrnekMaxMb * 1024 * 1024,
    files: 1,
    fields: 5,
    fieldSize: 4 * 1024,
  },
  fileFilter(req, dosya, geriCagri) {
    const adUygun = /\.(mp3|wav|webm|ogg|m4a|aac)$/i.test(dosya.originalname || '');
    if (!SES_MIME_IZIN.has(dosya.mimetype) && !adUygun) {
      return geriCagri(new Error('Yalnizca ses dosyalari kabul edilir (mp3, wav, webm, ogg, m4a, aac).'));
    }
    return geriCagri(null, true);
  },
});

/** multer hatalarini kullanici dostu JSON mesaja cevirir. */
function sesYuklemeHatasiYakala(hata, req, res, next) {
  if (!hata) return next();

  let mesaj = 'Ses dosyasi yuklenemedi.';
  if (hata instanceof multer.MulterError) {
    mesaj = hata.code === 'LIMIT_FILE_SIZE' ? 'Ses dosyasi cok buyuk.' : 'Yukleme istegi gecersiz.';
  } else if (hata.message) {
    mesaj = hata.message;
  }
  return res.status(400).json({ tamam: false, kod: 'YUKLEME_HATASI', hata: mesaj });
}

module.exports = { sesOrnekYukleyici, sesYuklemeHatasiYakala };
