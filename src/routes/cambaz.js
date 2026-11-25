'use strict';
/**
 * src/routes/cambaz.js   ->  /cambaz
 * Jarvis tarzi yapay zeka ajani: metin + sesli sohbet, kalici hafiza,
 * cevrimici (API anahtarli) / cevrimdisi (dahili motor) yanit, TTS.
 */

const express = require('express');
const cambazService = require('../services/cambazService');
const zekaService = require('../services/zekaService');
const sesServisi = require('../services/sesServisi');
const ayarService = require('../services/ayarService');
const { girisGerekli, jsonIster } = require('../middleware/auth');
const { onbellekYok } = require('../middleware/security');
const { csrfKoru } = require('../middleware/csrf');
const { yazmaSiniri } = require('../middleware/rateLimit');
const dogrula = require('../utils/validate');

const yonlendirici = express.Router();

// ------------------------------------------------------------- GET /cambaz
yonlendirici.get('/cambaz', onbellekYok, girisGerekli, async (req, res, next) => {
  try {
    const [oturumlar, hafiza, saglayici, model, aramaSaglayici, sesTuru, sesAd, sesHiz, sesPerde, sesOrnegi] = await Promise.all([
      cambazService.oturumlariListele(),
      cambazService.hafizaListele(),
      ayarService.ayarAl('cambaz_saglayici', 'anthropic'),
      ayarService.ayarAl('cambaz_model', 'claude-sonnet-4-5'),
      ayarService.ayarAl('cambaz_arama_saglayici', 'tavily'),
      ayarService.ayarAl('cambaz_ses_turu', 'tarayici'),
      ayarService.ayarAl('cambaz_ses_ad', ''),
      ayarService.ayarAl('cambaz_ses_hiz', '1'),
      ayarService.ayarAl('cambaz_ses_perde', '1'),
      sesServisi.sesOrnekBilgisi(),
    ]);

    const [motor, zekaDurum] = await Promise.all([
      ayarService.ayarAl('zeka_motor', 'dahili'),
      zekaService.durum().catch(() => null),
    ]);

    const sohbetAnahtari = await ayarService.apiAnahtarCoz(saglayici);
    const aramaAnahtari = await ayarService.apiAnahtarCoz(aramaSaglayici);
    const openaiTtsAnahtari = await ayarService.apiAnahtarCoz('openai');
    const elevenlabsAnahtari = await ayarService.apiAnahtarCoz('elevenlabs');

    let aktifOturum = null;
    let mesajlar = [];
    if (oturumlar.length > 0) {
      aktifOturum = oturumlar[0];
      mesajlar = await cambazService.mesajlariGetir(aktifOturum.id);
    }

    res.render('cambaz', {
      baslik: 'CAMBAZ AJANI',
      rota: '/cambaz',
      tamEkran: true,
      oturumlar,
      hafiza,
      aktifOturum,
      mesajlar,
      saglayici,
      model,
      motor,
      zekaDurum,
      anahtarVar: Boolean(sohbetAnahtari),
      aramaVar: Boolean(aramaAnahtari),
      sunucuSesVar: Boolean(openaiTtsAnahtari || elevenlabsAnahtari),
      sesAyarlari: { tur: sesTuru, ad: sesAd, hiz: sesHiz, perde: sesPerde },
      sesOrnegi,
    });
  } catch (hata) { next(hata); }
});

// -------------------------------------------------------- POST /cambaz/oturum
yonlendirici.post('/cambaz/oturum', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const saglayici = await ayarService.ayarAl('cambaz_saglayici', 'anthropic');
    const model = await ayarService.ayarAl('cambaz_model', null);
    const oturum = await cambazService.oturumOlustur({
      baslik: req.body.baslik, saglayici, model, yoneticiId: req.yonetici.id,
    });
    return res.json({ tamam: true, oturum });
  } catch (hata) { next(hata); }
});

// ----------------------------------------------- GET /cambaz/oturum/:id/mesajlar
yonlendirici.get('/cambaz/oturum/:id/mesajlar', onbellekYok, girisGerekli, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return res.status(400).json({ tamam: false, hata: 'Gecersiz kimlik.' });
    const oturum = await cambazService.oturumGetir(id);
    if (!oturum) return res.status(404).json({ tamam: false, hata: 'Gorusme bulunamadi.' });
    const mesajlar = await cambazService.mesajlariGetir(id);
    return res.json({ tamam: true, oturum, mesajlar });
  } catch (hata) { next(hata); }
});

// -------------------------------------------------- POST /cambaz/oturum/:id/mesaj
yonlendirici.post('/cambaz/oturum/:id/mesaj', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return res.status(400).json({ tamam: false, hata: 'Gecersiz kimlik.' });

    const sonuc = await cambazService.mesajGonder({
      oturumId: id,
      metin: req.body.metin,
      sesli: req.body.sesli === true,
      yoneticiId: req.yonetici.id,
    });

    if (!sonuc.tamam) {
      return res.status(sonuc.kod === 'YOK' ? 404 : 400).json(sonuc);
    }
    return res.json(sonuc);
  } catch (hata) { next(hata); }
});

// ----------------------------------------------------- POST /cambaz/oturum/:id/sil
yonlendirici.post('/cambaz/oturum/:id/sil', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return res.status(400).json({ tamam: false, hata: 'Gecersiz kimlik.' });
    const silindi = await cambazService.oturumSil(id);
    if (jsonIster(req)) return res.json({ tamam: silindi });
    return res.redirect(303, '/cambaz');
  } catch (hata) { next(hata); }
});

// -------------------------------------------------------------- HAFIZA CRUD
yonlendirici.post('/cambaz/hafiza', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const sonuc = await cambazService.hafizaEkle({
      baslik: req.body.baslik, icerik: req.body.icerik, kaynak: 'manuel', yoneticiId: req.yonetici.id,
    });
    return res.status(sonuc.tamam ? 200 : 400).json(sonuc);
  } catch (hata) { next(hata); }
});

yonlendirici.post('/cambaz/hafiza/:id', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return res.status(400).json({ tamam: false, hata: 'Gecersiz kimlik.' });
    const sonuc = await cambazService.hafizaGuncelle(id, { baslik: req.body.baslik, icerik: req.body.icerik });
    return res.status(sonuc.tamam ? 200 : 400).json(sonuc);
  } catch (hata) { next(hata); }
});

yonlendirici.post('/cambaz/hafiza/:id/sil', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const id = dogrula.kimlik(req.params.id);
    if (!id) return res.status(400).json({ tamam: false, hata: 'Gecersiz kimlik.' });
    const silindi = await cambazService.hafizaSil(id);
    return res.json({ tamam: silindi });
  } catch (hata) { next(hata); }
});

// ---------------------------------------------------------------- POST /cambaz/ses
// Metinden ses uretir (sunucu tarafi TTS yapilandirilmissa). Yapilandirilmamissa
// istemciye "TARAYICI" kodu doner; istemci o zaman Web Speech API kullanir.
yonlendirici.post('/cambaz/ses', onbellekYok, girisGerekli, yazmaSiniri, csrfKoru, async (req, res, next) => {
  try {
    const metin = dogrula.metin(req.body.metin, { max: 2000 });
    if (!metin) return res.status(400).json({ tamam: false, hata: 'Bos metin.' });

    const [elevenlabsKey, openaiKey, sesAd] = await Promise.all([
      ayarService.apiAnahtarCoz('elevenlabs'),
      ayarService.apiAnahtarCoz('openai'),
      ayarService.ayarAl('cambaz_ses_ad', ''),
    ]);

    const sonuc = await sesServisi.sentezle({ metin, elevenlabsApiKey: elevenlabsKey, openaiApiKey: openaiKey, sesAdi: sesAd });
    if (!sonuc.tamam) return res.status(200).json({ tamam: false, kod: sonuc.kod || 'TARAYICI', hata: sonuc.hata });

    res.set('Content-Type', sonuc.mime || 'audio/mpeg');
    res.set('Cache-Control', 'no-store');
    return res.send(sonuc.tampon);
  } catch (hata) { next(hata); }
});

module.exports = yonlendirici;
