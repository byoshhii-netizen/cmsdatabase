'use strict';
/**
 * src/utils/crypto.js
 * Kriptografik yardimcilar:
 *  - argon2id ile sifre hash'leme / dogrulama
 *  - AES-256-GCM ile veri sifreleme (API anahtarlari, dosya govdeleri)
 *  - zaman sabitli karsilastirma, guvenli token uretimi
 */

const crypto = require('node:crypto');
const argon2 = require('@node-rs/argon2');
const ayar = require('../config/env');

// --- argon2id parametreleri (OWASP onerisi: >=19MiB bellek, t=2, p=1) ------
const ARGON_AYAR = {
  algorithm: 2,          // 2 = Argon2id
  memoryCost: 19_456,    // 19 MiB
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

/** Sifreyi argon2id ile hashler. */
async function sifreHashle(duzMetin) {
  return argon2.hash(String(duzMetin), ARGON_AYAR);
}

/**
 * Sifreyi dogrular. Hash bozuk/eksikse sessizce false doner (hata sizdirmaz).
 */
async function sifreDogrula(hash, duzMetin) {
  if (!hash || typeof hash !== 'string') return false;
  try {
    return await argon2.verify(hash, String(duzMetin));
  } catch {
    return false;
  }
}

// Kullanici bulunamadiginda da ayni islem suresini harcamak icin sahte hash.
// (Kullanici adi envanteri cikarimini / zamanlama saldirisini engeller.)
const SAHTE_HASH = argon2.hashSync('cms-sahte-dogrulama-degeri', ARGON_AYAR);

/** Kullanici yoksa cagrilir: sabit maliyetli sahte dogrulama. */
async function sahteDogrulama(duzMetin = 'bos') {
  try { await argon2.verify(SAHTE_HASH, String(duzMetin)); } catch { /* yoksay */ }
  return false;
}

// --- AES-256-GCM ----------------------------------------------------------

/**
 * Metni AES-256-GCM ile sifreler.
 * @returns {{deger:string, iv:string, etiket:string}} base64 bilesenler
 */
function sifrele(duzMetin) {
  const iv = crypto.randomBytes(12);
  const sifreleyici = crypto.createCipheriv('aes-256-gcm', ayar.sir.sifrelemeAnahtari, iv);
  const govde = Buffer.concat([sifreleyici.update(String(duzMetin), 'utf8'), sifreleyici.final()]);
  return {
    deger: govde.toString('base64'),
    iv: iv.toString('base64'),
    etiket: sifreleyici.getAuthTag().toString('base64'),
  };
}

/** AES-256-GCM ile sifrelenmis metni cozer. Bozuksa hata atar. */
function coz({ deger, iv, etiket }) {
  const cozucu = crypto.createDecipheriv(
    'aes-256-gcm',
    ayar.sir.sifrelemeAnahtari,
    Buffer.from(iv, 'base64'),
  );
  cozucu.setAuthTag(Buffer.from(etiket, 'base64'));
  const duz = Buffer.concat([cozucu.update(Buffer.from(deger, 'base64')), cozucu.final()]);
  return duz.toString('utf8');
}

/** Dosya/ikili veri icin AES-256-GCM sifreleme. */
function tamponSifrele(tampon) {
  const iv = crypto.randomBytes(12);
  const sifreleyici = crypto.createCipheriv('aes-256-gcm', ayar.sir.sifrelemeAnahtari, iv);
  const govde = Buffer.concat([sifreleyici.update(tampon), sifreleyici.final()]);
  return { govde, iv: iv.toString('base64'), etiket: sifreleyici.getAuthTag().toString('base64') };
}

function tamponCoz(govde, iv, etiket) {
  const cozucu = crypto.createDecipheriv('aes-256-gcm', ayar.sir.sifrelemeAnahtari, Buffer.from(iv, 'base64'));
  cozucu.setAuthTag(Buffer.from(etiket, 'base64'));
  return Buffer.concat([cozucu.update(govde), cozucu.final()]);
}

// --- Token / karsilastirma ------------------------------------------------

/** URL guvenli rastgele token (varsayilan 32 bayt -> 43 karakter). */
function token(bayt = 32) {
  return crypto.randomBytes(bayt).toString('base64url');
}

/** Zaman sabitli string karsilastirmasi (CSRF, token kontrolu icin). */
function esitMi(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) {
    // Uzunluk farkinda da sabit maliyet harcamak icin kendisiyle karsilastir.
    crypto.timingSafeEqual(x, x);
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

/** SHA-256 ozeti (dosya butunlugu icin). */
function sha256(veri) {
  return crypto.createHash('sha256').update(veri).digest('hex');
}

/** Hassas degeri maskeler: "sk-ant-api03-xxxx...9f2a" */
function maskele(deger) {
  const s = String(deger || '');
  if (s.length <= 10) return '*'.repeat(Math.max(s.length, 4));
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

module.exports = {
  sifreHashle,
  sifreDogrula,
  sahteDogrulama,
  sifrele,
  coz,
  tamponSifrele,
  tamponCoz,
  token,
  esitMi,
  sha256,
  maskele,
  ARGON_AYAR,
};
