'use strict';
/**
 * src/middleware/errorHandler.js
 * 404 ve merkezi hata yakalayici.
 * Uretimde yigin izi (stack trace) ASLA istemciye gonderilmez.
 */

const ayar = require('../config/env');
const log = require('../services/logService');
const { jsonIster } = require('./auth');

function bulunamadi(req, res) {
  if (jsonIster(req)) {
    return res.status(404).json({ tamam: false, kod: 'BULUNAMADI', hata: 'Istenen kaynak yok.' });
  }
  return res.status(404).render('hata/genel', {
    baslik: 'SEKTOR BULUNAMADI',
    kod: 404,
    mesaj: 'Talep ettiginiz sektor bu veri merkezinde kayitli degil.',
    rota: req.path,
  });
}

// eslint-disable-next-line no-unused-vars
function hataYakala(hata, req, res, next) {
  const kod = Number(hata.status || hata.statusCode) || 500;
  const kritikMi = kod >= 500;

  console.error(`[HATA ${kod}] ${req.method} ${req.originalUrl}:`, hata.message);
  if (kritikMi && !ayar.uretim) console.error(hata.stack);

  void log.yaz({
    seviye: kritikMi ? 'kritik' : 'uyari',
    kategori: 'sistem',
    olay: `istisna_${kod}`,
    mesaj: hata.message ? String(hata.message).slice(0, 500) : 'Bilinmeyen hata',
    yoneticiId: req.session && req.session.yonetici ? req.session.yonetici.id : null,
    req,
    durumKodu: kod,
    meta: ayar.uretim ? {} : { yigin: String(hata.stack || '').slice(0, 2000) },
  });

  if (res.headersSent) return;

  // Gorunur mesaj: uretimde genel, gelistirmede ayrintili
  const gorunurMesaj = kritikMi && ayar.uretim
    ? 'Sistemde beklenmeyen bir ariza olustu. Olay kaydedildi.'
    : (hata.mesaj || hata.message || 'Beklenmeyen hata.');

  if (jsonIster(req)) {
    return res.status(kod).json({
      tamam: false,
      kod: hata.kod || 'SUNUCU_HATASI',
      hata: gorunurMesaj,
    });
  }

  return res.status(kod).render('hata/genel', {
    baslik: kritikMi ? 'SISTEM ARIZASI' : 'ISTEK REDDEDILDI',
    kod,
    mesaj: gorunurMesaj,
    rota: req.path,
  });
}

module.exports = { bulunamadi, hataYakala };
