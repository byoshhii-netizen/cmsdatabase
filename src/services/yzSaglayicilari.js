'use strict';
/**
 * src/services/yzSaglayicilari.js
 * Birden fazla yapay zeka saglayicisini (Anthropic, OpenAI, Google Gemini,
 * Groq, OpenRouter) TEK bir arayuze normalize eden ince adaptor katmani.
 * Hicbir saglayiciya ozel SDK kullanilmaz; dogrudan REST + global fetch
 * (Node >=18) ile cagrilir, boylece ekstra bagimlilik gerekmez.
 *
 * Ortak giris: sohbetTamamla({ saglayici, apiKey, model, sistemTalimati, mesajlar })
 *   mesajlar: [{ rol: 'kullanici'|'ajan'|'arac', icerik: string }]
 * Ortak cikis: { tamam, icerik, girdiToken, ciktiToken, hata }
 */

const ayar = require('../config/env');

const VARSAYILAN_MODEL = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.0-flash',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'openai/gpt-4o-mini',
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

/** 'arac' rolunu normal mesaj rolune cevirir (hicbir saglayicida gercek rol degildir). */
function mesajiDuzlestir(m) {
  if (m.rol === 'arac') return { rol: 'kullanici', icerik: `[ARAC SONUCU]\n${m.icerik}` };
  return m;
}

// --------------------------------------------------------------- ANTHROPIC
async function anthropicCagir({ apiKey, model, sistemTalimati, mesajlar }) {
  const govde = {
    model: model || VARSAYILAN_MODEL.anthropic,
    max_tokens: ayar.cambaz.maxCiktiToken,
    system: sistemTalimati,
    messages: mesajlar.map(mesajiDuzlestir).map((m) => ({
      role: m.rol === 'ajan' ? 'assistant' : 'user',
      content: m.icerik,
    })),
  };

  const yanit = await zamanAsimliFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(govde),
  });

  const veri = await yanit.json().catch(() => null);
  if (!yanit.ok) {
    return { tamam: false, hata: (veri && veri.error && veri.error.message) || `Anthropic HTTP ${yanit.status}` };
  }
  const icerik = (veri.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim();
  return {
    tamam: true,
    icerik,
    girdiToken: veri.usage ? veri.usage.input_tokens : null,
    ciktiToken: veri.usage ? veri.usage.output_tokens : null,
  };
}

// --------------------------------------- OpenAI UYUMLU (OpenAI/Groq/OpenRouter)
async function openaiUyumluCagir({ taban, apiKey, model, sistemTalimati, mesajlar, ekBasliklar = {} }) {
  const govde = {
    model,
    max_tokens: ayar.cambaz.maxCiktiToken,
    messages: [
      { role: 'system', content: sistemTalimati },
      ...mesajlar.map(mesajiDuzlestir).map((m) => ({
        role: m.rol === 'ajan' ? 'assistant' : 'user',
        content: m.icerik,
      })),
    ],
  };

  const yanit = await zamanAsimliFetch(`${taban}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...ekBasliklar,
    },
    body: JSON.stringify(govde),
  });

  const veri = await yanit.json().catch(() => null);
  if (!yanit.ok) {
    return { tamam: false, hata: (veri && veri.error && veri.error.message) || `HTTP ${yanit.status}` };
  }
  const secim = veri.choices && veri.choices[0];
  const icerik = secim && secim.message ? String(secim.message.content || '').trim() : '';
  return {
    tamam: true,
    icerik,
    girdiToken: veri.usage ? veri.usage.prompt_tokens : null,
    ciktiToken: veri.usage ? veri.usage.completion_tokens : null,
  };
}

// ------------------------------------------------------------------ GEMINI
async function geminiCagir({ apiKey, model, sistemTalimati, mesajlar }) {
  const m = model || VARSAYILAN_MODEL.google;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const govde = {
    systemInstruction: { parts: [{ text: sistemTalimati }] },
    contents: mesajlar.map(mesajiDuzlestir).map((msg) => ({
      role: msg.rol === 'ajan' ? 'model' : 'user',
      parts: [{ text: msg.icerik }],
    })),
    generationConfig: { maxOutputTokens: ayar.cambaz.maxCiktiToken },
  };

  const yanit = await zamanAsimliFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(govde),
  });

  const veri = await yanit.json().catch(() => null);
  if (!yanit.ok) {
    return { tamam: false, hata: (veri && veri.error && veri.error.message) || `Gemini HTTP ${yanit.status}` };
  }
  const aday = veri.candidates && veri.candidates[0];
  const parcalar = aday && aday.content && aday.content.parts ? aday.content.parts : [];
  const icerik = parcalar.map((p) => p.text || '').join('\n').trim();
  const kullanim = veri.usageMetadata || {};
  return {
    tamam: true,
    icerik,
    girdiToken: kullanim.promptTokenCount ?? null,
    ciktiToken: kullanim.candidatesTokenCount ?? null,
  };
}

/**
 * Tek giris noktasi: saglayiciya gore dogru adaptoru cagirir.
 * @returns {Promise<{tamam:boolean, icerik?:string, girdiToken?:number|null, ciktiToken?:number|null, hata?:string}>}
 */
async function sohbetTamamla({ saglayici, apiKey, model, sistemTalimati, mesajlar }) {
  const s = String(saglayici || '').toLowerCase();
  const m = model || VARSAYILAN_MODEL[s];
  try {
    if (s === 'anthropic') return await anthropicCagir({ apiKey, model: m, sistemTalimati, mesajlar });
    if (s === 'openai') {
      return await openaiUyumluCagir({ taban: 'https://api.openai.com/v1', apiKey, model: m, sistemTalimati, mesajlar });
    }
    if (s === 'groq') {
      return await openaiUyumluCagir({ taban: 'https://api.groq.com/openai/v1', apiKey, model: m, sistemTalimati, mesajlar });
    }
    if (s === 'openrouter') {
      return await openaiUyumluCagir({
        taban: 'https://openrouter.ai/api/v1', apiKey, model: m, sistemTalimati, mesajlar,
        ekBasliklar: { 'HTTP-Referer': ayar.publicUrl, 'X-Title': 'CMS Veri Merkezi / Cambaz' },
      });
    }
    if (s === 'google') return await geminiCagir({ apiKey, model: m, sistemTalimati, mesajlar });
    return { tamam: false, hata: `Bilinmeyen sohbet saglayicisi: ${saglayici}` };
  } catch (hata) {
    if (hata.name === 'AbortError') return { tamam: false, hata: 'Saglayici zaman asimina ugradi.' };
    return { tamam: false, hata: 'Saglayiciya ulasilamadi: ' + hata.message };
  }
}

const SOHBET_SAGLAYICILARI = ['anthropic', 'openai', 'google', 'groq', 'openrouter'];

module.exports = { sohbetTamamla, SOHBET_SAGLAYICILARI, VARSAYILAN_MODEL };
