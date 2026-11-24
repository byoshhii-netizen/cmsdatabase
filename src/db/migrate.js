'use strict';
/**
 * src/db/migrate.js
 * Semayi uygular ve varsayilan yoneticiyi olusturur.
 * Kullanim:
 *   node src/db/migrate.js            -> semayi uygula + varsayilan yonetici
 *   node src/db/migrate.js --sifirla  -> TUM tablolari dusurup yeniden kurar (DIKKAT)
 */

const fs = require('node:fs');
const path = require('node:path');
const ayar = require('../config/env');
const db = require('../config/db');
const { sifreHashle } = require('../utils/crypto');

const TABLOLAR = [
  'cambaz_mesajlari', 'cambaz_oturumlari',
  'paylasim_erisimleri', 'paylasim_linkleri',
  'pano_ogeleri', 'panolar',
  'belgeler', 'dosyalar', 'klasorler',
  'api_anahtarlari', 'loglar',
  'ip_kilitleri', 'giris_denemeleri',
  'oturumlar', 'ayarlar', 'yoneticiler',
];

async function sifirla() {
  console.log('[MIGRASYON] --sifirla verildi: mevcut tablolar dusuruluyor...');
  for (const t of TABLOLAR) {
    await db.sorgu(`DROP TABLE IF EXISTS ${t} CASCADE`);
    console.log(`  - ${t} dusuruldu`);
  }
  await db.sorgu('DROP FUNCTION IF EXISTS trg_guncellendi() CASCADE');
}

async function semaUygula() {
  const yol = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(yol, 'utf8');
  console.log('[MIGRASYON] schema.sql uygulaniyor...');
  await db.sorgu(sql);
  console.log('[MIGRASYON] Sema hazir.');
}

async function varsayilanYonetici() {
  const mevcut = await db.tekSatir('SELECT COUNT(*)::int AS adet FROM yoneticiler');
  if (mevcut && mevcut.adet > 0) {
    console.log('[MIGRASYON] Yonetici kaydi mevcut, varsayilan olusturulmadi.');
    return;
  }
  if (!ayar.varsayilan.sifre) {
    throw new Error('Ilk yonetici icin VARSAYILAN_SIFRE zorunludur. .env dosyasinda guclu ve benzersiz bir sifre belirleyin.');
  }
  const hash = await sifreHashle(ayar.varsayilan.sifre);
  await db.sorgu(
    `INSERT INTO yoneticiler (kullanici_adi, gorunen_ad, sifre_hash, sifre_algo)
     VALUES ($1, $2, $3, 'argon2id')
     ON CONFLICT (kullanici_adi) DO NOTHING`,
    [ayar.varsayilan.kullanici.toLowerCase(), 'Bas Operator', hash],
  );
  console.log('[MIGRASYON] Varsayilan yonetici olusturuldu.');
  console.log(`            kullanici: ${ayar.varsayilan.kullanici}`);
  console.log('            sifre    : (.env icindeki VARSAYILAN_SIFRE)');
  console.log('            >> Giris yaptiktan sonra /ayarlar uzerinden degistirin.');
}

async function temizlik() {
  // Suresi gecmis oturumlari ve eski giris denemelerini temizle.
  await db.sorgu('DELETE FROM oturumlar WHERE expire < NOW()');
  await db.sorgu("DELETE FROM giris_denemeleri WHERE olusturuldu_at < NOW() - INTERVAL '30 days'");
  await db.sorgu('DELETE FROM ip_kilitleri WHERE kilit_bitis_at IS NOT NULL AND kilit_bitis_at < NOW()');
}

(async function calistir() {
  try {
    const bilgi = await db.saglik();
    console.log(`[MIGRASYON] Baglanti tamam. Sunucu zamani: ${bilgi.zaman.toISOString()}`);

    if (process.argv.includes('--sifirla') && !ayar.varsayilan.sifre) {
      throw new Error('--sifirla mevcut verileri silmeden once VARSAYILAN_SIFRE gerektirir. .env dosyasinda guclu ve benzersiz bir sifre belirleyin.');
    }
    if (process.argv.includes('--sifirla')) await sifirla();
    await semaUygula();
    await varsayilanYonetici();
    await temizlik();

    console.log('[MIGRASYON] Tamamlandi.');
    await db.kapat();
    process.exit(0);
  } catch (hata) {
    console.error('[MIGRASYON] BASARISIZ:', hata.message);
    if (hata.detail) console.error('           detay:', hata.detail);
    try { await db.kapat(); } catch { /* yoksay */ }
    process.exit(1);
  }
})();
