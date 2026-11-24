'use strict';
/**
 * src/services/authService.js
 * Kimlik dogrulama is mantigi: giris, cikis, sifre degisimi.
 *
 * Guvenlik notlari:
 *  - Sifreler argon2id ile hashlenir, duz metin hicbir yerde saklanmaz/loglanmaz.
 *  - Kullanici bulunamadiginda da sahte dogrulama yapilir (zamanlama saldirisi).
 *  - Hata mesajlari genel tutulur: "kullanici yok" / "sifre yanlis" ayrimi sizdirilmaz.
 *  - Sifre degisince oturum_surumu artar -> diger tum oturumlar gecersizlesir.
 */

const db = require('../config/db');
const kripto = require('../utils/crypto');
const dogrula = require('../utils/validate');
const kilit = require('./kilitService');
const log = require('./logService');

const GENEL_HATA = 'Kimlik dogrulanamadi. Kullanici adi veya sifre hatali.';

/** Yoneticiyi kimlik ile getirir (sifre hash'i haric). */
async function yoneticiGetir(id) {
  return db.tekSatir(
    `SELECT id, kullanici_adi, gorunen_ad, oturum_surumu, aktif,
            son_giris_at, son_giris_ip, sifre_degisti_at, olusturuldu_at
       FROM yoneticiler
      WHERE id = $1`,
    [id],
  );
}

/**
 * Giris dogrulamasi.
 * @returns {{tamam:boolean, yonetici?:object, hata?:string, kod?:string, kalanSaniye?:number}}
 */
async function girisYap({ kullaniciAdi, sifre, ip, userAgent }) {
  // 1) IP kilidi
  const kilitDurumu = await kilit.durum(ip);
  if (kilitDurumu.kilitli) {
    return {
      tamam: false,
      kod: 'KILITLI',
      hata: `Cok fazla basarisiz deneme. Erisim gecici olarak kilitlendi.`,
      kalanSaniye: kilitDurumu.kalanSaniye,
    };
  }

  // 2) Girdi bicimi
  const ad = dogrula.kullaniciAdi(kullaniciAdi);
  const duzSifre = String(sifre ?? '');

  if (!ad || duzSifre.length === 0 || duzSifre.length > 200) {
    const sonuc = await kilit.basarisizKaydet(ip, kullaniciAdi, userAgent, 'gecersiz_bicim');
    await kripto.sahteDogrulama(duzSifre);
    return {
      tamam: false,
      kod: 'GECERSIZ',
      hata: GENEL_HATA,
      kalanDeneme: sonuc.kalanDeneme,
      kilitli: sonuc.kilitli,
      kalanSaniye: sonuc.kalanSaniye,
    };
  }

  // 3) Kullaniciyi bul
  const kayit = await db.tekSatir(
    `SELECT id, kullanici_adi, gorunen_ad, sifre_hash, oturum_surumu, aktif
       FROM yoneticiler
      WHERE kullanici_adi = $1`,
    [ad],
  );

  if (!kayit || !kayit.aktif) {
    await kripto.sahteDogrulama(duzSifre);   // sabit zaman
    const sonuc = await kilit.basarisizKaydet(ip, ad, userAgent, kayit ? 'hesap_kapali' : 'kullanici_yok');
    await log.uyari({
      kategori: 'kimlik', olay: 'giris_basarisiz',
      mesaj: 'Bilinmeyen veya kapali hesap ile giris denemesi.',
      meta: { kullanici_adi: ad, basarisiz_sayi: sonuc.basarisizSayi },
    });
    return {
      tamam: false, kod: 'GECERSIZ', hata: GENEL_HATA,
      kalanDeneme: sonuc.kalanDeneme, kilitli: sonuc.kilitli, kalanSaniye: sonuc.kalanSaniye,
    };
  }

  // 4) Sifreyi dogrula
  const uyumlu = await kripto.sifreDogrula(kayit.sifre_hash, duzSifre);
  if (!uyumlu) {
    const sonuc = await kilit.basarisizKaydet(ip, ad, userAgent, 'hatali_sifre');
    await log.uyari({
      kategori: 'kimlik', olay: 'giris_basarisiz',
      mesaj: 'Hatali sifre.',
      yoneticiId: kayit.id,
      meta: { kullanici_adi: ad, basarisiz_sayi: sonuc.basarisizSayi, kilitli: sonuc.kilitli },
    });
    return {
      tamam: false, kod: 'GECERSIZ', hata: GENEL_HATA,
      kalanDeneme: sonuc.kalanDeneme, kilitli: sonuc.kilitli, kalanSaniye: sonuc.kalanSaniye,
    };
  }

  // 5) Basarili
  await kilit.basariliKaydet(ip, ad, userAgent);
  await db.sorgu(
    `UPDATE yoneticiler SET son_giris_at = NOW(), son_giris_ip = $2 WHERE id = $1`,
    [kayit.id, ip || null],
  );
  await log.bilgi({
    kategori: 'kimlik', olay: 'giris_basarili',
    mesaj: 'Oturum acildi.',
    yoneticiId: kayit.id,
    meta: { kullanici_adi: ad },
  });

  return {
    tamam: true,
    yonetici: {
      id: kayit.id,
      kullaniciAdi: kayit.kullanici_adi,
      gorunenAd: kayit.gorunen_ad,
      oturumSurumu: kayit.oturum_surumu,
    },
  };
}

/**
 * Ana sifreyi degistirir.
 * Mevcut sifre dogrulanir; yeni sifre politikaya uymak zorundadir.
 * Basarili olursa oturum_surumu artar -> diger oturumlar duser.
 */
async function sifreDegistir({ yoneticiId, mevcutSifre, yeniSifre, yeniSifreTekrar, ip, userAgent }) {
  const kayit = await db.tekSatir(
    `SELECT id, kullanici_adi, sifre_hash, oturum_surumu FROM yoneticiler WHERE id = $1 AND aktif = TRUE`,
    [yoneticiId],
  );
  if (!kayit) return { tamam: false, kod: 'YOK', hata: 'Hesap bulunamadi.' };

  const mevcutTamam = await kripto.sifreDogrula(kayit.sifre_hash, String(mevcutSifre ?? ''));
  if (!mevcutTamam) {
    await log.uyari({
      kategori: 'ayarlar', olay: 'sifre_degistirme_basarisiz',
      mesaj: 'Mevcut sifre hatali.', yoneticiId: kayit.id,
    });
    return { tamam: false, kod: 'MEVCUT_HATALI', hata: 'Mevcut sifre hatali.' };
  }

  if (String(yeniSifre ?? '') !== String(yeniSifreTekrar ?? '')) {
    return { tamam: false, kod: 'UYUSMUYOR', hata: 'Yeni sifreler birbiriyle uyusmuyor.' };
  }

  const politika = dogrula.sifre(yeniSifre);
  if (!politika.gecerli) {
    return { tamam: false, kod: 'POLITIKA', hata: politika.hatalar.join(' '), hatalar: politika.hatalar };
  }

  const ayniMi = await kripto.sifreDogrula(kayit.sifre_hash, String(yeniSifre));
  if (ayniMi) {
    return { tamam: false, kod: 'AYNI', hata: 'Yeni sifre mevcut sifre ile ayni olamaz.' };
  }

  const yeniHash = await kripto.sifreHashle(yeniSifre);
  const guncel = await db.tekSatir(
    `UPDATE yoneticiler
        SET sifre_hash = $2,
            sifre_algo = 'argon2id',
            sifre_degisti_at = NOW(),
            oturum_surumu = oturum_surumu + 1
      WHERE id = $1
      RETURNING oturum_surumu`,
    [kayit.id, yeniHash],
  );

  await log.kritik({
    kategori: 'ayarlar', olay: 'sifre_degistirildi',
    mesaj: 'Ana sifre degistirildi; diger tum oturumlar kapatildi.',
    yoneticiId: kayit.id,
    meta: { kullanici_adi: kayit.kullanici_adi, yeni_oturum_surumu: guncel.oturum_surumu },
  });

  return { tamam: true, oturumSurumu: guncel.oturum_surumu, guc: politika.guc };
}

/**
 * Belirli bir yoneticinin, verilen oturum kimligi DISINDAKI tum oturumlarini siler.
 * (Sifre degisikligi sonrasi "diger cihazlardan cikis" etkisi.)
 */
async function digerOturumlariKapat(yoneticiId, korunacakSid) {
  const sonuc = await db.sorgu(
    `DELETE FROM oturumlar
      WHERE (sess::jsonb -> 'yonetici' ->> 'id') = $1::text
        AND sid <> $2`,
    [String(yoneticiId), String(korunacakSid || '')],
  );
  return sonuc.rowCount;
}

module.exports = { girisYap, sifreDegistir, yoneticiGetir, digerOturumlariKapat, GENEL_HATA };
