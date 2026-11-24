'use strict';
/**
 * src/services/cambazService.js
 * Cambaz yapay zeka ajaninin tum orkestrasyonu:
 *  - Gorusme (oturum) ve mesaj CRUD
 *  - Cevrimici yanit: secili saglayici + tek-adimli ReAct arac cagirma
 *    ("ara" / "oku") + metin-ici "HAFIZA:" yonergesiyle kalici ogrenme
 *  - Cevrimdisi (API anahtarsiz) dahili motor: matematik + hava durumu +
 *    basit sohbet sezgileri
 */

const db = require('../config/db');
const ayar = require('../config/env');
const ayarService = require('./ayarService');
const yzSaglayicilari = require('./yzSaglayicilari');
const aramaServisi = require('./aramaServisi');
const havaService = require('./havaService');
const hesapMakinesi = require('../utils/hesapMakinesi');
const dogrula = require('../utils/validate');
const log = require('./logService');

const MAX_ARAC_HOP = 2;

// ------------------------------------------------------------- OTURUMLAR

async function oturumlariListele() {
  return db.satirlar(
    `SELECT o.id, o.baslik, o.saglayici, o.model, o.guncellendi_at,
            (SELECT COUNT(*)::int FROM cambaz_mesajlari m WHERE m.oturum_id = o.id) AS mesaj_sayisi
       FROM cambaz_oturumlari o
      WHERE o.arsivlendi = FALSE
      ORDER BY o.guncellendi_at DESC
      LIMIT 50`,
  );
}

async function oturumGetir(id) {
  return db.tekSatir('SELECT * FROM cambaz_oturumlari WHERE id = $1', [id]);
}

async function oturumOlustur({ baslik, saglayici, model, yoneticiId }) {
  const satir = await db.tekSatir(
    `INSERT INTO cambaz_oturumlari (baslik, saglayici, model, yonetici_id)
          VALUES ($1, $2, $3, $4) RETURNING *`,
    [dogrula.metin(baslik || 'Yeni Gorusme', { max: 150 }) || 'Yeni Gorusme', saglayici || null, model || null, yoneticiId || null],
  );
  return satir;
}

async function oturumSil(id) {
  const sonuc = await db.sorgu('DELETE FROM cambaz_oturumlari WHERE id = $1', [id]);
  return sonuc.rowCount > 0;
}

/** Oturumu "dokunulmus" isaretler (liste sirasi icin) ve ilk mesajdan baslik uretir. */
async function oturumDokunuldu(id, adayBaslik) {
  await db.sorgu(
    `UPDATE cambaz_oturumlari
        SET baslik = CASE WHEN baslik = 'Yeni Gorusme' AND $2 <> '' THEN $2 ELSE baslik END
      WHERE id = $1`,
    [id, (adayBaslik || '').slice(0, 80)],
  );
}

async function mesajlariGetir(oturumId, limit = 200) {
  return db.satirlar(
    `SELECT id, rol, icerik, model, girdi_token, cikti_token, gecikme_ms, hata, sesli, meta, olusturuldu_at
       FROM cambaz_mesajlari WHERE oturum_id = $1 ORDER BY olusturuldu_at ASC LIMIT $2`,
    [oturumId, limit],
  );
}

async function sonMesajlariGetir(oturumId, limit) {
  const satirlar = await db.satirlar(
    `SELECT rol, icerik FROM cambaz_mesajlari
      WHERE oturum_id = $1 AND rol IN ('kullanici','ajan')
      ORDER BY olusturuldu_at DESC LIMIT $2`,
    [oturumId, limit],
  );
  return satirlar.reverse().map((s) => ({ rol: s.rol, icerik: s.icerik }));
}

async function mesajEkle({ oturumId, rol, icerik, model = null, girdiToken = null, ciktiToken = null, gecikmeMs = null, hata = null, sesli = false, meta = {} }) {
  return db.tekSatir(
    `INSERT INTO cambaz_mesajlari (oturum_id, rol, icerik, model, girdi_token, cikti_token, gecikme_ms, hata, sesli, meta)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, olusturuldu_at`,
    [oturumId, rol, icerik, model, girdiToken, ciktiToken, gecikmeMs, hata, Boolean(sesli), JSON.stringify(meta || {})],
  );
}

// -------------------------------------------------------------- HAFIZA

async function hafizaListele() {
  return db.satirlar('SELECT * FROM cambaz_hafiza ORDER BY guncellendi_at DESC LIMIT 300');
}

async function hafizaEkle({ baslik, icerik, kaynak = 'manuel', kaynakOturumId = null, yoneticiId = null }) {
  const temizIcerik = dogrula.metin(icerik, { max: 2000 });
  if (!temizIcerik) return { tamam: false, hata: 'Bos hafiza kaydi.' };
  const satir = await db.tekSatir(
    `INSERT INTO cambaz_hafiza (baslik, icerik, kaynak, kaynak_oturum_id, olusturan_id)
          VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [dogrula.metin(baslik || 'Not', { max: 150 }) || 'Not', temizIcerik, kaynak, kaynakOturumId, yoneticiId],
  );
  return { tamam: true, kayit: satir };
}

async function hafizaGuncelle(id, { baslik, icerik }) {
  const temizIcerik = dogrula.metin(icerik, { max: 2000 });
  if (!temizIcerik) return { tamam: false, hata: 'Icerik bos olamaz.' };
  const satir = await db.tekSatir(
    `UPDATE cambaz_hafiza SET baslik = $2, icerik = $3 WHERE id = $1 RETURNING *`,
    [id, dogrula.metin(baslik || 'Not', { max: 150 }) || 'Not', temizIcerik],
  );
  return satir ? { tamam: true, kayit: satir } : { tamam: false, hata: 'Kayit bulunamadi.' };
}

async function hafizaSil(id) {
  const sonuc = await db.sorgu('DELETE FROM cambaz_hafiza WHERE id = $1', [id]);
  return sonuc.rowCount > 0;
}

// ------------------------------------------------------- SISTEM TALIMATI

function sistemPromptUret({ aramaVar, hafiza }) {
  let s = `Sen CAMBAZ'sın: CMS Veri Merkezi adli kapali-devre operasyon panelinin dahili yapay zeka ajanisin. ` +
    `Karizmatik, ozguvenli, keskin zekali ama laubali olmayan bir tonun var. Operatorle daima Turkce konusursun. ` +
    `Cevaplarin kisa ve isabetli olsun; gereksiz girizgah veya tekrar yapma.\n\n`;

  if (aramaVar) {
    s += `Guncel bir bilgiye ihtiyacin varsa veya web'de arastirma yapman gerekiyorsa, cevap olarak SADECE ` +
      `asagidaki JSON'lardan birini don (baska hic bir karakter ekleme, aciklama yapma):\n` +
      `{"arac":"ara","sorgu":"..."}\n` +
      `{"arac":"oku","url":"..."}\n` +
      `Arac sonucu bir sonraki mesajda sana [ARAC SONUCU] etiketiyle verilecek; o zaman normal, dogal, ` +
      `Turkce bir cevap yaz (JSON DEGIL).\n\n`;
  }

  s += `Operator hakkinda veya projeyle ilgili kalici sekilde hatirlanmaya deger somut bir bilgi ogrendiysen ` +
    `(isim, tercih, tekrar eden bir talimat, proje detayi vb.), cevabinin EN SONUNA, yeni bir satirda SADECE ` +
    `su formati ekle: HAFIZA: <kisa ve net bilgi>. Bu satiri yalnizca gercekten kalici deger tasiyan bir ` +
    `bilgi oldugunda ekle, her mesajda ekleme; bu satir kullaniciya gosterilmeyecek, otomatik kaydedilecek.\n\n`;

  if (hafiza && hafiza.length > 0) {
    s += `Operator hakkinda su an bildigin kalici bilgiler:\n` +
      hafiza.slice(0, 40).map((h) => `- ${h.icerik}`).join('\n') + '\n\n';
  }

  return s;
}

/** Modelin donusunun TAMAMEN bir arac-cagirma JSON'u olup olmadigini kontrol eder. */
function jsonDirektifAyikla(icerik) {
  const temiz = String(icerik || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  if (!temiz.startsWith('{') || !temiz.endsWith('}')) return null;
  try {
    const obj = JSON.parse(temiz);
    if (obj && (obj.arac === 'ara' || obj.arac === 'oku')) return obj;
  } catch { /* JSON degil, normal cevap */ }
  return null;
}

/** Cevabin sonundaki "HAFIZA: ..." satirini ayiklar ve metinden cikarir. */
function hafizaSatiriniAyikla(icerik) {
  const satirlar = String(icerik || '').split('\n');
  let hafizaSatiri = null;
  const kalanlar = [];
  for (const satir of satirlar) {
    const eslesme = !hafizaSatiri && satir.match(/^\s*HAFIZA\s*:\s*(.+)$/i);
    if (eslesme) { hafizaSatiri = eslesme[1].trim(); continue; }
    kalanlar.push(satir);
  }
  return { temizIcerik: kalanlar.join('\n').trim(), hafizaSatiri };
}

// --------------------------------------------------------- CEVRIMICI YOL

async function cevrimiciYanitla({ saglayici, apiKey, model, oturumId }) {
  let mesajlar = await sonMesajlariGetir(oturumId, ayar.cambaz.maxGecmisMesaj);
  const hafiza = await hafizaListele();

  const aramaSaglayici = await ayarService.ayarAl('cambaz_arama_saglayici', 'tavily');
  const aramaKey = await ayarService.apiAnahtarCoz(aramaSaglayici);
  const sistemTalimati = sistemPromptUret({ aramaVar: Boolean(aramaKey), hafiza });

  let sonuc = await yzSaglayicilari.sohbetTamamla({ saglayici, apiKey, model, sistemTalimati, mesajlar });
  if (!sonuc.tamam) return sonuc;

  for (let hop = 0; hop < MAX_ARAC_HOP; hop++) {
    const direktif = jsonDirektifAyikla(sonuc.icerik);
    if (!direktif) break;

    let aracSonucMetni;
    if (direktif.arac === 'ara' && aramaKey) {
      const r = await aramaServisi.ara({ saglayici: aramaSaglayici, apiKey: aramaKey, sorgu: String(direktif.sorgu || '') });
      aracSonucMetni = r.tamam
        ? r.sonuclar.map((s) => `- ${s.baslik}\n  ${s.url}\n  ${s.ozet}`).join('\n\n') || 'Sonuc bulunamadi.'
        : `Arama basarisiz: ${r.hata}`;
    } else if (direktif.arac === 'oku') {
      const r = await aramaServisi.sayfaOku(String(direktif.url || ''));
      aracSonucMetni = r.tamam ? r.metin : `Sayfa okunamadi: ${r.hata}`;
    } else {
      aracSonucMetni = 'Bu arac su an kullanilamiyor: ilgili API anahtari /ayarlar ekraninda tanimli degil.';
    }

    mesajlar = [...mesajlar, { rol: 'ajan', icerik: sonuc.icerik }, { rol: 'arac', icerik: aracSonucMetni }];
    sonuc = await yzSaglayicilari.sohbetTamamla({ saglayici, apiKey, model, sistemTalimati, mesajlar });
    if (!sonuc.tamam) return sonuc;
  }

  const { temizIcerik, hafizaSatiri } = hafizaSatiriniAyikla(sonuc.icerik);
  return { ...sonuc, icerik: temizIcerik || sonuc.icerik, hafizaSatiri };
}

// -------------------------------------------------------- CEVRIMDISI YOL

function havaSehirCikar(metin) {
  let m = metin.match(/^(.*?)'?\s*(?:de|da|te|ta)?\s+hava(?:\s+durumu)?/i);
  if (m && m[1] && m[1].trim().length > 1) return m[1].trim();
  m = metin.match(/hava(?:\s+durumu)?\s+(?:nasil\s+)?(.+)/i);
  if (m && m[1]) {
    const aday = m[1].replace(/[?.!]/g, '').trim();
    if (aday) return aday;
  }
  return null;
}

async function cevrimdisiYanitla(metinHam) {
  const metin = metinHam.trim();

  if (hesapMakinesi.metindeIfadeVarMi(metin)) {
    const ifade = hesapMakinesi.ifadeCikar(metin);
    const sonuc = hesapMakinesi.hesapla(ifade);
    if (sonuc.tamam) return { metin: `${ifade.trim()} = ${sonuc.sonuc}` };
  }

  if (/hava/i.test(metin)) {
    const sehir = havaSehirCikar(metin);
    if (sehir) {
      const r = await havaService.sehirHavasi(sehir);
      return { metin: r.tamam ? r.metin : r.hata };
    }
    return { metin: 'Hangi sehir icin hava durumuna bakayim?' };
  }

  if (/\b(merhaba|selam|gunaydin|iyi aksamlar|iyi geceler)\b/i.test(metin)) {
    return { metin: 'Selam operator. Cambaz hazir, emrindeyim.' };
  }
  if (/\b(tesekkur|sagol|eyvallah)\b/i.test(metin)) {
    return { metin: 'Rica ederim, operator.' };
  }
  if (/saat kac|tarih ne|bugun ne/i.test(metin)) {
    return { metin: new Date().toLocaleString('tr-TR', { dateStyle: 'full', timeStyle: 'short' }) };
  }
  if (/\bsen kimsin\b|\bnesin\b|kendini tanit/i.test(metin)) {
    return { metin: 'Ben CAMBAZ: CMS Veri Merkezi\'nin dahili yapay zeka ajaniyim. Su an cevrimdisi modundayim.' };
  }

  return {
    metin: 'Su an cevrimdisi modundayim (aktif API anahtari yok). Yapabildiklerim: matematik islemleri ' +
      '("127*38 kac eder?") ve hava durumu ("Istanbul\'da hava nasil?"). Daha dogal sohbet, internet aramasi ' +
      've sayfa ozetleme icin /ayarlar ekranindan bir saglayici API anahtari ekleyebilirsin.',
  };
}

// ------------------------------------------------------------ ANA GIRIS

/**
 * Bir kullanici mesajini isler: kaydeder, cevrimici/cevrimdisi yanit uretir,
 * yaniti kaydeder ve donus deger olarak sonucu verir.
 */
async function mesajGonder({ oturumId, metin, sesli = false, yoneticiId = null }) {
  const oturum = await oturumGetir(oturumId);
  if (!oturum) return { tamam: false, kod: 'YOK', hata: 'Gorusme bulunamadi.' };

  const temizMetin = dogrula.metin(metin, { max: 4000 });
  if (!temizMetin) return { tamam: false, hata: 'Bos mesaj gonderilemez.' };

  await mesajEkle({ oturumId, rol: 'kullanici', icerik: temizMetin, sesli });

  const saglayici = oturum.saglayici || await ayarService.ayarAl('cambaz_saglayici', 'anthropic');
  const model = oturum.model || await ayarService.ayarAl('cambaz_model', null);
  const apiKey = await ayarService.apiAnahtarCoz(saglayici);

  const basla = Date.now();
  let cevapMetni; let model_ = null; let girdiToken = null; let ciktiToken = null; let hataMetni = null;
  let cevrimici = false; let hafizaEklendi = false;

  if (apiKey) {
    cevrimici = true;
    const sonuc = await cevrimiciYanitla({ saglayici, apiKey, model, oturumId });
    if (sonuc.tamam) {
      cevapMetni = sonuc.icerik || '(bos yanit)';
      model_ = model || null;
      girdiToken = sonuc.girdiToken ?? null;
      ciktiToken = sonuc.ciktiToken ?? null;
      if (sonuc.hafizaSatiri) {
        await hafizaEkle({ baslik: 'Otomatik not', icerik: sonuc.hafizaSatiri, kaynak: 'otomatik', kaynakOturumId: oturumId, yoneticiId });
        hafizaEklendi = true;
      }
    } else {
      hataMetni = sonuc.hata;
      cevapMetni = `Baglanti sorunu yasadim: ${sonuc.hata}`;
      await log.uyari({ kategori: 'cambaz', olay: 'saglayici_hata', mesaj: sonuc.hata, meta: { saglayici, oturumId } });
    }
  } else {
    const sonuc = await cevrimdisiYanitla(temizMetin);
    cevapMetni = sonuc.metin;
  }

  const gecikme = Date.now() - basla;
  await mesajEkle({
    oturumId, rol: 'ajan', icerik: cevapMetni, model: model_, girdiToken, ciktiToken,
    gecikmeMs: gecikme, hata: hataMetni, meta: { cevrimici },
  });
  await oturumDokunuldu(oturumId, temizMetin);

  return { tamam: true, yanit: cevapMetni, cevrimici, hafizaEklendi, gecikmeMs: gecikme };
}

module.exports = {
  oturumlariListele, oturumGetir, oturumOlustur, oturumSil, mesajlariGetir, mesajGonder,
  hafizaListele, hafizaEkle, hafizaGuncelle, hafizaSil,
};
