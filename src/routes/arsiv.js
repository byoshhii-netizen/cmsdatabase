'use strict';
/**
 * src/routes/arsiv.js   ->  /arsiv/*
 * ISTIHBARAT ARSIVI MODULU
 *
 *   GET  /arsiv                     arsiv kokpiti
 *   GET  /arsiv/varliklar           varlik listesi (filtreli)
 *   GET  /arsiv/varlik/:id          varlik dosyesi
 *   POST /arsiv/varlik              yeni varlik
 *   POST /arsiv/varlik/:id          guncelle
 *   POST /arsiv/varlik/:id/sil      sil
 *   POST /arsiv/varlik/:id/birlestir  baska varlikla birlestir
 *   POST /arsiv/iliski              iliski ekle
 *   POST /arsiv/iliski/:id/sil      iliski sil
 *   GET  /arsiv/kayitlar            kayit listesi
 *   GET  /arsiv/kayit/:id           kayit detayi
 *   POST /arsiv/kayit               yeni kayit
 *   POST /arsiv/kayit/:id           guncelle
 *   POST /arsiv/kayit/:id/sil       sil
 *   POST /arsiv/kayit/:id/varlik    kayda varlik bagla / coz
 *   GET  /arsiv/olaylar             zaman cizgisi listesi
 *   GET  /arsiv/olay/:id            olay detayi
 *   POST /arsiv/olay                yeni olay
 *   GET  /arsiv/vakalar             vaka listesi
 *   GET  /arsiv/vaka/:id            vaka dosyasi
 *   POST /arsiv/vaka                yeni vaka
 *   POST /arsiv/vaka/:id            guncelle
 *   GET  /arsiv/kaynaklar           kaynak listesi
 *   POST /arsiv/kaynak              yeni kaynak
 *   GET  /arsiv/izleme              izleme kurallari ve uyarilar
 *   POST /arsiv/izleme              kural ekle
 *   GET  /arsiv/api/varlik-ara      varlik otomatik tamamlama (JSON)
 *   GET  /arsiv/api/ozet            kokpit gostergeleri (JSON)
 */

const express = require('express');

const arsiv = require('../services/arsivService');
const uyariService = require('../services/uyariService');
const zeka = require('../services/zekaService');
const cozumleme = require('../services/cozumlemeService');
const log = require('../services/logService');
const dogrula = require('../utils/validate');
const nd = require('../zeka/dogalDil');

const { girisGerekli } = require('../middleware/auth');
const { onbellekYok } = require('../middleware/security');
const { csrfKoru } = require('../middleware/csrf');
const { yazmaSiniri } = require('../middleware/rateLimit');

const yonlendirici = express.Router();

// Tum arsiv rotalari kimlik ve onbellek korumasi altinda
yonlendirici.use('/arsiv', onbellekYok, girisGerekli);

// Gorunumlerde kullanilan ortak sozluk ve sabitler
function ortakVeri() {
  return {
    sozluk: nd,
    sabitler: {
      tasnifler: arsiv.TASNIFLER,
      guvenilirlikler: arsiv.GUVENILIRLIKLER,
      varlikTurleri: arsiv.VARLIK_TURLERI,
      varlikDurumlari: arsiv.VARLIK_DURUMLARI,
      iliskiTurleri: arsiv.ILISKI_TURLERI,
      kayitTurleri: arsiv.KAYIT_TURLERI,
      kayitDurumlari: arsiv.KAYIT_DURUMLARI,
      olayTurleri: arsiv.OLAY_TURLERI,
      kaynakTurleri: arsiv.KAYNAK_TURLERI,
      vakaDurumlari: arsiv.VAKA_DURUMLARI,
      oncelikler: arsiv.ONCELIKLER,
    },
  };
}

function kimlik(deger) {
  const n = Number(deger);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function istek(req) {
  return { yoneticiId: req.yonetici.id, ip: log.ipCikar(req) };
}

/** POST sonrasi hedefe bildirimle don. */
function geriDon(res, yol, bildirim, hata) {
  const parametreler = new URLSearchParams();
  if (bildirim) parametreler.set('bildirim', bildirim);
  if (hata) parametreler.set('hata', hata);
  const ek = parametreler.toString();
  res.redirect(303, ek ? `${yol}${yol.includes('?') ? '&' : '?'}${ek}` : yol);
}

// ============================================================== KOKPIT

yonlendirici.get('/arsiv', async (req, res, next) => {
  try {
    const [ozet, motorDurum, cozDurum, uyarilar, vakalar, kaynaklar] = await Promise.all([
      arsiv.panoOzet(),
      zeka.durum(),
      cozumleme.durum(),
      uyariService.uyarilariListele({ okundu: 0, limit: 10 }),
      arsiv.vakaListele({ durum: 'acik', limit: 6 }),
      arsiv.kaynakListele({ limit: 10 }),
    ]);

    res.render('arsiv/kokpit', {
      baslik: 'ISTIHBARAT ARSIVI',
      rota: '/arsiv',
      betikler: ['/js/arsiv.js', '/js/hud.js'],
      ozet, motorDurum, cozDurum, uyarilar, vakalar, kaynaklar,
      ...ortakVeri(),
    });
  } catch (hata) { next(hata); }
});

yonlendirici.get('/arsiv/api/ozet', async (req, res, next) => {
  try {
    const ozet = await arsiv.panoOzet();
    res.json({ tamam: true, ...ozet, zaman: new Date().toISOString() });
  } catch (hata) { next(hata); }
});

/** Varlik otomatik tamamlama — form alanlarinda kullanilir. */
yonlendirici.get('/arsiv/api/varlik-ara', async (req, res, next) => {
  try {
    const { varliklar } = await arsiv.varlikListele({
      arama: req.query.q || '',
      tur: req.query.tur || null,
      limit: 12,
      sirala: 'onem',
    });
    res.json({
      tamam: true,
      varliklar: varliklar.map((v) => ({
        id: v.id, kod: v.kod, ad: v.ad, tur: v.tur, onem: v.onem,
        durum: v.durum, iliski: v.iliski_sayisi, kayit: v.kayit_sayisi,
      })),
    });
  } catch (hata) { next(hata); }
});

// ============================================================= VARLIKLAR

yonlendirici.get('/arsiv/varliklar', async (req, res, next) => {
  try {
    const sayfa = Math.max(1, Number(req.query.sayfa) || 1);
    const limit = 40;
    const filtre = {
      arama: req.query.q || '',
      tur: req.query.tur || null,
      durum: req.query.durum || null,
      tasnif: req.query.tasnif || null,
      etiket: req.query.etiket || null,
      enAzOnem: req.query.onem || null,
      vakaId: kimlik(req.query.vaka),
      sirala: req.query.sirala || 'guncel',
      limit,
      kayma: (sayfa - 1) * limit,
    };

    const [liste, vakalar, etiketler] = await Promise.all([
      arsiv.varlikListele(filtre),
      arsiv.vakaListele({ limit: 40 }),
      arsiv.varlikListele({ limit: 1 }).then(() => null),
    ]);

    res.render('arsiv/varliklar', {
      baslik: 'VARLIKLAR',
      rota: '/arsiv/varliklar',
      betikler: ['/js/arsiv.js'],
      liste, filtre, sayfa, limit, vakalar, etiketler,
      sayfaSayisi: Math.max(1, Math.ceil(liste.toplam / limit)),
      sorgu: req.query,
      ...ortakVeri(),
    });
  } catch (hata) { next(hata); }
});

yonlendirici.get('/arsiv/varlik/:id', async (req, res, next) => {
  try {
    const id = kimlik(req.params.id);
    if (!id) return geriDon(res, '/arsiv/varliklar', null, 'Gecersiz varlik kimligi.');

    const varlik = await arsiv.varlikGetir(id);
    if (!varlik) return geriDon(res, '/arsiv/varliklar', null, 'Varlik bulunamadi.');

    const [iliskiler, kayitlar, olaylar, ekler, denetim, benzerler, grafVeri] = await Promise.all([
      arsiv.iliskiListele(id),
      arsiv.kayitListele({ varlikId: id, limit: 40 }),
      arsiv.olayListele({ varlikId: id, limit: 40 }),
      arsiv.varlikEkleri(id),
      arsiv.denetimListele({ ogeTur: 'varlik', ogeId: id, limit: 20 }),
      zeka.benzerler('varlik', id, { limit: 6 }).catch(() => []),
      zeka.grafVerisi({ varlikId: id, derinlik: 2, maxDugum: 120 }).catch(() => null),
    ]);

    // Motorun kendi dosye sentezi — sayfanin ustunde "degerlendirme" olarak gosterilir
    const sentez = await zeka.sor(`${varlik.ad} hakkinda`, {
      yoneticiId: req.yonetici.id,
    }).catch(() => null);

    await arsiv.denetimYaz({
      ogeTur: 'varlik', ogeId: id, eylem: 'goruntuleme',
      ...istek(req),
    });

    res.render('arsiv/varlik', {
      baslik: varlik.ad.toLocaleUpperCase('tr-TR'),
      rota: '/arsiv/varliklar',
      betikler: ['/js/arsiv.js', '/js/graf.js'],
      varlik, iliskiler, kayitlar, olaylar, ekler, denetim, benzerler,
      grafVeri, sentez,
      ...ortakVeri(),
    });
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/varlik', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const sonuc = await arsiv.varlikOlustur(req.body, istek(req));
    if (!sonuc.tamam) return geriDon(res, '/arsiv/varliklar', null, sonuc.hata);
    geriDon(res, `/arsiv/varlik/${sonuc.varlik.id}`, `${sonuc.varlik.kod} olusturuldu.`);
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/varlik/:id', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = kimlik(req.params.id);
    if (!id) return geriDon(res, '/arsiv/varliklar', null, 'Gecersiz kimlik.');
    const sonuc = await arsiv.varlikGuncelle(id, req.body, istek(req));
    if (!sonuc.tamam) return geriDon(res, `/arsiv/varlik/${id}`, null, sonuc.hata);
    geriDon(res, `/arsiv/varlik/${id}`,
      sonuc.degisen.length ? `Guncellendi: ${sonuc.degisen.join(', ')}` : 'Degisiklik yok.');
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/varlik/:id/sil', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = kimlik(req.params.id);
    const sonuc = await arsiv.varlikSil(id, istek(req));
    geriDon(res, '/arsiv/varliklar', sonuc.tamam ? 'Varlik arsivden dusuruldu.' : null, sonuc.hata);
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/varlik/:id/birlestir', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const kaynakId = kimlik(req.params.id);
    const hedefId = kimlik(req.body.hedef_id);
    if (!kaynakId || !hedefId) return geriDon(res, `/arsiv/varlik/${kaynakId || ''}`, null, 'Hedef varlik secilmedi.');

    const sonuc = await arsiv.varlikBirlestir(kaynakId, hedefId, istek(req));
    if (!sonuc.tamam) return geriDon(res, `/arsiv/varlik/${kaynakId}`, null, sonuc.hata);
    geriDon(res, `/arsiv/varlik/${hedefId}`,
      `Birlestirildi: ${sonuc.sayim.iliski} iliski, ${sonuc.sayim.kayit} kayit, ${sonuc.sayim.olay} olay tasindi.`);
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/varlik/:id/ek', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = kimlik(req.params.id);
    const ogeId = kimlik(req.body.oge_id);
    if (!id || !ogeId) return geriDon(res, `/arsiv/varlik/${id || ''}`, null, 'Ek secilmedi.');
    await arsiv.varlikEkEkle(id, req.body.oge_tur || 'dosya', ogeId, { notMetni: req.body.not_metni });
    geriDon(res, `/arsiv/varlik/${id}`, 'Ek baglandi.');
  } catch (hata) { next(hata); }
});

// ============================================================== ILISKILER

yonlendirici.post('/arsiv/iliski', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const sonuc = await arsiv.iliskiEkle(req.body, istek(req));
    const geri = req.body.geri || `/arsiv/varlik/${req.body.kaynak_varlik_id}`;
    if (!sonuc.tamam) return geriDon(res, geri, null, sonuc.hata);
    geriDon(res, geri, 'Iliski kaydedildi.');
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/iliski/:id/sil', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const sonuc = await arsiv.iliskiSil(kimlik(req.params.id), istek(req));
    geriDon(res, req.body.geri || '/arsiv/varliklar', sonuc.tamam ? 'Iliski kaldirildi.' : null, sonuc.hata);
  } catch (hata) { next(hata); }
});

// =============================================================== KAYITLAR

yonlendirici.get('/arsiv/kayitlar', async (req, res, next) => {
  try {
    const sayfa = Math.max(1, Number(req.query.sayfa) || 1);
    const limit = 30;
    const filtre = {
      arama: req.query.q || '',
      tur: req.query.tur || null,
      durum: req.query.durum || null,
      tasnif: req.query.tasnif || null,
      guvenilirlik: req.query.guven || null,
      vakaId: kimlik(req.query.vaka),
      kaynakId: kimlik(req.query.kaynak),
      varlikId: kimlik(req.query.varlik),
      etiket: req.query.etiket || null,
      baslangic: req.query.baslangic || null,
      bitis: req.query.bitis || null,
      sirala: req.query.sirala || 'zaman',
      limit,
      kayma: (sayfa - 1) * limit,
    };

    const [liste, vakalar, kaynaklar] = await Promise.all([
      arsiv.kayitListele(filtre),
      arsiv.vakaListele({ limit: 40 }),
      arsiv.kaynakListele({ limit: 60 }),
    ]);

    res.render('arsiv/kayitlar', {
      baslik: 'KAYITLAR',
      rota: '/arsiv/kayitlar',
      betikler: ['/js/arsiv.js'],
      liste, filtre, sayfa, limit, vakalar, kaynaklar,
      sayfaSayisi: Math.max(1, Math.ceil(liste.toplam / limit)),
      sorgu: req.query,
      ...ortakVeri(),
    });
  } catch (hata) { next(hata); }
});

yonlendirici.get('/arsiv/kayit/:id', async (req, res, next) => {
  try {
    const id = kimlik(req.params.id);
    if (!id) return geriDon(res, '/arsiv/kayitlar', null, 'Gecersiz kimlik.');

    const kayit = await arsiv.kayitGetir(id);
    if (!kayit) return geriDon(res, '/arsiv/kayitlar', null, 'Kayit bulunamadi.');

    const [varliklar, surumler, denetim, benzerler, vakalar, kaynaklar] = await Promise.all([
      arsiv.kayitVarliklari(id),
      arsiv.kayitSurumleri(id),
      arsiv.denetimListele({ ogeTur: 'kayit', ogeId: id, limit: 20 }),
      zeka.benzerler('kayit', id, { limit: 6 }).catch(() => []),
      arsiv.vakaListele({ limit: 40 }),
      arsiv.kaynakListele({ limit: 60 }),
    ]);

    // Motorun kayit uzerindeki cozumlemesi: ozet, anahtar kavram, varlik onerisi
    const metinCozum = kayit.govde
      ? zeka.metinCozumle(`${kayit.baslik}\n${kayit.govde}`, { cumleSayisi: 4 })
      : null;

    await arsiv.denetimYaz({ ogeTur: 'kayit', ogeId: id, eylem: 'goruntuleme', ...istek(req) });

    res.render('arsiv/kayit', {
      baslik: kayit.kod,
      rota: '/arsiv/kayitlar',
      betikler: ['/js/arsiv.js'],
      kayit, varliklar, surumler, denetim, benzerler, vakalar, kaynaklar, metinCozum,
      ...ortakVeri(),
    });
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/kayit', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const govde = { ...req.body };
    if (typeof govde.varlik_ids === 'string') govde.varlik_ids = govde.varlik_ids.split(',').filter(Boolean);
    const sonuc = await arsiv.kayitOlustur(govde, istek(req));
    if (!sonuc.tamam) return geriDon(res, '/arsiv/kayitlar', null, sonuc.hata);
    geriDon(res, `/arsiv/kayit/${sonuc.kayit.id}`, `${sonuc.kayit.kod} olusturuldu.`);
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/kayit/:id', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = kimlik(req.params.id);
    const sonuc = await arsiv.kayitGuncelle(id, req.body, istek(req));
    if (!sonuc.tamam) return geriDon(res, `/arsiv/kayit/${id}`, null, sonuc.hata);
    geriDon(res, `/arsiv/kayit/${id}`,
      sonuc.yeniSurum ? `Guncellendi, surum ${sonuc.kayit.surum} olarak kaydedildi.` : 'Guncellendi.');
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/kayit/:id/sil', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const sonuc = await arsiv.kayitSil(kimlik(req.params.id), istek(req));
    geriDon(res, '/arsiv/kayitlar', sonuc.tamam ? 'Kayit arsivden dusuruldu.' : null, sonuc.hata);
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/kayit/:id/varlik', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = kimlik(req.params.id);
    const varlikId = kimlik(req.body.varlik_id);
    if (!id || !varlikId) return geriDon(res, `/arsiv/kayit/${id || ''}`, null, 'Varlik secilmedi.');

    if (req.body.islem === 'coz') {
      await arsiv.kayitVarlikCoz(id, varlikId);
      return geriDon(res, `/arsiv/kayit/${id}`, 'Varlik baglantisi kaldirildi.');
    }
    await arsiv.kayitVarlikBagla(id, varlikId, req.body.rol);
    geriDon(res, `/arsiv/kayit/${id}`, 'Varlik baglandi.');
  } catch (hata) { next(hata); }
});

/** Kaydin govdesinden otomatik varlik cikarip arsive ekler. */
yonlendirici.post('/arsiv/kayit/:id/varlik-cikar', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = kimlik(req.params.id);
    const kayit = await arsiv.kayitGetir(id);
    if (!kayit) return geriDon(res, '/arsiv/kayitlar', null, 'Kayit bulunamadi.');

    const cozum = zeka.metinCozumle(`${kayit.baslik}\n${kayit.govde || ''}`);
    if (!cozum.tamam) return geriDon(res, `/arsiv/kayit/${id}`, null, 'Cikarilacak metin yok.');

    let olusturulan = 0;
    let baglanan = 0;
    for (const oneri of cozum.oneriler.slice(0, 30)) {
      if (oneri.guven < 0.75) continue;
      const mevcut = await arsiv.varlikListele({ arama: oneri.ad, tur: oneri.tur, limit: 1 });
      let varlikId;
      if (mevcut.varliklar.length && mevcut.varliklar[0].ad.toLocaleLowerCase('tr-TR') === oneri.ad.toLocaleLowerCase('tr-TR')) {
        varlikId = mevcut.varliklar[0].id;
      } else {
        const yeni = await arsiv.varlikOlustur({
          tur: oneri.tur, ad: oneri.ad, ozet: oneri.ozet, onem: 40,
          tasnif: kayit.tasnif, etiketler: ['otomatik'], ozellikler: oneri.ozellikler,
        }, istek(req));
        if (!yeni.tamam) continue;
        varlikId = yeni.varlik.id;
        olusturulan++;
      }
      await arsiv.kayitVarlikBagla(id, varlikId, 'ilgili', { otomatik: true });
      baglanan++;
    }

    geriDon(res, `/arsiv/kayit/${id}`,
      `${olusturulan} yeni varlik olusturuldu, ${baglanan} varlik kayda baglandi.`);
  } catch (hata) { next(hata); }
});

// ================================================================= OLAYLAR

yonlendirici.get('/arsiv/olaylar', async (req, res, next) => {
  try {
    const filtre = {
      arama: req.query.q || '',
      tur: req.query.tur || null,
      vakaId: kimlik(req.query.vaka),
      varlikId: kimlik(req.query.varlik),
      gun: req.query.gun || null,
      limit: 150,
    };
    const [liste, vakalar] = await Promise.all([
      arsiv.olayListele(filtre),
      arsiv.vakaListele({ limit: 40 }),
    ]);

    res.render('arsiv/olaylar', {
      baslik: 'ZAMAN CIZGISI',
      rota: '/arsiv/olaylar',
      betikler: ['/js/arsiv.js', '/js/zaman.js'],
      liste, filtre, vakalar, sorgu: req.query,
      ...ortakVeri(),
    });
  } catch (hata) { next(hata); }
});

yonlendirici.get('/arsiv/olay/:id', async (req, res, next) => {
  try {
    const id = kimlik(req.params.id);
    const olay = await arsiv.olayGetir(id);
    if (!olay) return geriDon(res, '/arsiv/olaylar', null, 'Olay bulunamadi.');

    const [varliklar, denetim, vakalar] = await Promise.all([
      arsiv.olayVarliklari(id),
      arsiv.denetimListele({ ogeTur: 'olay', ogeId: id, limit: 15 }),
      arsiv.vakaListele({ limit: 40 }),
    ]);

    res.render('arsiv/olay', {
      baslik: olay.kod,
      rota: '/arsiv/olaylar',
      betikler: ['/js/arsiv.js'],
      olay, varliklar, denetim, vakalar,
      ...ortakVeri(),
    });
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/olay', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const govde = { ...req.body };
    if (typeof govde.varlik_ids === 'string') govde.varlik_ids = govde.varlik_ids.split(',').filter(Boolean);
    const sonuc = await arsiv.olayOlustur(govde, istek(req));
    if (!sonuc.tamam) return geriDon(res, '/arsiv/olaylar', null, sonuc.hata);
    geriDon(res, `/arsiv/olay/${sonuc.olay.id}`, `${sonuc.olay.kod} olusturuldu.`);
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/olay/:id/sil', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const sonuc = await arsiv.olaySil(kimlik(req.params.id), istek(req));
    geriDon(res, '/arsiv/olaylar', sonuc.tamam ? 'Olay silindi.' : null, sonuc.hata);
  } catch (hata) { next(hata); }
});

// ================================================================= VAKALAR

yonlendirici.get('/arsiv/vakalar', async (req, res, next) => {
  try {
    const vakalar = await arsiv.vakaListele({
      durum: req.query.durum || null,
      oncelik: req.query.oncelik || null,
      arama: req.query.q || '',
      limit: 80,
    });
    res.render('arsiv/vakalar', {
      baslik: 'VAKALAR',
      rota: '/arsiv/vakalar',
      betikler: ['/js/arsiv.js'],
      vakalar, sorgu: req.query,
      ...ortakVeri(),
    });
  } catch (hata) { next(hata); }
});

yonlendirici.get('/arsiv/vaka/:id', async (req, res, next) => {
  try {
    const id = kimlik(req.params.id);
    const vaka = await arsiv.vakaGetir(id);
    if (!vaka) return geriDon(res, '/arsiv/vakalar', null, 'Vaka bulunamadi.');

    const [varliklar, kayitlar, olaylar, zamanVeri, grafVeri] = await Promise.all([
      arsiv.vakaVarliklari(id),
      arsiv.kayitListele({ vakaId: id, limit: 60 }),
      arsiv.olayListele({ vakaId: id, limit: 60 }),
      zeka.zamanVerisi({ gun: 365, vakaId: id }).catch(() => null),
      zeka.grafVerisi({ maxDugum: 150 }).catch(() => null),
    ]);

    res.render('arsiv/vaka', {
      baslik: vaka.kod,
      rota: '/arsiv/vakalar',
      betikler: ['/js/arsiv.js', '/js/zaman.js', '/js/graf.js'],
      vaka, varliklar, kayitlar, olaylar, zamanVeri, grafVeri,
      ...ortakVeri(),
    });
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/vaka', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const sonuc = await arsiv.vakaOlustur(req.body, istek(req));
    if (!sonuc.tamam) return geriDon(res, '/arsiv/vakalar', null, sonuc.hata);
    geriDon(res, `/arsiv/vaka/${sonuc.vaka.id}`, `${sonuc.vaka.kod} olusturuldu.`);
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/vaka/:id', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = kimlik(req.params.id);
    const sonuc = await arsiv.vakaGuncelle(id, req.body, istek(req));
    geriDon(res, `/arsiv/vaka/${id}`, sonuc.tamam ? 'Vaka guncellendi.' : null, sonuc.hata);
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/vaka/:id/oge', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = kimlik(req.params.id);
    const ogeId = kimlik(req.body.oge_id);
    if (!id || !ogeId) return geriDon(res, `/arsiv/vaka/${id || ''}`, null, 'Oge secilmedi.');

    if (req.body.islem === 'cikar') {
      await arsiv.vakaOgeCikar(id, req.body.oge_tur, ogeId);
      return geriDon(res, `/arsiv/vaka/${id}`, 'Oge vakadan cikarildi.');
    }
    await arsiv.vakaOgeEkle(id, req.body.oge_tur, ogeId, { notMetni: req.body.not_metni });
    geriDon(res, `/arsiv/vaka/${id}`, 'Oge vakaya eklendi.');
  } catch (hata) { next(hata); }
});

// =============================================================== KAYNAKLAR

yonlendirici.get('/arsiv/kaynaklar', async (req, res, next) => {
  try {
    const kaynaklar = await arsiv.kaynakListele({ aktif: req.query.aktif ?? null, limit: 200 });
    res.render('arsiv/kaynaklar', {
      baslik: 'KAYNAKLAR',
      rota: '/arsiv/kaynaklar',
      betikler: ['/js/arsiv.js'],
      kaynaklar, sorgu: req.query,
      ...ortakVeri(),
    });
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/kaynak', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const sonuc = await arsiv.kaynakOlustur(req.body, istek(req));
    geriDon(res, '/arsiv/kaynaklar', sonuc.tamam ? `${sonuc.kaynak.kod} eklendi.` : null, sonuc.hata);
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/kaynak/:id', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const sonuc = await arsiv.kaynakGuncelle(kimlik(req.params.id), req.body, istek(req));
    geriDon(res, '/arsiv/kaynaklar', sonuc.tamam ? 'Kaynak guncellendi.' : null, sonuc.hata);
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/kaynak/:id/sil', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    await arsiv.kaynakSil(kimlik(req.params.id), istek(req));
    geriDon(res, '/arsiv/kaynaklar', 'Kaynak kaldirildi.');
  } catch (hata) { next(hata); }
});

// ================================================================ IZLEME

yonlendirici.get('/arsiv/izleme', async (req, res, next) => {
  try {
    const [kurallar, uyarilar, varliklar] = await Promise.all([
      uyariService.kurallariListele({}),
      uyariService.uyarilariListele({ okundu: req.query.okundu ?? null, limit: 120 }),
      arsiv.varlikListele({ limit: 100, sirala: 'onem' }),
    ]);

    res.render('arsiv/izleme', {
      baslik: 'IZLEME VE UYARILAR',
      rota: '/arsiv/izleme',
      betikler: ['/js/arsiv.js'],
      kurallar, uyarilar, varliklar: varliklar.varliklar,
      seviyeler: uyariService.SEVIYELER,
      kapsamlar: uyariService.KAPSAMLAR,
      sorgu: req.query,
      ...ortakVeri(),
    });
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/izleme', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const sonuc = await uyariService.kuralOlustur(req.body, istek(req));
    geriDon(res, '/arsiv/izleme', sonuc.tamam ? 'Izleme kurali eklendi.' : null, sonuc.hata);
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/izleme/:id', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const sonuc = await uyariService.kuralGuncelle(kimlik(req.params.id), req.body, istek(req));
    geriDon(res, '/arsiv/izleme', sonuc.tamam ? 'Kural guncellendi.' : null, sonuc.hata);
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/izleme/:id/sil', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    await uyariService.kuralSil(kimlik(req.params.id));
    geriDon(res, '/arsiv/izleme', 'Kural kaldirildi.');
  } catch (hata) { next(hata); }
});

/** Yeni kurali gecmise uygula. */
yonlendirici.post('/arsiv/izleme/:id/tara', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const sayim = await uyariService.gecmisiTara({ kuralId: kimlik(req.params.id), limit: 1000 });
    geriDon(res, '/arsiv/izleme',
      `Gecmis tarandi: ${sayim.kayit} kayit, ${sayim.olay} olay, ${sayim.belge} belge — ${sayim.uyari} uyari uretildi.`);
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/uyari/:id/okundu', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    await uyariService.uyariOkundu(kimlik(req.params.id));
    geriDon(res, req.body.geri || '/arsiv/izleme', 'Uyari okundu olarak isaretlendi.');
  } catch (hata) { next(hata); }
});

yonlendirici.post('/arsiv/uyari/tumu-okundu', yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const sonuc = await uyariService.tumunuOkundu();
    geriDon(res, req.body.geri || '/arsiv/izleme', `${sonuc.sayi} uyari okundu olarak isaretlendi.`);
  } catch (hata) { next(hata); }
});

// ================================================================ DENETIM

yonlendirici.get('/arsiv/denetim', async (req, res, next) => {
  try {
    const kayitlar = await arsiv.denetimListele({
      ogeTur: req.query.tur || null,
      ogeId: kimlik(req.query.oge),
      limit: 200,
    });
    res.render('arsiv/denetim', {
      baslik: 'DENETIM IZI',
      rota: '/arsiv/denetim',
      betikler: ['/js/arsiv.js'],
      kayitlar, sorgu: req.query,
      ...ortakVeri(),
    });
  } catch (hata) { next(hata); }
});

module.exports = yonlendirici;
