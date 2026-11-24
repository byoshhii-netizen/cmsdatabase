'use strict';
/**
 * src/middleware/auth.js
 * Oturum koruma katmani.
 *
 *  - girisGerekli : kimlik yoksa /giris'e yonlendirir (hedef korunur)
 *  - misafirGerekli: oturum acikken /giris'i /merkez'e cevirir
 *  - Mutlak ve bosta zaman asimi uygulanir
 *  - oturum_surumu kontrolu: sifre degisince eski oturumlar reddedilir
 */

const ayar = require('../config/env');
const authService = require('../services/authService');
const log = require('../services/logService');
const dogrula = require('../utils/validate');
const kripto = require('../utils/crypto');

const SURUM_KONTROL_ARALIGI_MS = 60 * 1000;  // en fazla dakikada bir veritabani kontrolu

/** Oturumu guvenli sekilde yok eder ve cerezi temizler. */
function oturumuYokEt(req, res, geriCagri) {
  const adi = ayar.oturum.cerezAdi;
  if (!req.session) { res.clearCookie(adi, { path: '/' }); return geriCagri(); }
  req.session.destroy(() => {
    res.clearCookie(adi, { path: '/' });
    geriCagri();
  });
}

/** Istegin JSON yanit bekleyip beklemedigini anlar. */
function jsonIster(req) {
  return (req.get('accept') || '').includes('application/json') ||
         req.xhr || req.path.startsWith('/api/');
}

/**
 * Oturumu yukler (zorunlu kilmaz). res.locals.yonetici doldurulur.
 * Tum rotalarda calisir; sablonlar bu bilgiyi kullanir.
 */
async function oturumYukle(req, res, next) {
  res.locals.yonetici = null;
  res.locals.girisYapildi = false;

  const oturum = req.session;
  if (!oturum || !oturum.yonetici || !oturum.yonetici.id) return next();

  const simdi = Date.now();

  // --- Mutlak zaman asimi ---
  const mutlakMs = ayar.oturum.mutlakDakika * 60 * 1000;
  if (oturum.girisZamani && simdi - oturum.girisZamani > mutlakMs) {
    await log.bilgi({
      kategori: 'kimlik', olay: 'oturum_mutlak_asim',
      mesaj: 'Mutlak oturum suresi doldu.', yoneticiId: oturum.yonetici.id, req,
    });
    return oturumuYokEt(req, res, () => {
      req.oturumBitti = 'mutlak';
      next();
    });
  }

  // --- Bosta zaman asimi (rolling cerez zaten yeniler, bu ikinci kontrol) ---
  const bostaMs = ayar.oturum.bostaDakika * 60 * 1000;
  if (oturum.sonHareket && simdi - oturum.sonHareket > bostaMs) {
    await log.bilgi({
      kategori: 'kimlik', olay: 'oturum_bosta_asim',
      mesaj: 'Hareketsizlik nedeniyle oturum kapatildi.', yoneticiId: oturum.yonetici.id, req,
    });
    return oturumuYokEt(req, res, () => {
      req.oturumBitti = 'bosta';
      next();
    });
  }

  // --- Oturum surumu kontrolu (sifre degisimi sonrasi eski oturumlari duser) ---
  const kontrolGerekli = !oturum.surumKontrolZamani ||
                         simdi - oturum.surumKontrolZamani > SURUM_KONTROL_ARALIGI_MS;
  if (kontrolGerekli) {
    let kayit = null;
    try {
      kayit = await authService.yoneticiGetir(oturum.yonetici.id);
    } catch (hata) {
      console.error('[KIMLIK] Yonetici kontrolu basarisiz:', hata.message);
      return next(hata);
    }

    if (!kayit || !kayit.aktif || kayit.oturum_surumu !== oturum.yonetici.oturumSurumu) {
      await log.uyari({
        kategori: 'guvenlik', olay: 'oturum_gecersiz',
        mesaj: 'Oturum surumu uyusmuyor veya hesap kapali; oturum dusuruldu.',
        yoneticiId: oturum.yonetici.id, req,
      });
      return oturumuYokEt(req, res, () => {
        req.oturumBitti = 'surum';
        next();
      });
    }

    oturum.yonetici.gorunenAd = kayit.gorunen_ad;
    oturum.yonetici.kullaniciAdi = kayit.kullanici_adi;
    oturum.surumKontrolZamani = simdi;
  }

  oturum.sonHareket = simdi;
  req.yonetici = oturum.yonetici;
  res.locals.yonetici = oturum.yonetici;
  res.locals.girisYapildi = true;
  return next();
}

/** Kimlik zorunlu rotalar icin. */
function girisGerekli(req, res, next) {
  if (req.session && req.session.yonetici && req.session.yonetici.id) return next();

  const sebep = req.oturumBitti || 'yetkisiz';

  if (jsonIster(req)) {
    return res.status(401).json({
      tamam: false,
      kod: 'YETKISIZ',
      sebep,
      hata: 'Oturum bulunamadi veya suresi doldu. Yeniden giris yapin.',
      yonlendir: '/giris',
    });
  }

  const hedef = encodeURIComponent(dogrula.dahiliHedef(req.originalUrl, '/merkez'));
  const ek = sebep !== 'yetkisiz' ? `&sebep=${encodeURIComponent(sebep)}` : '';
  return res.redirect(302, `/giris?hedef=${hedef}${ek}`);
}

/** Oturum acikken giris ekranina gitmeyi engeller. */
function misafirGerekli(req, res, next) {
  if (req.session && req.session.yonetici && req.session.yonetici.id) {
    return res.redirect(302, '/merkez');
  }
  return next();
}

/**
 * Oturumu yeniden uretir (session fixation korumasi) ve kimligi yazar.
 * Girisin hemen ardindan cagrilir.
 */
function oturumBaslat(req, yonetici) {
  return new Promise((coz, reddet) => {
    req.session.regenerate((hata) => {
      if (hata) return reddet(hata);
      req.session.yonetici = {
        id: yonetici.id,
        kullaniciAdi: yonetici.kullaniciAdi,
        gorunenAd: yonetici.gorunenAd,
        oturumSurumu: yonetici.oturumSurumu,
      };
      req.session.girisZamani = Date.now();
      req.session.sonHareket = Date.now();
      req.session.surumKontrolZamani = Date.now();
      // CSRF sirrini yenile (eski token gecersiz olur)
      req.session.csrfSirri = kripto.token(32);
      req.session.save((kayitHatasi) => (kayitHatasi ? reddet(kayitHatasi) : coz()));
    });
  });
}

/** Oturumu kapatir. */
function oturumBitir(req, res) {
  return new Promise((coz) => oturumuYokEt(req, res, coz));
}

module.exports = { oturumYukle, girisGerekli, misafirGerekli, oturumBaslat, oturumBitir, jsonIster };
