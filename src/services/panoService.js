'use strict';
/**
 * src/services/panoService.js
 * /pano modulu: cizim/strateji tuvali.
 *
 * KAYIT MODELI
 *   Her "kaydet" cagrisi, o anki TUM oge listesini sunucuya tam bir
 *   enstantane (snapshot) olarak yollar. Sunucu pano_ogeleri tablosunda o
 *   panoya ait satirlari silip yeniden ekler. Bu; diff/patch mantigi
 *   gerektirmeden basit, tutarli ve "anlik kaydetme" ihtiyacini tam
 *   karsilayan bir yaklasimdir. Donen satirlarin id'leri HER kayitta
 *   yenilenir; istemci kendi yerel listesini donen id'lerle degistirir.
 *
 * ESZAMANLILIK
 *   panolar.surum iyimser kilitleme (optimistic concurrency) icin kullanilir.
 *   Istemci son bildigi surumu yollar; sunucu yalnizca o surum hala
 *   guncelse kaydi kabul eder ve surumu 1 artirir. Uyusmazlikta 409 ile
 *   guncel durum donulur; istemci kullaniciya "yeniden yukle mi / zorla
 *   kaydet mi" secenegi sunar.
 *
 * TUM PANO KILIDI vs OGE KILIDI
 *   panolar.kilitli  -> tum tuval salt-okunur (yanlislikla duzenlemeyi
 *                        onler). Kilitliyken kaydet() yalnizca kamera/
 *                        onizleme gibi goruntu bilgisini gunceller, oge
 *                        listesine dokunmaz.
 *   pano_ogeleri.kilitli -> tek bir ogenin tasinmasini/silinmesini engeller
 *                        (istemci tarafinda uygulanir, sunucu sadece saklar).
 */

const db = require('../config/db');

const GECERLI_TURLER = new Set(['not', 'kalem', 'dikdortgen', 'elips', 'cizgi', 'ok', 'metin', 'resim', 'dugum', 'baglanti']);
const RENK_DESENI = /^#[0-9a-fA-F]{3,8}$/;
const MAX_OGE = 4000;           // tek panoda ustte mantikli bir tavan
const MAX_OGE_VERI_BAYT = 2_500_000; // tek ogenin veri(JSONB) alani icin ust sinir (~2.5MB, resimler haric genelde cok altinda)

// ------------------------------------------------------------------ LISTELE
async function listele() {
  return db.satirlar(
    `SELECT p.id, p.ad, p.aciklama, p.onizleme, p.kilitli, p.surum, p.guncellendi_at,
            (SELECT COUNT(*)::int FROM pano_ogeleri o WHERE o.pano_id = p.id) AS oge_sayisi
       FROM panolar p
      WHERE p.silindi = FALSE
      ORDER BY p.guncellendi_at DESC
      LIMIT 100`,
  );
}

async function getir(id) {
  return db.tekSatir(
    `SELECT id, ad, aciklama, tuval, onizleme, kilitli, surum, olusturuldu_at, guncellendi_at
       FROM panolar WHERE id = $1 AND silindi = FALSE`,
    [id],
  );
}

/** Pano + tum ogelerini birlikte doner (editor sayfasinin ilk yuklemesi). */
async function tamOku(id) {
  const pano = await getir(id);
  if (!pano) return null;
  const ogeler = await db.satirlar(
    `SELECT id, tur, veri, x, y, genislik, yukseklik, renk, z_sira, kilitli
       FROM pano_ogeleri WHERE pano_id = $1 ORDER BY z_sira, id`,
    [id],
  );
  return { pano, ogeler };
}

// ------------------------------------------------------------------- CRUD
async function olustur({ ad, aciklama, yoneticiId }) {
  const temizAd = String(ad || '').trim().slice(0, 150) || 'Adsiz Pano';
  const temizAciklama = aciklama ? String(aciklama).trim().slice(0, 500) : null;

  const satir = await db.tekSatir(
    `INSERT INTO panolar (ad, aciklama, olusturan_id)
     VALUES ($1, $2, $3)
     RETURNING id, ad, aciklama, tuval, onizleme, kilitli, surum, olusturuldu_at, guncellendi_at`,
    [temizAd, temizAciklama, yoneticiId || null],
  );
  return { tamam: true, pano: satir };
}

async function silSoft(id) {
  const satir = await db.tekSatir(
    `UPDATE panolar SET silindi = TRUE WHERE id = $1 AND silindi = FALSE RETURNING id`,
    [id],
  );
  return { tamam: Boolean(satir) };
}

// -------------------------------------------------------------- TUM KILIT
async function kilitAyarla(id, kilitli) {
  const satir = await db.tekSatir(
    `UPDATE panolar SET kilitli = $2 WHERE id = $1 AND silindi = FALSE RETURNING id, kilitli`,
    [id, Boolean(kilitli)],
  );
  if (!satir) return { tamam: false, hata: 'Pano bulunamadi.' };
  return { tamam: true, kilitli: satir.kilitli };
}

// ------------------------------------------------------------- DOGRULAMA
/** Istemciden gelen tek bir ogeyi dogrular/temizler; gecersizse null doner. */
function ogeTemizle(ham) {
  if (!ham || typeof ham !== 'object') return null;
  const tur = String(ham.tur || '');
  if (!GECERLI_TURLER.has(tur)) return null;

  const sayi = (deger, varsayilan = 0) => (Number.isFinite(Number(deger)) ? Number(deger) : varsayilan);
  const renk = RENK_DESENI.test(String(ham.renk || '')) ? String(ham.renk) : '#00ff9c';

  let veri = ham.veri;
  if (veri === undefined || veri === null || typeof veri !== 'object' || Array.isArray(veri)) veri = {};
  try {
    if (Buffer.byteLength(JSON.stringify(veri), 'utf8') > MAX_OGE_VERI_BAYT) return null;
  } catch (_) {
    return null;
  }

  return {
    tur,
    veri,
    x: sayi(ham.x, 0),
    y: sayi(ham.y, 0),
    genislik: ham.genislik === null || ham.genislik === undefined ? null : sayi(ham.genislik, null),
    yukseklik: ham.yukseklik === null || ham.yukseklik === undefined ? null : sayi(ham.yukseklik, null),
    renk,
    zSira: Number.isInteger(Number(ham.zSira)) ? Number(ham.zSira) : 0,
    kilitli: Boolean(ham.kilitli),
  };
}

// -------------------------------------------------------------------- KAYDET
/**
 * Panonun TUM durumunu (kamera + oge listesi) tek enstantane olarak kaydeder.
 * @returns {{tamam:boolean, kod?:string, surum?:number, ogeler?:object[], pano?:object, hata?:string}}
 */
async function kaydet({ id, ad, tuval, onizleme, ogeler, beklenenSurum, zorla = false }) {
  return db.islem(async (istemci) => {
    const mevcut = await istemci.query(
      'SELECT surum, kilitli FROM panolar WHERE id = $1 AND silindi = FALSE FOR UPDATE',
      [id],
    );
    if (mevcut.rows.length === 0) return { tamam: false, kod: 'YOK', hata: 'Pano bulunamadi veya silinmis.' };

    const satirMevcut = mevcut.rows[0];
    if (!zorla && Number(beklenenSurum) !== Number(satirMevcut.surum)) {
      // Celiski: baska bir sekmede/oturumda guncellenmis. Guncel hali donelim.
      const guncelOgeler = await istemci.query(
        `SELECT id, tur, veri, x, y, genislik, yukseklik, renk, z_sira, kilitli
           FROM pano_ogeleri WHERE pano_id = $1 ORDER BY z_sira, id`,
        [id],
      );
      return {
        tamam: false, kod: 'CELISKI',
        hata: 'Bu pano baska bir yerden guncellenmis.',
        surum: satirMevcut.surum,
        ogeler: guncelOgeler.rows,
      };
    }

    const tuvalGuvenli = (tuval && typeof tuval === 'object' && !Array.isArray(tuval)) ? tuval : { kamera: { x: 0, y: 0, olcek: 1 }, izgara: true };
    const onizlemeGuvenli = typeof onizleme === 'string' ? onizleme.slice(0, 400_000) : null;
    const adGuvenli = typeof ad === 'string' && ad.trim() ? ad.trim().slice(0, 150) : null;

    const guncellenen = await istemci.query(
      `UPDATE panolar SET tuval = $2, onizleme = $3, surum = surum + 1,
              ad = COALESCE($4, ad)
        WHERE id = $1 RETURNING surum, kilitli, ad`,
      [id, JSON.stringify(tuvalGuvenli), onizlemeGuvenli, adGuvenli],
    );
    const yeniSurum = guncellenen.rows[0].surum;

    let donenOgeler = [];
    if (!satirMevcut.kilitli && Array.isArray(ogeler)) {
      const temizler = ogeler.map(ogeTemizle).filter(Boolean).slice(0, MAX_OGE);

      await istemci.query('DELETE FROM pano_ogeleri WHERE pano_id = $1', [id]);

      if (temizler.length > 0) {
        const degerler = [];
        const yerTutucular = [];
        temizler.forEach((o, i) => {
          const taban = i * 10;
          yerTutucular.push(
            `($${taban + 1}, $${taban + 2}, $${taban + 3}, $${taban + 4}, $${taban + 5}, $${taban + 6}, $${taban + 7}, $${taban + 8}, $${taban + 9}, $${taban + 10})`,
          );
          degerler.push(id, o.tur, JSON.stringify(o.veri), o.x, o.y, o.genislik, o.yukseklik, o.renk, o.zSira, o.kilitli);
        });

        const eklenen = await istemci.query(
          `INSERT INTO pano_ogeleri (pano_id, tur, veri, x, y, genislik, yukseklik, renk, z_sira, kilitli)
           VALUES ${yerTutucular.join(', ')}
           RETURNING id, tur, veri, x, y, genislik, yukseklik, renk, z_sira, kilitli`,
          degerler,
        );
        donenOgeler = eklenen.rows;
      }
    } else {
      // Pano kilitliyse oge listesine dokunulmaz; mevcutlari oldugu gibi geri don.
      const mevcutOgeler = await istemci.query(
        `SELECT id, tur, veri, x, y, genislik, yukseklik, renk, z_sira, kilitli
           FROM pano_ogeleri WHERE pano_id = $1 ORDER BY z_sira, id`,
        [id],
      );
      donenOgeler = mevcutOgeler.rows;
    }

    return { tamam: true, surum: yeniSurum, kilitli: satirMevcut.kilitli, ad: guncellenen.rows[0].ad, ogeler: donenOgeler };
  });
}

// ------------------------------------------------------------- TEK RESIM
async function resimEkle({ panoId, dosya, x, y, yoneticiId }) {
  const pano = await getir(panoId);
  if (!pano) return { tamam: false, hata: 'Pano bulunamadi.' };
  if (pano.kilitli) return { tamam: false, hata: 'Pano kilitli; once kilidi kaldirin.' };

  const maksZSiraSatir = await db.tekSatir(
    'SELECT COALESCE(MAX(z_sira), 0) + 1 AS sonraki FROM pano_ogeleri WHERE pano_id = $1',
    [panoId],
  );
  const zSira = maksZSiraSatir ? maksZSiraSatir.sonraki : 1;

  const base64 = dosya.buffer.toString('base64');
  const src = `data:${dosya.mimetype};base64,${base64}`;
  // Gercek piksel boyutu bilinmedigi icin makul bir varsayilan konuluyor;
  // istemci resmi yukleyince gercek en/boy oranina gore kendi tarafinda
  // yeniden olculendirip bir sonraki kaydet() cagrisinda duzeltir.
  const varsayilanBoyut = 260;

  const satir = await db.tekSatir(
    `INSERT INTO pano_ogeleri (pano_id, tur, veri, x, y, genislik, yukseklik, renk, z_sira, kilitli)
     VALUES ($1, 'resim', $2, $3, $4, $5, $5, '#00ff9c', $6, FALSE)
     RETURNING id, tur, veri, x, y, genislik, yukseklik, renk, z_sira, kilitli`,
    [panoId, JSON.stringify({ src, ad: String(dosya.originalname || 'resim').slice(0, 200) }), Number(x) || 0, Number(y) || 0, varsayilanBoyut, zSira],
  );

  return { tamam: true, oge: satir };
}

// ------------------------------------------------------------- DISA AKTAR
async function disaAktar(id) {
  const okunan = await tamOku(id);
  if (!okunan) return null;
  const { pano, ogeler } = okunan;
  return {
    sema: 'cms-pano-yedek',
    semaSurumu: 1,
    disaAktarilmaZamani: new Date().toISOString(),
    pano: { ad: pano.ad, aciklama: pano.aciklama, tuval: pano.tuval },
    ogeler: ogeler.map((o) => ({
      tur: o.tur, veri: o.veri, x: o.x, y: o.y,
      genislik: o.genislik, yukseklik: o.yukseklik, renk: o.renk,
      zSira: o.z_sira, kilitli: o.kilitli,
    })),
  };
}

// ------------------------------------------------------------- ICE AKTAR
async function iceAktar({ govde, yoneticiId }) {
  if (!govde || typeof govde !== 'object') return { tamam: false, hata: 'Yedek dosyasi okunamadi (gecersiz JSON).' };
  if (govde.sema !== 'cms-pano-yedek' && !Array.isArray(govde.ogeler)) {
    return { tamam: false, hata: 'Bu dosya bir CMS Veri Merkezi pano yedegi degil.' };
  }

  const panoBilgi = govde.pano || {};
  const ad = String(panoBilgi.ad || govde.ad || 'Geri Yuklenen Pano').trim().slice(0, 150) || 'Geri Yuklenen Pano';
  const aciklama = panoBilgi.aciklama ? String(panoBilgi.aciklama).trim().slice(0, 500) : null;
  const tuval = (panoBilgi.tuval && typeof panoBilgi.tuval === 'object') ? panoBilgi.tuval : { kamera: { x: 0, y: 0, olcek: 1 }, izgara: true };

  const hamOgeler = Array.isArray(govde.ogeler) ? govde.ogeler : [];
  const temizler = hamOgeler.map(ogeTemizle).filter(Boolean).slice(0, MAX_OGE);

  return db.islem(async (istemci) => {
    const panoSatir = await istemci.query(
      `INSERT INTO panolar (ad, aciklama, tuval, olusturan_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, ad, aciklama, tuval, onizleme, kilitli, surum, olusturuldu_at, guncellendi_at`,
      [ad, aciklama, JSON.stringify(tuval), yoneticiId || null],
    );
    const yeniPano = panoSatir.rows[0];

    if (temizler.length > 0) {
      const degerler = [];
      const yerTutucular = [];
      temizler.forEach((o, i) => {
        const taban = i * 10;
        yerTutucular.push(
          `($${taban + 1}, $${taban + 2}, $${taban + 3}, $${taban + 4}, $${taban + 5}, $${taban + 6}, $${taban + 7}, $${taban + 8}, $${taban + 9}, $${taban + 10})`,
        );
        degerler.push(yeniPano.id, o.tur, JSON.stringify(o.veri), o.x, o.y, o.genislik, o.yukseklik, o.renk, o.zSira, o.kilitli);
      });
      await istemci.query(
        `INSERT INTO pano_ogeleri (pano_id, tur, veri, x, y, genislik, yukseklik, renk, z_sira, kilitli)
         VALUES ${yerTutucular.join(', ')}`,
        degerler,
      );
    }

    return { tamam: true, pano: yeniPano, ogeSayisi: temizler.length };
  });
}

module.exports = {
  listele, getir, tamOku, olustur, silSoft, kilitAyarla,
  kaydet, resimEkle, disaAktar, iceAktar,
  GECERLI_TURLER,
  // test/log amacli
  _ogeTemizle: ogeTemizle,
};
