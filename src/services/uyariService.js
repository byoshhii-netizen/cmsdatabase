'use strict';
/**
 * src/services/uyariService.js
 * IZLEME LISTESI VE OTOMATIK UYARI
 *
 * Operator "su sozcuk gecerse", "su varlik anilirsa" ya da "su desen
 * tutarsa haber ver" diye kural tanimlar. Arsive her yeni kayit, olay ya da
 * cozumlenen belge girdiginde bu kurallardan gecirilir; tutan kural uyari
 * uretir ve merkez panosunda gorunur.
 *
 * Desen turleri:
 *   anahtar : bosluk/virgulle ayrilmis sozcukler — govdelenerek aranir,
 *             boylece "silah" kurali "silahlarin" metnini de yakalar
 *   varlik  : belirli bir varligin adi ya da takma adi anilirsa
 *   desen   : sinirlandirilmis duzenli ifade (guvenli alt kume)
 */

const db = require('../config/db');
const dogrula = require('../utils/validate');
const log = require('./logService');
const dil = require('../zeka/dil');

const SEVIYELER = ['bilgi', 'uyari', 'kritik'];
const TURLER = ['anahtar', 'varlik', 'desen'];
const KAPSAMLAR = ['kayit', 'belge', 'olay', 'varlik', 'dosya'];

const MAX_DESEN = 200;

// ---------------------------------------------------------------- KURALLAR

function kapsamListesi(girdi) {
  const ham = Array.isArray(girdi) ? girdi : String(girdi || '').split(/[,;\s]+/);
  const sonuc = ham.map((k) => String(k).trim()).filter((k) => KAPSAMLAR.includes(k));
  return sonuc.length ? [...new Set(sonuc)] : ['kayit', 'belge', 'olay'];
}

/**
 * Kullanici desenini guvenli bir RegExp'e cevirir.
 * Yikici kaliplar (ic ice nicelenmis gruplar) reddedilir; bu, tek bir
 * kuralin tum sunucuyu kilitlemesini (ReDoS) onler.
 */
function guvenliDesen(desen) {
  const ham = String(desen || '').slice(0, MAX_DESEN);
  if (!ham) return null;
  if (/\((?=[^)]*[+*{])[^)]*\)\s*[+*{]/.test(ham)) return null;   // (a+)+ benzeri
  if ((ham.match(/[+*]/g) || []).length > 6) return null;
  try {
    return new RegExp(ham, 'iu');
  } catch {
    return null;
  }
}

async function kuralOlustur(girdi, { yoneticiId = null } = {}) {
  const ad = dogrula.metin(girdi.ad, { max: 120 });
  if (!ad) return { tamam: false, hata: 'Kural adi zorunludur.' };

  const tur = TURLER.includes(girdi.tur) ? girdi.tur : 'anahtar';
  const desen = dogrula.metin(girdi.desen, { max: MAX_DESEN }) || '';
  const varlikId = girdi.varlik_id ? Number(girdi.varlik_id) : null;

  if (tur === 'anahtar' && !desen) return { tamam: false, hata: 'Anahtar kuralinda en az bir sozcuk gerekir.' };
  if (tur === 'varlik' && !varlikId) return { tamam: false, hata: 'Varlik kuralinda bir varlik secilmelidir.' };
  if (tur === 'desen') {
    if (!desen) return { tamam: false, hata: 'Duzenli ifade bos olamaz.' };
    if (!guvenliDesen(desen)) {
      return { tamam: false, hata: 'Bu duzenli ifade gecersiz ya da guvenli degil (asiri nicelenmis gruplar kabul edilmez).' };
    }
  }

  const satir = await db.tekSatir(
    `INSERT INTO izleme_kurallari (ad, tur, desen, varlik_id, kapsam, seviye, aktif, olusturan_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      ad, tur, desen, varlikId,
      kapsamListesi(girdi.kapsam),
      SEVIYELER.includes(girdi.seviye) ? girdi.seviye : 'uyari',
      girdi.aktif === undefined ? true : Boolean(girdi.aktif),
      yoneticiId,
    ],
  );

  await log.bilgi({ kategori: 'arsiv', olay: 'izleme_kurali_eklendi', mesaj: ad, yoneticiId });
  return { tamam: true, kural: satir };
}

async function kuralGuncelle(id, girdi, { yoneticiId = null } = {}) {
  const mevcut = await db.tekSatir('SELECT * FROM izleme_kurallari WHERE id = $1', [Number(id)]);
  if (!mevcut) return { tamam: false, hata: 'Kural bulunamadi.' };

  const tur = TURLER.includes(girdi.tur) ? girdi.tur : mevcut.tur;
  const desen = girdi.desen !== undefined ? (dogrula.metin(girdi.desen, { max: MAX_DESEN }) || '') : mevcut.desen;
  if (tur === 'desen' && desen && !guvenliDesen(desen)) {
    return { tamam: false, hata: 'Duzenli ifade guvenli degil.' };
  }

  const satir = await db.tekSatir(
    `UPDATE izleme_kurallari SET ad=$2, tur=$3, desen=$4, varlik_id=$5, kapsam=$6, seviye=$7, aktif=$8
      WHERE id=$1 RETURNING *`,
    [
      Number(id),
      dogrula.metin(girdi.ad, { max: 120 }) || mevcut.ad,
      tur, desen,
      girdi.varlik_id !== undefined ? (girdi.varlik_id ? Number(girdi.varlik_id) : null) : mevcut.varlik_id,
      girdi.kapsam !== undefined ? kapsamListesi(girdi.kapsam) : mevcut.kapsam,
      SEVIYELER.includes(girdi.seviye) ? girdi.seviye : mevcut.seviye,
      girdi.aktif === undefined ? mevcut.aktif : Boolean(girdi.aktif),
    ],
  );
  return { tamam: true, kural: satir };
}

async function kuralSil(id) {
  await db.sorgu('DELETE FROM izleme_kurallari WHERE id = $1', [Number(id)]);
  return { tamam: true };
}

async function kurallariListele({ aktif = null } = {}) {
  const kosul = aktif === null ? '' : `WHERE k.aktif = ${aktif ? 'TRUE' : 'FALSE'}`;
  return db.satirlar(
    `SELECT k.*, v.ad AS varlik_ad, v.kod AS varlik_kod
       FROM izleme_kurallari k
       LEFT JOIN varliklar v ON v.id = k.varlik_id
      ${kosul}
      ORDER BY k.aktif DESC, CASE k.seviye WHEN 'kritik' THEN 0 WHEN 'uyari' THEN 1 ELSE 2 END, k.ad`,
  );
}

// ---------------------------------------------------------------- UYARILAR

async function uyariEkle({ kuralId = null, seviye = 'uyari', baslik, mesaj = null, ogeTur = null, ogeId = null }) {
  const satir = await db.tekSatir(
    `INSERT INTO uyarilar (kural_id, seviye, baslik, mesaj, oge_tur, oge_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      kuralId,
      SEVIYELER.includes(seviye) ? seviye : 'uyari',
      String(baslik || '').slice(0, 300),
      mesaj ? String(mesaj).slice(0, 2000) : null,
      ogeTur, ogeId ? Number(ogeId) : null,
    ],
  );
  return satir;
}

async function uyarilariListele({ okundu = null, seviye = null, limit = 60 } = {}) {
  const kosullar = [];
  const parametreler = [];
  if (okundu !== null && okundu !== '') {
    parametreler.push(Boolean(Number(okundu) || okundu === true));
    kosullar.push(`u.okundu = $${parametreler.length}`);
  }
  if (seviye && SEVIYELER.includes(seviye)) {
    parametreler.push(seviye);
    kosullar.push(`u.seviye = $${parametreler.length}`);
  }
  parametreler.push(Math.min(Math.max(Number(limit) || 60, 1), 300));

  return db.satirlar(
    `SELECT u.*, k.ad AS kural_ad, k.tur AS kural_tur
       FROM uyarilar u
       LEFT JOIN izleme_kurallari k ON k.id = u.kural_id
      ${kosullar.length ? 'WHERE ' + kosullar.join(' AND ') : ''}
      ORDER BY u.okundu ASC,
               CASE u.seviye WHEN 'kritik' THEN 0 WHEN 'uyari' THEN 1 ELSE 2 END,
               u.olusturuldu_at DESC
      LIMIT $${parametreler.length}`,
    parametreler,
  );
}

async function uyariOkundu(id) {
  await db.sorgu('UPDATE uyarilar SET okundu = TRUE WHERE id = $1', [Number(id)]);
  return { tamam: true };
}

async function tumunuOkundu() {
  const sonuc = await db.sorgu('UPDATE uyarilar SET okundu = TRUE WHERE okundu = FALSE');
  return { tamam: true, sayi: sonuc.rowCount };
}

async function uyariSil(id) {
  await db.sorgu('DELETE FROM uyarilar WHERE id = $1', [Number(id)]);
  return { tamam: true };
}

// ------------------------------------------------------------ DEGERLENDIRME

/**
 * Yeni bir arsiv ogesini aktif izleme kurallarindan gecirir.
 * Tutan her kural icin uyari uretir.
 *
 * @param {object} oge
 * @param {string} oge.ogeTur   kayit | belge | olay | varlik | dosya
 * @param {number} oge.ogeId
 * @param {string} oge.baslik
 * @param {string} oge.metin
 * @param {number} [oge.varlikId]  oge dogrudan bir varliga aitse
 * @returns {Promise<{uyari:number, kurallar:string[]}>}
 */
async function ogeDegerlendir({ ogeTur, ogeId, baslik = '', metin = '', varlikId = null }) {
  const kurallar = await db.satirlar(
    `SELECT k.*, v.ad AS varlik_ad, v.takma_adlar
       FROM izleme_kurallari k
       LEFT JOIN varliklar v ON v.id = k.varlik_id
      WHERE k.aktif = TRUE AND $1 = ANY(k.kapsam)`,
    [ogeTur],
  );
  if (kurallar.length === 0) return { uyari: 0, kurallar: [] };

  const tamMetin = `${baslik}\n${metin}`;
  const anahtarKumesi = new Set(dil.anahtarlar(tamMetin));
  const normalMetin = dil.normalize(tamMetin);
  const tetiklenen = [];

  for (const kural of kurallar) {
    let tutti = false;
    let gerekce = '';

    if (kural.tur === 'anahtar') {
      const sozcukler = String(kural.desen || '').split(/[,;\s]+/).filter(Boolean);
      const bulunan = [];
      for (const s of sozcukler) {
        // Cok sozcuklu ifadeler dogrudan metinde aranir
        if (s.includes('_')) {
          const ifade = dil.normalize(s.replace(/_/g, ' '));
          if (normalMetin.includes(ifade)) bulunan.push(s.replace(/_/g, ' '));
          continue;
        }
        const anahtar = dil.anahtarlar(s);
        if (anahtar.some((a) => anahtarKumesi.has(a))) bulunan.push(s);
      }
      if (bulunan.length) {
        tutti = true;
        gerekce = `Eslesen sozcukler: ${bulunan.join(', ')}`;
      }
    } else if (kural.tur === 'varlik') {
      if (varlikId && Number(varlikId) === Number(kural.varlik_id)) {
        tutti = true;
        gerekce = 'Oge dogrudan izlenen varliga ait.';
      } else if (kural.varlik_ad) {
        const adlar = [kural.varlik_ad, ...(kural.takma_adlar || [])];
        const gecen = adlar.find((a) => a && normalMetin.includes(dil.normalize(a)));
        if (gecen) {
          tutti = true;
          gerekce = `Metinde "${gecen}" gecti.`;
        }
      }
    } else if (kural.tur === 'desen') {
      const ifade = guvenliDesen(kural.desen);
      if (ifade) {
        const eslesme = tamMetin.match(ifade);
        if (eslesme) {
          tutti = true;
          gerekce = `Desen tuttu: "${String(eslesme[0]).slice(0, 120)}"`;
        }
      }
    }

    if (!tutti) continue;

    await uyariEkle({
      kuralId: kural.id,
      seviye: kural.seviye,
      baslik: `${kural.ad}: ${String(baslik).slice(0, 160)}`,
      mesaj: gerekce,
      ogeTur, ogeId,
    });
    await db.sorgu(
      'UPDATE izleme_kurallari SET tetik_sayisi = tetik_sayisi + 1, son_tetik_at = NOW() WHERE id = $1',
      [kural.id],
    );
    tetiklenen.push(kural.ad);

    if (kural.seviye === 'kritik') {
      await log.uyari({
        kategori: 'arsiv', olay: 'kritik_izleme_tetikledi',
        mesaj: `${kural.ad} — ${String(baslik).slice(0, 120)}`,
        meta: { ogeTur, ogeId, kuralId: kural.id },
      });
    }
  }

  return { uyari: tetiklenen.length, kurallar: tetiklenen };
}

/** Tum arsivi kurallardan yeniden gecirir (yeni kural eklendiginde). */
async function gecmisiTara({ kuralId = null, limit = 2000 } = {}) {
  const sayim = { kayit: 0, olay: 0, belge: 0, uyari: 0 };

  const kayitlar = await db.satirlar(
    `SELECT id, baslik, govde FROM kayitlar WHERE silindi = FALSE ORDER BY olusturuldu_at DESC LIMIT $1`,
    [limit],
  );
  for (const k of kayitlar) {
    const r = await ogeDegerlendir({ ogeTur: 'kayit', ogeId: k.id, baslik: k.baslik, metin: k.govde || '' });
    sayim.kayit++;
    sayim.uyari += r.uyari;
  }

  const olaylar = await db.satirlar(
    `SELECT id, baslik, aciklama FROM olaylar WHERE silindi = FALSE ORDER BY zaman DESC LIMIT $1`,
    [limit],
  );
  for (const o of olaylar) {
    const r = await ogeDegerlendir({ ogeTur: 'olay', ogeId: o.id, baslik: o.baslik, metin: o.aciklama || '' });
    sayim.olay++;
    sayim.uyari += r.uyari;
  }

  const belgeler = await db.satirlar(
    `SELECT c.dosya_id AS id, d.ad AS baslik, c.metin
       FROM belge_cozumleme c JOIN dosyalar d ON d.id = c.dosya_id
      WHERE c.dosya_id IS NOT NULL AND d.silindi = FALSE AND c.metin <> ''
      ORDER BY c.olusturuldu_at DESC LIMIT $1`,
    [Math.min(limit, 500)],
  );
  for (const b of belgeler) {
    const r = await ogeDegerlendir({ ogeTur: 'belge', ogeId: b.id, baslik: b.baslik, metin: (b.metin || '').slice(0, 100_000) });
    sayim.belge++;
    sayim.uyari += r.uyari;
  }

  await log.bilgi({ kategori: 'arsiv', olay: 'gecmis_tarandi', mesaj: `${sayim.uyari} uyari uretildi`, meta: { sayim, kuralId } });
  return sayim;
}

module.exports = {
  SEVIYELER, TURLER, KAPSAMLAR,
  kuralOlustur, kuralGuncelle, kuralSil, kurallariListele,
  uyariEkle, uyarilariListele, uyariOkundu, tumunuOkundu, uyariSil,
  ogeDegerlendir, gecmisiTara, guvenliDesen,
};
