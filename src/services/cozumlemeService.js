'use strict';
/**
 * src/services/cozumlemeService.js
 * BELGE COZUMLEME HATTI
 *
 * Kasadaki sifreli bir dosyayi alir ve sirayla:
 *   1) AES-256-GCM ile cozer (dosyaService.coz)
 *   2) BICIMINI sihirli baytlardan dogrular, uzanti uyusmazligini isaretler
 *   3) METNINI cikarir (PDF/DOCX/XLSX/PPTX/ODF/RTF/EML/HTML/ZIP/metin)
 *      ya da goruntuyse EXIF + GPS ustverisini okur
 *   4) OZETLER (TextRank) ve anahtar kavramlarini cikarir
 *   5) VARLIKLARI cikarir (TCKN/IBAN/telefon/plaka/kisi/kurum/konum...)
 *   6) RISK isaretlerini toplar (makro, aktif icerik, cift uzanti, entropi)
 *   7) Sonucu belge_cozumleme tablosuna yazar
 *   8) YEREL ARAMA DIZININE ekler — artik zeka motoru bu belgeyi "okumus"
 *      sayilir ve icerigine dayanarak soru yanitlayabilir
 *   9) IZLEME KURALLARINDAN gecirir
 *
 * Tum adimlar bu makinede calisir; hicbir dis servise dosya gonderilmez.
 */

const db = require('../config/db');
const log = require('./logService');
const dosyaService = require('./dosyaService');
const uyariService = require('./uyariService');
const arsivService = require('./arsivService');

const belgeOkur = require('../zeka/belgeOkur');
const varlikCikarim = require('../zeka/varlikCikarim');
const metrik = require('../zeka/metrik');
const dizin = require('../zeka/dizin');
const ayarService = require('./ayarService');

const MAX_SAKLANAN_METIN = 1_200_000;   // belge_cozumleme.metin ust siniri
const MAX_DOSYA_BOYUT = 120 * 1024 * 1024;

const RISK_ACIKLAMALARI = {
  makro_icerir: 'Belge makro (VBA) tasiyor — acilirken kod calistirabilir.',
  gomulu_nesne: 'Belgeye baska bir dosya gomulmus.',
  gomulu_cerceve: 'Icerikte gomulu cerceve (iframe/object) var.',
  dis_baglanti: 'Belge disaridan icerik cekiyor — acilinca iz birakir.',
  betik_icerir: 'Icerikte calistirilabilir betik var.',
  uzanti_uyusmazligi: 'Dosya uzantisi gercek bicimiyle uyusmuyor — kasitli maskeleme olabilir.',
  cift_uzanti: 'Cift uzanti (orn. rapor.pdf.exe) — klasik maskeleme yontemi.',
  yuksek_entropi: 'Icerik neredeyse rastgele: sifreli ya da sikistirilmis olabilir.',
  calistirilabilir: 'Dosya calistirilabilir bir program.',
  arsivde_calistirilabilir: 'Arsivin icinde calistirilabilir dosya var.',
  sifreli_pdf: 'PDF sifreli; metin katmani cozulemedi.',
  pdf_javascript: 'PDF JavaScript tasiyor.',
  pdf_acilis_eylemi: 'PDF acilista kendiliginden bir eylem tetikliyor.',
  pdf_dis_program: 'PDF dis program cagirma komutu iceriyor.',
  pdf_gomulu_dosya: 'PDF icine baska bir dosya gomulmus.',
  pdf_form_gonderimi: 'PDF form verisini disariya gonderebilir.',
  pdf_zengin_medya: 'PDF zengin medya (video/ses/3B) iceriyor.',
  pdf_otomatik_eylem: 'PDF otomatik eylem tanimi iceriyor.',
  metin_katmani_yok: 'PDF yalnizca goruntuden olusuyor (taranmis) — metin katmani yok.',
  gps_konum_var: 'Goruntu GPS konumu tasiyor — cekildigi yer biliniyor.',
  tehlikeli_ek: 'E-postada calistirilabilir ek var.',
  makrolu_ek: 'E-postada makrolu Office eki var.',
  kaynak_ip_basligi: 'E-posta basliginda gonderen IP adresi var.',
  bozuk_json: 'JSON icerigi gecerli degil.',
};

// ------------------------------------------------------------------ YARDIMCI

function riskAciklamasi(bayrak) {
  return RISK_ACIKLAMALARI[bayrak] || bayrak;
}

/** Cozumleme kaydini dondurur. */
async function getir(dosyaId) {
  return db.tekSatir('SELECT * FROM belge_cozumleme WHERE dosya_id = $1', [Number(dosyaId)]);
}

async function belgeIcinGetir(belgeId) {
  return db.tekSatir('SELECT * FROM belge_cozumleme WHERE belge_id = $1', [Number(belgeId)]);
}

/** Metni, aramada vurgulanabilir sekilde kirpar. */
function metinOzeti(metin, uzunluk = 600) {
  const s = String(metin || '').trim();
  return s.length <= uzunluk ? s : s.slice(0, uzunluk) + '…';
}

// ============================================================== ANA COZUMLEME

/**
 * Bir dosyayi cozumler.
 *
 * @param {number} dosyaId
 * @param {object} secenek
 * @param {number} [secenek.yoneticiId]
 * @param {boolean} [secenek.yenile]  mevcut cozumleme varsa yine de yap
 * @returns {Promise<{tamam:boolean, cozumleme?:object, hata?:string}>}
 */
async function dosyaCozumle(dosyaId, { yoneticiId = null, yenile = false, ip = null } = {}) {
  const basla = Date.now();
  const dosya = await dosyaService.getir(dosyaId);
  if (!dosya) return { tamam: false, hata: 'Dosya bulunamadi.' };

  if (!yenile) {
    const mevcut = await getir(dosyaId);
    if (mevcut && ['tamam', 'kismi'].includes(mevcut.durum)) {
      return { tamam: true, cozumleme: mevcut, atlandi: true };
    }
  }

  if (Number(dosya.boyut_bayt) > MAX_DOSYA_BOYUT) {
    const satir = await kayitYaz(dosyaId, {
      durum: 'desteklenmiyor',
      hata: `Dosya cok buyuk (${Math.round(dosya.boyut_bayt / 1048576)} MB); cozumleme siniri ${Math.round(MAX_DOSYA_BOYUT / 1048576)} MB.`,
      sureMs: Date.now() - basla,
    });
    return { tamam: false, hata: satir.hata, cozumleme: satir };
  }

  let tampon;
  try {
    tampon = await dosyaService.coz(dosya);
  } catch (hata) {
    const satir = await kayitYaz(dosyaId, {
      durum: 'hata', hata: `Dosya cozulemedi: ${hata.message}`, sureMs: Date.now() - basla,
    });
    await log.hata({ kategori: 'arsiv', olay: 'cozumleme_sifre_hatasi', mesaj: hata.message, meta: { dosyaId } });
    return { tamam: false, hata: satir.hata, cozumleme: satir };
  }

  // --- 1-3: bicim + metin + ustveri ---
  const okuma = belgeOkur.oku(tampon, { ad: dosya.ad, mime: dosya.mime_turu });

  // --- 4: ozet + anahtar kavram ---
  let ozet = null;
  let anahtarKelimeler = [];
  if (okuma.metin && okuma.metin.length > 200) {
    const o = metrik.ozetle(okuma.metin, { cumleSayisi: 5, maxKarakter: 1400 });
    ozet = o.ozet || null;
    anahtarKelimeler = metrik.anahtarKelimeler(okuma.metin, { adet: 12 }).map((a) => a.obek.slice(0, 48));
  } else if (okuma.metin) {
    ozet = metinOzeti(okuma.metin, 400);
  }

  // --- 5: varlik cikarimi ---
  const cikarim = okuma.metin
    ? varlikCikarim.cikar(okuma.metin, { minGuven: 0.6, maxBulgu: 60 })
    : { bulgular: [], gruplar: {}, temalar: [], ozet: { toplam: 0, hassas: 0 } };

  // Goruntu GPS'i varsa koordinat bulgusu olarak ekle
  if (okuma.ustveri && okuma.ustveri.gps_enlem !== undefined) {
    cikarim.gruplar.koordinat = cikarim.gruplar.koordinat || [];
    cikarim.gruplar.koordinat.unshift({
      tur: 'koordinat',
      deger: `${okuma.ustveri.gps_enlem}, ${okuma.ustveri.gps_boylam}`,
      normal: `${okuma.ustveri.gps_enlem},${okuma.ustveri.gps_boylam}`,
      guven: 1, sayi: 1,
      baglamlar: ['Goruntu EXIF GPS etiketinden okundu.'],
      ek: { enlem: okuma.ustveri.gps_enlem, boylam: okuma.ustveri.gps_boylam, kaynak: 'exif' },
    });
    cikarim.ozet.toplam++;
  }

  // --- 6: risk isaretleri ---
  const riskler = (okuma.bayraklar || []).map((b) => ({ bayrak: b, aciklama: riskAciklamasi(b) }));

  // --- 7: veritabanina yaz ---
  const satir = await kayitYaz(dosyaId, {
    bicim: okuma.bicim,
    sihirliTur: okuma.sihirli,
    uyusmazlik: okuma.uyusmazlik,
    sayfaSayisi: okuma.sayfaSayisi,
    kelimeSayisi: okuma.kelimeSayisi,
    karakterSayisi: okuma.karakterSayisi,
    dil: okuma.dil,
    metin: okuma.metin.slice(0, MAX_SAKLANAN_METIN),
    ozet,
    anahtarKelimeler,
    bulgular: {
      gruplar: Object.fromEntries(
        Object.entries(cikarim.gruplar).map(([tur, liste]) => [
          tur,
          liste.slice(0, 30).map((b) => ({
            deger: b.deger, normal: b.normal, guven: b.guven, sayi: b.sayi,
            baglam: (b.baglamlar && b.baglamlar[0]) || b.baglam || null,
            ek: b.ek || null,
          })),
        ]),
      ),
      temalar: cikarim.temalar.slice(0, 8),
      ozet: cikarim.ozet,
    },
    ustveri: okuma.ustveri || {},
    riskIsaretleri: (okuma.bayraklar || []).slice(0, 20),
    entropi: okuma.entropi,
    durum: okuma.durum,
    hata: okuma.hata,
    sureMs: Date.now() - basla,
  });

  // --- 8: yerel arama dizinine ekle ---
  if (okuma.metin) {
    try {
      await dizin.yaz({
        kaynakTur: 'dosya',
        kaynakId: Number(dosyaId),
        baslik: dosya.ad,
        metin: `${ozet || ''}\n${okuma.metin}`,
      });
    } catch (hata) {
      await log.uyari({ kategori: 'zeka', olay: 'dizin_yazilamadi', mesaj: hata.message, meta: { dosyaId } });
    }
  }

  // --- 9: izleme kurallari ---
  if (okuma.metin) {
    uyariService.ogeDegerlendir({
      ogeTur: 'belge', ogeId: Number(dosyaId), baslik: dosya.ad,
      metin: okuma.metin.slice(0, 200_000),
    }).catch(() => {});
  }

  // Yuksek riskli bulgular icin dogrudan uyari
  const agirRiskler = (okuma.bayraklar || []).filter((b) =>
    ['makro_icerir', 'cift_uzanti', 'uzanti_uyusmazligi', 'calistirilabilir',
      'pdf_javascript', 'pdf_dis_program', 'tehlikeli_ek', 'arsivde_calistirilabilir'].includes(b));
  if (agirRiskler.length) {
    await uyariService.uyariEkle({
      seviye: 'kritik',
      baslik: `Riskli dosya: ${dosya.ad}`,
      mesaj: agirRiskler.map(riskAciklamasi).join(' '),
      ogeTur: 'dosya', ogeId: Number(dosyaId),
    });
  }
  if (cikarim.ozet.hassas > 0) {
    await uyariService.uyariEkle({
      seviye: 'uyari',
      baslik: `Hassas veri icerigi: ${dosya.ad}`,
      mesaj: `${cikarim.ozet.hassas} dogrulanmis kimlik/hesap bilgisi tespit edildi (TCKN, IBAN, kart vb.).`,
      ogeTur: 'dosya', ogeId: Number(dosyaId),
    });
  }

  await arsivService.denetimYaz({
    ogeTur: 'dosya', ogeId: Number(dosyaId), eylem: 'cozumleme', yoneticiId,
    sonraki: { bicim: okuma.bicim, durum: okuma.durum, kelime: okuma.kelimeSayisi, varlik: cikarim.ozet.toplam },
    ip,
  });

  await log.bilgi({
    kategori: 'arsiv', olay: 'belge_cozumlendi',
    mesaj: `${dosya.ad} (${okuma.bicim}, ${okuma.kelimeSayisi} kelime, ${cikarim.ozet.toplam} varlik)`,
    yoneticiId, meta: { dosyaId, durum: okuma.durum, sureMs: satir.sure_ms },
  });

  return { tamam: okuma.durum !== 'hata', cozumleme: satir, cikarim, riskler };
}

/** belge_cozumleme satirini ekler/guncellerr. */
async function kayitYaz(dosyaId, veri) {
  return db.tekSatir(
    `INSERT INTO belge_cozumleme
       (dosya_id, bicim, sihirli_tur, uyusmazlik, sayfa_sayisi, kelime_sayisi, karakter_sayisi,
        dil, metin, ozet, anahtar_kelimeler, bulgular, ustveri, risk_isaretleri, entropi,
        durum, hata, sure_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (dosya_id) WHERE dosya_id IS NOT NULL DO UPDATE SET
       bicim=EXCLUDED.bicim, sihirli_tur=EXCLUDED.sihirli_tur, uyusmazlik=EXCLUDED.uyusmazlik,
       sayfa_sayisi=EXCLUDED.sayfa_sayisi, kelime_sayisi=EXCLUDED.kelime_sayisi,
       karakter_sayisi=EXCLUDED.karakter_sayisi, dil=EXCLUDED.dil, metin=EXCLUDED.metin,
       ozet=EXCLUDED.ozet, anahtar_kelimeler=EXCLUDED.anahtar_kelimeler,
       bulgular=EXCLUDED.bulgular, ustveri=EXCLUDED.ustveri,
       risk_isaretleri=EXCLUDED.risk_isaretleri, entropi=EXCLUDED.entropi,
       durum=EXCLUDED.durum, hata=EXCLUDED.hata, sure_ms=EXCLUDED.sure_ms,
       guncellendi_at=NOW()
     RETURNING *`,
    [
      Number(dosyaId),
      veri.bicim || null,
      veri.sihirliTur || null,
      Boolean(veri.uyusmazlik),
      veri.sayfaSayisi || null,
      veri.kelimeSayisi || 0,
      veri.karakterSayisi || 0,
      veri.dil || null,
      veri.metin || '',
      veri.ozet || null,
      veri.anahtarKelimeler || [],
      JSON.stringify(veri.bulgular || {}),
      JSON.stringify(veri.ustveri || {}),
      veri.riskIsaretleri || [],
      veri.entropi !== undefined ? veri.entropi : null,
      veri.durum || 'hata',
      veri.hata || null,
      veri.sureMs || null,
    ],
  );
}

// =========================================================== TOPLU COZUMLEME

/**
 * Henuz cozumlenmemis tum dosyalari sirayla cozumler.
 * @param {(bilgi:object)=>void} [ilerleme]
 */
async function bekleyenleriCozumle({ limit = 200, yoneticiId = null } = {}, ilerleme) {
  const bekleyenler = await db.satirlar(
    `SELECT d.id, d.ad, d.boyut_bayt FROM dosyalar d
      WHERE d.silindi = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM belge_cozumleme c
           WHERE c.dosya_id = d.id AND c.durum IN ('tamam','kismi','desteklenmiyor'))
      ORDER BY d.olusturuldu_at DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 200, 1), 1000)],
  );

  const sayim = { toplam: bekleyenler.length, tamam: 0, kismi: 0, basarisiz: 0, varlik: 0 };

  for (const d of bekleyenler) {
    try {
      const sonuc = await dosyaCozumle(d.id, { yoneticiId });
      if (sonuc.cozumleme) {
        if (sonuc.cozumleme.durum === 'tamam') sayim.tamam++;
        else if (sonuc.cozumleme.durum === 'kismi') sayim.kismi++;
        else sayim.basarisiz++;
      } else sayim.basarisiz++;
      if (sonuc.cikarim) sayim.varlik += sonuc.cikarim.ozet.toplam;
    } catch (hata) {
      sayim.basarisiz++;
      await log.uyari({ kategori: 'arsiv', olay: 'toplu_cozumleme_hatasi', mesaj: hata.message, meta: { dosyaId: d.id } });
    }
    if (typeof ilerleme === 'function') ilerleme({ ...sayim, suAnki: d.ad });
  }

  return sayim;
}

/** Yukleme sirasinda otomatik cozumleme ayari aciksa tetiklenir. */
async function otomatikCozumle(dosyaId, { yoneticiId = null } = {}) {
  try {
    const acik = await ayarService.ayarAl('zeka_otomatik_cozumleme', 'true');
    if (String(acik) !== 'true') return { tamam: false, atlandi: true };
    return dosyaCozumle(dosyaId, { yoneticiId });
  } catch (hata) {
    await log.uyari({ kategori: 'arsiv', olay: 'otomatik_cozumleme_hatasi', mesaj: hata.message, meta: { dosyaId } });
    return { tamam: false, hata: hata.message };
  }
}

// ======================================================== VARLIK ONERILERI

/**
 * Cozumlemede bulunan varliklari arsive eklemeye hazir oneri listesine
 * cevirir; halihazirda kayitli olanlari isaretler.
 */
async function varlikOnerileri(dosyaId) {
  const cozumleme = await getir(dosyaId);
  if (!cozumleme || !cozumleme.bulgular || !cozumleme.bulgular.gruplar) return [];

  const TUR_ESLEME = {
    kisi: 'kisi', kurum: 'kurum', konum: 'konum', telefon: 'telefon', eposta: 'eposta',
    web: 'web', ip: 'cihaz', cihaz: 'cihaz', plaka: 'arac', iban: 'hesap',
    cuzdan: 'hesap', sosyal: 'hesap', imei: 'cihaz', kod_adi: 'kod_adi',
  };

  const oneriler = [];
  for (const [tur, liste] of Object.entries(cozumleme.bulgular.gruplar)) {
    const arsivTuru = TUR_ESLEME[tur];
    if (!arsivTuru) continue;
    for (const b of liste) {
      if (Number(b.guven) < 0.6) continue;
      oneriler.push({
        arsivTuru, kaynakTuru: tur, ad: String(b.deger).slice(0, 180),
        normal: b.normal, guven: b.guven, sayi: b.sayi, baglam: b.baglam, ek: b.ek,
      });
    }
  }

  if (oneriler.length === 0) return [];

  // Mevcut varliklari tek sorguda isaretle
  const adlar = oneriler.map((o) => o.ad);
  const mevcutlar = await db.satirlar(
    `SELECT id, kod, ad, tur FROM varliklar
      WHERE silindi = FALSE
        AND arsiv_normalize(ad) = ANY(SELECT arsiv_normalize(a) FROM UNNEST($1::text[]) a)`,
    [adlar],
  );
  const harita = new Map(mevcutlar.map((m) => [`${m.tur}|${String(m.ad).toLocaleLowerCase('tr-TR')}`, m]));

  return oneriler
    .map((o) => {
      const eslesme = harita.get(`${o.arsivTuru}|${o.ad.toLocaleLowerCase('tr-TR')}`);
      return { ...o, mevcut: eslesme || null };
    })
    .sort((a, b) => (b.guven * b.sayi) - (a.guven * a.sayi))
    .slice(0, 80);
}

/**
 * Secili onerileri gercek varliga cevirir ve dosyayi onlara ek olarak baglar.
 */
async function onerileriKaydet(dosyaId, secimler, { yoneticiId = null, kayitId = null } = {}) {
  const sonuc = { olusturulan: 0, baglanan: 0, hatalar: [] };
  const oneriler = await varlikOnerileri(dosyaId);
  const haritalanan = new Map(oneriler.map((o) => [`${o.arsivTuru}|${o.ad}`, o]));

  for (const secim of (Array.isArray(secimler) ? secimler : []).slice(0, 60)) {
    const anahtar = `${secim.tur}|${secim.ad}`;
    const oneri = haritalanan.get(anahtar) || { arsivTuru: secim.tur, ad: secim.ad, guven: 0.6, ek: null, baglam: null };

    try {
      let varlikId = secim.varlik_id ? Number(secim.varlik_id) : null;

      if (!varlikId) {
        const olusturma = await arsivService.varlikOlustur({
          tur: oneri.arsivTuru,
          ad: oneri.ad,
          ozet: oneri.baglam ? `Belge cozumlemesinden cikarildi: ${oneri.baglam}` : 'Belge cozumlemesinden cikarildi.',
          guvenilirlik: 'C',
          dogruluk: 3,
          onem: 40,
          etiketler: ['cozumleme'],
          ozellikler: {
            kaynak: 'belge_cozumleme', dosya_id: Number(dosyaId),
            guven: oneri.guven, ...(oneri.normal ? { normal: oneri.normal } : {}), ...(oneri.ek || {}),
          },
          ...(oneri.ek && Number.isFinite(oneri.ek.enlem) ? { enlem: oneri.ek.enlem, boylam: oneri.ek.boylam } : {}),
        }, { yoneticiId });

        if (!olusturma.tamam) { sonuc.hatalar.push(`${oneri.ad}: ${olusturma.hata}`); continue; }
        varlikId = olusturma.varlik.id;
        sonuc.olusturulan++;
      }

      await arsivService.varlikEkEkle(varlikId, 'dosya', Number(dosyaId), { notMetni: 'Cozumleme kaynagi' });
      if (kayitId) await arsivService.kayitVarlikBagla(kayitId, varlikId, 'ilgili', { otomatik: true });
      sonuc.baglanan++;
    } catch (hata) {
      sonuc.hatalar.push(`${secim.ad}: ${hata.message}`);
    }
  }

  return sonuc;
}

/**
 * Cozumlenmis bir dosyadan dogrudan arsiv kaydi uretir.
 * Belgeyi "okuyup" istihbarat kaydina ceviren kisayol.
 */
async function kayitUret(dosyaId, { yoneticiId = null, vakaId = null, tasnif = null } = {}) {
  const [dosya, cozumleme] = await Promise.all([dosyaService.getir(dosyaId), getir(dosyaId)]);
  if (!dosya) return { tamam: false, hata: 'Dosya bulunamadi.' };
  if (!cozumleme || !['tamam', 'kismi'].includes(cozumleme.durum)) {
    return { tamam: false, hata: 'Dosya henuz cozumlenmedi. Once cozumleme yapilmali.' };
  }

  const varsayilanTasnif = tasnif || await ayarService.ayarAl('arsiv_varsayilan_tasnif', 'hizmete_ozel');
  const gruplar = (cozumleme.bulgular && cozumleme.bulgular.gruplar) || {};
  const tarih = (gruplar.tarih || [])[0];
  const konum = (gruplar.konum || [])[0];
  const koordinat = (gruplar.koordinat || [])[0];

  const olusturma = await arsivService.kayitOlustur({
    baslik: `Belge: ${dosya.ad}`.slice(0, 300),
    govde: (cozumleme.metin || '').slice(0, 180_000),
    tur: 'acik_kaynak',
    tasnif: varsayilanTasnif,
    guvenilirlik: 'C',
    dogruluk: 3,
    durum: 'yeni',
    vaka_id: vakaId,
    ozet: cozumleme.ozet,
    anahtar_kelimeler: cozumleme.anahtar_kelimeler || [],
    etiketler: ['belge', cozumleme.bicim || 'dosya'].filter(Boolean),
    konum: konum ? konum.deger : null,
    olay_zamani: tarih ? tarih.normal : null,
    enlem: koordinat && koordinat.ek ? koordinat.ek.enlem : null,
    boylam: koordinat && koordinat.ek ? koordinat.ek.boylam : null,
  }, { yoneticiId });

  if (!olusturma.tamam) return olusturma;

  // Uretilen kaydi ve kaynak dosyayi birbirine bagla
  await arsivService.denetimYaz({
    ogeTur: 'kayit', ogeId: olusturma.kayit.id, eylem: 'baglanti', yoneticiId,
    sonraki: { kaynak_dosya: Number(dosyaId), dosya_adi: dosya.ad },
    aciklama: 'Kayit, cozumlenmis belgeden uretildi.',
  });
  if (vakaId) {
    await arsivService.vakaOgeEkle(Number(vakaId), 'dosya', Number(dosyaId), { notMetni: 'Kayit kaynagi' }).catch(() => {});
  }

  return { tamam: true, kayit: olusturma.kayit };
}

// ============================================================== GOSTERGELER

async function durum() {
  const genel = await db.tekSatir(`
    SELECT COUNT(*)::int AS toplam,
           COUNT(*) FILTER (WHERE durum = 'tamam')::int AS tamam,
           COUNT(*) FILTER (WHERE durum = 'kismi')::int AS kismi,
           COUNT(*) FILTER (WHERE durum = 'desteklenmiyor')::int AS desteklenmiyor,
           COUNT(*) FILTER (WHERE durum = 'hata')::int AS hata,
           COALESCE(SUM(kelime_sayisi), 0)::bigint AS kelime,
           COALESCE(SUM(array_length(risk_isaretleri, 1)), 0)::int AS risk,
           COUNT(*) FILTER (WHERE uyusmazlik)::int AS uyusmazlik,
           COALESCE(ROUND(AVG(sure_ms))::int, 0) AS ort_sure
      FROM belge_cozumleme`);

  const bekleyen = await db.tekSatir(`
    SELECT COUNT(*)::int AS n FROM dosyalar d
     WHERE d.silindi = FALSE
       AND NOT EXISTS (SELECT 1 FROM belge_cozumleme c
                        WHERE c.dosya_id = d.id AND c.durum IN ('tamam','kismi','desteklenmiyor'))`);

  const bicimler = await db.satirlar(`
    SELECT bicim, COUNT(*)::int AS n FROM belge_cozumleme
     WHERE bicim IS NOT NULL GROUP BY bicim ORDER BY n DESC LIMIT 14`);

  const riskler = await db.satirlar(`
    SELECT b AS bayrak, COUNT(*)::int AS n
      FROM belge_cozumleme, UNNEST(risk_isaretleri) AS b
     GROUP BY b ORDER BY n DESC LIMIT 14`);

  return {
    ...(genel || {}),
    bekleyen: bekleyen ? bekleyen.n : 0,
    bicimler,
    riskler: riskler.map((r) => ({ ...r, aciklama: riskAciklamasi(r.bayrak) })),
  };
}

/** Risk isareti tasiyan cozumlemeler. */
async function riskliBelgeler({ limit = 40 } = {}) {
  return db.satirlar(
    `SELECT c.dosya_id, c.bicim, c.risk_isaretleri, c.uyusmazlik, c.entropi, c.durum,
            d.ad, d.boyut_bayt, d.mime_turu, c.guncellendi_at
       FROM belge_cozumleme c
       JOIN dosyalar d ON d.id = c.dosya_id
      WHERE d.silindi = FALSE
        AND (array_length(c.risk_isaretleri, 1) > 0 OR c.uyusmazlik = TRUE)
      ORDER BY array_length(c.risk_isaretleri, 1) DESC NULLS LAST, c.guncellendi_at DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 40, 1), 200)],
  );
}

module.exports = {
  dosyaCozumle, bekleyenleriCozumle, otomatikCozumle,
  getir, belgeIcinGetir, durum, riskliBelgeler,
  varlikOnerileri, onerileriKaydet, kayitUret,
  riskAciklamasi, RISK_ACIKLAMALARI,
};
