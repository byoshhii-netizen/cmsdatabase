'use strict';
/**
 * src/middleware/logger.js
 * Istek/yanit izleme. Konsola kisa satir, veritabanina anlamli olaylar.
 * Statik dosyalar ve saglik kontrolu veritabanina yazilmaz (gurultu).
 */

const log = require('../services/logService');

const ATLA = [/^\/css\//, /^\/js\//, /^\/ikon\//, /^\/favicon/, /^\/saglik$/, /\.map$/];

function istekKaydi(req, res, next) {
  const baslangic = process.hrtime.bigint();

  res.on('finish', () => {
    const sureMs = Number(process.hrtime.bigint() - baslangic) / 1e6;
    const kod = res.statusCode;

    if (!process.env.SESSIZ_LOG) {
      const isaret = kod >= 500 ? '!!' : kod >= 400 ? ' !' : ' >';
      console.log(`${isaret} ${req.method} ${req.originalUrl} ${kod} ${sureMs.toFixed(1)}ms`);
    }

    if (ATLA.some((d) => d.test(req.path))) return;

    // Yalnizca anlamli olaylari kalici kaydet
    const kayitlik = kod >= 400 || req.method !== 'GET';
    if (!kayitlik) return;

    const seviye = kod >= 500 ? 'hata' : kod >= 400 ? 'uyari' : 'izleme';

    void log.yaz({
      seviye,
      kategori: 'sistem',
      olay: `http_${kod}`,
      mesaj: `${req.method} ${req.path}`,
      yoneticiId: req.session && req.session.yonetici ? req.session.yonetici.id : null,
      req,
      durumKodu: kod,
      sureMs: Math.round(sureMs),
    });
  });

  next();
}

module.exports = { istekKaydi };
