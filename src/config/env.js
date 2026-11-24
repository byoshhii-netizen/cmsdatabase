'use strict';
/**
 * src/config/env.js
 * Ortam degiskenlerinin yuklenmesi, dogrulanmasi ve guvenli varsayilanlar.
 * Uretimde eksik/zayif sir varsa uygulama BILEREK baslamaz.
 */

const path = require('node:path');
const crypto = require('node:crypto');

require('dotenv').config();

const koklDizin = path.resolve(__dirname, '..', '..');
const uretim = process.env.NODE_ENV === 'production';

/** Sayi okur, gecersizse varsayilani dondurur. */
function sayi(deger, varsayilan) {
  const n = Number.parseInt(deger, 10);
  return Number.isFinite(n) ? n : varsayilan;
}

/** "true"/"1"/"evet" -> true */
function mantik(deger, varsayilan = false) {
  if (deger === undefined || deger === null || deger === '') return varsayilan;
  return ['true', '1', 'evet', 'acik', 'on', 'yes'].includes(String(deger).toLowerCase());
}

const hatalar = [];

// --- Oturum sirri ---------------------------------------------------------
let sessionSecret = process.env.SESSION_SECRET || '';
if (!sessionSecret || sessionSecret.length < 32) {
  if (uretim) {
    hatalar.push('SESSION_SECRET eksik veya 32 karakterden kisa. "npm run guvenlik:anahtar" ile uretin.');
  } else {
    sessionSecret = crypto.randomBytes(48).toString('hex');
    console.warn('[UYARI] SESSION_SECRET tanimli degil. Gelistirme icin gecici bir sir uretildi; sunucu her yeniden baslayista oturumlar dusecek.');
  }
}

// --- Sifreleme anahtari (AES-256-GCM) -------------------------------------
let encKeyHex = (process.env.ENCRYPTION_KEY || '').trim();
if (!/^[0-9a-fA-F]{64}$/.test(encKeyHex)) {
  if (uretim) {
    hatalar.push('ENCRYPTION_KEY eksik veya 64 HEX karakter degil. "npm run guvenlik:anahtar" ile uretin.');
  } else {
    encKeyHex = crypto.randomBytes(32).toString('hex');
    console.warn('[UYARI] ENCRYPTION_KEY tanimli degil. Gecici anahtar uretildi; kayitli API anahtarlari bu oturumdan sonra okunamaz.');
  }
}

// --- Veritabani -----------------------------------------------------------
const databaseUrl = process.env.DATABASE_URL || '';
if (!databaseUrl) {
  hatalar.push('DATABASE_URL eksik. Railway PostgreSQL eklentisini baglayin veya .env dosyasina ekleyin.');
}

if (hatalar.length > 0) {
  console.error('\n==================== YAPILANDIRMA HATASI ====================');
  for (const h of hatalar) console.error('  * ' + h);
  console.error('=============================================================\n');
  process.exit(1);
}

/** SSL kararı: Railway dis baglantilarinda zorunlu, dahili aginda gereksiz. */
function sslKarari() {
  const mod = (process.env.DB_SSL || 'otomatik').toLowerCase();
  if (mod === 'kapali' || mod === 'false') return false;
  if (mod === 'zorunlu' || mod === 'true') return { rejectUnauthorized: false };
  // otomatik
  const dahili = /\.railway\.internal|localhost|127\.0\.0\.1|\[::1\]/i.test(databaseUrl);
  if (dahili) return false;
  return uretim ? { rejectUnauthorized: false } : false;
}

const ayar = {
  uretim,
  ortam: process.env.NODE_ENV || 'development',
  koklDizin,
  port: sayi(process.env.PORT, 3000),
  trustProxy: sayi(process.env.TRUST_PROXY, uretim ? 1 : 0),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${sayi(process.env.PORT, 3000)}`).replace(/\/+$/, ''),

  db: {
    url: databaseUrl,
    ssl: sslKarari(),
    maxHavuz: sayi(process.env.DB_POOL_MAX, 10),
  },

  sir: {
    oturum: sessionSecret,
    sifrelemeAnahtari: Buffer.from(encKeyHex, 'hex'),
  },

  varsayilan: {
    kullanici: process.env.VARSAYILAN_KULLANICI || 'cms',
    sifre: process.env.VARSAYILAN_SIFRE || '',
  },

  oturum: {
    cerezAdi: 'cms_kimlik',
    bostaDakika: sayi(process.env.OTURUM_BOSTA_DAKIKA, 60),
    mutlakDakika: sayi(process.env.OTURUM_MUTLAK_DAKIKA, 720),
  },

  bruteForce: {
    esik: sayi(process.env.BF_ESIK, 5),
    kilitDakika: sayi(process.env.BF_KILIT_DAKIKA, 5),
    agirEsik: sayi(process.env.BF_AGIR_ESIK, 10),
    agirKilitDakika: sayi(process.env.BF_AGIR_KILIT_DAKIKA, 60),
    pencereDakika: 30,
  },

  depo: {
    yol: path.isAbsolute(process.env.DEPO_YOLU || '')
      ? process.env.DEPO_YOLU
      : path.join(koklDizin, process.env.DEPO_YOLU || 'depo_veri'),
    maxBayt: sayi(process.env.DEPO_MAX_MB, 50) * 1024 * 1024,
  },

  pano: {
    // Tuval uzerine surukle-birakla eklenen resimler dogrudan base64 olarak
    // pano_ogeleri.veri (JSONB) icinde tutulur (ayrica dosya yok) -> boylece
    // "disa aktar" tek bir JSON ile goruntuleri de tasir (tam yedek).
    resimMaxMb: sayi(process.env.PANO_RESIM_MAX_MB, 6),
    yedekMaxMb: sayi(process.env.PANO_YEDEK_MAX_MB, 40),
  },

  cambaz: {
    saglayici: process.env.CAMBAZ_SAGLAYICI || 'anthropic',
    model: process.env.CAMBAZ_MODEL || 'claude-sonnet-4-5',
    // Harici saglayici cagrilarinda (Anthropic/OpenAI/Gemini/Groq/OpenRouter/
    // Tavily/Serper/ElevenLabs/Open-Meteo) kullanilan ust sinir ve zaman asimi.
    httpZamanAsimiMs: sayi(process.env.CAMBAZ_HTTP_TIMEOUT_MS, 30000),
    maxGecmisMesaj: sayi(process.env.CAMBAZ_MAX_GECMIS, 20),
    maxCiktiToken: sayi(process.env.CAMBAZ_MAX_CIKTI_TOKEN, 1024),
    // Ozel ses ornegi (klonlama icin referans dosya) yukleme siniri.
    sesOrnekMaxMb: sayi(process.env.CAMBAZ_SES_MAX_MB, 15),
  },

  sifrePolitikasi: {
    minUzunluk: 10,
    maxUzunluk: 200,
  },

  yardimci: { sayi, mantik },
};

module.exports = ayar;
