'use strict';
/**
 * src/config/db.js
 * PostgreSQL baglanti havuzu ve sorgu yardimcilari.
 * TUM sorgular parametrelidir ($1, $2 ...) -> SQL injection'a kapali.
 */

const { Pool } = require('pg');
const ayar = require('./env');

const havuz = new Pool({
  connectionString: ayar.db.url,
  ssl: ayar.db.ssl,
  max: ayar.db.maxHavuz,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'cms-veri-merkezi',
});

havuz.on('error', (hata) => {
  // Bosta bekleyen istemcide beklenmeyen hata: surecin cokmesini engelle.
  console.error('[VERITABANI] Havuz hatasi:', hata.message);
});

/**
 * Parametreli sorgu calistirir.
 * @param {string} metin SQL metni ($1, $2 ... yer tutuculari ile)
 * @param {Array} parametreler
 */
async function sorgu(metin, parametreler = []) {
  const baslangic = Date.now();
  try {
    const sonuc = await havuz.query(metin, parametreler);
    if (!ayar.uretim) {
      const sure = Date.now() - baslangic;
      if (sure > 300) console.warn(`[VERITABANI] Yavas sorgu (${sure}ms): ${metin.slice(0, 80)}`);
    }
    return sonuc;
  } catch (hata) {
    // Sorgu metnini loga basma (icinde hassas veri olabilir), yalnizca kodu.
    console.error(`[VERITABANI] Sorgu hatasi (${hata.code || 'bilinmiyor'}): ${hata.message}`);
    throw hata;
  }
}

/** Tek satir dondurur, yoksa null. */
async function tekSatir(metin, parametreler = []) {
  const { rows } = await sorgu(metin, parametreler);
  return rows[0] || null;
}

/** Satir dizisi dondurur. */
async function satirlar(metin, parametreler = []) {
  const { rows } = await sorgu(metin, parametreler);
  return rows;
}

/**
 * Islem (transaction) icinde calistirir; hata halinde geri alir.
 * @param {(istemci: import('pg').PoolClient) => Promise<any>} isFonksiyonu
 */
async function islem(isFonksiyonu) {
  const istemci = await havuz.connect();
  try {
    await istemci.query('BEGIN');
    const sonuc = await isFonksiyonu(istemci);
    await istemci.query('COMMIT');
    return sonuc;
  } catch (hata) {
    try { await istemci.query('ROLLBACK'); } catch { /* yoksay */ }
    throw hata;
  } finally {
    istemci.release();
  }
}

/** Baglanti saglik kontrolu. */
async function saglik() {
  const satir = await tekSatir('SELECT NOW() AS zaman, version() AS surum');
  return satir;
}

async function kapat() {
  await havuz.end();
}

module.exports = { havuz, sorgu, tekSatir, satirlar, islem, saglik, kapat };
