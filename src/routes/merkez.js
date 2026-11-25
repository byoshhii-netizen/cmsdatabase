'use strict';
/**
 * src/routes/merkez.js   ->  /merkez
 * ISTIHBARAT KONTROL MERKEZI
 *
 * Tek ekranda: tehdit seviyesi, 30 gunluk hareketlilik, acik vakalar,
 * okunmamis uyarilar, kilit aktorler, bekleyen is yuku, motor durumu ve
 * cekirdek zekanin o anki degerlendirmesi.
 */

const express = require('express');
const db = require('../config/db');
const log = require('../services/logService');
const kilitService = require('../services/kilitService');
const arsiv = require('../services/arsivService');
const zeka = require('../services/zekaService');
const cozumleme = require('../services/cozumlemeService');
const uyariService = require('../services/uyariService');
const nd = require('../zeka/dogalDil');
const { girisGerekli } = require('../middleware/auth');
const { onbellekYok } = require('../middleware/security');

const yonlendirici = express.Router();

/**
 * Tehdit seviyesi: tek bir sayiya indirgenmis durum gostergesi.
 * Kritik uyari, yuksek onemli izlemedeki varlik, acik kritik vaka ve
 * bekleyen is yuku bilesenlerinden hesaplanir. Gerekcesi her zaman gosterilir.
 */
function tehditSeviyesi({ sayim, uyarilar, vakalar, riskliBelge }) {
  const bilesenler = [];
  let puan = 0;

  const kritikUyari = uyarilar.filter((u) => u.seviye === 'kritik').length;
  if (kritikUyari) {
    const k = Math.min(30, kritikUyari * 10);
    puan += k;
    bilesenler.push({ ad: `${kritikUyari} kritik uyari`, puan: k });
  }

  const kritikVaka = vakalar.filter((v) => v.oncelik === 'kritik').length;
  if (kritikVaka) {
    const k = Math.min(25, kritikVaka * 12);
    puan += k;
    bilesenler.push({ ad: `${kritikVaka} kritik vaka`, puan: k });
  }

  if (sayim.izlemede) {
    const k = Math.min(20, sayim.izlemede * 4);
    puan += k;
    bilesenler.push({ ad: `${sayim.izlemede} varlik izlemede`, puan: k });
  }

  if (sayim.bekleyen) {
    const k = Math.min(15, Math.ceil(sayim.bekleyen / 3));
    puan += k;
    bilesenler.push({ ad: `${sayim.bekleyen} kayit incelenmeyi bekliyor`, puan: k });
  }

  if (riskliBelge) {
    const k = Math.min(10, riskliBelge * 3);
    puan += k;
    bilesenler.push({ ad: `${riskliBelge} riskli belge`, puan: k });
  }

  const sinirli = Math.max(0, Math.min(100, puan));
  const seviye = sinirli >= 70 ? 'kritik' : sinirli >= 45 ? 'yuksek' : sinirli >= 20 ? 'orta' : 'dusuk';
  const etiket = { dusuk: 'DUSUK', orta: 'ORTA', yuksek: 'YUKSEK', kritik: 'KRITIK' }[seviye];

  return { puan: sinirli, seviye, etiket, bilesenler };
}

yonlendirici.get('/merkez', onbellekYok, girisGerekli, async (req, res, next) => {
  try {
    const [depoSayim, logOzet, kilitler, panoOzet, motorDurum, cozDurum] = await Promise.all([
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
      arsiv.panoOzet(),
      zeka.durum().catch(() => null),
      cozumleme.durum().catch(() => null),
    ]);

    const sonLoglar = await log.listele({ limit: 8 });

    // Kilit aktorler (graf etkisine gore) — ag kuruluysa
    let kilitAktorler = [];
    try {
      const graf = await zeka.grafVerisi({ maxDugum: 200 });
      kilitAktorler = graf.merkeziyet.slice(0, 6);
    } catch { kilitAktorler = []; }

    const tehdit = tehditSeviyesi({
      sayim: panoOzet.sayim,
      uyarilar: panoOzet.uyarilar,
      vakalar: panoOzet.acikVakalar,
      riskliBelge: cozDurum ? cozDurum.uyusmazlik : 0,
    });

    res.render('merkez', {
      baslik: 'KONTROL MERKEZI',
      rota: '/merkez',
      betikler: ['/js/hud.js', '/js/merkez.js'],
      sayimlar: depoSayim || {},
      ozet: logOzet || {},
      kilitSayisi: kilitler.length,
      sonLoglar: sonLoglar.kayitlar,
      panoOzet, motorDurum, cozDurum, tehdit, kilitAktorler,
      sozluk: nd,
    });
  } catch (hata) { next(hata); }
});

/** Panonun canli yenilenmesi icin hafif JSON ucu. */
yonlendirici.get('/merkez/api/nabiz', onbellekYok, girisGerekli, async (req, res, next) => {
  try {
    const [panoOzet, uyarilar] = await Promise.all([
      arsiv.panoOzet(),
      uyariService.uyarilariListele({ okundu: 0, limit: 5 }),
    ]);
    res.json({
      tamam: true,
      sayim: panoOzet.sayim,
      hareket: panoOzet.hareket,
      uyarilar: uyarilar.map((u) => ({ id: u.id, seviye: u.seviye, baslik: u.baslik, zaman: u.olusturuldu_at })),
      zaman: new Date().toISOString(),
    });
  } catch (hata) { next(hata); }
});

module.exports = yonlendirici;
