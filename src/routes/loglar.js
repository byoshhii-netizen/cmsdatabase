'use strict';
/**
 * src/routes/loglar.js   ->  /loglar
 * Erisim ve izleme kayitlari + disa acik paylasimlara yapilan DIS ERISIM
 * izlerinin (IP, tarih/saat, ayristirilmis cihaz/tarayici, goruntuleme
 * sayisi) filtrelenebilir istihbarat tablosu.
 */

const express = require('express');
const log = require('../services/logService');
const kilitService = require('../services/kilitService');
const erisimService = require('../services/erisimService');
const { girisGerekli } = require('../middleware/auth');
const { onbellekYok } = require('../middleware/security');

const yonlendirici = express.Router();

const CIHAZ_TIPLERI = ['masaustu', 'mobil', 'tablet', 'tv', 'bot', 'bilinmiyor'];

yonlendirici.get('/loglar', onbellekYok, girisGerekli, async (req, res, next) => {
  try {
    const sayfa = Math.max(1, Number.parseInt(req.query.sayfa, 10) || 1);
    const limit = 50;

    const erisimSayfa = Math.max(1, Number.parseInt(req.query.e_sayfa, 10) || 1);
    const erisimLimit = 40;

    const [liste, denemeler, kilitler, ozet, erisimListe, erisimOzet] = await Promise.all([
      log.listele({
        seviye: req.query.seviye,
        kategori: req.query.kategori,
        arama: req.query.arama,
        limit,
        ofset: (sayfa - 1) * limit,
      }),
      kilitService.sonDenemeler(25),
      kilitService.aktifKilitler(),
      log.ozet(),
      erisimService.listele({
        eylem: req.query.e_eylem,
        cihazTipi: req.query.e_cihaz,
        arama: req.query.e_arama,
        limit: erisimLimit,
        ofset: (erisimSayfa - 1) * erisimLimit,
      }),
      erisimService.ozet(),
    ]);

    res.render('loglar', {
      baslik: 'IZLEME KAYITLARI',
      rota: '/loglar',
      liste,
      sayfa,
      sayfaSayisi: Math.max(1, Math.ceil(liste.toplam / limit)),
      denemeler,
      kilitler,
      ozet: ozet || {},
      filtre: {
        seviye: req.query.seviye || '',
        kategori: req.query.kategori || '',
        arama: req.query.arama || '',
      },
      seviyeler: log.SEVIYELER,
      kategoriler: log.KATEGORILER,

      // --- Dis erisim istihbarati ---
      erisimListe,
      erisimOzet: erisimOzet || {},
      erisimSayfa,
      erisimSayfaSayisi: Math.max(1, Math.ceil(erisimListe.toplam / erisimLimit)),
      erisimFiltre: {
        eylem: req.query.e_eylem || '',
        cihaz: req.query.e_cihaz || '',
        arama: req.query.e_arama || '',
      },
      erisimEylemleri: erisimService.EYLEMLER,
      cihazTipleri: CIHAZ_TIPLERI,
    });
  } catch (hata) { next(hata); }
});

module.exports = yonlendirici;
