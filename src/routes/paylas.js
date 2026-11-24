'use strict';
/**
 * src/routes/paylas.js   ->  /paylas/:token
 * Disa acilan klasorlerin herkese acik ama KONTROLLU gorunumu.
 *
 * Kontroller:
 *  - token bicimi dogrulanir (base64url, 20-64 karakter)
 *  - link aktif mi, suresi gecmis mi, goruntuleme kotasi dolmus mu
 *  - opsiyonel link sifresi (argon2id) -> oturumda dogrulanmis token listesi
 *  - HER erisim (klasor acilisi, dosya goruntuleme/indirme, belge okuma)
 *    IP + ayristirilmis User-Agent (tarayici/isletim sistemi/cihaz turu)
 *    ile paylasim_erisimleri tablosuna yazilir -> /loglar "DIS ERISIM
 *    IZLERI" panelinin veri kaynagidir.
 *  - arama motorlarina kapali (X-Robots-Tag: noindex)
 */

const express = require('express');
const db = require('../config/db');
const kripto = require('../utils/crypto');
const dogrula = require('../utils/validate');
const log = require('../services/logService');
const erisimService = require('../services/erisimService');
const dosyaService = require('../services/dosyaService');
const { paylasimSiniri } = require('../middleware/rateLimit');
const { csrfKoru } = require('../middleware/csrf');

const yonlendirici = express.Router();

/** Arama motoru indekslemesini kapat. */
function robotYok(req, res, next) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Cache-Control', 'no-store, private');
  next();
}

/** Token'dan gecerli linki bulur; gecersizse sebebi doner. */
async function linkCoz(token) {
  const satir = await db.tekSatir(
    `SELECT id, token, tur, klasor_id, dosya_id, pano_id, baslik, hedef_adi, sifre_hash,
            indirmeye_izin, son_kullanma_at, max_goruntuleme, goruntuleme_sayisi, aktif
       FROM paylasim_linkleri
      WHERE token = $1`,
    [token],
  );

  if (!satir) return { tamam: false, kod: 'YOK', mesaj: 'Bu baglanti gecersiz veya kaldirilmis.' };
  if (!satir.aktif) return { tamam: false, kod: 'KAPALI', mesaj: 'Bu baglanti yonetici tarafindan kapatilmis.' };
  if (satir.son_kullanma_at && new Date(satir.son_kullanma_at) < new Date()) {
    return { tamam: false, kod: 'SURE', mesaj: 'Bu baglantinin suresi dolmus.' };
  }
  if (satir.max_goruntuleme && satir.goruntuleme_sayisi >= satir.max_goruntuleme) {
    return { tamam: false, kod: 'KOTA', mesaj: 'Bu baglanti icin goruntuleme kotasi dolmus.' };
  }
  return { tamam: true, link: satir };
}

/** Oturumda bu token icin sifre dogrulanmis mi? */
function sifreOnayli(req, token) {
  const liste = (req.session && req.session.paylasimOnay) || [];
  return liste.includes(token);
}

/** Verilen dosya/belge gercekten bu linkin kapsamindaki klasore mi ait? */
async function kapsamdaMi(link, { dosyaId, belgeId }) {
  if (link.tur === 'dosya' && dosyaId) return Number(link.dosya_id) === Number(dosyaId);
  if (link.tur !== 'klasor' || !link.klasor_id) return false;

  if (dosyaId) {
    const satir = await db.tekSatir(
      'SELECT 1 FROM dosyalar WHERE id = $1 AND klasor_id = $2 AND silindi = FALSE',
      [dosyaId, link.klasor_id],
    );
    return Boolean(satir);
  }
  if (belgeId) {
    const satir = await db.tekSatir(
      'SELECT 1 FROM belgeler WHERE id = $1 AND klasor_id = $2 AND silindi = FALSE',
      [belgeId, link.klasor_id],
    );
    return Boolean(satir);
  }
  return false;
}

// ------------------------------------------------------- GET /paylas/:token
yonlendirici.get('/paylas/:token', robotYok, paylasimSiniri, async (req, res, next) => {
  try {
    const token = dogrula.paylasimToken(req.params.token);
    if (!token) {
      return res.status(404).render('paylas', {
        baslik: 'BAGLANTI GECERSIZ', rota: '/paylas', durum: 'gecersiz',
        mesaj: 'Baglanti bicimi tanimlanamadi.',
        link: null, klasorler: [], dosyalar: [], belgeler: [], token: '',
      });
    }

    const cozum = await linkCoz(token);
    if (!cozum.tamam) {
      if (cozum.link) await erisimService.kaydet({ linkId: cozum.link.id, req, eylem: 'reddedildi' });
      return res.status(cozum.kod === 'YOK' ? 404 : 410).render('paylas', {
        baslik: 'BAGLANTI KAPALI', rota: '/paylas', durum: 'gecersiz',
        mesaj: cozum.mesaj, link: null, klasorler: [], dosyalar: [], belgeler: [], token,
      });
    }

    const link = cozum.link;

    // Sifre korumali ve henuz onaylanmamis -> sifre ekrani
    if (link.sifre_hash && !sifreOnayli(req, token)) {
      return res.render('paylas', {
        baslik: 'KORUMALI BAGLANTI', rota: '/paylas', durum: 'sifre',
        mesaj: null, link: { baslik: link.baslik, tur: link.tur },
        klasorler: [], dosyalar: [], belgeler: [], token,
      });
    }

    // Icerigi getir
    let klasorler = [];
    let dosyalar = [];
    let belgeler = [];

    if (link.tur === 'klasor' && link.klasor_id) {
      klasorler = await db.satirlar(
        `SELECT id, ad, aciklama, renk FROM klasorler
          WHERE ebeveyn_id = $1 AND silindi = FALSE AND kilitli = FALSE
          ORDER BY siralama, ad`,
        [link.klasor_id],
      );
      dosyalar = await db.satirlar(
        `SELECT id, ad, mime_turu, boyut_bayt, goruntuleme_sayisi, indirme_sayisi, olusturuldu_at
           FROM dosyalar WHERE klasor_id = $1 AND silindi = FALSE
          ORDER BY ad LIMIT 500`,
        [link.klasor_id],
      );
      belgeler = await db.satirlar(
        `SELECT id, baslik, imza, butunluk_hash, olusturuldu_at FROM belgeler
          WHERE klasor_id = $1 AND silindi = FALSE
          ORDER BY baslik LIMIT 200`,
        [link.klasor_id],
      );
    } else if (link.tur === 'dosya' && link.dosya_id) {
      dosyalar = await db.satirlar(
        `SELECT id, ad, mime_turu, boyut_bayt, goruntuleme_sayisi, indirme_sayisi, olusturuldu_at
           FROM dosyalar WHERE id = $1 AND silindi = FALSE`,
        [link.dosya_id],
      );
    }

    await db.sorgu('UPDATE paylasim_linkleri SET goruntuleme_sayisi = goruntuleme_sayisi + 1 WHERE id = $1', [link.id]);
    await erisimService.kaydet({ linkId: link.id, req, eylem: 'goruntuleme' });

    res.render('paylas', {
      baslik: link.baslik || link.hedef_adi || 'PAYLASILAN SEKTOR',
      rota: '/paylas',
      durum: 'acik',
      mesaj: null,
      link: {
        id: link.id, baslik: link.baslik, tur: link.tur,
        indirmeyeIzin: link.indirmeye_izin, sonKullanma: link.son_kullanma_at,
      },
      klasorler, dosyalar, belgeler, token,
    });
  } catch (hata) { next(hata); }
});

// ------------------------------------------------ POST /paylas/:token/sifre
yonlendirici.post('/paylas/:token/sifre', robotYok, paylasimSiniri, csrfKoru, async (req, res, next) => {
  try {
    const token = dogrula.paylasimToken(req.params.token);
    if (!token) return res.status(404).redirect('/paylas/gecersiz');

    const cozum = await linkCoz(token);
    if (!cozum.tamam) {
      return res.status(410).render('paylas', {
        baslik: 'BAGLANTI KAPALI', rota: '/paylas', durum: 'gecersiz',
        mesaj: cozum.mesaj, link: null, klasorler: [], dosyalar: [], belgeler: [], token,
      });
    }

    const link = cozum.link;
    const uygun = link.sifre_hash
      ? await kripto.sifreDogrula(link.sifre_hash, String(req.body.sifre || ''))
      : true;

    if (!uygun) {
      await erisimService.kaydet({ linkId: link.id, req, eylem: 'sifre_hatasi' });
      await log.uyari({
        kategori: 'paylasim', olay: 'paylasim_sifre_hatasi',
        mesaj: 'Paylasim linki icin hatali sifre.', req, meta: { link_id: link.id },
      });
      return res.status(401).render('paylas', {
        baslik: 'KORUMALI BAGLANTI', rota: '/paylas', durum: 'sifre',
        mesaj: 'Sifre hatali.', link: { baslik: link.baslik, tur: link.tur },
        klasorler: [], dosyalar: [], belgeler: [], token,
      });
    }

    if (!req.session.paylasimOnay) req.session.paylasimOnay = [];
    if (!req.session.paylasimOnay.includes(token)) {
      // En fazla 20 onay tut (oturum sismesini engelle)
      req.session.paylasimOnay = [...req.session.paylasimOnay.slice(-19), token];
    }

    return res.redirect(303, `/paylas/${encodeURIComponent(token)}`);
  } catch (hata) { next(hata); }
});

/**
 * Paylasim baglantisini dogrular ve kapsam kontrolu yapar. Basarisizsa
 * uygun HTTP durumunu yazip null doner; cagiran fonksiyon `return` etmelidir.
 */
async function baglantiVeKapsamDogrula(req, res, { dosyaId, belgeId } = {}) {
  const token = dogrula.paylasimToken(req.params.token);
  if (!token) { res.status(404).end(); return null; }

  const cozum = await linkCoz(token);
  if (!cozum.tamam) { res.status(cozum.kod === 'YOK' ? 404 : 410).end(); return null; }

  const link = cozum.link;
  if (link.sifre_hash && !sifreOnayli(req, token)) { res.status(401).end(); return null; }

  if (!(await kapsamdaMi(link, { dosyaId, belgeId }))) {
    res.status(404).end();
    return null;
  }
  return link;
}

// --------------------------------------------- GET /paylas/:token/dosya/:id
yonlendirici.get('/paylas/:token/dosya/:id/goruntule', robotYok, paylasimSiniri, async (req, res, next) => {
  try {
    const dosyaId = dogrula.kimlik(req.params.id);
    if (!dosyaId) return res.status(400).end();

    const link = await baglantiVeKapsamDogrula(req, res, { dosyaId });
    if (!link) return;

    const dosya = await dosyaService.getir(dosyaId);
    if (!dosya) return res.status(404).end();

    const arabellek = await dosyaService.coz(dosya);
    await erisimService.kaydet({ linkId: link.id, dosyaId, req, eylem: 'goruntuleme' });
    return dosyaService.akisGonder(res, req, dosya, arabellek, { indir: false });
  } catch (hata) { next(hata); }
});

yonlendirici.get('/paylas/:token/dosya/:id/indir', robotYok, paylasimSiniri, async (req, res, next) => {
  try {
    const dosyaId = dogrula.kimlik(req.params.id);
    if (!dosyaId) return res.status(400).end();

    const link = await baglantiVeKapsamDogrula(req, res, { dosyaId });
    if (!link) return;
    if (!link.indirmeye_izin) {
      await erisimService.kaydet({ linkId: link.id, dosyaId, req, eylem: 'reddedildi' });
      return res.status(403).render('hata/genel', {
        baslik: 'INDIRME KAPALI', kod: 403,
        mesaj: 'Bu baglanti icin yalnizca goruntuleme izni verilmis; indirme kapali.',
        rota: req.path,
      });
    }

    const dosya = await dosyaService.getir(dosyaId);
    if (!dosya) return res.status(404).end();

    const arabellek = await dosyaService.coz(dosya);
    await erisimService.kaydet({ linkId: link.id, dosyaId, req, eylem: 'indirme' });
    return dosyaService.akisGonder(res, req, dosya, arabellek, { indir: true });
  } catch (hata) { next(hata); }
});

// -------------------------------------------- GET /paylas/:token/belge/:id
yonlendirici.get('/paylas/:token/belge/:id', robotYok, paylasimSiniri, async (req, res, next) => {
  try {
    const belgeId = dogrula.kimlik(req.params.id);
    if (!belgeId) return res.status(400).end();

    const link = await baglantiVeKapsamDogrula(req, res, { belgeId });
    if (!link) return;

    const belge = await db.tekSatir(
      `SELECT id, baslik, icerik, imza, butunluk_hash, olusturuldu_at
         FROM belgeler WHERE id = $1 AND silindi = FALSE`,
      [belgeId],
    );
    if (!belge) return res.status(404).end();

    await erisimService.kaydet({ linkId: link.id, belgeId, req, eylem: 'goruntuleme' });

    return res.render('paylas', {
      baslik: belge.baslik, rota: '/paylas', durum: 'belge',
      mesaj: null, link: { baslik: link.baslik, tur: link.tur },
      klasorler: [], dosyalar: [], belgeler: [], belge, token: req.params.token,
    });
  } catch (hata) { next(hata); }
});

module.exports = yonlendirici;
