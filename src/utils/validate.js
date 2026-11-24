'use strict';
/**
 * src/utils/validate.js
 * Girdi dogrulama ve temizleme (XSS/enjeksiyon yuzeyini daraltir).
 * Not: EJS varsayilan olarak <%= %> ile kacis yapar; burasi ikinci savunma hattidir.
 */

const ayar = require('../config/env');

/** Kontrol karakterlerini atar, bosluklari kirpar, uzunlugu sinirlar. */
function metin(deger, { max = 500, kirp = true } = {}) {
  if (deger === undefined || deger === null) return '';
  let s = String(deger);
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (kirp) s = s.trim();
  return s.slice(0, max);
}

/** HTML'e gomulecek metni kacir (ozel durumlar icin; EJS zaten yapar). */
function kacir(deger) {
  return String(deger ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Kullanici adi: 3-32, harf/rakam/alt cizgi/nokta/tire */
function kullaniciAdi(deger) {
  const s = metin(deger, { max: 32 }).toLowerCase();
  return /^[a-z0-9._-]{3,32}$/.test(s) ? s : null;
}

/**
 * Sifre politikasi kontrolu.
 * @returns {{gecerli:boolean, hatalar:string[], guc:number}}
 */
function sifre(deger) {
  const s = String(deger ?? '');
  const hatalar = [];
  const { minUzunluk, maxUzunluk } = ayar.sifrePolitikasi;

  if (s.length < minUzunluk) hatalar.push(`Sifre en az ${minUzunluk} karakter olmali.`);
  if (s.length > maxUzunluk) hatalar.push(`Sifre en fazla ${maxUzunluk} karakter olabilir.`);
  if (!/[a-zA-Z]/.test(s)) hatalar.push('Sifre en az bir harf icermeli.');
  if (!/[0-9]/.test(s)) hatalar.push('Sifre en az bir rakam icermeli.');
  if (/^(.)\1+$/.test(s)) hatalar.push('Sifre tek karakterin tekrari olamaz.');

  const zayifListe = ['sifre123456', 'password123', '1234567890', 'qwertyuiop', 'kartridex001'];
  if (zayifListe.includes(s.toLowerCase())) {
    hatalar.push('Bu sifre cok yaygin/varsayilan. Baska bir sifre secin.');
  }

  // Kaba bir guc puani (0-100)
  let guc = Math.min(s.length * 4, 40);
  if (/[a-z]/.test(s)) guc += 10;
  if (/[A-Z]/.test(s)) guc += 12;
  if (/[0-9]/.test(s)) guc += 12;
  if (/[^a-zA-Z0-9]/.test(s)) guc += 16;
  if (new Set(s).size > 8) guc += 10;
  guc = Math.max(0, Math.min(100, guc));

  return { gecerli: hatalar.length === 0, hatalar, guc };
}

/** Pozitif tamsayi kimlik dogrulamasi (rota parametreleri icin). */
function kimlik(deger) {
  const n = Number(deger);
  return Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
}

/** Paylasim token'i: base64url, 20-64 karakter. */
function paylasimToken(deger) {
  const s = String(deger ?? '');
  return /^[A-Za-z0-9_-]{20,64}$/.test(s) ? s : null;
}

/** Guvenli dahili yonlendirme hedefi (open redirect korumasi). */
function dahiliHedef(deger, varsayilan = '/merkez') {
  const s = String(deger ?? '');
  // Yalnizca tek "/" ile baslayan, "//" veya ":" icermeyen yollar kabul edilir.
  if (!/^\/[A-Za-z0-9/_\-.?=&%]*$/.test(s)) return varsayilan;
  if (s.startsWith('//') || s.includes('..') || s.includes(':')) return varsayilan;
  if (s.startsWith('/giris')) return varsayilan;
  return s;
}

/** Dosya adini guvenli hale getirir (path traversal korumasi). */
function dosyaAdi(deger) {
  const s = metin(deger, { max: 180 })
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return s || 'adsiz';
}

module.exports = {
  metin, kacir, kullaniciAdi, sifre, kimlik, paylasimToken, dahiliHedef, dosyaAdi,
};
