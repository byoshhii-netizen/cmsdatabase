'use strict';
/**
 * src/services/logService.js
 * Merkezi kayit servisi (/loglar modulunun veri kaynagi).
 * Log yazimi asla istek akisini kesmez: hata olursa yalnizca konsola dusulur.
 */

const db = require('../config/db');

const SEVIYELER = ['izleme', 'bilgi', 'uyari', 'hata', 'kritik'];
const KATEGORILER = ['sistem', 'kimlik', 'depo', 'pano', 'cambaz', 'paylasim', 'ayarlar', 'guvenlik'];

/** Istekten IP'yi guvenli sekilde cikarir (INET sutunu icin). */
function ipCikar(req) {
  if (!req) return null;
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || null;
  if (!ip) return null;
  // "::ffff:1.2.3.4" -> "1.2.3.4"
  return ip.replace(/^::ffff:/, '');
}

/**
 * Log kaydi yazar.
 * @param {object} kayit
 */
async function yaz(kayit = {}) {
  const {
    seviye = 'bilgi',
    kategori = 'sistem',
    olay = 'bilinmeyen',
    mesaj = null,
    yoneticiId = null,
    req = null,
    durumKodu = null,
    sureMs = null,
    meta = {},
  } = kayit;

  try {
    await db.sorgu(
      `INSERT INTO loglar
         (seviye, kategori, olay, mesaj, yonetici_id, rota, metot, durum_kodu, ip, user_agent, sure_ms, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        SEVIYELER.includes(seviye) ? seviye : 'bilgi',
        KATEGORILER.includes(kategori) ? kategori : 'sistem',
        String(olay).slice(0, 120),
        mesaj ? String(mesaj).slice(0, 2000) : null,
        yoneticiId,
        req ? String(req.originalUrl || req.path).slice(0, 300) : null,
        req ? req.method : null,
        durumKodu,
        ipCikar(req),
        req ? String(req.get('user-agent') || '').slice(0, 400) : null,
        sureMs,
        JSON.stringify(meta || {}),
      ],
    );
  } catch (hata) {
    console.error('[LOG] Yazilamadi:', hata.message, '|', olay);
  }
}

/** Kisayollar */
const bilgi  = (o) => yaz({ ...o, seviye: 'bilgi' });
const uyari  = (o) => yaz({ ...o, seviye: 'uyari' });
const hata   = (o) => yaz({ ...o, seviye: 'hata' });
const kritik = (o) => yaz({ ...o, seviye: 'kritik' });

/**
 * Loglari filtreli listeler (sayfalama ile).
 */
async function listele({ seviye, kategori, arama, limit = 100, ofset = 0 } = {}) {
  const kosullar = [];
  const parametreler = [];
  let i = 1;

  if (seviye && SEVIYELER.includes(seviye)) { kosullar.push(`seviye = $${i++}`); parametreler.push(seviye); }
  if (kategori && KATEGORILER.includes(kategori)) { kosullar.push(`kategori = $${i++}`); parametreler.push(kategori); }
  if (arama) {
    kosullar.push(`(olay ILIKE $${i} OR mesaj ILIKE $${i} OR rota ILIKE $${i})`);
    parametreler.push(`%${String(arama).slice(0, 80)}%`);
    i++;
  }

  const nerede = kosullar.length ? `WHERE ${kosullar.join(' AND ')}` : '';
  const sinir = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const atla = Math.max(Number(ofset) || 0, 0);

  parametreler.push(sinir, atla);

  const satirlar = await db.satirlar(
    `SELECT l.*, y.kullanici_adi
       FROM loglar l
       LEFT JOIN yoneticiler y ON y.id = l.yonetici_id
       ${nerede}
       ORDER BY l.olusturuldu_at DESC
       LIMIT $${i++} OFFSET $${i}`,
    parametreler,
  );

  const sayim = await db.tekSatir(
    `SELECT COUNT(*)::int AS adet FROM loglar ${nerede}`,
    parametreler.slice(0, parametreler.length - 2),
  );

  return { kayitlar: satirlar, toplam: sayim ? sayim.adet : 0, limit: sinir, ofset: atla };
}

/** Ozet istatistikler (/merkez paneli icin). */
async function ozet() {
  return db.tekSatir(`
    SELECT
      (SELECT COUNT(*)::int FROM loglar)                                            AS toplam_log,
      (SELECT COUNT(*)::int FROM loglar WHERE seviye IN ('hata','kritik'))          AS hata_sayisi,
      (SELECT COUNT(*)::int FROM loglar WHERE olusturuldu_at > NOW() - INTERVAL '24 hours') AS gunluk,
      (SELECT COUNT(*)::int FROM giris_denemeleri WHERE basarili = FALSE
         AND olusturuldu_at > NOW() - INTERVAL '24 hours')                          AS basarisiz_giris,
      (SELECT COUNT(*)::int FROM ip_kilitleri WHERE kilit_bitis_at > NOW())         AS aktif_kilit
  `);
}

/** Saklama suresini gecen loglari siler. */
async function budama(gun = 90) {
  const g = Math.min(Math.max(Number(gun) || 90, 1), 3650);
  const sonuc = await db.sorgu(
    `DELETE FROM loglar WHERE olusturuldu_at < NOW() - ($1 || ' days')::interval`,
    [String(g)],
  );
  return sonuc.rowCount;
}

module.exports = { yaz, bilgi, uyari, hata, kritik, listele, ozet, budama, ipCikar, SEVIYELER, KATEGORILER };
