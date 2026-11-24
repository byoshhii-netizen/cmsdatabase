'use strict';
/**
 * src/routes/depo.js   ->  /depo
 * Sifreli dosya/klasor kasasi: hiyerarsik klasorler, bagimsiz klasor
 * kilitleri, AES-256-GCM dosya sifreleme, dahili metin belgesi editoru
 * ve "Disariya Ac" paylasim yonetimi.
 *
 * KILIT MODELI (ozet; detay: klasorService.js basindaki not)
 *   req.session.depoKilitAcik = [klasorId, ...]  -> bu oturumda sifresi
 *   dogrulanmis klasorlerin kimlikleri. Listeleme/yukleme/silme gibi her
 *   islemden once ilgili klasorun ATA zinciri bu listeye gore denetlenir.
 */

const express = require('express');
const ayar = require('../config/env');

const klasorService = require('../services/klasorService');
const dosyaService = require('../services/dosyaService');
const belgeService = require('../services/belgeService');
const paylasimService = require('../services/paylasimService');
const log = require('../services/logService');

const { girisGerekli, jsonIster } = require('../middleware/auth');
const { onbellekYok } = require('../middleware/security');
const { csrfKoru } = require('../middleware/csrf');
const { yazmaSiniri } = require('../middleware/rateLimit');
const { yukleyici, yuklemeHatasiYakala } = require('../middleware/yukleme');
const dogrula = require('../utils/validate');

const yonlendirici = express.Router();

const DURUM_MESAJLARI = {
  klasor_olusturuldu: 'Yeni sektor olusturuldu.',
  klasor_silindi: 'Sektor ve icerigi guvenli sekilde silindi.',
  kilit_tamam: 'Sektor kilidi guncellendi.',
  kilit_kaldirildi: 'Sektor kilidi kaldirildi.',
  yukleme_tamam: 'Dosya(lar) sifrelenerek yuklendi.',
  dosya_silindi: 'Dosya guvenli sekilde silindi.',
  belge_tamam: 'Belge kaydedildi.',
  belge_silindi: 'Belge silindi.',
  paylasim_olusturuldu: 'Disa acik baglanti olusturuldu.',
  paylasim_kapatildi: 'Baglanti kapatildi.',
  paylasim_acildi: 'Baglanti yeniden acildi.',
};
const DURUM_HATALARI = {}; // route'lar kendi hata metnini ?hata= ile tasir

/** Oturumdaki acik klasor listesini okur/limitler. */
function acikListesi(req) {
  if (!Array.isArray(req.session.depoKilitAcik)) req.session.depoKilitAcik = [];
  return req.session.depoKilitAcik;
}

function acikListesineEkle(req, klasorId) {
  const liste = acikListesi(req);
  if (!liste.includes(klasorId)) {
    req.session.depoKilitAcik = [...liste.slice(-49), klasorId];
  }
}

/** Yardimci: basarisizlikta JSON ya da yonlendirme ile cevap verir. */
function basarisizYanit(req, res, { durum = 400, hata, geriYol = '/depo' } = {}) {
  if (jsonIster(req)) return res.status(durum).json({ tamam: false, hata });
  return res.redirect(303, `${geriYol}${geriYol.includes('?') ? '&' : '?'}hata=${encodeURIComponent(hata)}`);
}

function basariliYanit(req, res, { govde = {}, geriYol = '/depo', durumKodu } = {}) {
  if (jsonIster(req)) return res.json({ tamam: true, ...govde });
  const ayrac = geriYol.includes('?') ? '&' : '?';
  return res.redirect(303, durumKodu ? `${geriYol}${ayrac}durum=${durumKodu}` : geriYol);
}

// ============================================================== GET /depo
yonlendirici.get('/depo', onbellekYok, girisGerekli, async (req, res, next) => {
  try {
    const klasorId = dogrula.kimlik(req.query.klasor);
    const acikList = acikListesi(req);

    // Ata zincirinde kilitli-ve-acilmamis bir sektor var mi?
    const kilitliHalka = klasorId ? await klasorService.erisimDenetle(klasorId, acikList) : null;

    const mevcutKlasor = klasorId ? await klasorService.getir(klasorId) : null;
    if (klasorId && !mevcutKlasor) {
      return res.status(404).render('hata/genel', {
        baslik: 'SEKTOR BULUNAMADI', kod: 404, mesaj: 'Istenen sektor kayitli degil veya silinmis.', rota: req.path,
      });
    }

    if (kilitliHalka) {
      return res.render('depo', {
        baslik: 'VERI KASASI', rota: '/depo',
        kilitliHalka, hedefKlasor: klasorId,
        mevcutKlasor: null, yolZinciri: [], altKlasorler: [], dosyalar: [], belgeler: [], paylasimlar: [],
        durum: DURUM_MESAJLARI[String(req.query.durum || '')] || null,
        hata: req.query.hata ? decodeURIComponent(req.query.hata) : null,
        depoMaxMb: Math.floor(ayar.depo.maxBayt / (1024 * 1024)),
        publicUrl: ayar.publicUrl,
      });
    }

    const [altKlasorler, dosyalar, belgeler, yolZinciri, paylasimlar] = await Promise.all([
      klasorService.listele(klasorId),
      klasorId ? dosyaService.listele(klasorId) : [],
      klasorId ? belgeService.listele(klasorId) : [],
      klasorService.yolZinciri(klasorId),
      klasorId ? paylasimService.klasorLinkleri(klasorId) : [],
    ]);

    res.render('depo', {
      baslik: mevcutKlasor ? mevcutKlasor.ad : 'VERI KASASI', rota: '/depo',
      kilitliHalka: null, hedefKlasor: null,
      mevcutKlasor, yolZinciri, altKlasorler, dosyalar, belgeler, paylasimlar,
      durum: DURUM_MESAJLARI[String(req.query.durum || '')] || null,
      hata: req.query.hata ? decodeURIComponent(req.query.hata) : null,
      depoMaxMb: Math.floor(ayar.depo.maxBayt / (1024 * 1024)),
      publicUrl: ayar.publicUrl,
    });
  } catch (hata) { next(hata); }
});

// =========================================================== KLASOR kilit
yonlendirici.post('/depo/klasor/:id/kilit-dogrula', onbellekYok, girisGerekli, csrfKoru, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    const hedef = dogrula.kimlik(req.body.hedef) || id;
    if (!id) return basarisizYanit(req, res, { hata: 'Gecersiz sektor.' });

    const sonuc = await klasorService.kilitDogrula({ klasorId: id, sifre: req.body.sifre });
    if (!sonuc.tamam) {
      await log.uyari({ kategori: 'depo', olay: 'klasor_sifre_hatasi', mesaj: `#${id} sektoru icin hatali sifre denemesi.`, yoneticiId: req.yonetici.id, req });
      return basarisizYanit(req, res, { durum: 401, hata: sonuc.hata, geriYol: `/depo?klasor=${hedef}` });
    }

    acikListesineEkle(req, id);
    return basariliYanit(req, res, { geriYol: `/depo?klasor=${hedef}` });
  } catch (hata) { next(hata); }
});

yonlendirici.post('/depo/klasor/:id/kilit', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return basarisizYanit(req, res, { hata: 'Gecersiz sektor.' });

    const engel = await klasorService.ataZinciriDenetle(id, acikListesi(req));
    if (engel) return basarisizYanit(req, res, { hata: `Once "${engel.ad}" sektorunun kilidini acin.`, geriYol: `/depo?klasor=${id}` });

    const sonuc = await klasorService.kilitAyarla({
      klasorId: id, yeniSifre: req.body.yeni_sifre, mevcutSifre: req.body.mevcut_sifre, yoneticiId: req.yonetici.id,
    });
    if (!sonuc.tamam) return basarisizYanit(req, res, { hata: sonuc.hata, geriYol: `/depo?klasor=${id}` });

    acikListesineEkle(req, id); // kilidi koyan operator disarida kalmasin
    return basariliYanit(req, res, { geriYol: `/depo?klasor=${id}`, durumKodu: 'kilit_tamam' });
  } catch (hata) { next(hata); }
});

yonlendirici.post('/depo/klasor/:id/kilit-kaldir', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return basarisizYanit(req, res, { hata: 'Gecersiz sektor.' });

    const engel = await klasorService.ataZinciriDenetle(id, acikListesi(req));
    if (engel) return basarisizYanit(req, res, { hata: `Once "${engel.ad}" sektorunun kilidini acin.`, geriYol: `/depo?klasor=${id}` });

    const sonuc = await klasorService.kilitKaldir({ klasorId: id, mevcutSifre: req.body.mevcut_sifre, yoneticiId: req.yonetici.id });
    if (!sonuc.tamam) return basarisizYanit(req, res, { hata: sonuc.hata, geriYol: `/depo?klasor=${id}` });

    return basariliYanit(req, res, { geriYol: `/depo?klasor=${id}`, durumKodu: 'kilit_kaldirildi' });
  } catch (hata) { next(hata); }
});

// =========================================================== KLASOR CRUD
yonlendirici.post('/depo/klasor', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const ebeveynId = dogrula.kimlik(req.body.ebeveyn_id);
    if (ebeveynId) {
      const engel = await klasorService.erisimDenetle(ebeveynId, acikListesi(req));
      if (engel) return basarisizYanit(req, res, { hata: `Once "${engel.ad}" sektorunun kilidini acin.`, geriYol: `/depo?klasor=${ebeveynId}` });
    }

    const sonuc = await klasorService.olustur({
      ad: req.body.ad, aciklama: req.body.aciklama, renk: req.body.renk,
      ebeveynId: ebeveynId || null, yoneticiId: req.yonetici.id,
    });
    const geriYol = ebeveynId ? `/depo?klasor=${ebeveynId}` : '/depo';
    if (!sonuc.tamam) return basarisizYanit(req, res, { hata: sonuc.hata, geriYol });

    return basariliYanit(req, res, { govde: { klasor: sonuc.klasor }, geriYol, durumKodu: 'klasor_olusturuldu' });
  } catch (hata) { next(hata); }
});

yonlendirici.post('/depo/klasor/:id/sil', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return basarisizYanit(req, res, { hata: 'Gecersiz sektor.' });

    const engel = await klasorService.erisimDenetle(id, acikListesi(req));
    if (engel) return basarisizYanit(req, res, { hata: `Once "${engel.ad}" sektorunun kilidini acin.`, geriYol: `/depo?klasor=${id}` });

    const klasor = await klasorService.getir(id);
    if (!klasor) return basarisizYanit(req, res, { hata: 'Sektor bulunamadi.' });

    const sonuc = await klasorService.silRecursive(id, { yoneticiId: req.yonetici.id, depoYolu: ayar.depo.yol });
    if (!sonuc.tamam) return basarisizYanit(req, res, { hata: sonuc.hata });

    const geriYol = klasor.ebeveyn_id ? `/depo?klasor=${klasor.ebeveyn_id}` : '/depo';
    return basariliYanit(req, res, { geriYol, durumKodu: 'klasor_silindi' });
  } catch (hata) { next(hata); }
});

// ============================================================== PAYLASIM
yonlendirici.post('/depo/klasor/:id/paylas', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return basarisizYanit(req, res, { hata: 'Gecersiz sektor.' });

    const engel = await klasorService.erisimDenetle(id, acikListesi(req));
    if (engel) return basarisizYanit(req, res, { hata: `Once "${engel.ad}" sektorunun kilidini acin.`, geriYol: `/depo?klasor=${id}` });

    const sifreKorumali = req.body.sifre_korumali === 'true' || req.body.sifre_korumali === 'on' || req.body.sifre_korumali === true;

    const sonuc = await paylasimService.klasorPaylas({
      klasorId: id,
      baslik: req.body.baslik,
      sifre: sifreKorumali ? req.body.sifre : null,
      indirmeyeIzin: req.body.indirme_izni === 'true' || req.body.indirme_izni === 'on' || req.body.indirme_izni === true,
      sonKullanmaSaat: req.body.sure_saat,
      maxGoruntuleme: req.body.max_goruntuleme,
      yoneticiId: req.yonetici.id,
    });
    if (!sonuc.tamam) return basarisizYanit(req, res, { hata: sonuc.hata, geriYol: `/depo?klasor=${id}` });

    return basariliYanit(req, res, {
      govde: { link: sonuc.link, url: `${ayar.publicUrl}/paylas/${sonuc.link.token}` },
      geriYol: `/depo?klasor=${id}`, durumKodu: 'paylasim_olusturuldu',
    });
  } catch (hata) { next(hata); }
});

yonlendirici.post('/depo/paylasim/:id/kapat', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return basarisizYanit(req, res, { hata: 'Gecersiz baglanti.' });
    const link = await paylasimService.linkGetir(id);
    const sonuc = await paylasimService.kapat(id, { yoneticiId: req.yonetici.id });
    if (!sonuc.tamam) return basarisizYanit(req, res, { hata: sonuc.hata });
    return basariliYanit(req, res, { geriYol: `/depo?klasor=${link ? link.klasor_id : ''}`, durumKodu: 'paylasim_kapatildi' });
  } catch (hata) { next(hata); }
});

yonlendirici.post('/depo/paylasim/:id/ac', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return basarisizYanit(req, res, { hata: 'Gecersiz baglanti.' });
    const link = await paylasimService.linkGetir(id);
    const sonuc = await paylasimService.yenidenAc(id, { yoneticiId: req.yonetici.id });
    if (!sonuc.tamam) return basarisizYanit(req, res, { hata: sonuc.hata });
    return basariliYanit(req, res, { geriYol: `/depo?klasor=${link ? link.klasor_id : ''}`, durumKodu: 'paylasim_acildi' });
  } catch (hata) { next(hata); }
});

// =================================================================== DOSYA
yonlendirici.post(
  '/depo/yukle', onbellekYok, girisGerekli, yazmaSiniri,
  yukleyici.array('dosyalar', 10), yuklemeHatasiYakala, csrfKoru,
  async (req, res, next) => {
    try {
      const klasorId = dogrula.kimlik(req.body.klasor_id);
      if (!klasorId) return basarisizYanit(req, res, { hata: 'Hedef sektor belirtilmedi.' });

      const engel = await klasorService.erisimDenetle(klasorId, acikListesi(req));
      if (engel) return basarisizYanit(req, res, { hata: `Once "${engel.ad}" sektorunun kilidini acin.`, geriYol: `/depo?klasor=${klasorId}` });

      const dosyalar = req.files || [];
      if (dosyalar.length === 0) return basarisizYanit(req, res, { hata: 'Yuklenecek dosya secilmedi.', geriYol: `/depo?klasor=${klasorId}` });

      const sonuclar = [];
      for (const dosya of dosyalar) {
        const sonuc = await dosyaService.yukle({ klasorId, dosya, yoneticiId: req.yonetici.id });
        sonuclar.push(sonuc);
      }

      const basarisizlar = sonuclar.filter((s) => !s.tamam);
      if (basarisizlar.length > 0 && jsonIster(req)) {
        return res.status(207).json({ tamam: basarisizlar.length < sonuclar.length, sonuclar });
      }
      if (basarisizlar.length === sonuclar.length) {
        return basarisizYanit(req, res, { hata: basarisizlar[0].hata, geriYol: `/depo?klasor=${klasorId}` });
      }

      return basariliYanit(req, res, { govde: { sonuclar }, geriYol: `/depo?klasor=${klasorId}`, durumKodu: 'yukleme_tamam' });
    } catch (hata) { next(hata); }
  },
);

/** Dosyanin ait oldugu klasor zincirinde kilit kontrolu yapar. */
async function dosyaErisimKontrol(req, res, dosya) {
  if (!dosya) { res.status(404); return false; }
  const engel = await klasorService.erisimDenetle(dosya.klasor_id, acikListesi(req));
  if (engel) { res.status(403); return false; }
  return true;
}

yonlendirici.get('/depo/dosya/:id/goruntule', girisGerekli, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return res.status(400).end();
    const dosya = await dosyaService.getir(id);
    if (!(await dosyaErisimKontrol(req, res, dosya))) return res.end();

    const arabellek = await dosyaService.coz(dosya);
    await dosyaService.goruntulemeSayaciArtir(id);
    return dosyaService.akisGonder(res, req, dosya, arabellek, { indir: false });
  } catch (hata) { next(hata); }
});

yonlendirici.get('/depo/dosya/:id/indir', girisGerekli, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return res.status(400).end();
    const dosya = await dosyaService.getir(id);
    if (!(await dosyaErisimKontrol(req, res, dosya))) return res.end();

    const arabellek = await dosyaService.coz(dosya);
    await dosyaService.indirmeSayaciArtir(id);
    return dosyaService.akisGonder(res, req, dosya, arabellek, { indir: true });
  } catch (hata) { next(hata); }
});

yonlendirici.post('/depo/dosya/:id/sil', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return basarisizYanit(req, res, { hata: 'Gecersiz dosya.' });

    const dosya = await dosyaService.getir(id);
    if (!dosya) return basarisizYanit(req, res, { hata: 'Dosya bulunamadi.' });

    const engel = await klasorService.erisimDenetle(dosya.klasor_id, acikListesi(req));
    if (engel) return basarisizYanit(req, res, { hata: `Once "${engel.ad}" sektorunun kilidini acin.` });

    const sonuc = await dosyaService.sil(id, { yoneticiId: req.yonetici.id });
    if (!sonuc.tamam) return basarisizYanit(req, res, { hata: sonuc.hata });

    return basariliYanit(req, res, { geriYol: `/depo?klasor=${dosya.klasor_id}`, durumKodu: 'dosya_silindi' });
  } catch (hata) { next(hata); }
});

// =================================================================== BELGE
yonlendirici.post('/depo/belge', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const klasorId = dogrula.kimlik(req.body.klasor_id);
    if (klasorId) {
      const engel = await klasorService.erisimDenetle(klasorId, acikListesi(req));
      if (engel) return basarisizYanit(req, res, { hata: `Once "${engel.ad}" sektorunun kilidini acin.`, geriYol: `/depo?klasor=${klasorId}` });
    }

    const sonuc = await belgeService.olustur({
      klasorId: klasorId || null, baslik: req.body.baslik, icerik: req.body.icerik,
      imza: req.body.imza, yoneticiId: req.yonetici.id,
    });
    const geriYol = klasorId ? `/depo?klasor=${klasorId}` : '/depo';
    if (!sonuc.tamam) return basarisizYanit(req, res, { hata: sonuc.hata, geriYol });

    return basariliYanit(req, res, { govde: { belge: sonuc.belge }, geriYol, durumKodu: 'belge_tamam' });
  } catch (hata) { next(hata); }
});

yonlendirici.get('/depo/belge/:id', girisGerekli, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return res.status(400).json({ tamam: false, hata: 'Gecersiz belge.' });

    const belge = await belgeService.getir(id);
    if (!belge) return res.status(404).json({ tamam: false, hata: 'Belge bulunamadi.' });

    if (belge.klasor_id) {
      const engel = await klasorService.erisimDenetle(belge.klasor_id, acikListesi(req));
      if (engel) return res.status(403).json({ tamam: false, hata: `Once "${engel.ad}" sektorunun kilidini acin.` });
    }

    return res.json({ tamam: true, belge });
  } catch (hata) { next(hata); }
});

yonlendirici.post('/depo/belge/:id/guncelle', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return basarisizYanit(req, res, { hata: 'Gecersiz belge.' });

    const mevcut = await belgeService.getir(id);
    if (!mevcut) return basarisizYanit(req, res, { hata: 'Belge bulunamadi.' });

    if (mevcut.klasor_id) {
      const engel = await klasorService.erisimDenetle(mevcut.klasor_id, acikListesi(req));
      if (engel) return basarisizYanit(req, res, { hata: `Once "${engel.ad}" sektorunun kilidini acin.` });
    }

    const sonuc = await belgeService.guncelle({
      id, baslik: req.body.baslik, icerik: req.body.icerik, imza: req.body.imza, yoneticiId: req.yonetici.id,
    });
    const geriYol = mevcut.klasor_id ? `/depo?klasor=${mevcut.klasor_id}` : '/depo';
    if (!sonuc.tamam) return basarisizYanit(req, res, { hata: sonuc.hata, geriYol });

    return basariliYanit(req, res, { govde: { belge: sonuc.belge }, geriYol, durumKodu: 'belge_tamam' });
  } catch (hata) { next(hata); }
});

yonlendirici.post('/depo/belge/:id/sil', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return basarisizYanit(req, res, { hata: 'Gecersiz belge.' });

    const mevcut = await belgeService.getir(id);
    if (!mevcut) return basarisizYanit(req, res, { hata: 'Belge bulunamadi.' });

    if (mevcut.klasor_id) {
      const engel = await klasorService.erisimDenetle(mevcut.klasor_id, acikListesi(req));
      if (engel) return basarisizYanit(req, res, { hata: `Once "${engel.ad}" sektorunun kilidini acin.` });
    }

    const sonuc = await belgeService.sil(id, { yoneticiId: req.yonetici.id });
    if (!sonuc.tamam) return basarisizYanit(req, res, { hata: sonuc.hata });

    const geriYol = mevcut.klasor_id ? `/depo?klasor=${mevcut.klasor_id}` : '/depo';
    return basariliYanit(req, res, { geriYol, durumKodu: 'belge_silindi' });
  } catch (hata) { next(hata); }
});

module.exports = yonlendirici;
