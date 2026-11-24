'use strict';
/**
 * src/middleware/rateLimit.js
 * Istek hizi sinirlayicilari (bellek ici sayac) + veritabani destekli
 * kademeli brute-force kilidi (src/services/kilitService.js).
 */

const rateLimit = require('express-rate-limit');
const ayar = require('../config/env');

/** JSON isteyen istemciyi tespit eder. */
function jsonIster(req) {
  return (req.get('accept') || '').includes('application/json') ||
         req.xhr || req.path.startsWith('/api/');
}

/** Ortak asim yaniti. */
function asimYaniti(mesaj) {
  return (req, res) => {
    const yenidenDene = Number(res.getHeader('Retry-After')) || 60;
    if (jsonIster(req)) {
      return res.status(429).json({ tamam: false, kod: 'HIZ_SINIRI', hata: mesaj, yenidenDeneSaniye: yenidenDene });
    }
    return res.status(429).render('hata/genel', {
      baslik: 'HIZ SINIRI',
      kod: 429,
      mesaj: `${mesaj} (${yenidenDene} saniye sonra tekrar deneyin.)`,
      rota: req.path,
    });
  };
}

const ortakAyar = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Anahtar varsayilan olarak req.ip'dir; req.ip degeri
  // app.set('trust proxy', n) ayari ile dogru sekilde cozulur.
};

/** Tum uygulama icin genel ust sinir (DoS yuzeyini daraltir). */
const genelSinir = rateLimit({
  ...ortakAyar,
  windowMs: 15 * 60 * 1000,
  limit: ayar.uretim ? 900 : 5000,
  handler: asimYaniti('Cok fazla istek gonderildi.'),
});

/** Giris denemeleri: IP basina siki sinir. */
const girisSiniri = rateLimit({
  ...ortakAyar,
  windowMs: 10 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,   // basarili giris sayaci tuketmez
  handler: asimYaniti('Cok fazla giris denemesi. Erisiminiz gecici olarak kisitlandi.'),
});

/** Sifre degistirme: kotuye kullanimi engelle. */
const sifreSiniri = rateLimit({
  ...ortakAyar,
  windowMs: 60 * 60 * 1000,
  limit: 12,
  handler: asimYaniti('Cok fazla sifre degistirme denemesi.'),
});

/** Paylasim linki sifre denemeleri. */
const paylasimSiniri = rateLimit({
  ...ortakAyar,
  windowMs: 15 * 60 * 1000,
  limit: 30,
  handler: asimYaniti('Bu baglanti icin cok fazla deneme yapildi.'),
});

/** Yazma islemleri (API POST/PUT/DELETE) icin orta siki sinir. */
const yazmaSiniri = rateLimit({
  ...ortakAyar,
  windowMs: 5 * 60 * 1000,
  limit: ayar.uretim ? 300 : 2000,
  handler: asimYaniti('Cok fazla yazma istegi.'),
});

module.exports = { genelSinir, girisSiniri, sifreSiniri, paylasimSiniri, yazmaSiniri };
