'use strict';
/**
 * src/services/aramaServisi.js
 * Web arama (Tavily / Serper) ve sayfa okuma (fetch + HTML->metin) servisi.
 * Cambaz'in "arac_cagirma" (ReAct tarzi) dongusunde kullanilir.
 */

const ayar = require('../config/env');

const ARAMA_SAGLAYICILARI = ['tavily', 'serper'];

async function zamanAsimliFetch(url, secenekler = {}) {
  const denetleyici = new AbortController();
  const zamanlayici = setTimeout(() => denetleyici.abort(), ayar.cambaz.httpZamanAsimiMs);
  try {
    return await fetch(url, { ...secenekler, signal: denetleyici.signal });
  } finally {
    clearTimeout(zamanlayici);
  }
}

async function tavilyAra(apiKey, sorgu) {
  const yanit = await zamanAsimliFetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query: sorgu, max_results: 5, include_answer: false }),
  });
  const veri = await yanit.json().catch(() => null);
  if (!yanit.ok || !veri) return { tamam: false, hata: `Tavily HTTP ${yanit.status}` };
  const sonuclar = (veri.results || []).map((r) => ({
    baslik: r.title, url: r.url, ozet: String(r.content || '').slice(0, 500),
  }));
  return { tamam: true, sonuclar };
}

async function serperAra(apiKey, sorgu) {
  const yanit = await zamanAsimliFetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ q: sorgu }),
  });
  const veri = await yanit.json().catch(() => null);
  if (!yanit.ok || !veri) return { tamam: false, hata: `Serper HTTP ${yanit.status}` };
  const sonuclar = (veri.organic || []).slice(0, 5).map((r) => ({
    baslik: r.title, url: r.link, ozet: String(r.snippet || '').slice(0, 500),
  }));
  return { tamam: true, sonuclar };
}

/** Normallestirilmis arama: {tamam, sonuclar:[{baslik,url,ozet}]} */
async function ara({ saglayici, apiKey, sorgu }) {
  const temizSorgu = String(sorgu || '').trim().slice(0, 300);
  if (!temizSorgu) return { tamam: false, hata: 'Bos arama sorgusu.' };
  try {
    if (saglayici === 'tavily') return await tavilyAra(apiKey, temizSorgu);
    if (saglayici === 'serper') return await serperAra(apiKey, temizSorgu);
    return { tamam: false, hata: `Bilinmeyen arama saglayicisi: ${saglayici}` };
  } catch (hata) {
    if (hata.name === 'AbortError') return { tamam: false, hata: 'Arama zaman asimina ugradi.' };
    return { tamam: false, hata: 'Arama servisine ulasilamadi: ' + hata.message };
  }
}

/** Basit SSRF guard: acik/herkese gorunur olmayan hedeflere izin verme. */
function guvenliMiHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\.0\.0\.0$/.test(h)) return false;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return false;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd')) return false;
  return true;
}

/** Bir web sayfasini getirip kaba sekilde duz metne cevirir (ozetlemek icin). */
async function sayfaOku(url) {
  let ayristirilmisUrl;
  try {
    ayristirilmisUrl = new URL(url);
  } catch {
    return { tamam: false, hata: 'Gecersiz adres.' };
  }
  if (!['http:', 'https:'].includes(ayristirilmisUrl.protocol) || !guvenliMiHost(ayristirilmisUrl.hostname)) {
    return { tamam: false, hata: 'Bu adres okunamiyor (guvenlik kisitlamasi).' };
  }

  try {
    const yanit = await zamanAsimliFetch(ayristirilmisUrl.toString(), {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; CambazBot/1.0)' },
    });
    if (!yanit.ok) return { tamam: false, hata: `Sayfa getirilemedi (HTTP ${yanit.status}).` };

    const turu = yanit.headers.get('content-type') || '';
    if (!turu.includes('text/html') && !turu.includes('text/plain')) {
      return { tamam: false, hata: 'Bu icerik turu okunamiyor (HTML/metin degil).' };
    }

    const ham = await yanit.text();
    const metin = ham
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return { tamam: true, metin: metin.slice(0, 8000), url: ayristirilmisUrl.toString() };
  } catch (hata) {
    if (hata.name === 'AbortError') return { tamam: false, hata: 'Sayfa getirme zaman asimina ugradi.' };
    return { tamam: false, hata: 'Sayfa getirilemedi: ' + hata.message };
  }
}

module.exports = { ara, sayfaOku, ARAMA_SAGLAYICILARI };
