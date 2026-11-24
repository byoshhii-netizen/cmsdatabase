'use strict';
/**
 * src/middleware/session.js
 * PostgreSQL destekli oturum yonetimi.
 * Cerez: HttpOnly + Secure (uretimde) + SameSite=Lax + imzali.
 */

const session = require('express-session');
const PgOturumDeposu = require('connect-pg-simple')(session);
const ayar = require('../config/env');
const { havuz } = require('../config/db');

function oturumAraYazilimi() {
  const depo = new PgOturumDeposu({
    pool: havuz,
    tableName: 'oturumlar',
    createTableIfMissing: false,   // tablo schema.sql tarafindan olusturulur
    pruneSessionInterval: 60 * 15, // 15 dakikada bir suresi gecenleri temizle
    errorLog: (m) => console.error('[OTURUM DEPOSU]', m),
  });

  return session({
    name: ayar.oturum.cerezAdi,        // varsayilan "connect.sid" degil -> parmak izi azaltir
    store: depo,
    secret: ayar.sir.oturum,
    resave: false,
    saveUninitialized: false,          // gereksiz oturum kaydi olusturmaz
    rolling: true,                     // her istekte sureyi tazeler (bosta zaman asimi)
    proxy: ayar.trustProxy > 0,
    cookie: {
      httpOnly: true,                  // JavaScript cerezi okuyamaz -> XSS'te token calinamaz
      secure: ayar.uretim,             // yalnizca HTTPS
      sameSite: 'lax',                 // CSRF yuzeyini daraltir
      maxAge: ayar.oturum.bostaDakika * 60 * 1000,
      path: '/',
    },
  });
}

module.exports = { oturumAraYazilimi };
