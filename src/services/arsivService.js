'use strict';
/**
 * src/services/arsivService.js
 * ISTIHBARAT ARSIVI SERVISI
 *
 * Varlik, iliski, kayit, olay, vaka ve kaynak kayitlarinin tum yasam dongusu.
 * Her yazma islemi:
 *   1) parametreli SQL ile veritabanina yazilir (SQL enjeksiyonu imkansiz),
 *   2) DENETIM IZINE islenir (kim, ne zaman, neyi, hangi degerle degistirdi),
 *   3) YEREL ARAMA DIZININE yansitilir (zeka motoru aninda gorsun),
 *   4) IZLEME KURALLARINDAN gecirilir (gerekirse uyari uretir).
 */

const db = require('../config/db');
const dogrula = require('../utils/validate');
const log = require('./logService');
const dizin = require('../zeka/dizin');
const dil = require('../zeka/dil');
const nd = require('../zeka/dogalDil');
const uyariService = require('./uyariService');

// --------------------------------------------------------------- SABITLER

const TASNIFLER = ['acik', 'hizmete_ozel', 'gizli', 'cok_gizli'];
const GUVENILIRLIKLER = ['A', 'B', 'C', 'D', 'E', 'F'];
const VARLIK_TURLERI = ['kisi', 'kurum', 'konum', 'arac', 'telefon', 'eposta', 'hesap',
  'web', 'cihaz', 'maddi', 'kod_adi', 'grup', 'etkinlik', 'diger'];
const VARLIK_DURUMLARI = ['aktif', 'izlemede', 'pasif', 'arsiv', 'elendi'];
const ILISKI_TURLERI = ['akrabalik', 'is', 'ortaklik', 'uyelik', 'sahiplik', 'iletisim',
  'finansal', 'husumet', 'lojistik', 'konum', 'ayni_kisi', 'diger'];
const KAYIT_TURLERI = ['ihbar', 'gozlem', 'rapor', 'analiz', 'sinyal', 'acik_kaynak',
  'tutanak', 'gorusme', 'teknik', 'ozet'];
const KAYIT_DURUMLARI = ['yeni', 'incelemede', 'dogrulandi', 'yalanlandi', 'arsiv'];
const OLAY_TURLERI = ['toplanti', 'seyahat', 'iletisim', 'islem', 'olay', 'tespit', 'operasyon', 'diger'];
const KAYNAK_TURLERI = ['insan', 'acik_kaynak', 'sinyal', 'teknik', 'belge', 'kurum', 'anonim', 'dahili'];
const VAKA_DURUMLARI = ['acik', 'askida', 'kapali', 'arsiv'];
const ONCELIKLER = ['dusuk', 'orta', 'yuksek', 'kritik'];

const TASNIF_DERECESI = { acik: 0, hizmete_ozel: 1, gizli: 2, cok_gizli: 3 };

// -------------------------------------------------------------- YARDIMCILAR

function secenek(deger, izinli, varsayilan) {
  const d = String(deger || '').trim();
  return izinli.includes(d) ? d : varsayilan;
}

function tamSayi(deger, { min = 0, max = 100, varsayilan = 50 } = {}) {
  const n = Number(deger);
  if (!Number.isFinite(n)) return varsayilan;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Virgulle ayrilmis ya da dizi halinde gelen etiketleri temizler. */
function etiketListesi(girdi, { max = 24 } = {}) {
  const ham = Array.isArray(girdi) ? girdi : String(girdi || '').split(/[,;\n]/);
  const sonuc = [];
  for (const e of ham) {
    const temiz = dogrula.metin(e, { max: 48 });
    if (!temiz) continue;
    if (sonuc.some((x) => dil.normalize(x) === dil.normalize(temiz))) continue;
    sonuc.push(temiz);
    if (sonuc.length >= max) break;
  }
  return sonuc;
}

function koordinat(deger, sinir) {
  const n = Number(String(deger || '').replace(',', '.'));
  if (!Number.isFinite(n) || Math.abs(n) > sinir) return null;
  return n;
}

function tarihDegeri(deger) {
  if (!deger) return null;
  const d = new Date(deger);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function nesneDegeri(deger) {
  if (!deger) return {};
  if (typeof deger === 'object') return deger;
  try {
    const cozulen = JSON.parse(String(deger));
    return cozulen && typeof cozulen === 'object' ? cozulen : {};
  } catch { return {}; }
}

/** Operatorun gorebilecegi en ust tasnife gore SQL kosulu uretir. */
function tasnifKosulu(enUstTasnif, alan = 'tasnif') {
  if (!enUstTasnif || TASNIF_DERECESI[enUstTasnif] === undefined) return null;
  const izinli = TASNIFLER.filter((t) => TASNIF_DERECESI[t] <= TASNIF_DERECESI[enUstTasnif]);
  return { sql: `${alan} = ANY($#::text[])`, deger: izinli };
}

// ------------------------------------------------------------- DENETIM IZI

/**
 * Denetim izine kayit dusur. Arsivde "kim neyi degistirdi" sorusunun
 * cevabi her zaman burada durur; silinen kayitlarin izi de kalir.
 */
async function denetimYaz({ ogeTur, ogeId, eylem, yoneticiId = null, onceki = null, sonraki = null, aciklama = null, ip = null }) {
  try {
    await db.sorgu(
      `INSERT INTO denetim_izi (oge_tur, oge_id, eylem, yonetici_id, onceki, sonraki, aciklama, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        ogeTur, ogeId || null, eylem, yoneticiId,
        onceki ? JSON.stringify(onceki) : null,
        sonraki ? JSON.stringify(sonraki) : null,
        aciklama, ip || null,
      ],
    );
  } catch (hata) {
    await log.uyari({ kategori: 'arsiv', olay: 'denetim_yazilamadi', mesaj: hata.message });
  }
}

async function denetimListele({ ogeTur = null, ogeId = null, limit = 60 } = {}) {
  const kosullar = [];
  const parametreler = [];
  if (ogeTur) { parametreler.push(ogeTur); kosullar.push(`d.oge_tur = $${parametreler.length}`); }
  if (ogeId) { parametreler.push(Number(ogeId)); kosullar.push(`d.oge_id = $${parametreler.length}`); }
  parametreler.push(Math.min(Math.max(Number(limit) || 60, 1), 300));

  return db.satirlar(
    `SELECT d.*, y.kullanici_adi, y.gorunen_ad
       FROM denetim_izi d
       LEFT JOIN yoneticiler y ON y.id = d.yonetici_id
      ${kosullar.length ? 'WHERE ' + kosullar.join(' AND ') : ''}
      ORDER BY d.olusturuldu_at DESC
      LIMIT $${parametreler.length}`,
    parametreler,
  );
}

// ================================================================ VARLIKLAR

/** Varlik olusturur. */
async function varlikOlustur(girdi, { yoneticiId = null, ip = null } = {}) {
  const ad = dogrula.metin(girdi.ad, { max: 180 });
  if (!ad) return { tamam: false, hata: 'Varlik adi zorunludur.' };

  const satir = await db.tekSatir(
    `INSERT INTO varliklar
       (tur, ad, takma_adlar, ozet, detay, tasnif, guvenilirlik, dogruluk, durum,
        onem, ulke, adres, enlem, boylam, baslangic_tarihi, bitis_tarihi,
        ozellikler, etiketler, renk, olusturan_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING *`,
    [
      secenek(girdi.tur, VARLIK_TURLERI, 'kisi'),
      ad,
      etiketListesi(girdi.takma_adlar, { max: 12 }),
      dogrula.metin(girdi.ozet, { max: 2000 }) || null,
      dogrula.metin(girdi.detay, { max: 20000 }) || null,
      secenek(girdi.tasnif, TASNIFLER, 'hizmete_ozel'),
      secenek(girdi.guvenilirlik, GUVENILIRLIKLER, 'C'),
      tamSayi(girdi.dogruluk, { min: 1, max: 6, varsayilan: 3 }),
      secenek(girdi.durum, VARLIK_DURUMLARI, 'aktif'),
      tamSayi(girdi.onem, { min: 0, max: 100, varsayilan: 50 }),
      dogrula.metin(girdi.ulke, { max: 80 }) || null,
      dogrula.metin(girdi.adres, { max: 400 }) || null,
      koordinat(girdi.enlem, 90),
      koordinat(girdi.boylam, 180),
      tarihDegeri(girdi.baslangic_tarihi),
      tarihDegeri(girdi.bitis_tarihi),
      JSON.stringify(nesneDegeri(girdi.ozellikler)),
      etiketListesi(girdi.etiketler),
      dogrula.metin(girdi.renk, { max: 16 }) || '#00ff9c',
      yoneticiId,
    ],
  );

  await Promise.all([
    denetimYaz({ ogeTur: 'varlik', ogeId: satir.id, eylem: 'olusturma', yoneticiId, sonraki: { ad: satir.ad, tur: satir.tur, tasnif: satir.tasnif }, ip }),
    dizinYenile('varlik', satir.id),
    log.bilgi({ kategori: 'arsiv', olay: 'varlik_olusturuldu', mesaj: `${satir.kod} ${satir.ad}`, yoneticiId }),
  ]);

  uyariService.ogeDegerlendir({ ogeTur: 'varlik', ogeId: satir.id, baslik: satir.ad, metin: `${satir.ad} ${satir.ozet || ''}`, varlikId: satir.id }).catch(() => {});

  return { tamam: true, varlik: satir };
}

/** Varligi guncelleyip degisiklikleri denetim izine yazar. */
async function varlikGuncelle(id, girdi, { yoneticiId = null, ip = null } = {}) {
  const mevcut = await varlikGetir(id);
  if (!mevcut) return { tamam: false, hata: 'Varlik bulunamadi.' };

  const yeni = {
    tur: secenek(girdi.tur, VARLIK_TURLERI, mevcut.tur),
    ad: dogrula.metin(girdi.ad, { max: 180 }) || mevcut.ad,
    takma_adlar: girdi.takma_adlar !== undefined ? etiketListesi(girdi.takma_adlar, { max: 12 }) : mevcut.takma_adlar,
    ozet: girdi.ozet !== undefined ? (dogrula.metin(girdi.ozet, { max: 2000 }) || null) : mevcut.ozet,
    detay: girdi.detay !== undefined ? (dogrula.metin(girdi.detay, { max: 20000 }) || null) : mevcut.detay,
    tasnif: secenek(girdi.tasnif, TASNIFLER, mevcut.tasnif),
    guvenilirlik: secenek(girdi.guvenilirlik, GUVENILIRLIKLER, mevcut.guvenilirlik),
    dogruluk: girdi.dogruluk !== undefined ? tamSayi(girdi.dogruluk, { min: 1, max: 6, varsayilan: mevcut.dogruluk }) : mevcut.dogruluk,
    durum: secenek(girdi.durum, VARLIK_DURUMLARI, mevcut.durum),
    onem: girdi.onem !== undefined ? tamSayi(girdi.onem, { varsayilan: mevcut.onem }) : mevcut.onem,
    ulke: girdi.ulke !== undefined ? (dogrula.metin(girdi.ulke, { max: 80 }) || null) : mevcut.ulke,
    adres: girdi.adres !== undefined ? (dogrula.metin(girdi.adres, { max: 400 }) || null) : mevcut.adres,
    enlem: girdi.enlem !== undefined ? koordinat(girdi.enlem, 90) : mevcut.enlem,
    boylam: girdi.boylam !== undefined ? koordinat(girdi.boylam, 180) : mevcut.boylam,
    baslangic_tarihi: girdi.baslangic_tarihi !== undefined ? tarihDegeri(girdi.baslangic_tarihi) : mevcut.baslangic_tarihi,
    bitis_tarihi: girdi.bitis_tarihi !== undefined ? tarihDegeri(girdi.bitis_tarihi) : mevcut.bitis_tarihi,
    ozellikler: girdi.ozellikler !== undefined ? nesneDegeri(girdi.ozellikler) : mevcut.ozellikler,
    etiketler: girdi.etiketler !== undefined ? etiketListesi(girdi.etiketler) : mevcut.etiketler,
    renk: dogrula.metin(girdi.renk, { max: 16 }) || mevcut.renk,
  };

  const satir = await db.tekSatir(
    `UPDATE varliklar SET
       tur=$2, ad=$3, takma_adlar=$4, ozet=$5, detay=$6, tasnif=$7, guvenilirlik=$8,
       dogruluk=$9, durum=$10, onem=$11, ulke=$12, adres=$13, enlem=$14, boylam=$15,
       baslangic_tarihi=$16, bitis_tarihi=$17, ozellikler=$18, etiketler=$19, renk=$20
     WHERE id=$1 AND silindi = FALSE
     RETURNING *`,
    [
      Number(id), yeni.tur, yeni.ad, yeni.takma_adlar, yeni.ozet, yeni.detay, yeni.tasnif,
      yeni.guvenilirlik, yeni.dogruluk, yeni.durum, yeni.onem, yeni.ulke, yeni.adres,
      yeni.enlem, yeni.boylam, yeni.baslangic_tarihi, yeni.bitis_tarihi,
      JSON.stringify(yeni.ozellikler), yeni.etiketler, yeni.renk,
    ],
  );
  if (!satir) return { tamam: false, hata: 'Varlik guncellenemedi.' };

  // Yalnizca degisen alanlari denetim izine yaz
  const degisenler = {};
  for (const alan of Object.keys(yeni)) {
    const a = JSON.stringify(mevcut[alan] ?? null);
    const b = JSON.stringify(satir[alan] ?? null);
    if (a !== b) degisenler[alan] = { onceki: mevcut[alan], sonraki: satir[alan] };
  }

  if (Object.keys(degisenler).length) {
    const tasnifDegisti = Boolean(degisenler.tasnif);
    await denetimYaz({
      ogeTur: 'varlik', ogeId: satir.id,
      eylem: tasnifDegisti ? 'tasnif_degisimi' : 'guncelleme',
      yoneticiId, onceki: Object.fromEntries(Object.entries(degisenler).map(([k, v]) => [k, v.onceki])),
      sonraki: Object.fromEntries(Object.entries(degisenler).map(([k, v]) => [k, v.sonraki])),
      ip,
    });
    await dizinYenile('varlik', satir.id);
  }

  return { tamam: true, varlik: satir, degisen: Object.keys(degisenler) };
}

async function varlikGetir(id) {
  return db.tekSatir('SELECT * FROM varliklar WHERE id = $1 AND silindi = FALSE', [Number(id)]);
}

async function varlikKodIle(kod) {
  return db.tekSatir('SELECT * FROM varliklar WHERE upper(kod) = upper($1) AND silindi = FALSE', [String(kod)]);
}

/**
 * Varlik listesi: cok olcutlu filtre + siralama + sayfalama.
 */
async function varlikListele({
  arama = '', tur = null, durum = null, tasnif = null, etiket = null,
  enAzOnem = null, vakaId = null, enUstTasnif = null,
  sirala = 'guncel', limit = 50, kayma = 0,
} = {}) {
  const kosullar = ['v.silindi = FALSE'];
  const parametreler = [];
  const ekle = (sql, deger) => {
    parametreler.push(deger);
    kosullar.push(sql.replace('$#', `$${parametreler.length}`));
  };

  const temizArama = dogrula.metin(arama, { max: 120 });
  if (temizArama) {
    parametreler.push(temizArama);
    const p = parametreler.length;
    kosullar.push(`(v.arama @@ plainto_tsquery('simple', arsiv_normalize($${p}))
                    OR arsiv_normalize(v.ad) LIKE '%' || arsiv_normalize($${p}) || '%'
                    OR upper(v.kod) = upper($${p}))`);
  }
  if (tur) ekle('v.tur = $#', secenek(tur, VARLIK_TURLERI, 'kisi'));
  if (durum) ekle('v.durum = $#', secenek(durum, VARLIK_DURUMLARI, 'aktif'));
  if (tasnif) ekle('v.tasnif = $#', secenek(tasnif, TASNIFLER, 'hizmete_ozel'));
  if (etiket) ekle('$# = ANY(v.etiketler)', String(etiket).slice(0, 48));
  if (enAzOnem !== null && enAzOnem !== '') ekle('v.onem >= $#', tamSayi(enAzOnem, { varsayilan: 0 }));
  if (vakaId) ekle("EXISTS (SELECT 1 FROM vaka_ogeleri vo WHERE vo.vaka_id = $# AND vo.oge_tur = 'varlik' AND vo.oge_id = v.id)", Number(vakaId));

  const tk = tasnifKosulu(enUstTasnif, 'v.tasnif');
  if (tk) ekle(tk.sql, tk.deger);

  const siralamalar = {
    guncel: 'v.guncellendi_at DESC',
    yeni: 'v.olusturuldu_at DESC',
    onem: 'v.onem DESC, v.guncellendi_at DESC',
    ad: 'arsiv_normalize(v.ad) ASC',
    tur: 'v.tur ASC, arsiv_normalize(v.ad) ASC',
    baglanti: 'iliski_sayisi DESC, v.onem DESC',
    kayit: 'kayit_sayisi DESC, v.onem DESC',
  };
  const siraSql = siralamalar[sirala] || siralamalar.guncel;

  parametreler.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const limitP = parametreler.length;
  parametreler.push(Math.max(Number(kayma) || 0, 0));
  const kaymaP = parametreler.length;

  const satirlar = await db.satirlar(
    `SELECT v.*,
            (SELECT COUNT(*)::int FROM varlik_iliskileri i
              WHERE i.kaynak_varlik_id = v.id OR i.hedef_varlik_id = v.id) AS iliski_sayisi,
            (SELECT COUNT(*)::int FROM kayit_varliklari kv JOIN kayitlar k ON k.id = kv.kayit_id
              WHERE kv.varlik_id = v.id AND k.silindi = FALSE) AS kayit_sayisi,
            (SELECT COUNT(*)::int FROM olay_varliklari ov JOIN olaylar o ON o.id = ov.olay_id
              WHERE ov.varlik_id = v.id AND o.silindi = FALSE) AS olay_sayisi
       FROM varliklar v
      WHERE ${kosullar.join(' AND ')}
      ORDER BY ${siraSql}
      LIMIT $${limitP} OFFSET $${kaymaP}`,
    parametreler,
  );

  const sayim = await db.tekSatir(
    `SELECT COUNT(*)::int AS n FROM varliklar v WHERE ${kosullar.join(' AND ')}`,
    parametreler.slice(0, limitP - 1),
  );

  return { varliklar: satirlar, toplam: sayim ? sayim.n : satirlar.length };
}

async function varlikSil(id, { yoneticiId = null, ip = null } = {}) {
  const mevcut = await varlikGetir(id);
  if (!mevcut) return { tamam: false, hata: 'Varlik bulunamadi.' };

  await db.sorgu('UPDATE varliklar SET silindi = TRUE, silindi_at = NOW() WHERE id = $1', [Number(id)]);
  await Promise.all([
    dizin.sil('varlik', id),
    denetimYaz({ ogeTur: 'varlik', ogeId: Number(id), eylem: 'silme', yoneticiId, onceki: { ad: mevcut.ad, kod: mevcut.kod }, ip }),
    log.uyari({ kategori: 'arsiv', olay: 'varlik_silindi', mesaj: `${mevcut.kod} ${mevcut.ad}`, yoneticiId }),
  ]);
  return { tamam: true };
}

/**
 * Iki varligi birlestirir: kaynak varligin tum baglantilari hedefe tasinir,
 * kaynak varlik arsive dusurulur. Tekrarli kayitlari temizlemek icin.
 */
async function varlikBirlestir(kaynakId, hedefId, { yoneticiId = null, ip = null } = {}) {
  const [kaynak, hedef] = await Promise.all([varlikGetir(kaynakId), varlikGetir(hedefId)]);
  if (!kaynak || !hedef) return { tamam: false, hata: 'Varliklardan biri bulunamadi.' };
  if (Number(kaynakId) === Number(hedefId)) return { tamam: false, hata: 'Bir varlik kendisiyle birlestirilemez.' };

  const sayim = { iliski: 0, kayit: 0, olay: 0, ek: 0 };

  await db.islem(async (istemci) => {
    // Iliskileri tasi (cakisanlari at)
    const i1 = await istemci.query(
      `UPDATE varlik_iliskileri SET kaynak_varlik_id = $2
        WHERE kaynak_varlik_id = $1 AND hedef_varlik_id <> $2
          AND NOT EXISTS (
            SELECT 1 FROM varlik_iliskileri x
             WHERE x.kaynak_varlik_id = $2 AND x.hedef_varlik_id = varlik_iliskileri.hedef_varlik_id
               AND x.tur = varlik_iliskileri.tur)`,
      [Number(kaynakId), Number(hedefId)],
    );
    const i2 = await istemci.query(
      `UPDATE varlik_iliskileri SET hedef_varlik_id = $2
        WHERE hedef_varlik_id = $1 AND kaynak_varlik_id <> $2
          AND NOT EXISTS (
            SELECT 1 FROM varlik_iliskileri x
             WHERE x.hedef_varlik_id = $2 AND x.kaynak_varlik_id = varlik_iliskileri.kaynak_varlik_id
               AND x.tur = varlik_iliskileri.tur)`,
      [Number(kaynakId), Number(hedefId)],
    );
    sayim.iliski = i1.rowCount + i2.rowCount;

    await istemci.query('DELETE FROM varlik_iliskileri WHERE kaynak_varlik_id = $1 OR hedef_varlik_id = $1', [Number(kaynakId)]);

    const k = await istemci.query(
      `UPDATE kayit_varliklari SET varlik_id = $2
        WHERE varlik_id = $1
          AND NOT EXISTS (SELECT 1 FROM kayit_varliklari x
                           WHERE x.kayit_id = kayit_varliklari.kayit_id AND x.varlik_id = $2
                             AND x.rol = kayit_varliklari.rol)`,
      [Number(kaynakId), Number(hedefId)],
    );
    sayim.kayit = k.rowCount;
    await istemci.query('DELETE FROM kayit_varliklari WHERE varlik_id = $1', [Number(kaynakId)]);

    const o = await istemci.query(
      `UPDATE olay_varliklari SET varlik_id = $2
        WHERE varlik_id = $1
          AND NOT EXISTS (SELECT 1 FROM olay_varliklari x
                           WHERE x.olay_id = olay_varliklari.olay_id AND x.varlik_id = $2
                             AND x.rol = olay_varliklari.rol)`,
      [Number(kaynakId), Number(hedefId)],
    );
    sayim.olay = o.rowCount;
    await istemci.query('DELETE FROM olay_varliklari WHERE varlik_id = $1', [Number(kaynakId)]);

    const e = await istemci.query(
      `UPDATE varlik_ekleri SET varlik_id = $2
        WHERE varlik_id = $1
          AND NOT EXISTS (SELECT 1 FROM varlik_ekleri x
                           WHERE x.varlik_id = $2 AND x.oge_tur = varlik_ekleri.oge_tur
                             AND x.oge_id = varlik_ekleri.oge_id)`,
      [Number(kaynakId), Number(hedefId)],
    );
    sayim.ek = e.rowCount;
    await istemci.query('DELETE FROM varlik_ekleri WHERE varlik_id = $1', [Number(kaynakId)]);

    // Takma adlari ve etiketleri hedefe ekle
    await istemci.query(
      `UPDATE varliklar SET
         takma_adlar = (SELECT ARRAY(SELECT DISTINCT e FROM UNNEST(takma_adlar || $2::text[] || ARRAY[$3]::text[]) e WHERE e IS NOT NULL AND e <> '')),
         etiketler   = (SELECT ARRAY(SELECT DISTINCT e FROM UNNEST(etiketler || $4::text[]) e WHERE e IS NOT NULL AND e <> '')),
         onem = GREATEST(onem, $5)
       WHERE id = $1`,
      [Number(hedefId), kaynak.takma_adlar || [], kaynak.ad, kaynak.etiketler || [], kaynak.onem],
    );

    await istemci.query('UPDATE varliklar SET silindi = TRUE, silindi_at = NOW() WHERE id = $1', [Number(kaynakId)]);
  });

  await Promise.all([
    dizin.sil('varlik', kaynakId),
    dizinYenile('varlik', hedefId),
    denetimYaz({
      ogeTur: 'varlik', ogeId: Number(hedefId), eylem: 'guncelleme', yoneticiId,
      onceki: { birlestirilen: kaynak.kod, ad: kaynak.ad },
      sonraki: { hedef: hedef.kod, tasinan: sayim },
      aciklama: `${kaynak.kod} -> ${hedef.kod} birlestirme`, ip,
    }),
  ]);

  return { tamam: true, sayim, hedef: await varlikGetir(hedefId) };
}

// ================================================================ ILISKILER

async function iliskiEkle(girdi, { yoneticiId = null, ip = null } = {}) {
  const kaynakId = Number(girdi.kaynak_varlik_id);
  const hedefId = Number(girdi.hedef_varlik_id);
  if (!Number.isInteger(kaynakId) || !Number.isInteger(hedefId)) {
    return { tamam: false, hata: 'Iliskinin iki ucu da secilmelidir.' };
  }
  if (kaynakId === hedefId) return { tamam: false, hata: 'Varlik kendisiyle iliskilendirilemez.' };

  const [a, b] = await Promise.all([varlikGetir(kaynakId), varlikGetir(hedefId)]);
  if (!a || !b) return { tamam: false, hata: 'Varliklardan biri bulunamadi.' };

  const satir = await db.tekSatir(
    `INSERT INTO varlik_iliskileri
       (kaynak_varlik_id, hedef_varlik_id, tur, etiket, yon, guc, guvenilirlik,
        baslangic, bitis, aciklama, kanit_kayit_id, otomatik, olusturan_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (kaynak_varlik_id, hedef_varlik_id, tur, COALESCE(lower(etiket), ''))
       DO UPDATE SET guc = EXCLUDED.guc, guvenilirlik = EXCLUDED.guvenilirlik,
                     aciklama = COALESCE(EXCLUDED.aciklama, varlik_iliskileri.aciklama),
                     yon = EXCLUDED.yon, guncellendi_at = NOW()
     RETURNING *`,
    [
      kaynakId, hedefId,
      secenek(girdi.tur, ILISKI_TURLERI, 'iletisim'),
      dogrula.metin(girdi.etiket, { max: 80 }) || null,
      secenek(girdi.yon, ['tek', 'cift'], 'cift'),
      tamSayi(girdi.guc, { varsayilan: 50 }),
      secenek(girdi.guvenilirlik, GUVENILIRLIKLER, 'C'),
      tarihDegeri(girdi.baslangic),
      tarihDegeri(girdi.bitis),
      dogrula.metin(girdi.aciklama, { max: 2000 }) || null,
      girdi.kanit_kayit_id ? Number(girdi.kanit_kayit_id) : null,
      Boolean(girdi.otomatik),
      yoneticiId,
    ],
  );

  await denetimYaz({
    ogeTur: 'iliski', ogeId: satir.id, eylem: 'baglanti', yoneticiId,
    sonraki: { kaynak: a.kod, hedef: b.kod, tur: satir.tur, guc: satir.guc }, ip,
  });

  return { tamam: true, iliski: satir };
}

async function iliskiSil(id, { yoneticiId = null, ip = null } = {}) {
  const mevcut = await db.tekSatir('SELECT * FROM varlik_iliskileri WHERE id = $1', [Number(id)]);
  if (!mevcut) return { tamam: false, hata: 'Iliski bulunamadi.' };
  await db.sorgu('DELETE FROM varlik_iliskileri WHERE id = $1', [Number(id)]);
  await denetimYaz({ ogeTur: 'iliski', ogeId: Number(id), eylem: 'silme', yoneticiId, onceki: mevcut, ip });
  return { tamam: true };
}

async function iliskiListele(varlikId, { limit = 200 } = {}) {
  return db.satirlar(
    `SELECT i.*,
            k.ad AS kaynak_ad, k.kod AS kaynak_kod, k.tur AS kaynak_varlik_tur, k.renk AS kaynak_renk,
            h.ad AS hedef_ad,  h.kod AS hedef_kod,  h.tur AS hedef_varlik_tur,  h.renk AS hedef_renk
       FROM varlik_iliskileri i
       JOIN varliklar k ON k.id = i.kaynak_varlik_id AND k.silindi = FALSE
       JOIN varliklar h ON h.id = i.hedef_varlik_id AND h.silindi = FALSE
      ${varlikId ? 'WHERE i.kaynak_varlik_id = $1 OR i.hedef_varlik_id = $1' : ''}
      ORDER BY i.guc DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 200, 1), 2000)}`,
    varlikId ? [Number(varlikId)] : [],
  );
}

// ================================================================== KAYITLAR

async function kayitOlustur(girdi, { yoneticiId = null, ip = null } = {}) {
  const baslik = dogrula.metin(girdi.baslik, { max: 300 });
  if (!baslik) return { tamam: false, hata: 'Kayit basligi zorunludur.' };
  return kayitOlusturIc(girdi, baslik, { yoneticiId, ip });
}

async function kayitOlusturIc(girdi, baslik, { yoneticiId, ip }) {
  const govde = dogrula.metin(girdi.govde, { max: 200_000 }) || '';
  const satir = await db.tekSatir(
    `INSERT INTO kayitlar
       (baslik, govde, tur, kaynak_id, vaka_id, tasnif, guvenilirlik, dogruluk, durum,
        olay_zamani, konum, enlem, boylam, etiketler, ozet, anahtar_kelimeler, olusturan_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      baslik, govde,
      secenek(girdi.tur, KAYIT_TURLERI, 'rapor'),
      girdi.kaynak_id ? Number(girdi.kaynak_id) : null,
      girdi.vaka_id ? Number(girdi.vaka_id) : null,
      secenek(girdi.tasnif, TASNIFLER, 'hizmete_ozel'),
      secenek(girdi.guvenilirlik, GUVENILIRLIKLER, 'C'),
      tamSayi(girdi.dogruluk, { min: 1, max: 6, varsayilan: 3 }),
      secenek(girdi.durum, KAYIT_DURUMLARI, 'yeni'),
      tarihDegeri(girdi.olay_zamani),
      dogrula.metin(girdi.konum, { max: 200 }) || null,
      koordinat(girdi.enlem, 90),
      koordinat(girdi.boylam, 180),
      etiketListesi(girdi.etiketler),
      dogrula.metin(girdi.ozet, { max: 3000 }) || null,
      etiketListesi(girdi.anahtar_kelimeler, { max: 20 }),
      yoneticiId,
    ],
  );

  if (girdi.kaynak_id) {
    await db.sorgu('UPDATE kaynaklar SET kayit_sayisi = kayit_sayisi + 1 WHERE id = $1', [Number(girdi.kaynak_id)]);
  }
  if (Array.isArray(girdi.varlik_ids)) {
    for (const vid of girdi.varlik_ids.slice(0, 40)) {
      await kayitVarlikBagla(satir.id, vid, 'ilgili');
    }
  }

  await Promise.all([
    surumYaz(satir, yoneticiId),
    dizinYenile('kayit', satir.id),
    denetimYaz({ ogeTur: 'kayit', ogeId: satir.id, eylem: 'olusturma', yoneticiId, sonraki: { kod: satir.kod, baslik: satir.baslik, tasnif: satir.tasnif }, ip }),
    log.bilgi({ kategori: 'arsiv', olay: 'kayit_olusturuldu', mesaj: `${satir.kod} ${satir.baslik}`, yoneticiId }),
  ]);

  uyariService.ogeDegerlendir({ ogeTur: 'kayit', ogeId: satir.id, baslik: satir.baslik, metin: `${satir.baslik}\n${govde}` }).catch(() => {});

  return { tamam: true, kayit: satir };
}

async function surumYaz(kayit, yoneticiId) {
  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha256').update(`${kayit.baslik}\u0000${kayit.govde || ''}`).digest('hex');
  await db.sorgu(
    `INSERT INTO kayit_surumleri (kayit_id, surum, baslik, govde, butunluk_hash, yonetici_id)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (kayit_id, surum) DO NOTHING`,
    [kayit.id, kayit.surum, kayit.baslik, kayit.govde, hash, yoneticiId],
  );
  await db.sorgu('UPDATE kayitlar SET butunluk_hash = $2 WHERE id = $1', [kayit.id, hash]);
}

async function kayitGuncelle(id, girdi, { yoneticiId = null, ip = null } = {}) {
  const mevcut = await kayitGetir(id);
  if (!mevcut) return { tamam: false, hata: 'Kayit bulunamadi.' };

  const govdeDegisti = girdi.govde !== undefined &&
    dogrula.metin(girdi.govde, { max: 200_000 }) !== (mevcut.govde || '');
  const baslikDegisti = girdi.baslik !== undefined &&
    dogrula.metin(girdi.baslik, { max: 300 }) !== mevcut.baslik;
  const yeniSurum = govdeDegisti || baslikDegisti ? mevcut.surum + 1 : mevcut.surum;

  const satir = await db.tekSatir(
    `UPDATE kayitlar SET
       baslik=$2, govde=$3, tur=$4, kaynak_id=$5, vaka_id=$6, tasnif=$7, guvenilirlik=$8,
       dogruluk=$9, durum=$10, olay_zamani=$11, konum=$12, enlem=$13, boylam=$14,
       etiketler=$15, ozet=$16, anahtar_kelimeler=$17, surum=$18
     WHERE id=$1 AND silindi = FALSE
     RETURNING *`,
    [
      Number(id),
      girdi.baslik !== undefined ? (dogrula.metin(girdi.baslik, { max: 300 }) || mevcut.baslik) : mevcut.baslik,
      girdi.govde !== undefined ? (dogrula.metin(girdi.govde, { max: 200_000 }) || '') : mevcut.govde,
      secenek(girdi.tur, KAYIT_TURLERI, mevcut.tur),
      girdi.kaynak_id !== undefined ? (girdi.kaynak_id ? Number(girdi.kaynak_id) : null) : mevcut.kaynak_id,
      girdi.vaka_id !== undefined ? (girdi.vaka_id ? Number(girdi.vaka_id) : null) : mevcut.vaka_id,
      secenek(girdi.tasnif, TASNIFLER, mevcut.tasnif),
      secenek(girdi.guvenilirlik, GUVENILIRLIKLER, mevcut.guvenilirlik),
      girdi.dogruluk !== undefined ? tamSayi(girdi.dogruluk, { min: 1, max: 6, varsayilan: mevcut.dogruluk }) : mevcut.dogruluk,
      secenek(girdi.durum, KAYIT_DURUMLARI, mevcut.durum),
      girdi.olay_zamani !== undefined ? tarihDegeri(girdi.olay_zamani) : mevcut.olay_zamani,
      girdi.konum !== undefined ? (dogrula.metin(girdi.konum, { max: 200 }) || null) : mevcut.konum,
      girdi.enlem !== undefined ? koordinat(girdi.enlem, 90) : mevcut.enlem,
      girdi.boylam !== undefined ? koordinat(girdi.boylam, 180) : mevcut.boylam,
      girdi.etiketler !== undefined ? etiketListesi(girdi.etiketler) : mevcut.etiketler,
      girdi.ozet !== undefined ? (dogrula.metin(girdi.ozet, { max: 3000 }) || null) : mevcut.ozet,
      girdi.anahtar_kelimeler !== undefined ? etiketListesi(girdi.anahtar_kelimeler, { max: 20 }) : mevcut.anahtar_kelimeler,
      yeniSurum,
    ],
  );
  if (!satir) return { tamam: false, hata: 'Kayit guncellenemedi.' };

  if (yeniSurum !== mevcut.surum) await surumYaz(satir, yoneticiId);

  await Promise.all([
    dizinYenile('kayit', satir.id),
    denetimYaz({
      ogeTur: 'kayit', ogeId: satir.id,
      eylem: mevcut.tasnif !== satir.tasnif ? 'tasnif_degisimi' : 'guncelleme',
      yoneticiId,
      onceki: { baslik: mevcut.baslik, durum: mevcut.durum, tasnif: mevcut.tasnif, surum: mevcut.surum },
      sonraki: { baslik: satir.baslik, durum: satir.durum, tasnif: satir.tasnif, surum: satir.surum },
      ip,
    }),
  ]);

  return { tamam: true, kayit: satir, yeniSurum: yeniSurum !== mevcut.surum };
}

async function kayitGetir(id) {
  return db.tekSatir(
    `SELECT k.*, kn.ad AS kaynak_ad, kn.kod AS kaynak_kod, kn.guvenilirlik AS kaynak_guvenilirlik,
            va.ad AS vaka_ad, va.kod AS vaka_kod
       FROM kayitlar k
       LEFT JOIN kaynaklar kn ON kn.id = k.kaynak_id
       LEFT JOIN vakalar va ON va.id = k.vaka_id
      WHERE k.id = $1 AND k.silindi = FALSE`,
    [Number(id)],
  );
}

async function kayitListele({
  arama = '', tur = null, durum = null, tasnif = null, guvenilirlik = null,
  vakaId = null, varlikId = null, kaynakId = null, etiket = null,
  baslangic = null, bitis = null, enUstTasnif = null,
  sirala = 'zaman', limit = 50, kayma = 0,
} = {}) {
  const kosullar = ['k.silindi = FALSE'];
  const parametreler = [];
  const ekle = (sql, deger) => {
    parametreler.push(deger);
    kosullar.push(sql.replace('$#', `$${parametreler.length}`));
  };

  const temizArama = dogrula.metin(arama, { max: 160 });
  if (temizArama) {
    parametreler.push(temizArama);
    const p = parametreler.length;
    kosullar.push(`(k.arama @@ plainto_tsquery('simple', arsiv_normalize($${p}))
                    OR arsiv_normalize(k.baslik) LIKE '%' || arsiv_normalize($${p}) || '%'
                    OR upper(k.kod) = upper($${p}))`);
  }
  if (tur) ekle('k.tur = $#', secenek(tur, KAYIT_TURLERI, 'rapor'));
  if (durum) ekle('k.durum = $#', secenek(durum, KAYIT_DURUMLARI, 'yeni'));
  if (tasnif) ekle('k.tasnif = $#', secenek(tasnif, TASNIFLER, 'hizmete_ozel'));
  if (guvenilirlik) ekle('k.guvenilirlik = $#', secenek(guvenilirlik, GUVENILIRLIKLER, 'C'));
  if (vakaId) ekle('k.vaka_id = $#', Number(vakaId));
  if (kaynakId) ekle('k.kaynak_id = $#', Number(kaynakId));
  if (etiket) ekle('$# = ANY(k.etiketler)', String(etiket).slice(0, 48));
  if (varlikId) ekle('EXISTS (SELECT 1 FROM kayit_varliklari kv WHERE kv.kayit_id = k.id AND kv.varlik_id = $#)', Number(varlikId));
  if (baslangic) ekle('COALESCE(k.olay_zamani, k.olusturuldu_at) >= $#', tarihDegeri(baslangic));
  if (bitis) ekle('COALESCE(k.olay_zamani, k.olusturuldu_at) <= $#', tarihDegeri(bitis));

  const tk = tasnifKosulu(enUstTasnif, 'k.tasnif');
  if (tk) ekle(tk.sql, tk.deger);

  const siralamalar = {
    zaman: 'COALESCE(k.olay_zamani, k.olusturuldu_at) DESC',
    yeni: 'k.olusturuldu_at DESC',
    guncel: 'k.guncellendi_at DESC',
    tasnif: `CASE k.tasnif WHEN 'cok_gizli' THEN 0 WHEN 'gizli' THEN 1 WHEN 'hizmete_ozel' THEN 2 ELSE 3 END, k.olusturuldu_at DESC`,
    guven: 'k.guvenilirlik ASC, k.dogruluk ASC',
    baslik: 'arsiv_normalize(k.baslik) ASC',
  };

  parametreler.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const limitP = parametreler.length;
  parametreler.push(Math.max(Number(kayma) || 0, 0));

  const satirlar = await db.satirlar(
    `SELECT k.id, k.kod, k.baslik, k.ozet, k.tur, k.tasnif, k.guvenilirlik, k.dogruluk,
            k.durum, k.konum, k.etiketler, k.surum, k.olay_zamani, k.olusturuldu_at,
            COALESCE(k.olay_zamani, k.olusturuldu_at) AS zaman,
            kn.ad AS kaynak_ad, va.kod AS vaka_kod, va.ad AS vaka_ad,
            (SELECT COUNT(*)::int FROM kayit_varliklari kv WHERE kv.kayit_id = k.id) AS varlik_sayisi
       FROM kayitlar k
       LEFT JOIN kaynaklar kn ON kn.id = k.kaynak_id
       LEFT JOIN vakalar va ON va.id = k.vaka_id
      WHERE ${kosullar.join(' AND ')}
      ORDER BY ${siralamalar[sirala] || siralamalar.zaman}
      LIMIT $${limitP} OFFSET $${limitP + 1}`,
    parametreler,
  );

  const sayim = await db.tekSatir(
    `SELECT COUNT(*)::int AS n FROM kayitlar k WHERE ${kosullar.join(' AND ')}`,
    parametreler.slice(0, limitP - 1),
  );

  return { kayitlar: satirlar, toplam: sayim ? sayim.n : satirlar.length };
}

async function kayitSil(id, { yoneticiId = null, ip = null } = {}) {
  const mevcut = await kayitGetir(id);
  if (!mevcut) return { tamam: false, hata: 'Kayit bulunamadi.' };
  await db.sorgu('UPDATE kayitlar SET silindi = TRUE, silindi_at = NOW() WHERE id = $1', [Number(id)]);
  await Promise.all([
    dizin.sil('kayit', id),
    denetimYaz({ ogeTur: 'kayit', ogeId: Number(id), eylem: 'silme', yoneticiId, onceki: { kod: mevcut.kod, baslik: mevcut.baslik }, ip }),
  ]);
  return { tamam: true };
}

async function kayitVarlikBagla(kayitId, varlikId, rol = 'ilgili', { otomatik = false } = {}) {
  const izinliRol = secenek(rol, ['ozne', 'hedef', 'tanik', 'araci', 'konum', 'ilgili'], 'ilgili');
  await db.sorgu(
    `INSERT INTO kayit_varliklari (kayit_id, varlik_id, rol, otomatik)
     VALUES ($1,$2,$3,$4) ON CONFLICT (kayit_id, varlik_id, rol) DO NOTHING`,
    [Number(kayitId), Number(varlikId), izinliRol, Boolean(otomatik)],
  );
  return { tamam: true };
}

async function kayitVarlikCoz(kayitId, varlikId) {
  await db.sorgu('DELETE FROM kayit_varliklari WHERE kayit_id = $1 AND varlik_id = $2', [Number(kayitId), Number(varlikId)]);
  return { tamam: true };
}

async function kayitVarliklari(kayitId) {
  return db.satirlar(
    `SELECT v.id, v.kod, v.ad, v.tur, v.onem, v.renk, kv.rol, kv.otomatik
       FROM kayit_varliklari kv
       JOIN varliklar v ON v.id = kv.varlik_id AND v.silindi = FALSE
      WHERE kv.kayit_id = $1
      ORDER BY v.onem DESC`,
    [Number(kayitId)],
  );
}

async function kayitSurumleri(kayitId) {
  return db.satirlar(
    `SELECT s.*, y.kullanici_adi FROM kayit_surumleri s
       LEFT JOIN yoneticiler y ON y.id = s.yonetici_id
      WHERE s.kayit_id = $1 ORDER BY s.surum DESC LIMIT 40`,
    [Number(kayitId)],
  );
}

// ==================================================================== OLAYLAR

async function olayOlustur(girdi, { yoneticiId = null, ip = null } = {}) {
  const baslik = dogrula.metin(girdi.baslik, { max: 300 });
  if (!baslik) return { tamam: false, hata: 'Olay basligi zorunludur.' };

  const satir = await db.tekSatir(
    `INSERT INTO olaylar
       (baslik, aciklama, tur, zaman, bitis_zamani, belirsizlik, konum, enlem, boylam,
        tasnif, guvenilirlik, dogruluk, onem, vaka_id, kayit_id, etiketler, olusturan_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      baslik,
      dogrula.metin(girdi.aciklama, { max: 20000 }) || null,
      secenek(girdi.tur, OLAY_TURLERI, 'olay'),
      tarihDegeri(girdi.zaman) || new Date().toISOString(),
      tarihDegeri(girdi.bitis_zamani),
      secenek(girdi.belirsizlik, ['kesin', 'yaklasik', 'tahmini'], 'kesin'),
      dogrula.metin(girdi.konum, { max: 200 }) || null,
      koordinat(girdi.enlem, 90),
      koordinat(girdi.boylam, 180),
      secenek(girdi.tasnif, TASNIFLER, 'hizmete_ozel'),
      secenek(girdi.guvenilirlik, GUVENILIRLIKLER, 'C'),
      tamSayi(girdi.dogruluk, { min: 1, max: 6, varsayilan: 3 }),
      tamSayi(girdi.onem, { varsayilan: 50 }),
      girdi.vaka_id ? Number(girdi.vaka_id) : null,
      girdi.kayit_id ? Number(girdi.kayit_id) : null,
      etiketListesi(girdi.etiketler),
      yoneticiId,
    ],
  );

  if (Array.isArray(girdi.varlik_ids)) {
    for (const vid of girdi.varlik_ids.slice(0, 40)) {
      await db.sorgu(
        `INSERT INTO olay_varliklari (olay_id, varlik_id, rol) VALUES ($1,$2,'katilimci')
         ON CONFLICT (olay_id, varlik_id, rol) DO NOTHING`,
        [satir.id, Number(vid)],
      );
    }
  }

  await Promise.all([
    dizinYenile('olay', satir.id),
    denetimYaz({ ogeTur: 'olay', ogeId: satir.id, eylem: 'olusturma', yoneticiId, sonraki: { kod: satir.kod, baslik: satir.baslik }, ip }),
  ]);

  uyariService.ogeDegerlendir({ ogeTur: 'olay', ogeId: satir.id, baslik: satir.baslik, metin: `${satir.baslik}\n${satir.aciklama || ''}` }).catch(() => {});

  return { tamam: true, olay: satir };
}

async function olayGetir(id) {
  return db.tekSatir(
    `SELECT o.*, va.kod AS vaka_kod, va.ad AS vaka_ad, k.kod AS kayit_kod
       FROM olaylar o
       LEFT JOIN vakalar va ON va.id = o.vaka_id
       LEFT JOIN kayitlar k ON k.id = o.kayit_id
      WHERE o.id = $1 AND o.silindi = FALSE`,
    [Number(id)],
  );
}

async function olayListele({
  arama = '', tur = null, vakaId = null, varlikId = null, gun = null,
  baslangic = null, bitis = null, enUstTasnif = null, limit = 100, kayma = 0,
} = {}) {
  const kosullar = ['o.silindi = FALSE'];
  const parametreler = [];
  const ekle = (sql, deger) => {
    parametreler.push(deger);
    kosullar.push(sql.replace('$#', `$${parametreler.length}`));
  };

  const temizArama = dogrula.metin(arama, { max: 160 });
  if (temizArama) {
    parametreler.push(temizArama);
    const p = parametreler.length;
    kosullar.push(`(o.arama @@ plainto_tsquery('simple', arsiv_normalize($${p}))
                    OR arsiv_normalize(o.baslik) LIKE '%' || arsiv_normalize($${p}) || '%')`);
  }
  if (tur) ekle('o.tur = $#', secenek(tur, OLAY_TURLERI, 'olay'));
  if (vakaId) ekle('o.vaka_id = $#', Number(vakaId));
  if (varlikId) ekle('EXISTS (SELECT 1 FROM olay_varliklari ov WHERE ov.olay_id = o.id AND ov.varlik_id = $#)', Number(varlikId));
  if (gun) ekle("o.zaman > NOW() - ($# || ' days')::interval", String(tamSayi(gun, { min: 1, max: 3650, varsayilan: 30 })));
  if (baslangic) ekle('o.zaman >= $#', tarihDegeri(baslangic));
  if (bitis) ekle('o.zaman <= $#', tarihDegeri(bitis));

  const tk = tasnifKosulu(enUstTasnif, 'o.tasnif');
  if (tk) ekle(tk.sql, tk.deger);

  parametreler.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const limitP = parametreler.length;
  parametreler.push(Math.max(Number(kayma) || 0, 0));

  const satirlar = await db.satirlar(
    `SELECT o.*, va.kod AS vaka_kod,
            (SELECT COUNT(*)::int FROM olay_varliklari ov WHERE ov.olay_id = o.id) AS varlik_sayisi,
            (SELECT ARRAY_AGG(v.ad) FROM olay_varliklari ov JOIN varliklar v ON v.id = ov.varlik_id
              WHERE ov.olay_id = o.id AND v.silindi = FALSE) AS varlik_adlari
       FROM olaylar o
       LEFT JOIN vakalar va ON va.id = o.vaka_id
      WHERE ${kosullar.join(' AND ')}
      ORDER BY o.zaman DESC
      LIMIT $${limitP} OFFSET $${limitP + 1}`,
    parametreler,
  );

  const sayim = await db.tekSatir(
    `SELECT COUNT(*)::int AS n FROM olaylar o WHERE ${kosullar.join(' AND ')}`,
    parametreler.slice(0, limitP - 1),
  );

  return { olaylar: satirlar, toplam: sayim ? sayim.n : satirlar.length };
}

async function olaySil(id, { yoneticiId = null, ip = null } = {}) {
  const mevcut = await olayGetir(id);
  if (!mevcut) return { tamam: false, hata: 'Olay bulunamadi.' };
  await db.sorgu('UPDATE olaylar SET silindi = TRUE WHERE id = $1', [Number(id)]);
  await Promise.all([
    dizin.sil('olay', id),
    denetimYaz({ ogeTur: 'olay', ogeId: Number(id), eylem: 'silme', yoneticiId, onceki: { kod: mevcut.kod }, ip }),
  ]);
  return { tamam: true };
}

async function olayVarliklari(olayId) {
  return db.satirlar(
    `SELECT v.id, v.kod, v.ad, v.tur, v.renk, ov.rol
       FROM olay_varliklari ov
       JOIN varliklar v ON v.id = ov.varlik_id AND v.silindi = FALSE
      WHERE ov.olay_id = $1`,
    [Number(olayId)],
  );
}

// ==================================================================== VAKALAR

async function vakaOlustur(girdi, { yoneticiId = null, ip = null } = {}) {
  const ad = dogrula.metin(girdi.ad, { max: 200 });
  if (!ad) return { tamam: false, hata: 'Vaka adi zorunludur.' };

  const satir = await db.tekSatir(
    `INSERT INTO vakalar (ad, kod_adi, aciklama, durum, oncelik, tasnif, sorumlu, hedef_tarih, etiketler, olusturan_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      ad,
      dogrula.metin(girdi.kod_adi, { max: 80 }) || null,
      dogrula.metin(girdi.aciklama, { max: 20000 }) || null,
      secenek(girdi.durum, VAKA_DURUMLARI, 'acik'),
      secenek(girdi.oncelik, ONCELIKLER, 'orta'),
      secenek(girdi.tasnif, TASNIFLER, 'gizli'),
      dogrula.metin(girdi.sorumlu, { max: 120 }) || null,
      tarihDegeri(girdi.hedef_tarih),
      etiketListesi(girdi.etiketler),
      yoneticiId,
    ],
  );

  await Promise.all([
    dizinYenile('vaka', satir.id),
    denetimYaz({ ogeTur: 'vaka', ogeId: satir.id, eylem: 'olusturma', yoneticiId, sonraki: { kod: satir.kod, ad: satir.ad }, ip }),
  ]);
  return { tamam: true, vaka: satir };
}

async function vakaGuncelle(id, girdi, { yoneticiId = null, ip = null } = {}) {
  const mevcut = await db.tekSatir('SELECT * FROM vakalar WHERE id = $1 AND silindi = FALSE', [Number(id)]);
  if (!mevcut) return { tamam: false, hata: 'Vaka bulunamadi.' };

  const satir = await db.tekSatir(
    `UPDATE vakalar SET ad=$2, kod_adi=$3, aciklama=$4, durum=$5, oncelik=$6, tasnif=$7,
            sorumlu=$8, hedef_tarih=$9, etiketler=$10
      WHERE id=$1 RETURNING *`,
    [
      Number(id),
      dogrula.metin(girdi.ad, { max: 200 }) || mevcut.ad,
      girdi.kod_adi !== undefined ? (dogrula.metin(girdi.kod_adi, { max: 80 }) || null) : mevcut.kod_adi,
      girdi.aciklama !== undefined ? (dogrula.metin(girdi.aciklama, { max: 20000 }) || null) : mevcut.aciklama,
      secenek(girdi.durum, VAKA_DURUMLARI, mevcut.durum),
      secenek(girdi.oncelik, ONCELIKLER, mevcut.oncelik),
      secenek(girdi.tasnif, TASNIFLER, mevcut.tasnif),
      girdi.sorumlu !== undefined ? (dogrula.metin(girdi.sorumlu, { max: 120 }) || null) : mevcut.sorumlu,
      girdi.hedef_tarih !== undefined ? tarihDegeri(girdi.hedef_tarih) : mevcut.hedef_tarih,
      girdi.etiketler !== undefined ? etiketListesi(girdi.etiketler) : mevcut.etiketler,
    ],
  );

  await Promise.all([
    dizinYenile('vaka', satir.id),
    denetimYaz({ ogeTur: 'vaka', ogeId: satir.id, eylem: 'guncelleme', yoneticiId, onceki: { durum: mevcut.durum, oncelik: mevcut.oncelik }, sonraki: { durum: satir.durum, oncelik: satir.oncelik }, ip }),
  ]);
  return { tamam: true, vaka: satir };
}

async function vakaGetir(id) {
  return db.tekSatir('SELECT * FROM vakalar WHERE id = $1 AND silindi = FALSE', [Number(id)]);
}

async function vakaListele({ durum = null, oncelik = null, arama = '', limit = 60 } = {}) {
  const kosullar = ['v.silindi = FALSE'];
  const parametreler = [];
  if (durum) { parametreler.push(secenek(durum, VAKA_DURUMLARI, 'acik')); kosullar.push(`v.durum = $${parametreler.length}`); }
  if (oncelik) { parametreler.push(secenek(oncelik, ONCELIKLER, 'orta')); kosullar.push(`v.oncelik = $${parametreler.length}`); }
  const temizArama = dogrula.metin(arama, { max: 120 });
  if (temizArama) {
    parametreler.push(temizArama);
    kosullar.push(`arsiv_normalize(v.ad || ' ' || COALESCE(v.kod_adi,'')) LIKE '%' || arsiv_normalize($${parametreler.length}) || '%'`);
  }
  parametreler.push(Math.min(Math.max(Number(limit) || 60, 1), 200));

  return db.satirlar(
    `SELECT v.*,
            (SELECT COUNT(*)::int FROM kayitlar k WHERE k.vaka_id = v.id AND k.silindi = FALSE) AS kayit_sayisi,
            (SELECT COUNT(*)::int FROM olaylar o WHERE o.vaka_id = v.id AND o.silindi = FALSE) AS olay_sayisi,
            (SELECT COUNT(*)::int FROM vaka_ogeleri vo WHERE vo.vaka_id = v.id AND vo.oge_tur = 'varlik') AS varlik_sayisi
       FROM vakalar v
      WHERE ${kosullar.join(' AND ')}
      ORDER BY CASE v.oncelik WHEN 'kritik' THEN 0 WHEN 'yuksek' THEN 1 WHEN 'orta' THEN 2 ELSE 3 END,
               v.guncellendi_at DESC
      LIMIT $${parametreler.length}`,
    parametreler,
  );
}

async function vakaOgeEkle(vakaId, ogeTur, ogeId, { notMetni = null } = {}) {
  const izinli = ['varlik', 'kayit', 'olay', 'dosya', 'belge', 'pano'];
  if (!izinli.includes(ogeTur)) return { tamam: false, hata: 'Gecersiz oge turu.' };
  await db.sorgu(
    `INSERT INTO vaka_ogeleri (vaka_id, oge_tur, oge_id, not_metni)
     VALUES ($1,$2,$3,$4) ON CONFLICT (vaka_id, oge_tur, oge_id) DO UPDATE SET not_metni = EXCLUDED.not_metni`,
    [Number(vakaId), ogeTur, Number(ogeId), dogrula.metin(notMetni, { max: 500 }) || null],
  );
  await db.sorgu('UPDATE vakalar SET guncellendi_at = NOW() WHERE id = $1', [Number(vakaId)]);
  return { tamam: true };
}

async function vakaOgeCikar(vakaId, ogeTur, ogeId) {
  await db.sorgu('DELETE FROM vaka_ogeleri WHERE vaka_id = $1 AND oge_tur = $2 AND oge_id = $3',
    [Number(vakaId), ogeTur, Number(ogeId)]);
  return { tamam: true };
}

async function vakaVarliklari(vakaId) {
  return db.satirlar(
    `SELECT v.* FROM vaka_ogeleri vo JOIN varliklar v ON v.id = vo.oge_id
      WHERE vo.vaka_id = $1 AND vo.oge_tur = 'varlik' AND v.silindi = FALSE
      ORDER BY v.onem DESC`,
    [Number(vakaId)],
  );
}

// =================================================================== KAYNAKLAR

async function kaynakOlustur(girdi, { yoneticiId = null, ip = null } = {}) {
  const ad = dogrula.metin(girdi.ad, { max: 160 });
  if (!ad) return { tamam: false, hata: 'Kaynak adi zorunludur.' };

  const satir = await db.tekSatir(
    `INSERT INTO kaynaklar (ad, tur, guvenilirlik, irtibat, aciklama, etiketler, aktif, olusturan_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      ad,
      secenek(girdi.tur, KAYNAK_TURLERI, 'acik_kaynak'),
      secenek(girdi.guvenilirlik, GUVENILIRLIKLER, 'C'),
      dogrula.metin(girdi.irtibat, { max: 200 }) || null,
      dogrula.metin(girdi.aciklama, { max: 4000 }) || null,
      etiketListesi(girdi.etiketler),
      girdi.aktif === undefined ? true : Boolean(girdi.aktif),
      yoneticiId,
    ],
  );
  await denetimYaz({ ogeTur: 'kaynak', ogeId: satir.id, eylem: 'olusturma', yoneticiId, sonraki: { kod: satir.kod, ad: satir.ad }, ip });
  return { tamam: true, kaynak: satir };
}

async function kaynakGuncelle(id, girdi, { yoneticiId = null } = {}) {
  const mevcut = await db.tekSatir('SELECT * FROM kaynaklar WHERE id = $1 AND silindi = FALSE', [Number(id)]);
  if (!mevcut) return { tamam: false, hata: 'Kaynak bulunamadi.' };
  const satir = await db.tekSatir(
    `UPDATE kaynaklar SET ad=$2, tur=$3, guvenilirlik=$4, irtibat=$5, aciklama=$6, etiketler=$7, aktif=$8
      WHERE id=$1 RETURNING *`,
    [
      Number(id),
      dogrula.metin(girdi.ad, { max: 160 }) || mevcut.ad,
      secenek(girdi.tur, KAYNAK_TURLERI, mevcut.tur),
      secenek(girdi.guvenilirlik, GUVENILIRLIKLER, mevcut.guvenilirlik),
      girdi.irtibat !== undefined ? (dogrula.metin(girdi.irtibat, { max: 200 }) || null) : mevcut.irtibat,
      girdi.aciklama !== undefined ? (dogrula.metin(girdi.aciklama, { max: 4000 }) || null) : mevcut.aciklama,
      girdi.etiketler !== undefined ? etiketListesi(girdi.etiketler) : mevcut.etiketler,
      girdi.aktif === undefined ? mevcut.aktif : Boolean(girdi.aktif),
    ],
  );
  await denetimYaz({ ogeTur: 'kaynak', ogeId: satir.id, eylem: 'guncelleme', yoneticiId, onceki: { guvenilirlik: mevcut.guvenilirlik }, sonraki: { guvenilirlik: satir.guvenilirlik } });
  return { tamam: true, kaynak: satir };
}

async function kaynakListele({ aktif = null, limit = 100 } = {}) {
  const kosullar = ['silindi = FALSE'];
  const parametreler = [];
  if (aktif !== null && aktif !== '') { parametreler.push(Boolean(Number(aktif) || aktif === true)); kosullar.push(`aktif = $${parametreler.length}`); }
  parametreler.push(Math.min(Math.max(Number(limit) || 100, 1), 300));
  return db.satirlar(
    `SELECT * FROM kaynaklar WHERE ${kosullar.join(' AND ')}
      ORDER BY guvenilirlik ASC, kayit_sayisi DESC LIMIT $${parametreler.length}`,
    parametreler,
  );
}

async function kaynakSil(id, { yoneticiId = null } = {}) {
  await db.sorgu('UPDATE kaynaklar SET silindi = TRUE WHERE id = $1', [Number(id)]);
  await denetimYaz({ ogeTur: 'kaynak', ogeId: Number(id), eylem: 'silme', yoneticiId });
  return { tamam: true };
}

// ==================================================================== EKLER

async function varlikEkEkle(varlikId, ogeTur, ogeId, { notMetni = null } = {}) {
  const izinli = ['dosya', 'belge', 'pano'];
  if (!izinli.includes(ogeTur)) return { tamam: false, hata: 'Gecersiz ek turu.' };
  await db.sorgu(
    `INSERT INTO varlik_ekleri (varlik_id, oge_tur, oge_id, not_metni)
     VALUES ($1,$2,$3,$4) ON CONFLICT (varlik_id, oge_tur, oge_id) DO UPDATE SET not_metni = EXCLUDED.not_metni`,
    [Number(varlikId), ogeTur, Number(ogeId), dogrula.metin(notMetni, { max: 400 }) || null],
  );
  return { tamam: true };
}

async function varlikEkleri(varlikId) {
  const ekler = await db.satirlar('SELECT * FROM varlik_ekleri WHERE varlik_id = $1 ORDER BY olusturuldu_at DESC LIMIT 60', [Number(varlikId)]);
  const dosyaIdleri = ekler.filter((e) => e.oge_tur === 'dosya').map((e) => Number(e.oge_id));
  const belgeIdleri = ekler.filter((e) => e.oge_tur === 'belge').map((e) => Number(e.oge_id));

  const [dosyalar, belgeler] = await Promise.all([
    dosyaIdleri.length
      ? db.satirlar('SELECT id, ad, mime_turu, boyut_bayt FROM dosyalar WHERE id = ANY($1::bigint[]) AND silindi = FALSE', [dosyaIdleri])
      : [],
    belgeIdleri.length
      ? db.satirlar('SELECT id, baslik FROM belgeler WHERE id = ANY($1::bigint[]) AND silindi = FALSE', [belgeIdleri])
      : [],
  ]);

  const dosyaHarita = new Map(dosyalar.map((d) => [Number(d.id), d]));
  const belgeHarita = new Map(belgeler.map((b) => [Number(b.id), b]));

  return ekler.map((e) => ({
    ...e,
    detay: e.oge_tur === 'dosya' ? dosyaHarita.get(Number(e.oge_id)) : belgeHarita.get(Number(e.oge_id)),
  })).filter((e) => e.oge_tur === 'pano' || e.detay);
}

// ================================================================= GOSTERGELER

/** Merkez panosu icin tek sorguda ozet sayimlar. */
async function panoOzet() {
  const [sayim, sonKayitlar, sonOlaylar, acikVakalar, uyarilar, tasnifDagilim] = await Promise.all([
    db.tekSatir(`
      SELECT (SELECT COUNT(*)::int FROM varliklar WHERE silindi = FALSE) AS varlik,
             (SELECT COUNT(*)::int FROM varliklar WHERE silindi = FALSE AND durum = 'izlemede') AS izlemede,
             (SELECT COUNT(*)::int FROM kayitlar WHERE silindi = FALSE) AS kayit,
             (SELECT COUNT(*)::int FROM kayitlar WHERE silindi = FALSE AND durum = 'yeni') AS bekleyen,
             (SELECT COUNT(*)::int FROM olaylar WHERE silindi = FALSE) AS olay,
             (SELECT COUNT(*)::int FROM varlik_iliskileri) AS iliski,
             (SELECT COUNT(*)::int FROM vakalar WHERE silindi = FALSE AND durum = 'acik') AS acik_vaka,
             (SELECT COUNT(*)::int FROM kaynaklar WHERE silindi = FALSE AND aktif = TRUE) AS kaynak,
             (SELECT COUNT(*)::int FROM uyarilar WHERE okundu = FALSE) AS uyari,
             (SELECT COUNT(*)::int FROM belge_cozumleme WHERE durum IN ('tamam','kismi')) AS cozumleme,
             (SELECT COUNT(*)::int FROM dosyalar WHERE silindi = FALSE) AS dosya,
             (SELECT COUNT(*)::int FROM kayitlar WHERE silindi = FALSE AND olusturuldu_at > NOW() - INTERVAL '7 days') AS hafta_kayit,
             (SELECT COUNT(*)::int FROM olaylar WHERE silindi = FALSE AND zaman > NOW() - INTERVAL '7 days') AS hafta_olay
    `),
    db.satirlar(
      `SELECT id, kod, baslik, tur, tasnif, guvenilirlik, durum,
              COALESCE(olay_zamani, olusturuldu_at) AS zaman
         FROM kayitlar WHERE silindi = FALSE
         ORDER BY olusturuldu_at DESC LIMIT 8`,
    ),
    db.satirlar(
      `SELECT id, kod, baslik, zaman, konum, onem, tur FROM olaylar
        WHERE silindi = FALSE ORDER BY zaman DESC LIMIT 8`,
    ),
    db.satirlar(
      `SELECT id, kod, ad, kod_adi, oncelik, durum, guncellendi_at FROM vakalar
        WHERE silindi = FALSE AND durum = 'acik'
        ORDER BY CASE oncelik WHEN 'kritik' THEN 0 WHEN 'yuksek' THEN 1 WHEN 'orta' THEN 2 ELSE 3 END
        LIMIT 6`,
    ),
    db.satirlar(
      `SELECT u.*, k.ad AS kural_ad FROM uyarilar u
        LEFT JOIN izleme_kurallari k ON k.id = u.kural_id
        WHERE u.okundu = FALSE ORDER BY
          CASE u.seviye WHEN 'kritik' THEN 0 WHEN 'uyari' THEN 1 ELSE 2 END,
          u.olusturuldu_at DESC LIMIT 8`,
    ),
    db.satirlar("SELECT tasnif, COUNT(*)::int AS n FROM kayitlar WHERE silindi = FALSE GROUP BY tasnif"),
  ]);

  // 30 gunluk hareketlilik serisi (grafik icin)
  const hareket = await db.satirlar(`
    SELECT to_char(gun, 'DD.MM') AS etiket, gun,
           COALESCE(k.n, 0)::int AS kayit, COALESCE(o.n, 0)::int AS olay
      FROM generate_series(date_trunc('day', NOW()) - INTERVAL '29 days', date_trunc('day', NOW()), INTERVAL '1 day') AS gun
      LEFT JOIN (
        SELECT date_trunc('day', COALESCE(olay_zamani, olusturuldu_at)) AS g, COUNT(*)::int AS n
          FROM kayitlar WHERE silindi = FALSE
           AND COALESCE(olay_zamani, olusturuldu_at) > NOW() - INTERVAL '30 days'
         GROUP BY 1
      ) k ON k.g = gun
      LEFT JOIN (
        SELECT date_trunc('day', zaman) AS g, COUNT(*)::int AS n
          FROM olaylar WHERE silindi = FALSE AND zaman > NOW() - INTERVAL '30 days'
         GROUP BY 1
      ) o ON o.g = gun
     ORDER BY gun`);

  return {
    sayim: sayim || {},
    sonKayitlar, sonOlaylar, acikVakalar, uyarilar,
    tasnifDagilim, hareket,
  };
}

/** Haritada gosterilecek koordinatli ogeler. */
async function haritaNoktalari({ enUstTasnif = null, limit = 500 } = {}) {
  const tk = tasnifKosulu(enUstTasnif, 'tasnif');
  const ekKosul = tk ? ` AND ${tk.sql.replace('$#', '$1')}` : '';
  const parametreler = tk ? [tk.deger] : [];

  const [varliklar, olaylar, kayitlar, dosyalar] = await Promise.all([
    db.satirlar(
      `SELECT id, kod, ad AS baslik, tur, enlem, boylam, onem, tasnif, 'varlik' AS kaynak
         FROM varliklar WHERE silindi = FALSE AND enlem IS NOT NULL AND boylam IS NOT NULL${ekKosul}
         LIMIT ${limit}`, parametreler,
    ),
    db.satirlar(
      `SELECT id, kod, baslik, tur, enlem, boylam, onem, tasnif, zaman, 'olay' AS kaynak
         FROM olaylar WHERE silindi = FALSE AND enlem IS NOT NULL AND boylam IS NOT NULL${ekKosul}
         ORDER BY zaman DESC LIMIT ${limit}`, parametreler,
    ),
    db.satirlar(
      `SELECT id, kod, baslik, tur, enlem, boylam, 50 AS onem, tasnif,
              COALESCE(olay_zamani, olusturuldu_at) AS zaman, 'kayit' AS kaynak
         FROM kayitlar WHERE silindi = FALSE AND enlem IS NOT NULL AND boylam IS NOT NULL${ekKosul}
         ORDER BY zaman DESC LIMIT ${limit}`, parametreler,
    ),
    db.satirlar(
      `SELECT c.dosya_id AS id, d.ad AS baslik, 'gps' AS tur,
              (c.ustveri->>'gps_enlem')::float AS enlem,
              (c.ustveri->>'gps_boylam')::float AS boylam,
              40 AS onem, 'hizmete_ozel' AS tasnif, 'dosya' AS kaynak
         FROM belge_cozumleme c JOIN dosyalar d ON d.id = c.dosya_id
        WHERE c.ustveri->>'gps_enlem' IS NOT NULL AND d.silindi = FALSE
        LIMIT 200`,
    ),
  ]);

  return [...varliklar, ...olaylar, ...kayitlar, ...dosyalar]
    .filter((n) => Number.isFinite(Number(n.enlem)) && Number.isFinite(Number(n.boylam)));
}

// ----------------------------------------------------------- DIZIN YANSITMA

/**
 * Zamani ARANABILIR metne cevirir. Dizinde yalnizca sayisal zaman damgasi
 * dururken "olay ne zaman oldu" sorusu yanitsiz kalir; bu yuzden tarih
 * hem rakamla hem sozcukle (12.03.2024 / 12 Mart 2024, Salı) yazilir.
 */
async function zamanMetni(zaman) {
  if (!zaman) return null;
  const d = zaman instanceof Date ? zaman : new Date(zaman);
  if (Number.isNaN(d.getTime())) return null;
  const gun = String(d.getDate()).padStart(2, '0');
  const ay = String(d.getMonth() + 1).padStart(2, '0');
  return [
    `${gun}.${ay}.${d.getFullYear()}`,
    nd.tarihSozcuk(d, { gunAdi: true }),
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  ].join(' ');
}

/**
 * Ogeye bagli varliklarin adlarini dizine ekler. Boylece "kim" ve "hangi
 * kurum" sorulari, adlar govde metninde gecmese bile yanitlanabilir.
 */
async function bagliVarlikMetni(tur, id) {
  const tablo = tur === 'kayit' ? 'kayit_varliklari' : 'olay_varliklari';
  const alan = tur === 'kayit' ? 'kayit_id' : 'olay_id';
  const satirlar = await db.satirlar(
    `SELECT v.ad, v.tur, v.takma_adlar FROM ${tablo} b
       JOIN varliklar v ON v.id = b.varlik_id AND v.silindi = FALSE
      WHERE b.${alan} = $1 LIMIT 40`,
    [Number(id)],
  );
  if (!satirlar.length) return null;
  return 'Ilgili varliklar: ' + satirlar
    .map((v) => [v.ad, ...(v.takma_adlar || [])].join(' '))
    .join(', ');
}

/** Bir ogeyi yerel arama dizininde gunceller (hatasi akisi kesmez). */
async function dizinYenile(tur, id) {
  try {
    if (tur === 'varlik') {
      const v = await varlikGetir(id);
      if (!v) return;
      const govde = [
        (v.takma_adlar || []).join(', '), v.ozet, v.detay,
        (v.etiketler || []).join(' '), v.adres, v.ulke, v.tur,
      ].filter(Boolean).join('\n');
      await dizin.yaz({ kaynakTur: 'varlik', kaynakId: v.id, baslik: `${v.kod} ${v.ad}`, metin: govde, tasnif: v.tasnif });
    } else if (tur === 'kayit') {
      const k = await db.tekSatir('SELECT * FROM kayitlar WHERE id = $1', [Number(id)]);
      if (!k) return;
      const govde = [
        k.govde, k.ozet,
        (k.etiketler || []).join(' '),
        (k.anahtar_kelimeler || []).join(' '),
        k.konum,
        await zamanMetni(k.olay_zamani || k.olusturuldu_at),
        await bagliVarlikMetni('kayit', k.id),
      ].filter(Boolean).join('\n');
      await dizin.yaz({ kaynakTur: 'kayit', kaynakId: k.id, baslik: `${k.kod} ${k.baslik}`, metin: govde, tasnif: k.tasnif });
    } else if (tur === 'olay') {
      const o = await db.tekSatir('SELECT * FROM olaylar WHERE id = $1', [Number(id)]);
      if (!o) return;
      const govde = [
        o.aciklama, o.konum,
        (o.etiketler || []).join(' '),
        await zamanMetni(o.zaman),
        await bagliVarlikMetni('olay', o.id),
      ].filter(Boolean).join('\n');
      await dizin.yaz({ kaynakTur: 'olay', kaynakId: o.id, baslik: `${o.kod} ${o.baslik}`, metin: govde, tasnif: o.tasnif });
    } else if (tur === 'vaka') {
      const v = await db.tekSatir('SELECT * FROM vakalar WHERE id = $1', [Number(id)]);
      if (!v) return;
      await dizin.yaz({
        kaynakTur: 'vaka', kaynakId: v.id,
        baslik: `${v.kod} ${v.ad}${v.kod_adi ? ' / ' + v.kod_adi : ''}`,
        metin: [v.aciklama, (v.etiketler || []).join(' '), v.sorumlu].filter(Boolean).join('\n'),
        tasnif: v.tasnif,
      });
    }
  } catch (hata) {
    await log.uyari({ kategori: 'zeka', olay: 'dizin_yazilamadi', mesaj: hata.message, meta: { tur, id } });
  }
}

module.exports = {
  // sabitler
  TASNIFLER, GUVENILIRLIKLER, VARLIK_TURLERI, VARLIK_DURUMLARI, ILISKI_TURLERI,
  KAYIT_TURLERI, KAYIT_DURUMLARI, OLAY_TURLERI, KAYNAK_TURLERI, VAKA_DURUMLARI,
  ONCELIKLER, TASNIF_DERECESI,
  // varlik
  varlikOlustur, varlikGuncelle, varlikGetir, varlikKodIle, varlikListele, varlikSil, varlikBirlestir,
  // iliski
  iliskiEkle, iliskiSil, iliskiListele,
  // kayit
  kayitOlustur, kayitGuncelle, kayitGetir, kayitListele, kayitSil,
  kayitVarlikBagla, kayitVarlikCoz, kayitVarliklari, kayitSurumleri,
  // olay
  olayOlustur, olayGetir, olayListele, olaySil, olayVarliklari,
  // vaka
  vakaOlustur, vakaGuncelle, vakaGetir, vakaListele, vakaOgeEkle, vakaOgeCikar, vakaVarliklari,
  // kaynak
  kaynakOlustur, kaynakGuncelle, kaynakListele, kaynakSil,
  // ek
  varlikEkEkle, varlikEkleri,
  // gosterge
  panoOzet, haritaNoktalari,
  // denetim + dizin
  denetimYaz, denetimListele, dizinYenile, zamanMetni, bagliVarlikMetni,
  // yardimci
  etiketListesi, tasnifKosulu,
};
