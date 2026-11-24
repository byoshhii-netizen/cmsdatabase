'use strict';
/**
 * src/services/kilitService.js
 * Veritabani destekli kademeli brute-force kilidi.
 *
 * Politika (.env ile ayarlanabilir):
 *   BF_ESIK (5) basarisiz deneme        -> BF_KILIT_DAKIKA (5 dk) kilit
 *   BF_AGIR_ESIK (10) basarisiz deneme  -> BF_AGIR_KILIT_DAKIKA (60 dk) kilit
 * Basarili giris sayaci sifirlar.
 */

const db = require('../config/db');
const ayar = require('../config/env');

/**
 * IP su anda kilitli mi?
 * @returns {{kilitli:boolean, kalanSaniye:number, basarisizSayi:number}}
 */
async function durum(ip) {
  if (!ip) return { kilitli: false, kalanSaniye: 0, basarisizSayi: 0 };

  const satir = await db.tekSatir(
    `SELECT basarisiz_sayi,
            kilit_bitis_at,
            GREATEST(0, CEIL(EXTRACT(EPOCH FROM (kilit_bitis_at - NOW()))))::int AS kalan
       FROM ip_kilitleri
      WHERE ip = $1`,
    [ip],
  );

  if (!satir) return { kilitli: false, kalanSaniye: 0, basarisizSayi: 0 };

  const kalan = satir.kalan || 0;
  return {
    kilitli: Boolean(satir.kilit_bitis_at) && kalan > 0,
    kalanSaniye: kalan,
    basarisizSayi: satir.basarisiz_sayi || 0,
  };
}

/**
 * Basarisiz denemeyi kaydeder ve gerekirse kilit uygular.
 * @returns {{kilitli:boolean, kalanSaniye:number, basarisizSayi:number, kalanDeneme:number}}
 */
async function basarisizKaydet(ip, kullaniciAdi, userAgent, sebep = 'hatali_kimlik') {
  if (!ip) return { kilitli: false, kalanSaniye: 0, basarisizSayi: 0, kalanDeneme: ayar.bruteForce.esik };

  return db.islem(async (istemci) => {
    await istemci.query(
      `INSERT INTO giris_denemeleri (kullanici_adi, ip, basarili, sebep, user_agent)
       VALUES ($1, $2, FALSE, $3, $4)`,
      [kullaniciAdi ? String(kullaniciAdi).slice(0, 64) : null, ip, sebep, userAgent ? String(userAgent).slice(0, 400) : null],
    );

    const { rows } = await istemci.query(
      `INSERT INTO ip_kilitleri (ip, basarisiz_sayi, toplam_sayi, son_deneme_at)
            VALUES ($1, 1, 1, NOW())
       ON CONFLICT (ip) DO UPDATE SET
            basarisiz_sayi = CASE
              WHEN ip_kilitleri.son_deneme_at < NOW() - ($2 || ' minutes')::interval THEN 1
              ELSE ip_kilitleri.basarisiz_sayi + 1
            END,
            toplam_sayi   = ip_kilitleri.toplam_sayi + 1,
            son_deneme_at = NOW()
       RETURNING basarisiz_sayi`,
      [ip, String(ayar.bruteForce.pencereDakika)],
    );

    const sayi = rows[0].basarisiz_sayi;
    const { esik, kilitDakika, agirEsik, agirKilitDakika } = ayar.bruteForce;

    let kilitDk = 0;
    if (sayi >= agirEsik) kilitDk = agirKilitDakika;
    else if (sayi >= esik) kilitDk = kilitDakika;

    if (kilitDk > 0) {
      await istemci.query(
        `UPDATE ip_kilitleri
            SET kilit_bitis_at = NOW() + ($2 || ' minutes')::interval
          WHERE ip = $1`,
        [ip, String(kilitDk)],
      );
      return {
        kilitli: true,
        kalanSaniye: kilitDk * 60,
        basarisizSayi: sayi,
        kalanDeneme: 0,
      };
    }

    return {
      kilitli: false,
      kalanSaniye: 0,
      basarisizSayi: sayi,
      kalanDeneme: Math.max(0, esik - sayi),
    };
  });
}

/** Basarili girisi kaydeder ve sayaci sifirlar. */
async function basariliKaydet(ip, kullaniciAdi, userAgent) {
  if (!ip) return;
  await db.islem(async (istemci) => {
    await istemci.query(
      `INSERT INTO giris_denemeleri (kullanici_adi, ip, basarili, sebep, user_agent)
       VALUES ($1, $2, TRUE, 'tamam', $3)`,
      [kullaniciAdi ? String(kullaniciAdi).slice(0, 64) : null, ip, userAgent ? String(userAgent).slice(0, 400) : null],
    );
    await istemci.query(
      `INSERT INTO ip_kilitleri (ip, basarisiz_sayi, toplam_sayi, kilit_bitis_at, son_deneme_at)
            VALUES ($1, 0, 1, NULL, NOW())
       ON CONFLICT (ip) DO UPDATE SET
            basarisiz_sayi = 0,
            toplam_sayi    = ip_kilitleri.toplam_sayi + 1,
            kilit_bitis_at = NULL,
            son_deneme_at  = NOW()`,
      [ip],
    );
  });
}

/** Yonetici tarafindan kilidi elle kaldirma. */
async function kilitKaldir(ip) {
  await db.sorgu(
    `UPDATE ip_kilitleri SET kilit_bitis_at = NULL, basarisiz_sayi = 0 WHERE ip = $1`,
    [ip],
  );
}

/** Aktif kilitleri listeler (/loglar ekrani icin). */
async function aktifKilitler() {
  return db.satirlar(
    `SELECT ip, basarisiz_sayi, toplam_sayi, kilit_bitis_at, son_deneme_at
       FROM ip_kilitleri
      WHERE kilit_bitis_at > NOW()
      ORDER BY kilit_bitis_at DESC
      LIMIT 100`,
  );
}

/** Son giris denemeleri. */
async function sonDenemeler(limit = 50) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db.satirlar(
    `SELECT kullanici_adi, ip, basarili, sebep, user_agent, olusturuldu_at
       FROM giris_denemeleri
      ORDER BY olusturuldu_at DESC
      LIMIT $1`,
    [n],
  );
}

module.exports = { durum, basarisizKaydet, basariliKaydet, kilitKaldir, aktifKilitler, sonDenemeler };
