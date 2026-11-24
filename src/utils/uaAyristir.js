'use strict';
/**
 * src/utils/uaAyristir.js
 * User-Agent dizesini cihaz/tarayici/isletim sistemine ayristirir.
 * "ua-parser-js" paketi opsiyonel kabul edilir: kurulu degilse (henuz
 * npm install calistirilmamissa) basit bir yedek ayristirici devreye girer,
 * uygulama hicbir sekilde cokmez.
 */

let UAParser = null;
try {
  // Lazy require: paket eksikse uygulamanin geri kalani calismaya devam etsin.
  UAParser = require('ua-parser-js').UAParser || require('ua-parser-js');
} catch {
  UAParser = null;
}

const BOT_DESENI = /bot|crawl|spider|slurp|facebookexternalhit|curl|wget|python-requests|axios|postman/i;

/** Paket yoksa kullanilan kaba (ama isabetli) yedek ayristirici. */
function yedekAyristir(uaDizesi) {
  const ua = String(uaDizesi || '');
  let tarayici = 'Bilinmiyor';
  let isletimSistemi = 'Bilinmiyor';
  let cihazTipi = 'masaustu';

  if (BOT_DESENI.test(ua)) {
    return { tarayici: 'Bot/Otomasyon', isletimSistemi: '—', cihazTipi: 'bot', ham: ua.slice(0, 300) };
  }

  if (/edg\//i.test(ua)) tarayici = 'Edge';
  else if (/opr\/|opera/i.test(ua)) tarayici = 'Opera';
  else if (/chrome\//i.test(ua) && !/chromium/i.test(ua)) tarayici = 'Chrome';
  else if (/crios\//i.test(ua)) tarayici = 'Chrome (iOS)';
  else if (/firefox\//i.test(ua)) tarayici = 'Firefox';
  else if (/fxios\//i.test(ua)) tarayici = 'Firefox (iOS)';
  else if (/safari\//i.test(ua) && /version\//i.test(ua)) tarayici = 'Safari';

  if (/windows nt/i.test(ua)) isletimSistemi = 'Windows';
  else if (/mac os x/i.test(ua) && !/mobile/i.test(ua)) isletimSistemi = 'macOS';
  else if (/android/i.test(ua)) isletimSistemi = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) isletimSistemi = 'iOS';
  else if (/linux/i.test(ua)) isletimSistemi = 'Linux';

  if (/ipad|tablet/i.test(ua)) cihazTipi = 'tablet';
  else if (/mobile|iphone|android/i.test(ua)) cihazTipi = 'mobil';

  return { tarayici, isletimSistemi, cihazTipi, ham: ua.slice(0, 300) };
}

/**
 * Ayristirir ve kisa, okunabilir degerler dondurur.
 * @param {string} uaDizesi
 * @returns {{tarayici:string, isletimSistemi:string, cihazTipi:string, ham:string}}
 */
function ayristir(uaDizesi) {
  const ua = String(uaDizesi || '').slice(0, 512);
  if (!ua) return { tarayici: 'Bilinmiyor', isletimSistemi: 'Bilinmiyor', cihazTipi: 'bilinmiyor', ham: '' };

  if (BOT_DESENI.test(ua)) {
    return { tarayici: 'Bot/Otomasyon', isletimSistemi: '—', cihazTipi: 'bot', ham: ua.slice(0, 300) };
  }

  if (!UAParser) return yedekAyristir(ua);

  try {
    const sonuc = (typeof UAParser === 'function') ? new UAParser(ua).getResult() : UAParser(ua);
    const tarayiciAdi = sonuc.browser && sonuc.browser.name ? sonuc.browser.name : null;
    const tarayiciSurum = sonuc.browser && sonuc.browser.version ? String(sonuc.browser.version).split('.')[0] : '';
    const isletimAdi = sonuc.os && sonuc.os.name ? sonuc.os.name : null;
    const isletimSurum = sonuc.os && sonuc.os.version ? sonuc.os.version : '';
    const cihazTuru = sonuc.device && sonuc.device.type ? sonuc.device.type : null;

    const cihazTipi = cihazTuru === 'mobile' ? 'mobil'
      : cihazTuru === 'tablet' ? 'tablet'
      : cihazTuru === 'smarttv' ? 'tv'
      : 'masaustu';

    return {
      tarayici: tarayiciAdi ? `${tarayiciAdi}${tarayiciSurum ? ' ' + tarayiciSurum : ''}` : 'Bilinmiyor',
      isletimSistemi: isletimAdi ? `${isletimAdi}${isletimSurum ? ' ' + isletimSurum : ''}` : 'Bilinmiyor',
      cihazTipi,
      ham: ua.slice(0, 300),
    };
  } catch {
    return yedekAyristir(ua);
  }
}

module.exports = { ayristir };
