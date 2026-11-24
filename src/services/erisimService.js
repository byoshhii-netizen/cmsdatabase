'use strict';
/**
 * src/services/erisimService.js
 * Disa acik paylasim baglantilarina (klasor/dosya/belge) yapilan dis
 * erisimlerin detayli izlenmesi. /loglar sayfasindaki "DIS ERISIM IZLERI"
 * istihbarat tablosunun veri kaynagidir.
 */

const db = require('../config/db');
const uaAyristir = require('../utils/uaAyristir');
const log = require('./logService');

const EYLEMLER = ['goruntuleme', 'indirme', 'sifre_hatasi', 'reddedildi'];

/**
 * Bir disa acik erisim olayini kaydeder: IP, ayristirilmis User-Agent,
 * hangi link/dosya/belgeye erisildigi.
 */
async function kaydet({ linkId, dosyaId = null, belgeId = null, req, eylem = 'goruntuleme' }) {
  const ua = uaAyristir.ayristir(req ? req.get('user-agent') : '');
  try {
    await db.sorgu(
      `INSERT INTO paylasim_erisimleri
         (link_id, dosya_id, belge_id, ip, user_agent, referans, eylem, tarayici, isletim_sistemi, cihaz_tipi)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        linkId, dosyaId, belgeId,
        log.ipCikar(req),
        ua.ham,
        req ? String(req.get('referer') || '').slice(0, 300) || null : null,
        EYLEMLER.includes(eylem) ? eylem : 'goruntuleme',
        ua.tarayici, ua.isletimSistemi, ua.cihazTipi,
      ],
    );
    if (dosyaId && eylem === 'goruntuleme') {
      await db.sorgu('UPDATE dosyalar SET goruntuleme_sayisi = goruntuleme_sayisi + 1 WHERE id = $1', [dosyaId]);
    }
    if (dosyaId && eylem === 'indirme') {
      await db.sorgu('UPDATE dosyalar SET indirme_sayisi = indirme_sayisi + 1 WHERE id = $1', [dosyaId]);
    }
  } catch (hata) {
    console.error('[ERISIM] Kaydedilemedi:', hata.message);
  }
}

/**
 * Filtrelenebilir, sayfalanmis dis erisim izi listesi.
 * Her satir: hangi baglanti/hedef, IP, cihaz/tarayici, zaman, eylem.
 */
async function listele({ linkId, dosyaId, eylem, cihazTipi, arama, limit = 50, ofset = 0 } = {}) {
  const kosullar = [];
  const parametreler = [];
  let i = 1;

  if (linkId)   { kosullar.push(`e.link_id = $${i++}`); parametreler.push(linkId); }
  if (dosyaId)  { kosullar.push(`e.dosya_id = $${i++}`); parametreler.push(dosyaId); }
  if (eylem && EYLEMLER.includes(eylem)) { kosullar.push(`e.eylem = $${i++}`); parametreler.push(eylem); }
  if (cihazTipi) { kosullar.push(`e.cihaz_tipi = $${i++}`); parametreler.push(cihazTipi); }
  if (arama) {
    kosullar.push(`(p.baslik ILIKE $${i} OR p.hedef_adi ILIKE $${i} OR d.ad ILIKE $${i} OR e.ip::text ILIKE $${i})`);
    parametreler.push(`%${String(arama).slice(0, 80)}%`);
    i++;
  }

  const nerede = kosullar.length ? `WHERE ${kosullar.join(' AND ')}` : '';
  const sinir = Math.min(Math.max(Number(limit) || 50, 1), 300);
  const atla = Math.max(Number(ofset) || 0, 0);

  const satirlar = await db.satirlar(
    `SELECT e.id, e.link_id, e.dosya_id, e.belge_id, e.ip, e.eylem,
            e.tarayici, e.isletim_sistemi, e.cihaz_tipi, e.olusturuldu_at,
            p.baslik AS link_baslik, p.hedef_adi AS link_hedef, p.token AS link_token,
            d.ad AS dosya_adi, b.baslik AS belge_baslik
       FROM paylasim_erisimleri e
       JOIN paylasim_linkleri p ON p.id = e.link_id
       LEFT JOIN dosyalar d ON d.id = e.dosya_id
       LEFT JOIN belgeler b ON b.id = e.belge_id
       ${nerede}
       ORDER BY e.olusturuldu_at DESC
       LIMIT $${i++} OFFSET $${i}`,
    [...parametreler, sinir, atla],
  );

  const sayim = await db.tekSatir(
    `SELECT COUNT(*)::int AS adet
       FROM paylasim_erisimleri e
       JOIN paylasim_linkleri p ON p.id = e.link_id
       LEFT JOIN dosyalar d ON d.id = e.dosya_id
       LEFT JOIN belgeler b ON b.id = e.belge_id
       ${nerede}`,
    parametreler,
  );

  return { kayitlar: satirlar, toplam: sayim ? sayim.adet : 0, limit: sinir, ofset: atla };
}

/** Ozet: toplam erisim, benzersiz IP, en cok erisilen hedefler. */
async function ozet() {
  const genel = await db.tekSatir(`
    SELECT
      (SELECT COUNT(*)::int FROM paylasim_erisimleri)                                         AS toplam_erisim,
      (SELECT COUNT(DISTINCT ip)::int FROM paylasim_erisimleri)                                AS benzersiz_ip,
      (SELECT COUNT(*)::int FROM paylasim_erisimleri WHERE olusturuldu_at > NOW() - INTERVAL '24 hours') AS son_24_saat,
      (SELECT COUNT(*)::int FROM paylasim_erisimleri WHERE eylem = 'indirme')                  AS toplam_indirme,
      (SELECT COUNT(*)::int FROM paylasim_erisimleri WHERE eylem = 'sifre_hatasi')             AS sifre_hatasi
  `);

  const enCokGorulen = await db.satirlar(`
    SELECT p.id AS link_id, p.baslik, p.hedef_adi, p.token, COUNT(e.id)::int AS erisim_sayisi
      FROM paylasim_linkleri p
      JOIN paylasim_erisimleri e ON e.link_id = p.id
     GROUP BY p.id, p.baslik, p.hedef_adi, p.token
     ORDER BY erisim_sayisi DESC
     LIMIT 5
  `);

  // En cok goruntulenen/indirilen dosyalar (dis erisim sayaclarina gore).
  const enCokGorulenDosya = await db.satirlar(`
    SELECT id, ad, mime_turu, goruntuleme_sayisi, indirme_sayisi,
           (goruntuleme_sayisi + indirme_sayisi) AS toplam
      FROM dosyalar
     WHERE silindi = FALSE AND (goruntuleme_sayisi > 0 OR indirme_sayisi > 0)
     ORDER BY toplam DESC
     LIMIT 5
  `);

  return { ...genel, enCokGorulen, enCokGorulenDosya };
}

module.exports = { kaydet, listele, ozet, EYLEMLER };
