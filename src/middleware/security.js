'use strict';
/**
 * src/middleware/security.js
 * HTTP guvenlik basliklari (Helmet + siki CSP) ve onbellek politikasi.
 *
 * CSP notu: TUM betikler ve stiller harici dosyalardan yuklenir.
 * Satir ici (inline) script/style YOKTUR -> 'unsafe-inline' gerekmez.
 * Sunucudan tarayiciya veri aktarimi <body data-*> nitelikleri ile yapilir.
 */

const helmet = require('helmet');
const ayar = require('../config/env');

function guvenlikBasliklari() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'script-src': ["'self'"],
        'script-src-attr': ["'none'"],       // onclick="" vb. tamamen yasak
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'media-src': ["'self'", 'blob:'],
        'worker-src': ["'self'", 'blob:'],
        'object-src': ["'none'"],
        'frame-src': ["'none'"],
        'frame-ancestors': ["'none'"],        // clickjacking korumasi
        'form-action': ["'self'"],
        'manifest-src': ["'self'"],
        ...(ayar.uretim ? { 'upgrade-insecure-requests': [] } : {}),
      },
    },
    // --- Helmet v8 secenek adlari ---
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    originAgentCluster: true,
    strictTransportSecurity: ayar.uretim
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
      : false,
    xFrameOptions: { action: 'deny' },            // clickjacking
    xContentTypeOptions: true,                     // MIME sniffing
    xDnsPrefetchControl: { allow: false },
    xDownloadOptions: true,
    xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
    xPoweredBy: true,
    xXssProtection: true,
  });
}

/** Ek basliklar: izin politikasi ve sunucu kimligini gizleme. */
function ekBasliklar(req, res, next) {
  // microphone=(self): /cambaz sesli komut (Web Speech API / mikrofon) icin
  // YALNIZCA kendi kokenimize izin verilir; baska hicbir izin gevsetilmedi.
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), microphone=(self), camera=(), payment=(), usb=(), magnetometer=(), accelerometer=()',
  );
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.removeHeader('X-Powered-By');
  next();
}

/**
 * Kimlik gerektiren sayfalarin tarayici onbelleginde kalmasini engeller.
 * (Cikis sonrasi "geri" tusuyla gizli sayfa gorulmesini onler.)
 */
function onbellekYok(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
}

/**
 * Kaynak (Origin/Referer) dogrulamasi: CSRF'e karsi ikinci savunma hatti.
 * Durum degistiren isteklerde kaynak, sunucunun kendi kokeni olmalidir.
 */
function kaynakDogrula(req, res, next) {
  const guvenliMetotlar = ['GET', 'HEAD', 'OPTIONS'];
  if (guvenliMetotlar.includes(req.method)) return next();

  const kaynak = req.get('origin') || req.get('referer');
  if (!kaynak) {
    // Origin yoksa (bazi eski istemciler) CSRF token kontrolu devrededir.
    return next();
  }

  let kaynakHost;
  try {
    kaynakHost = new URL(kaynak).host;
  } catch {
    return res.status(403).json({ tamam: false, hata: 'Gecersiz istek kaynagi.' });
  }

  const beklenen = new Set([req.get('host')]);
  try { beklenen.add(new URL(ayar.publicUrl).host); } catch { /* yoksay */ }

  if (!beklenen.has(kaynakHost)) {
    return res.status(403).json({ tamam: false, hata: 'Istek kaynagi reddedildi.' });
  }
  return next();
}

/** HTTP -> HTTPS yonlendirmesi (Railway proxy arkasinda). */
function httpsZorla(req, res, next) {
  if (!ayar.uretim) return next();
  if (req.secure || req.get('x-forwarded-proto') === 'https') return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(403).send('HTTPS zorunludur.');
  }
  return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
}

module.exports = { guvenlikBasliklari, ekBasliklar, onbellekYok, kaynakDogrula, httpsZorla };
