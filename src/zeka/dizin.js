'use strict';
/**
 * src/zeka/dizin.js
 * YEREL ARAMA DIZINI — Okapi BM25, tamamen PostgreSQL uzerinde.
 *
 * Arsivdeki her kayit, belge, cozumlenmis dosya, varlik ve olay burada
 * parcalara (chunk) bolunup ters dizine yazilir. Arama, BM25 siralamasiyla
 * dogrudan SQL icinde yapilir; boylece binlerce belgede bile tek sorguda
 * siralanmis sonuc doner ve hicbir dis servise ihtiyac duyulmaz.
 *
 * Parcalama neden onemli: 40 sayfalik bir raporun tamami tek belge olarak
 * dizine girerse, icindeki tek bir cumlelik bilgi uzunluk normalizasyonunda
 * kaybolur. ~220 kelimelik ortusen parcalar, cevabin tam yerini bulmayi
 * saglar (motor cevabi gerekcelendirebilir).
 */

const db = require('../config/db');
const dil = require('./dil');
const nd = require('./dogalDil');

const PARCA_KELIME = 220;
const PARCA_ORTUSME = 40;
const MAX_PARCA = 60;              // tek kaynak icin en fazla parca
const MAX_PARCA_METIN = 4000;      // parca basina saklanan metin siniri

const BM25_K1 = 1.4;
const BM25_B = 0.72;

const KAYNAK_TURLERI = ['kayit', 'belge', 'dosya', 'varlik', 'olay', 'hafiza', 'vaka'];

/** Zamani aranabilir metne cevirir (rakam + sozcuk bicimiyle). */
function zamanMetniYerel(zaman) {
  if (!zaman) return null;
  const d = zaman instanceof Date ? zaman : new Date(zaman);
  if (Number.isNaN(d.getTime())) return null;
  const gun = String(d.getDate()).padStart(2, '0');
  const ay = String(d.getMonth() + 1).padStart(2, '0');
  return `${gun}.${ay}.${d.getFullYear()} ${nd.tarihSozcuk(d, { gunAdi: true })} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ------------------------------------------------------------- PARCALAMA

/** Metni ortusen kelime bloklarina boler. */
function parcala(metin, { kelime = PARCA_KELIME, ortusme = PARCA_ORTUSME } = {}) {
  const kelimeler = String(metin || '').split(/\s+/).filter(Boolean);
  if (kelimeler.length === 0) return [];
  if (kelimeler.length <= kelime) return [kelimeler.join(' ')];

  const parcalar = [];
  const adim = Math.max(1, kelime - ortusme);
  for (let i = 0; i < kelimeler.length && parcalar.length < MAX_PARCA; i += adim) {
    parcalar.push(kelimeler.slice(i, i + kelime).join(' '));
  }
  return parcalar;
}

// ------------------------------------------------------------- YAZMA / SILME

/**
 * Bir kaynagi dizine yazar (varsa once eski parcalarini siler).
 * @param {object} secenek
 * @param {string} secenek.kaynakTur  kayit|belge|dosya|varlik|olay|hafiza|vaka
 * @param {number} secenek.kaynakId
 * @param {string} secenek.baslik
 * @param {string} secenek.metin
 * @param {string} [secenek.tasnif]
 */
async function yaz({ kaynakTur, kaynakId, baslik = '', metin = '', tasnif = 'hizmete_ozel' }) {
  if (!KAYNAK_TURLERI.includes(kaynakTur)) {
    throw new Error(`Bilinmeyen dizin kaynak turu: ${kaynakTur}`);
  }
  const kimlik = Number(kaynakId);
  if (!Number.isInteger(kimlik) || kimlik <= 0) throw new Error('Gecersiz kaynak kimligi.');

  const tamMetin = `${baslik}\n${metin}`.trim();
  await sil(kaynakTur, kimlik);
  if (!tamMetin) return { parca: 0, terim: 0 };

  const parcalar = parcala(tamMetin);
  let terimSayisi = 0;

  await db.islem(async (istemci) => {
    for (let i = 0; i < parcalar.length; i++) {
      // Baslik her parcaya eklenir: parcanin baglami kaybolmasin.
      const parcaMetni = i === 0 ? parcalar[i] : `${baslik} — ${parcalar[i]}`;
      const terimler = dil.anahtarlar(parcaMetni);
      if (terimler.length === 0) continue;

      const sayac = new Map();
      for (const t of terimler) sayac.set(t, (sayac.get(t) || 0) + 1);

      const { rows } = await istemci.query(
        `INSERT INTO zeka_belgeleri (kaynak_tur, kaynak_id, baslik, parca_no, metin, uzunluk, tasnif)
              VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (kaynak_tur, kaynak_id, parca_no) DO UPDATE SET
              baslik = EXCLUDED.baslik, metin = EXCLUDED.metin,
              uzunluk = EXCLUDED.uzunluk, tasnif = EXCLUDED.tasnif,
              guncellendi_at = NOW()
         RETURNING id`,
        [
          kaynakTur, kimlik, String(baslik).slice(0, 300), i,
          parcalar[i].slice(0, MAX_PARCA_METIN), terimler.length, tasnif,
        ],
      );
      const belgeId = rows[0].id;

      // Terimleri tek sorguda yaz (unnest ile toplu ekleme)
      const anahtarlar = [...sayac.keys()];
      const sayilar = [...sayac.values()];
      await istemci.query(
        `INSERT INTO zeka_terimleri (belge_id, terim, sayi)
         SELECT $1, t.terim, t.sayi
           FROM UNNEST($2::text[], $3::int[]) AS t(terim, sayi)
         ON CONFLICT (belge_id, terim) DO UPDATE SET sayi = EXCLUDED.sayi`,
        [belgeId, anahtarlar, sayilar],
      );
      terimSayisi += anahtarlar.length;
    }
  });

  return { parca: parcalar.length, terim: terimSayisi };
}

/** Bir kaynagin tum parcalarini dizinden siler. */
async function sil(kaynakTur, kaynakId) {
  const sonuc = await db.sorgu(
    'DELETE FROM zeka_belgeleri WHERE kaynak_tur = $1 AND kaynak_id = $2',
    [kaynakTur, Number(kaynakId)],
  );
  return sonuc.rowCount;
}

// ----------------------------------------------------------------- ARAMA

const TASNIF_SIRASI = { acik: 0, hizmete_ozel: 1, gizli: 2, cok_gizli: 3 };

/**
 * BM25 ile arama. Puanlama tamamen SQL icinde yapilir.
 *
 * @param {string} sorgu
 * @param {object} secenek
 * @param {string[]} [secenek.turler]      yalnizca bu kaynak turleri
 * @param {number}   [secenek.limit]
 * @param {string}   [secenek.enUstTasnif] bu seviyeye kadar olanlar
 * @returns {Promise<{sonuclar:Array, terimler:string[], sure:number}>}
 */
async function ara(sorgu, { turler = null, limit = 20, enUstTasnif = null, kaynakId = null } = {}) {
  const basla = Date.now();
  const terimler = [...new Set(dil.anahtarlar(sorgu))].slice(0, 40);
  if (terimler.length === 0) return { sonuclar: [], terimler: [], sure: 0 };

  const kosullar = ['t.terim = ANY($1::text[])'];
  const parametreler = [terimler, BM25_K1, BM25_B];
  let sira = 4;

  if (Array.isArray(turler) && turler.length) {
    kosullar.push(`b.kaynak_tur = ANY($${sira}::text[])`);
    parametreler.push(turler.filter((t) => KAYNAK_TURLERI.includes(t)));
    sira++;
  }
  if (enUstTasnif && TASNIF_SIRASI[enUstTasnif] !== undefined) {
    const izinli = Object.entries(TASNIF_SIRASI)
      .filter(([, d]) => d <= TASNIF_SIRASI[enUstTasnif])
      .map(([ad]) => ad);
    kosullar.push(`b.tasnif = ANY($${sira}::text[])`);
    parametreler.push(izinli);
    sira++;
  }
  if (kaynakId) {
    kosullar.push(`b.kaynak_id = $${sira}`);
    parametreler.push(Number(kaynakId));
    sira++;
  }

  const limitSira = sira;
  parametreler.push(Math.min(Math.max(Number(limit) || 20, 1), 200));

  const sql = `
    WITH genel AS (
      SELECT GREATEST(COUNT(*), 1)::float AS n,
             GREATEST(AVG(uzunluk), 1)::float AS ort
        FROM zeka_belgeleri
    ),
    df AS (
      SELECT terim, COUNT(*)::float AS df
        FROM zeka_terimleri
       WHERE terim = ANY($1::text[])
       GROUP BY terim
    )
    SELECT b.id, b.kaynak_tur, b.kaynak_id, b.baslik, b.parca_no, b.tasnif,
           b.metin, b.uzunluk,
           SUM(
             ln(1 + (genel.n - df.df + 0.5) / (df.df + 0.5))
             * (t.sayi * ($2::float + 1))
             / (t.sayi + $2::float * (1 - $3::float + $3::float * (b.uzunluk / genel.ort)))
           )::float AS puan,
           COUNT(DISTINCT t.terim)::int AS eslesen_terim,
           ARRAY_AGG(DISTINCT t.terim) AS eslesen
      FROM zeka_terimleri t
      JOIN zeka_belgeleri b ON b.id = t.belge_id
      JOIN df ON df.terim = t.terim
      CROSS JOIN genel
     WHERE ${kosullar.join(' AND ')}
     GROUP BY b.id, b.kaynak_tur, b.kaynak_id, b.baslik, b.parca_no, b.tasnif,
              b.metin, b.uzunluk
     ORDER BY puan DESC, eslesen_terim DESC
     LIMIT $${limitSira}`;

  const satirlar = await db.satirlar(sql, parametreler);

  // Ayni kaynagin birden fazla parcasi dondugunde en iyi parcayi one al,
  // digerlerini "ek parca" olarak altina baglar.
  const kaynakHarita = new Map();
  for (const s of satirlar) {
    const anahtar = `${s.kaynak_tur}|${s.kaynak_id}`;
    if (!kaynakHarita.has(anahtar)) {
      kaynakHarita.set(anahtar, { ...s, parcalar: [] });
    } else {
      const ana = kaynakHarita.get(anahtar);
      ana.puan += s.puan * 0.35;      // ek parcalar puani az miktarda arttirir
      ana.parcalar.push({ parca_no: s.parca_no, metin: s.metin, puan: s.puan });
    }
  }

  const sonuclar = [...kaynakHarita.values()]
    .sort((a, b) => b.puan - a.puan)
    .map((s) => ({
      ...s,
      puan: Math.round(s.puan * 1000) / 1000,
      alinti: alintiCikar(s.metin, terimler),
    }));

  return { sonuclar, terimler, sure: Date.now() - basla };
}

/** Eslesen terimlerin yogun oldugu pencereyi alinti olarak dondurur. */
function alintiCikar(metin, terimler, { uzunluk = 320 } = {}) {
  const ham = String(metin || '');
  if (ham.length <= uzunluk) return ham;

  const hedef = new Set(terimler);
  const cumleler = dil.cumleler(ham);
  if (cumleler.length === 0) return ham.slice(0, uzunluk);

  let enIyi = 0;
  let enIyiPuan = -1;
  for (let i = 0; i < cumleler.length; i++) {
    const anahtarlar = new Set(dil.anahtarlar(cumleler[i]));
    let puan = 0;
    for (const a of anahtarlar) if (hedef.has(a)) puan++;
    if (puan > enIyiPuan) { enIyiPuan = puan; enIyi = i; }
  }

  let alinti = cumleler[enIyi];
  let onceki = enIyi - 1;
  let sonraki = enIyi + 1;
  while (alinti.length < uzunluk && (onceki >= 0 || sonraki < cumleler.length)) {
    if (sonraki < cumleler.length && alinti.length + cumleler[sonraki].length < uzunluk) {
      alinti += ' ' + cumleler[sonraki++];
    } else if (onceki >= 0 && alinti.length + cumleler[onceki].length < uzunluk) {
      alinti = cumleler[onceki--] + ' ' + alinti;
    } else break;
  }

  return (enIyi > 0 ? '…' : '') + alinti.trim() + (sonraki < cumleler.length ? '…' : '');
}

// ------------------------------------------------------------ BENZER BELGE

/**
 * Bir kaynaga en benzeyen diger kaynaklari bulur ("daha fazlasi gibi").
 * Kaynagin en ayirt edici terimleri sorguya cevrilir.
 */
async function benzerler(kaynakTur, kaynakId, { limit = 8 } = {}) {
  const parcalar = await db.satirlar(
    'SELECT baslik, metin FROM zeka_belgeleri WHERE kaynak_tur = $1 AND kaynak_id = $2 ORDER BY parca_no LIMIT 6',
    [kaynakTur, Number(kaynakId)],
  );
  if (parcalar.length === 0) return [];

  const metin = parcalar.map((p) => p.metin).join(' ');
  const sayac = dil.terimSikligi(metin);

  // En yuksek df-dusuk / tf-yuksek terimleri sec
  const terimler = [...sayac.keys()];
  if (terimler.length === 0) return [];

  const dfSatirlar = await db.satirlar(
    `SELECT terim, COUNT(*)::int AS df FROM zeka_terimleri
      WHERE terim = ANY($1::text[]) GROUP BY terim`,
    [terimler.slice(0, 400)],
  );
  const df = new Map(dfSatirlar.map((r) => [r.terim, r.df]));
  const toplam = await db.tekSatir('SELECT GREATEST(COUNT(*),1)::int AS n FROM zeka_belgeleri');

  const puanli = terimler
    .map((t) => ({
      terim: t,
      puan: (sayac.get(t) || 0) * Math.log(1 + toplam.n / Math.max(1, df.get(t) || 1)),
    }))
    .sort((a, b) => b.puan - a.puan)
    .slice(0, 18)
    .map((x) => x.terim);

  const { sonuclar } = await ara(puanli.join(' '), { limit: limit + 4 });
  return sonuclar
    .filter((s) => !(s.kaynak_tur === kaynakTur && Number(s.kaynak_id) === Number(kaynakId)))
    .slice(0, limit);
}

// ------------------------------------------------------- DIZINI YENIDEN KUR

/**
 * Tum arsivi bastan dizine yazar. Buyuk arsivlerde biraz surer; arayuzden
 * elle tetiklenir ve ilerleme geri bildirimi uretir.
 * @param {(bilgi:object)=>void} [ilerleme]
 */
async function yenidenKur(ilerleme) {
  const bildir = (bilgi) => { if (typeof ilerleme === 'function') ilerleme(bilgi); };
  const sayim = { kayit: 0, belge: 0, dosya: 0, varlik: 0, olay: 0, hafiza: 0, vaka: 0, parca: 0 };

  await db.sorgu('TRUNCATE zeka_terimleri, zeka_belgeleri RESTART IDENTITY');
  bildir({ adim: 'temizlendi' });

  // --- Kayitlar ---
  // Zaman ve bagli varlik adlari da metne katilir: "ne zaman" / "kim"
  // sorulari ancak bu bilgi aranabilir oldugunda yanitlanabilir.
  const kayitlar = await db.satirlar(
    `SELECT k.id, k.kod, k.baslik, k.govde, k.ozet, k.tasnif, k.etiketler, k.konum, k.tur,
            COALESCE(k.olay_zamani, k.olusturuldu_at) AS zaman,
            (SELECT string_agg(v.ad, ', ') FROM kayit_varliklari kv
               JOIN varliklar v ON v.id = kv.varlik_id AND v.silindi = FALSE
              WHERE kv.kayit_id = k.id) AS varlik_adlari
       FROM kayitlar k WHERE k.silindi = FALSE`,
  );
  for (const k of kayitlar) {
    const govde = [
      k.govde, k.ozet, (k.etiketler || []).join(' '), k.konum, k.tur,
      zamanMetniYerel(k.zaman),
      k.varlik_adlari ? `Ilgili varliklar: ${k.varlik_adlari}` : null,
    ].filter(Boolean).join('\n');
    const r = await yaz({ kaynakTur: 'kayit', kaynakId: k.id, baslik: `${k.kod} ${k.baslik}`, metin: govde, tasnif: k.tasnif });
    sayim.kayit++;
    sayim.parca += r.parca;
  }
  bildir({ adim: 'kayitlar', sayi: sayim.kayit });

  // --- Belgeler (dahili editor) ---
  const belgeler = await db.satirlar('SELECT id, baslik, icerik FROM belgeler WHERE silindi = FALSE');
  for (const b of belgeler) {
    const r = await yaz({ kaynakTur: 'belge', kaynakId: b.id, baslik: b.baslik, metin: b.icerik });
    sayim.belge++;
    sayim.parca += r.parca;
  }
  bildir({ adim: 'belgeler', sayi: sayim.belge });

  // --- Cozumlenmis dosyalar ---
  const cozumlemeler = await db.satirlar(
    `SELECT c.dosya_id, c.metin, c.ozet, d.ad
       FROM belge_cozumleme c
       JOIN dosyalar d ON d.id = c.dosya_id
      WHERE c.dosya_id IS NOT NULL AND d.silindi = FALSE AND c.metin <> ''`,
  );
  for (const c of cozumlemeler) {
    const r = await yaz({ kaynakTur: 'dosya', kaynakId: c.dosya_id, baslik: c.ad, metin: `${c.ozet || ''}\n${c.metin}` });
    sayim.dosya++;
    sayim.parca += r.parca;
  }
  bildir({ adim: 'dosyalar', sayi: sayim.dosya });

  // --- Varliklar ---
  const varliklar = await db.satirlar(
    `SELECT id, kod, ad, takma_adlar, ozet, detay, tasnif, etiketler, adres, tur
       FROM varliklar WHERE silindi = FALSE`,
  );
  for (const v of varliklar) {
    const govde = [
      (v.takma_adlar || []).join(', '), v.ozet, v.detay,
      (v.etiketler || []).join(' '), v.adres, v.tur,
    ].filter(Boolean).join('\n');
    const r = await yaz({ kaynakTur: 'varlik', kaynakId: v.id, baslik: `${v.kod} ${v.ad}`, metin: govde, tasnif: v.tasnif });
    sayim.varlik++;
    sayim.parca += r.parca;
  }
  bildir({ adim: 'varliklar', sayi: sayim.varlik });

  // --- Olaylar ---
  const olaylar = await db.satirlar(
    `SELECT o.id, o.kod, o.baslik, o.aciklama, o.konum, o.tasnif, o.etiketler, o.tur, o.zaman,
            (SELECT string_agg(v.ad, ', ') FROM olay_varliklari ov
               JOIN varliklar v ON v.id = ov.varlik_id AND v.silindi = FALSE
              WHERE ov.olay_id = o.id) AS varlik_adlari
       FROM olaylar o WHERE o.silindi = FALSE`,
  );
  for (const o of olaylar) {
    const govde = [
      o.aciklama, o.konum, (o.etiketler || []).join(' '), o.tur,
      zamanMetniYerel(o.zaman),
      o.varlik_adlari ? `Ilgili varliklar: ${o.varlik_adlari}` : null,
    ].filter(Boolean).join('\n');
    const r = await yaz({ kaynakTur: 'olay', kaynakId: o.id, baslik: `${o.kod} ${o.baslik}`, metin: govde, tasnif: o.tasnif });
    sayim.olay++;
    sayim.parca += r.parca;
  }
  bildir({ adim: 'olaylar', sayi: sayim.olay });

  // --- Vakalar ---
  const vakalar = await db.satirlar('SELECT id, kod, ad, kod_adi, aciklama, tasnif FROM vakalar WHERE silindi = FALSE');
  for (const v of vakalar) {
    const r = await yaz({
      kaynakTur: 'vaka', kaynakId: v.id,
      baslik: `${v.kod} ${v.ad}${v.kod_adi ? ' / ' + v.kod_adi : ''}`,
      metin: v.aciklama || '', tasnif: v.tasnif,
    });
    sayim.vaka++;
    sayim.parca += r.parca;
  }

  // --- Cambaz hafizasi ---
  const hafiza = await db.satirlar('SELECT id, baslik, icerik FROM cambaz_hafiza');
  for (const h of hafiza) {
    const r = await yaz({ kaynakTur: 'hafiza', kaynakId: h.id, baslik: h.baslik, metin: h.icerik });
    sayim.hafiza++;
    sayim.parca += r.parca;
  }
  bildir({ adim: 'tamamlandi', sayim });

  return sayim;
}

/** Dizin durumu (arayuz gostergesi). */
async function durum() {
  const genel = await db.tekSatir(`
    SELECT COUNT(*)::int AS parca,
           COUNT(DISTINCT (kaynak_tur, kaynak_id))::int AS kaynak,
           COALESCE(ROUND(AVG(uzunluk))::int, 0) AS ort_uzunluk,
           MAX(guncellendi_at) AS son_guncelleme
      FROM zeka_belgeleri`);
  const terim = await db.tekSatir(`
    SELECT COUNT(*)::int AS kayit, COUNT(DISTINCT terim)::int AS tekil
      FROM zeka_terimleri`);
  const turler = await db.satirlar(`
    SELECT kaynak_tur, COUNT(DISTINCT kaynak_id)::int AS sayi, COUNT(*)::int AS parca
      FROM zeka_belgeleri GROUP BY kaynak_tur ORDER BY sayi DESC`);

  return { ...genel, ...terim, turler };
}

/** En sik gecen terimler (dizin saglik gostergesi / konu haritasi). */
async function sikTerimler(adet = 40) {
  return db.satirlar(
    `SELECT terim, SUM(sayi)::int AS toplam, COUNT(*)::int AS belge
       FROM zeka_terimleri
      GROUP BY terim
      HAVING COUNT(*) > 1
      ORDER BY toplam DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(adet) || 40, 1), 200)],
  );
}

module.exports = {
  yaz, sil, ara, benzerler, yenidenKur, durum, sikTerimler, parcala,
  alintiCikar, KAYNAK_TURLERI, PARCA_KELIME,
};
