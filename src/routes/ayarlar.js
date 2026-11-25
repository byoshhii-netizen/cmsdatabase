'use strict';
/**
 * src/routes/ayarlar.js   ->  /ayarlar
 * Ana sifre degistirme ve API anahtari yonetimi.
 */

const express = require('express');
const ayarService = require('../services/ayarService');
const authService = require('../services/authService');
const sesServisi = require('../services/sesServisi');
const { girisGerekli, jsonIster } = require('../middleware/auth');
const { onbellekYok } = require('../middleware/security');
const { csrfKoru } = require('../middleware/csrf');
const { sifreSiniri, yazmaSiniri } = require('../middleware/rateLimit');
const { sesOrnekYukleyici, sesYuklemeHatasiYakala } = require('../middleware/sesYukleme');
const dogrula = require('../utils/validate');
const log = require('../services/logService');
const zekaService = require('../services/zekaService');
const cozumlemeService = require('../services/cozumlemeService');

const yonlendirici = express.Router();

/** Yonlendirme sonrasi gosterilecek bildirim metinleri. */
const DURUM_MESAJLARI = {
  sifre_tamam:     'Ana sifre guncellendi. Diger tum oturumlar kapatildi.',
  anahtar_tamam:   'API anahtari sifrelenerek kaydedildi.',
  anahtar_silindi: 'API anahtari silindi.',
  anahtar_yok:     'Silinecek anahtar bulunamadi.',
  arayuz_tamam:    'Arayuz ayarlari kaydedildi.',
  anahtar_durum:   'Anahtar durumu guncellendi.',
  ses_tamam:       'Cambaz ses ayarlari kaydedildi.',
  ses_ornek_tamam: 'Ozel ses ornegi yuklendi.',
  ses_ornek_silindi: 'Ozel ses ornegi silindi.',
};

const DURUM_HATALARI = {
  anahtar_hata: 'Anahtar kaydedilemedi. Degeri kontrol edin.',
  ses_ornek_hata: 'Ses ornegi kaydedilemedi.',
};

// ------------------------------------------------------------- GET /ayarlar
yonlendirici.get('/ayarlar', onbellekYok, girisGerekli, async (req, res, next) => {
  try {
    const [anahtarlar, ayarlar, hesap, sesOrnegi, zekaDurum, cozDurum, sorguGecmisi] = await Promise.all([
      ayarService.apiAnahtarlariListele(),
      ayarService.tumAyarlar(),
      authService.yoneticiGetir(req.yonetici.id),
      sesServisi.sesOrnekBilgisi(),
      zekaService.durum().catch(() => null),
      cozumlemeService.durum().catch(() => null),
      zekaService.sorguGecmisi({ limit: 15 }).catch(() => []),
    ]);

    res.render('ayarlar', {
      baslik: 'SISTEM AYARLARI',
      rota: '/ayarlar',
      betikler: ['/js/ayarlar.js'],
      anahtarlar,
      ayarlar,
      hesap,
      sesOrnegi,
      zekaDurum,
      cozDurum,
      sorguGecmisi,
      sozluk: require('../zeka/dogalDil'),
      bildirim: DURUM_MESAJLARI[String(req.query.durum || '')]
        || dogrula.metin(req.query.bildirim, { max: 400 }) || null,
      hata: DURUM_HATALARI[String(req.query.durum || '')]
        || dogrula.metin(req.query.hata, { max: 400 }) || null,
    });
  } catch (hata) { next(hata); }
});

// --------------------------------------------- POST /ayarlar/sifre (degistir)
yonlendirici.post(
  '/ayarlar/sifre',
  onbellekYok,
  girisGerekli,
  sifreSiniri,
  csrfKoru,
  async (req, res, next) => {
    try {
      const sonuc = await authService.sifreDegistir({
        yoneticiId: req.yonetici.id,
        mevcutSifre: req.body.mevcut_sifre,
        yeniSifre: req.body.yeni_sifre,
        yeniSifreTekrar: req.body.yeni_sifre_tekrar,
        ip: log.ipCikar(req),
        userAgent: req.get('user-agent'),
      });

      if (!sonuc.tamam) {
        if (jsonIster(req)) {
          return res.status(400).json({ tamam: false, kod: sonuc.kod, hata: sonuc.hata, hatalar: sonuc.hatalar || [] });
        }
        return res.status(400).render('ayarlar', {
          baslik: 'SISTEM AYARLARI',
          rota: '/ayarlar',
          anahtarlar: await ayarService.apiAnahtarlariListele(),
          ayarlar: await ayarService.tumAyarlar(),
          hesap: await authService.yoneticiGetir(req.yonetici.id),
          bildirim: null,
          hata: sonuc.hata,
        });
      }

      // Diger cihazlardaki oturumlari dusur, mevcut oturumu guncel surume tasi.
      const dusen = await authService.digerOturumlariKapat(req.yonetici.id, req.sessionID);
      req.session.yonetici.oturumSurumu = sonuc.oturumSurumu;
      req.session.surumKontrolZamani = Date.now();

      if (jsonIster(req)) {
        return res.json({
          tamam: true,
          mesaj: 'Ana sifre guncellendi. Diger tum oturumlar kapatildi.',
          kapatilanOturum: dusen,
          guc: sonuc.guc,
        });
      }
      return res.redirect(303, '/ayarlar?durum=sifre_tamam');
    } catch (hata) { next(hata); }
  },
);

// ----------------------------------------------- POST /ayarlar/api-anahtari
yonlendirici.post(
  '/ayarlar/api-anahtari',
  onbellekYok,
  girisGerekli,
  yazmaSiniri,
  csrfKoru,
  async (req, res, next) => {
    try {
      const sonuc = await ayarService.apiAnahtarKaydet({
        saglayici: req.body.saglayici,
        etiket: req.body.etiket,
        deger: req.body.deger,
        yoneticiId: req.yonetici.id,
      });

      if (!sonuc.tamam) {
        if (jsonIster(req)) return res.status(400).json({ tamam: false, hata: sonuc.hata });
        return res.redirect(303, '/ayarlar?durum=anahtar_hata');
      }

      if (jsonIster(req)) return res.json({ tamam: true, mesaj: 'Anahtar sifrelenerek kaydedildi.' });
      return res.redirect(303, '/ayarlar?durum=anahtar_tamam');
    } catch (hata) { next(hata); }
  },
);

// ------------------------------------- POST /ayarlar/api-anahtari/:id/aktif
yonlendirici.post(
  '/ayarlar/api-anahtari/:id/aktif',
  onbellekYok,
  girisGerekli,
  yazmaSiniri,
  csrfKoru,
  async (req, res, next) => {
    try {
      const id = dogrula.kimlik(req.params.id);
      if (!id) {
        if (jsonIster(req)) return res.status(400).json({ tamam: false, hata: 'Gecersiz kimlik.' });
        return res.redirect(303, '/ayarlar');
      }
      const aktif = req.body.aktif === true || req.body.aktif === 'true';
      const satir = await ayarService.apiAnahtarAktifAyarla(id, aktif, req.yonetici.id);
      if (jsonIster(req)) return res.json({ tamam: Boolean(satir), satir: satir || null });
      return res.redirect(303, '/ayarlar?durum=anahtar_durum');
    } catch (hata) { next(hata); }
  },
);

// --------------------------------------- POST /ayarlar/api-anahtari/:id/sil
yonlendirici.post(
  '/ayarlar/api-anahtari/:id/sil',
  onbellekYok,
  girisGerekli,
  yazmaSiniri,
  csrfKoru,
  async (req, res, next) => {
    try {
      const id = dogrula.kimlik(req.params.id);
      if (!id) {
        if (jsonIster(req)) return res.status(400).json({ tamam: false, hata: 'Gecersiz kimlik.' });
        return res.redirect(303, '/ayarlar');
      }
      const silindi = await ayarService.apiAnahtarSil(id, req.yonetici.id);
      if (jsonIster(req)) return res.json({ tamam: silindi });
      return res.redirect(303, '/ayarlar?durum=' + (silindi ? 'anahtar_silindi' : 'anahtar_yok'));
    } catch (hata) { next(hata); }
  },
);

// -------------------------------------------------- POST /ayarlar/arayuz
yonlendirici.post(
  '/ayarlar/arayuz',
  onbellekYok,
  girisGerekli,
  yazmaSiniri,
  csrfKoru,
  async (req, res, next) => {
    try {
      const mantikAyarlar = ['ses_aktif', 'matrix_aktif', 'gecis_animasyonu'];
      for (const anahtar of mantikAyarlar) {
        const deger = req.body[anahtar] === 'true' || req.body[anahtar] === 'on' || req.body[anahtar] === true;
        await ayarService.ayarYaz(anahtar, deger ? 'true' : 'false', 'mantik');
      }
      await log.bilgi({
        kategori: 'ayarlar', olay: 'arayuz_ayarlari_guncellendi',
        yoneticiId: req.yonetici.id, req,
      });

      if (jsonIster(req)) return res.json({ tamam: true, mesaj: 'Arayuz ayarlari kaydedildi.' });
      return res.redirect(303, '/ayarlar?durum=arayuz_tamam');
    } catch (hata) { next(hata); }
  },
);

// ======================================================================
//  CAMBAZ SES AYARLARI
// ======================================================================

const SES_TUR_IZIN = new Set(['tarayici', 'openai', 'elevenlabs']);

// ----------------------------------------------------- POST /ayarlar/cambaz-ses
yonlendirici.post(
  '/ayarlar/cambaz-ses',
  onbellekYok,
  girisGerekli,
  yazmaSiniri,
  csrfKoru,
  async (req, res, next) => {
    try {
      const tur = SES_TUR_IZIN.has(req.body.tur) ? req.body.tur : 'tarayici';
      const ad = dogrula.metin(req.body.ad, { max: 80 });
      const hiz = Math.max(0.5, Math.min(2, Number(req.body.hiz) || 1));
      const perde = Math.max(0.5, Math.min(2, Number(req.body.perde) || 1));

      await Promise.all([
        ayarService.ayarYaz('cambaz_ses_turu', tur, 'metin'),
        ayarService.ayarYaz('cambaz_ses_ad', ad, 'metin'),
        ayarService.ayarYaz('cambaz_ses_hiz', String(hiz), 'metin'),
        ayarService.ayarYaz('cambaz_ses_perde', String(perde), 'metin'),
      ]);

      await log.bilgi({ kategori: 'cambaz', olay: 'ses_ayarlari_guncellendi', yoneticiId: req.yonetici.id, req });

      if (jsonIster(req)) return res.json({ tamam: true });
      return res.redirect(303, '/ayarlar?durum=ses_tamam');
    } catch (hata) { next(hata); }
  },
);

// ------------------------------------------- POST /ayarlar/cambaz-ses-ornegi
yonlendirici.post(
  '/ayarlar/cambaz-ses-ornegi',
  onbellekYok,
  girisGerekli,
  yazmaSiniri,
  csrfKoru,
  sesOrnekYukleyici.single('ornek'),
  sesYuklemeHatasiYakala,
  async (req, res, next) => {
    try {
      if (!req.file) {
        if (jsonIster(req)) return res.status(400).json({ tamam: false, hata: 'Dosya bulunamadi.' });
        return res.redirect(303, '/ayarlar?durum=ses_ornek_hata');
      }

      await sesServisi.sesOrnekKaydet({
        tampon: req.file.buffer, mime: req.file.mimetype, dosyaAdi: req.file.originalname,
      });

      // ElevenLabs anahtari varsa, ornegi hemen klonlamayi dene (en iyi efor;
      // basarisiz olursa kullanici /ayarlar'da anahtar/dosya durumunu gorur).
      const elevenlabsKey = await ayarService.apiAnahtarCoz('elevenlabs');
      let klonSonucu = null;
      if (elevenlabsKey) klonSonucu = await sesServisi.elevenlabsKlonOlustur(elevenlabsKey);

      await log.bilgi({ kategori: 'cambaz', olay: 'ses_ornegi_yuklendi', yoneticiId: req.yonetici.id, req });

      if (jsonIster(req)) return res.json({ tamam: true, klon: klonSonucu });
      return res.redirect(303, '/ayarlar?durum=ses_ornek_tamam');
    } catch (hata) { next(hata); }
  },
);

// --------------------------------------- POST /ayarlar/cambaz-ses-ornegi/sil
yonlendirici.post(
  '/ayarlar/cambaz-ses-ornegi/sil',
  onbellekYok,
  girisGerekli,
  yazmaSiniri,
  csrfKoru,
  async (req, res, next) => {
    try {
      const silindi = await sesServisi.sesOrnekSil();
      if (jsonIster(req)) return res.json({ tamam: silindi });
      return res.redirect(303, '/ayarlar?durum=ses_ornek_silindi');
    } catch (hata) { next(hata); }
  },
);

// ============================================================ CEKIRDEK ZEKA

const ZEKA_AYARLARI = {
  zeka_motor: ['dahili', 'saglayici', 'karma'],
  zeka_otomatik_cozumleme: ['true', 'false'],
  zeka_otomatik_varlik: ['true', 'false'],
  arsiv_tasnif_bandi: ['true', 'false'],
  arsiv_varsayilan_tasnif: ['acik', 'hizmete_ozel', 'gizli', 'cok_gizli'],
  arayuz_temasi: ['zumrut', 'kehribar', 'camgobegi', 'mor'],
};

/** Cekirdek zeka ve arsiv ayarlarini kaydeder. */
yonlendirici.post('/ayarlar/zeka', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const kaydedilen = [];

    for (const [anahtar, izinli] of Object.entries(ZEKA_AYARLARI)) {
      if (req.body[anahtar] === undefined) continue;
      const deger = String(req.body[anahtar]);
      if (!izinli.includes(deger)) continue;
      await ayarService.ayarYaz(anahtar, deger, { yoneticiId: req.yonetici.id });
      kaydedilen.push(anahtar);
    }

    // Sayisal ayarlar
    for (const [anahtar, alt, ust] of [
      ['risk_esigi', 0, 100],
      ['zeka_dizin_parca_kelime', 60, 600],
    ]) {
      if (req.body[anahtar] === undefined) continue;
      const sayi = Number(req.body[anahtar]);
      if (!Number.isFinite(sayi) || sayi < alt || sayi > ust) continue;
      await ayarService.ayarYaz(anahtar, String(Math.round(sayi)), { yoneticiId: req.yonetici.id });
      kaydedilen.push(anahtar);
    }

    await log.bilgi({
      kategori: 'ayar', olay: 'zeka_ayari_guncellendi',
      mesaj: kaydedilen.join(', ') || 'degisiklik yok', yoneticiId: req.yonetici.id,
    });

    res.redirect(303, `/ayarlar?bildirim=${encodeURIComponent(
      kaydedilen.length ? `${kaydedilen.length} ayar kaydedildi.` : 'Degisiklik yok.',
    )}#zeka`);
  } catch (hata) { next(hata); }
});

/** Yerel arama dizinini sifirdan kurar. */
yonlendirici.post('/ayarlar/zeka/dizin', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const sonuc = await zekaService.dizinKur({ yoneticiId: req.yonetici.id });
    const s = sonuc.sayim;
    res.redirect(303, `/ayarlar?bildirim=${encodeURIComponent(
      `Dizin kuruldu: ${s.kayit} kayit, ${s.varlik} varlik, ${s.olay} olay, ${s.dosya} belge, ` +
      `${s.belge} dahili belge, ${s.vaka} vaka -> ${s.parca} parca (${Math.round(sonuc.sureMs / 100) / 10} sn).`,
    )}#zeka`);
  } catch (hata) { next(hata); }
});

/** Siniflandirma modelini egitir. */
yonlendirici.post('/ayarlar/zeka/model', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const modelAdi = String(req.body.model || 'kayit_turu');
    const sonuc = await zekaService.modelEgit(modelAdi, { yoneticiId: req.yonetici.id });

    if (!sonuc.tamam) {
      return res.redirect(303, `/ayarlar?hata=${encodeURIComponent(sonuc.hata)}#zeka`);
    }
    res.redirect(303, `/ayarlar?bildirim=${encodeURIComponent(
      `${modelAdi} egitildi: ${sonuc.ozet.toplamBelge} ornek, ${sonuc.ozet.sinifSayisi} sinif, ` +
      `${sonuc.ozet.dagarcik} terim, capraz dogrulama basarisi %${sonuc.dogrulama.basari ?? '—'}.`,
    )}#zeka`);
  } catch (hata) { next(hata); }
});

/** Modeli siler. */
yonlendirici.post('/ayarlar/zeka/model-sil', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    await zekaService.modelSil(String(req.body.model || 'kayit_turu'));
    res.redirect(303, '/ayarlar?bildirim=Model+silindi.#zeka');
  } catch (hata) { next(hata); }
});

/** Bekleyen belgeleri topluca cozumler. */
yonlendirici.post('/ayarlar/zeka/cozumle', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const sayim = await cozumlemeService.bekleyenleriCozumle({ limit: 300, yoneticiId: req.yonetici.id });
    res.redirect(303, `/ayarlar?bildirim=${encodeURIComponent(
      `${sayim.toplam} belge islendi: ${sayim.tamam} tamam, ${sayim.kismi} kismi, ` +
      `${sayim.basarisiz} basarisiz, ${sayim.varlik} varlik bulundu.`,
    )}#zeka`);
  } catch (hata) { next(hata); }
});

module.exports = yonlendirici;
