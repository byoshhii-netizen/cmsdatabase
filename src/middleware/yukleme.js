'use strict';
/**
 * src/middleware/yukleme.js
 * Dosya yukleme ara yazilimi (multer, bellek deposu).
 *
 * Bellek deposu kullanilir cunku her dosya hemen AES-256-GCM ile sifrelenip
 * diske yazilir; duz (sifresiz) hali diskte hic var olmaz.
 * Boyut siniri .env -> DEPO_MAX_MB degerinden gelir (varsayilan 50 MB).
 */

const multer = require('multer');
const ayar = require('../config/env');

const depolama = multer.memoryStorage();

const yukleyici = multer({
  storage: depolama,
  limits: {
    fileSize: ayar.depo.maxBayt,
    files: 10,          // tek istekte en fazla 10 dosya
    fields: 20,
    fieldSize: 4 * 1024,
  },
  fileFilter(req, dosya, geriCagri) {
    // Depo kasasi KASITLI olarak her dosya turunu kabul eder (operatorun
    // kendi sifreli kasasidir). Yalnizca dosya adinda gizli kontrol
    // karakteri veya asiri uzunluk varsa reddedilir; gercek temizlik
    // dosyaService.yukle() icinde dogrula.dosyaAdi ile yapilir.
    if (!dosya.originalname || dosya.originalname.length > 255) {
      return geriCagri(new Error('Dosya adi gecersiz veya cok uzun.'));
    }
    return geriCagri(null, true);
  },
});

/** multer hatalarini Turkce, kullanici dostu mesaja cevirir. */
function yuklemeHatasiYakala(hata, req, res, next) {
  if (!hata) return next();

  let mesaj = 'Dosya yuklenemedi.';
  if (hata instanceof multer.MulterError) {
    if (hata.code === 'LIMIT_FILE_SIZE') {
      mesaj = `Dosya cok buyuk. En fazla ${Math.floor(ayar.depo.maxBayt / (1024 * 1024))} MB yuklenebilir.`;
    } else if (hata.code === 'LIMIT_FILE_COUNT') {
      mesaj = 'Tek seferde en fazla 10 dosya yuklenebilir.';
    } else if (hata.code === 'LIMIT_UNEXPECTED_FILE') {
      mesaj = 'Beklenmeyen dosya alani.';
    }
  } else if (hata.message) {
    mesaj = hata.message;
  }

  const jsonIster = (req.get('accept') || '').includes('application/json') || req.xhr || req.path.startsWith('/api/');
  if (jsonIster || req.path.startsWith('/depo')) {
    return res.status(400).json({ tamam: false, kod: 'YUKLEME_HATASI', hata: mesaj });
  }
  return res.status(400).render('hata/genel', {
    baslik: 'YUKLEME HATASI', kod: 400, mesaj, rota: req.path,
  });
}

module.exports = { yukleyici, yuklemeHatasiYakala };
