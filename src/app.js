'use strict';
/**
 * src/app.js
 * Express uygulamasinin kurulumu: ara yazilim sirasi burada belirlenir.
 *
 * SIRA ONEMLIDIR:
 *   1. proxy guveni  2. guvenlik basliklari  3. govde ayristirma
 *   4. statik dosyalar  5. oturum  6. CSRF  7. rotalar  8. hata yakalayici
 */

const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');

const ayar = require('./config/env');
const { guvenlikBasliklari, ekBasliklar, httpsZorla } = require('./middleware/security');
const { oturumAraYazilimi } = require('./middleware/session');
const { csrfHazirla, csrfAlani } = require('./middleware/csrf');
const { oturumYukle } = require('./middleware/auth');
const { istekKaydi } = require('./middleware/logger');
const { genelSinir } = require('./middleware/rateLimit');
const { bulunamadi, hataYakala } = require('./middleware/errorHandler');
const ayarService = require('./services/ayarService');
const yonlendiriciler = require('./routes');

const uygulama = express();

// 1) Proxy guveni (Railway, X-Forwarded-For) -------------------------------
uygulama.set('trust proxy', ayar.trustProxy);
uygulama.disable('x-powered-by');
uygulama.set('etag', 'strong');

// 2) Sablon motoru ---------------------------------------------------------
uygulama.set('view engine', 'ejs');
uygulama.set('views', path.join(__dirname, 'views'));

// 3) Guvenlik basliklari ---------------------------------------------------
uygulama.use(httpsZorla);
uygulama.use(guvenlikBasliklari());
uygulama.use(ekBasliklar);

// 4) Sablon varsayilanlari (ERKEN) ---------------------------------------
// Hiz siniri veya erken bir hata, oturum/ayar katmanina ulasmadan hata
// sablonu render edebilir. Bu varsayilanlar o durumda sablonun patlamasini
// engeller; asagidaki 9. adim bunlari veritabani degerleriyle gunceller.
const SISTEM_VARSAYILAN = Object.freeze({
  sistem_adi: 'CMS VERI MERKEZI',
  sistem_kodu: 'KARTRIDEX',
  ses_aktif: true,
  matrix_aktif: true,
  gecis_animasyonu: true,
  bakim_modu: false,
});

uygulama.use((req, res, next) => {
  res.locals.sistem = SISTEM_VARSAYILAN;
  res.locals.girisYapildi = false;
  res.locals.yonetici = null;
  res.locals.csrfToken = '';
  res.locals.csrfAlani = () => '';
  res.locals.rota = req.path;
  res.locals.baslik = 'CMS VERI MERKEZI';
  res.locals.bildirim = null;
  res.locals.hata = null;
  res.locals.uretim = ayar.uretim;
  next();
});

// 5) Istek kaydi + genel hiz siniri ---------------------------------------
uygulama.use(istekKaydi);
uygulama.use(genelSinir);

// 6) Govde ayristirma (DoS'a karsi kati boyut sinirlari) -------------------
// Not: JSON siniri 8mb'ye cikarildi cünkü /pano/:id/kaydet her otomatik
// kaydetmede panonun TUM oge listesini (serbest kalem cizimlerinin yuzlerce
// noktasi dahil) tek JSON govdesi olarak yollar. Gercek resim dosyalari bu
// siniri hic gormez; onlar multer (multipart) uzerinden ayri ve daha genis
// kendi sinirlarina (bkz. src/middleware/panoYukleme.js) tabidir. Bu uc,
// oturum acmis (girisGerekli) ve yazma hiz siniri (yazmaSiniri) ile korunan
// tek bir operator ucu oldugu icin daha genis govde siniri kabul edilebilir.
uygulama.use(express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 100 }));
uygulama.use(express.json({ limit: '8mb' }));
uygulama.use(cookieParser(ayar.sir.oturum));

// 7) Statik dosyalar (oturumdan ONCE: gereksiz oturum kaydi olusmasin) ----
uygulama.use(
  express.static(path.join(ayar.koklDizin, 'public'), {
    maxAge: ayar.uretim ? '7d' : 0,
    etag: true,
    index: false,
    dotfiles: 'ignore',
    fallthrough: true,
    setHeaders(res, dosyaYolu) {
      if (dosyaYolu.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
    },
  }),
);

// 8) Oturum + kimlik + CSRF ------------------------------------------------
uygulama.use(oturumAraYazilimi());
uygulama.use(csrfHazirla);
uygulama.use(oturumYukle);

// 9) Sablonlara ortak degiskenler -----------------------------------------
let arayuzOnbellek = { veri: null, zaman: 0 };
const ONBELLEK_MS = 30_000;

// Gezintideki uyari sayaci her istekte sorgulanmasin: kisa sureli onbellek.
let uyariOnbellek = { sayi: 0, zaman: 0 };
const UYARI_ONBELLEK_MS = 15_000;

async function uyariSayisi() {
  const simdi = Date.now();
  if (simdi - uyariOnbellek.zaman < UYARI_ONBELLEK_MS) return uyariOnbellek.sayi;
  try {
    const db = require('./config/db');
    const satir = await db.tekSatir('SELECT COUNT(*)::int AS n FROM uyarilar WHERE okundu = FALSE');
    uyariOnbellek = { sayi: satir ? satir.n : 0, zaman: simdi };
  } catch {
    // Arsiv semasi henuz uygulanmadiysa sayac sifir kalir, sayfa calismaya devam eder.
    uyariOnbellek = { sayi: 0, zaman: simdi };
  }
  return uyariOnbellek.sayi;
}

uygulama.use(async (req, res, next) => {
  try {
    const simdi = Date.now();
    if (!arayuzOnbellek.veri || simdi - arayuzOnbellek.zaman > ONBELLEK_MS) {
      arayuzOnbellek = { veri: await ayarService.arayuzAyarlari(), zaman: simdi };
    }
    const sistem = arayuzOnbellek.veri;

    res.locals.sistem = sistem;
    res.locals.uretim = ayar.uretim;
    res.locals.yil = new Date().getFullYear();
    res.locals.rota = req.path;
    res.locals.csrfAlani = () => csrfAlani(res.locals.csrfToken);
    res.locals.baslik = 'CMS VERI MERKEZI';

    // Yonlendirme sonrasi bildirimler: POST -> 303 -> GET akisinda mesaj
    // tasimanin en yalin yolu sorgu dizesidir. Uzunluk sinirlanir ve
    // EJS zaten kacirdigi icin enjeksiyon riski yoktur.
    const bildirimHam = typeof req.query.bildirim === 'string' ? req.query.bildirim : '';
    const hataHam = typeof req.query.hata === 'string' ? req.query.hata : '';
    res.locals.bildirim = bildirimHam ? bildirimHam.slice(0, 400) : null;
    res.locals.hata = hataHam ? hataHam.slice(0, 400) : null;

    // Arayuz temasi ve okunmamis uyari sayaci (gezinti rozeti icin)
    res.locals.tema = ['istihbarat', 'zumrut', 'kehribar', 'camgobegi', 'mor']
      .includes(sistem.arayuz_temasi) ? sistem.arayuz_temasi : 'istihbarat';
    res.locals.tasnifBandi = sistem.arsiv_tasnif_bandi !== false && sistem.arsiv_tasnif_bandi !== 'false';
    res.locals.varsayilanTasnif = typeof sistem.arsiv_varsayilan_tasnif === 'string'
      ? sistem.arsiv_varsayilan_tasnif : 'hizmete_ozel';
    res.locals.uyariSayisi = req.session && req.session.yonetici ? await uyariSayisi() : 0;

    // Bakim modu: giris, saglik ve statik dosyalar haric her sey kapali.
    if (sistem.bakim_modu && !/^\/(giris|cikis|saglik|api\/kimlik)/.test(req.path)) {
      const yoneticiMi = Boolean(req.session && req.session.yonetici);
      if (!yoneticiMi) {
        return res.status(503).render('hata/genel', {
          baslik: 'BAKIM MODU',
          kod: 503,
          mesaj: 'Veri merkezi gecici olarak bakim modunda. Daha sonra tekrar deneyin.',
          rota: req.path,
        });
      }
    }
    return next();
  } catch (hata) { return next(hata); }
});

// 10) Rotalar ---------------------------------------------------------------
uygulama.use(yonlendiriciler);

// 11) 404 ve hata yakalayici ----------------------------------------------
uygulama.use(bulunamadi);
uygulama.use(hataYakala);

/** Arayuz ayarlari onbellegini elle temizler (ayar degisiminde kullanilir). */
uygulama.locals.arayuzOnbellegiTemizle = () => { arayuzOnbellek = { veri: null, zaman: 0 }; };

module.exports = uygulama;
