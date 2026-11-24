'use strict';
/**
 * src/routes/index.js
 * Tum rotalarin tek giris noktasi.
 *
 * ROTA HARITASI
 *   GET  /                      -> /merkez veya /giris yonlendirmesi
 *   GET  /giris                 -> sifreli terminal giris ekrani
 *   POST /giris                 -> kimlik dogrulama
 *   POST /cikis                 -> oturum kapatma
 *   GET  /merkez                -> ana kontrol paneli          [kimlik]
 *   GET  /depo                  -> sifreli dosya/klasor kasasi [kimlik]
 *   GET  /pano                  -> cizim ve strateji panosu    [kimlik]
 *   GET  /cambaz                -> yapay zeka ajani (sohbet+ses+hafiza) [kimlik]
 *   POST /cambaz/oturum/*       -> gorusme/mesaj/ses uretme    [kimlik]
 *   POST /cambaz/hafiza/*       -> kalici hafiza CRUD          [kimlik]
 *   GET  /loglar                -> erisim ve izleme kayitlari  [kimlik]
 *   GET  /ayarlar               -> sifre, API anahtari ve ses yonetimi [kimlik]
 *   POST /ayarlar/sifre         -> ana sifre degistirme        [kimlik]
 *   POST /ayarlar/api-anahtari  -> API anahtari kaydet/aktif/sil [kimlik]
 *   POST /ayarlar/cambaz-ses*   -> Cambaz ses motoru + ozel ornek [kimlik]
 *   GET  /paylas/:token         -> disa acik kontrollu gorunum [acik]
 *   GET  /saglik                -> saglik kontrolu (Railway)   [acik]
 *   GET  /api/kimlik/*          -> oturum durumu
 *   GET  /api/sistem/*          -> panel verileri              [kimlik]
 */

const express = require('express');

const girisRotalari = require('./giris');
const merkezRotalari = require('./merkez');
const depoRotalari = require('./depo');
const panoRotalari = require('./pano');
const cambazRotalari = require('./cambaz');
const loglarRotalari = require('./loglar');
const ayarlarRotalari = require('./ayarlar');
const paylasRotalari = require('./paylas');

const kimlikApi = require('./api/kimlik');
const sistemApi = require('./api/sistem');

const db = require('../config/db');

const yonlendirici = express.Router();

// --- Kok ------------------------------------------------------------------
yonlendirici.get('/', (req, res) => {
  const acik = Boolean(req.session && req.session.yonetici && req.session.yonetici.id);
  res.redirect(302, acik ? '/merkez' : '/giris');
});

// --- Saglik kontrolu (Railway healthcheck) --------------------------------
yonlendirici.get('/saglik', async (req, res) => {
  try {
    await db.sorgu('SELECT 1');
    res.json({ tamam: true, durum: 'calisiyor', veritabani: 'bagli', zaman: new Date().toISOString() });
  } catch {
    res.status(503).json({ tamam: false, durum: 'bozuk', veritabani: 'kopuk' });
  }
});

// --- Sayfa rotalari -------------------------------------------------------
yonlendirici.use(girisRotalari);
yonlendirici.use(merkezRotalari);
yonlendirici.use(depoRotalari);
yonlendirici.use(panoRotalari);
yonlendirici.use(cambazRotalari);
yonlendirici.use(loglarRotalari);
yonlendirici.use(ayarlarRotalari);
yonlendirici.use(paylasRotalari);

// --- API ------------------------------------------------------------------
yonlendirici.use('/api/kimlik', kimlikApi);
yonlendirici.use('/api/sistem', sistemApi);

module.exports = yonlendirici;
