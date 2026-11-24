'use strict';
/**
 * src/middleware/csrf.js
 * Oturum bagli senkronizasyon token'i (synchronizer token pattern).
 *
 *  - Her oturum icin 32 baytlik rastgele bir sir uretilir ve oturumda saklanir.
 *  - Sayfalar bu token'i <body data-csrf="..."> ile tasir; JS istekleri
 *    "X-CSRF-Token" basligi, form gonderimleri "_csrf" alani ile dogrulanir.
 *  - Karsilastirma zaman sabitlidir.
 */

const { token: tokenUret, esitMi } = require('../utils/crypto');

const GUVENLI_METOTLAR = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Oturumda CSRF sirri yoksa uretir ve res.locals'a koyar. */
function csrfHazirla(req, res, next) {
  if (!req.session) return next();
  if (!req.session.csrfSirri) {
    req.session.csrfSirri = tokenUret(32);
  }
  res.locals.csrfToken = req.session.csrfSirri;
  next();
}

/** Durum degistiren isteklerde token'i dogrular. */
function csrfKoru(req, res, next) {
  if (GUVENLI_METOTLAR.has(req.method)) return next();

  const beklenen = req.session && req.session.csrfSirri;
  const gelen =
    req.get('x-csrf-token') ||
    req.get('x-xsrf-token') ||
    (req.body && req.body._csrf) ||
    '';

  if (!beklenen || !gelen || !esitMi(beklenen, gelen)) {
    const jsonIster = (req.get('accept') || '').includes('application/json') ||
                      req.xhr || req.path.startsWith('/api/');
    if (jsonIster) {
      return res.status(403).json({
        tamam: false,
        kod: 'CSRF_GECERSIZ',
        hata: 'Guvenlik belirteci gecersiz. Sayfayi yenileyip tekrar deneyin.',
      });
    }
    return res.status(403).render('hata/genel', {
      baslik: 'ERISIM REDDEDILDI',
      kod: 403,
      mesaj: 'Guvenlik belirteci dogrulanamadi. Sayfayi yenileyip tekrar deneyin.',
      rota: req.path,
    });
  }
  return next();
}

/** Form icine gizli alan uretir (EJS yardimcisi). */
function csrfAlani(token) {
  return `<input type="hidden" name="_csrf" value="${String(token || '').replace(/"/g, '&quot;')}">`;
}

module.exports = { csrfHazirla, csrfKoru, csrfAlani };
