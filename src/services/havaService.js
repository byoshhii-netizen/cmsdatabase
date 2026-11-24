'use strict';
/**
 * src/services/havaService.js
 * Open-Meteo (ucretsiz, API anahtari gerektirmez) ile sehir -> konum
 * cozumleme ve anlik hava durumu sorgusu. Cambaz'in cevrimdisi
 * (API anahtarsiz) motorunda kullanilir.
 */

const ayar = require('../config/env');

const HAVA_KODLARI = {
  0: 'Acik / gunesli', 1: 'Genelde acik', 2: 'Parcali bulutlu', 3: 'Kapali/bulutlu',
  45: 'Sisli', 48: 'Kiragili sis',
  51: 'Hafif ciseleme', 53: 'Ciseleme', 55: 'Yogun ciseleme',
  56: 'Hafif donan ciseleme', 57: 'Yogun donan ciseleme',
  61: 'Hafif yagmur', 63: 'Yagmur', 65: 'Kuvvetli yagmur',
  66: 'Hafif donan yagmur', 67: 'Kuvvetli donan yagmur',
  71: 'Hafif kar', 73: 'Kar', 75: 'Kuvvetli kar', 77: 'Kar taneleri',
  80: 'Hafif saganak', 81: 'Saganak', 82: 'Siddetli saganak',
  85: 'Hafif kar saganagi', 86: 'Kuvvetli kar saganagi',
  95: 'Firtina', 96: 'Dolulu firtina', 99: 'Siddetli dolulu firtina',
};

async function zamanAsimliFetch(url, secenekler = {}) {
  const denetleyici = new AbortController();
  const zamanlayici = setTimeout(() => denetleyici.abort(), ayar.cambaz.httpZamanAsimiMs);
  try {
    return await fetch(url, { ...secenekler, signal: denetleyici.signal });
  } finally {
    clearTimeout(zamanlayici);
  }
}

/** Sehir adindan enlem/boylam bulur (Open-Meteo Geocoding API). */
async function konumBul(sehirAdi) {
  const temiz = String(sehirAdi || '').trim().slice(0, 100);
  if (!temiz) return null;

  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(temiz)}&count=1&language=tr&format=json`;
  const yanit = await zamanAsimliFetch(url);
  if (!yanit.ok) return null;
  const veri = await yanit.json();
  const sonuc = veri && Array.isArray(veri.results) ? veri.results[0] : null;
  if (!sonuc) return null;

  return {
    ad: sonuc.name,
    ulke: sonuc.country,
    bolge: sonuc.admin1 || null,
    enlem: sonuc.latitude,
    boylam: sonuc.longitude,
  };
}

/** Enlem/boylam icin anlik hava durumunu getirir (Open-Meteo Forecast API). */
async function anlikHava(enlem, boylam) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${enlem}&longitude=${boylam}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
    `&timezone=auto`;
  const yanit = await zamanAsimliFetch(url);
  if (!yanit.ok) return null;
  const veri = await yanit.json();
  if (!veri || !veri.current) return null;

  const c = veri.current;
  return {
    sicaklik: c.temperature_2m,
    hissedilen: c.apparent_temperature,
    nem: c.relative_humidity_2m,
    ruzgarKmh: c.wind_speed_10m,
    kod: c.weather_code,
    aciklama: HAVA_KODLARI[c.weather_code] || 'Bilinmiyor',
    zamanDilimi: veri.timezone,
  };
}

/** Sehir adindan dogrudan anlik hava durumu metnini uretir. */
async function sehirHavasi(sehirAdi) {
  try {
    const konum = await konumBul(sehirAdi);
    if (!konum) return { tamam: false, hata: `"${sehirAdi}" adinda bir yerlesim bulunamadi.` };

    const hava = await anlikHava(konum.enlem, konum.boylam);
    if (!hava) return { tamam: false, hata: 'Hava durumu servisine ulasilamadi.' };

    const yer = [konum.ad, konum.bolge, konum.ulke].filter(Boolean).join(', ');
    const metin =
      `${yer}: ${hava.aciklama}, ${hava.sicaklik}°C (hissedilen ${hava.hissedilen}°C), ` +
      `nem %${hava.nem}, ruzgar ${hava.ruzgarKmh} km/sa.`;

    return { tamam: true, yer, hava, metin };
  } catch (hata) {
    return { tamam: false, hata: 'Hava durumu sorgusu basarisiz: ' + hata.message };
  }
}

module.exports = { konumBul, anlikHava, sehirHavasi, HAVA_KODLARI };
