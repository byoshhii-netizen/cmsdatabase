'use strict';
/**
 * server.js
 * Giris noktasi: HTTP sunucusunu baslatir, zarif kapanisi yonetir.
 * Railway PORT degiskenini saglar; 0.0.0.0 uzerinde dinlemek zorunludur.
 */

const http = require('node:http');
const fs = require('node:fs');

const ayar = require('./src/config/env');
const db = require('./src/config/db');
const uygulama = require('./src/app');
const log = require('./src/services/logService');

// Depo dizini yoksa olustur (dosya kasasi icin)
try {
  fs.mkdirSync(ayar.depo.yol, { recursive: true });
} catch (hata) {
  console.error('[DEPO] Dizin olusturulamadi:', hata.message);
}

const sunucu = http.createServer(uygulama);
sunucu.keepAliveTimeout = 65_000;
sunucu.headersTimeout = 70_000;
sunucu.requestTimeout = 120_000;

async function basla() {
  try {
    const bilgi = await db.saglik();
    console.log(`[VERITABANI] Bagli. PostgreSQL: ${String(bilgi.surum).split(' ').slice(0, 2).join(' ')}`);
  } catch (hata) {
    console.error('[VERITABANI] Baglanti kurulamadi:', hata.message);
    console.error('             DATABASE_URL degerini ve ag erisimini kontrol edin.');
    process.exit(1);
  }

  sunucu.listen(ayar.port, '0.0.0.0', () => {
    console.log('');
    console.log('  ####################################################');
    console.log('  #            C M S   V E R I   M E R K E Z I       #');
    console.log('  ####################################################');
    console.log(`  Ortam      : ${ayar.ortam}`);
    console.log(`  Dinleniyor : http://0.0.0.0:${ayar.port}`);
    console.log(`  Genel adres: ${ayar.publicUrl}`);
    console.log(`  Giris      : ${ayar.publicUrl}/giris`);
    console.log('');
    void log.bilgi({ kategori: 'sistem', olay: 'sunucu_basladi', mesaj: `Port ${ayar.port}` });
  });
}

// --- Zarif kapanis --------------------------------------------------------
let kapaniyor = false;

async function kapat(sinyal) {
  if (kapaniyor) return;
  kapaniyor = true;
  console.log(`\n[SUNUCU] ${sinyal} alindi, kapatiliyor...`);

  const zorlaKapat = setTimeout(() => {
    console.error('[SUNUCU] Zaman asimi, zorla kapatiliyor.');
    process.exit(1);
  }, 15_000);
  zorlaKapat.unref();

  sunucu.close(async () => {
    try {
      await log.bilgi({ kategori: 'sistem', olay: 'sunucu_kapandi', mesaj: `Sinyal: ${sinyal}` });
      await db.kapat();
    } catch { /* yoksay */ }
    console.log('[SUNUCU] Kapandi.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => void kapat('SIGTERM'));
process.on('SIGINT', () => void kapat('SIGINT'));

process.on('unhandledRejection', (sebep) => {
  console.error('[KRITIK] Yakalanmayan reddetme:', sebep);
  void log.kritik({ kategori: 'sistem', olay: 'unhandled_rejection', mesaj: String(sebep) });
});

process.on('uncaughtException', (hata) => {
  console.error('[KRITIK] Yakalanmayan istisna:', hata);
  void log.kritik({ kategori: 'sistem', olay: 'uncaught_exception', mesaj: hata.message });
  void kapat('uncaughtException');
});

void basla();
