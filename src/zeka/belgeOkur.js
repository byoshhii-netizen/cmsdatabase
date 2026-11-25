'use strict';
/**
 * src/zeka/belgeOkur.js
 * EVRENSEL BELGE OKUYUCU — harici bagimliligi yoktur.
 *
 * Desteklenen bicimler:
 *   PDF ....................... metin katmani + ustveri + aktif icerik isareti
 *   DOCX / DOTX ............... word/document.xml + yazar/sirket ustverisi
 *   XLSX / XLSM ............... tum sayfalar, paylasimli dizeler, TSV ciktisi
 *   PPTX / POTX ............... slayt sirasi korunarak metin
 *   ODT / ODS / ODP ........... content.xml
 *   RTF ....................... kontrol sozcugu temizligi + \uN cozme
 *   EML / MSG(metin) .......... MIME agaci, QP/Base64, basliklar, ek listesi
 *   HTML / XML / SVG .......... etiket soyma, betik/stil atma
 *   TXT / MD / CSV / TSV ...... kodlama tespiti (UTF-8/16, Windows-1254)
 *   JSON / LOG / INI / YAML ... duz metin
 *   JPEG/PNG/GIF/BMP/WEBP/TIFF  EXIF + GPS + cihaz ustverisi (OCR yok)
 *   ZIP ....................... icerik listesi + icindeki metin dosyalari
 *
 * Her okumada ayrica sunlar uretilir:
 *   - sihirli bayt ile GERCEK tur tespiti ve uzanti/MIME uyusmazligi uyarisi
 *   - Shannon entropisi (sifreli/sikistirilmis govde tespiti)
 *   - risk isaretleri (makro, gomulu dosya, aktif icerik, cift uzanti ...)
 *   - dil tahmini (tr/en/de/fr/ar/ru)
 */

const kodlama = require('./kodlama');
const zip = require('./zip');
const pdf = require('./pdf');
const ustveriOkuyucu = require('./ustveri');

const MAX_METIN = 4 * 1024 * 1024;

// ------------------------------------------------------- SIHIRLI BAYT TESPITI

const SIHIRLI = [
  { tur: 'pdf', uzanti: 'pdf', imza: [0x25, 0x50, 0x44, 0x46] },
  { tur: 'zip', uzanti: 'zip', imza: [0x50, 0x4B, 0x03, 0x04] },
  { tur: 'zip', uzanti: 'zip', imza: [0x50, 0x4B, 0x05, 0x06] },
  { tur: 'rar', uzanti: 'rar', imza: [0x52, 0x61, 0x72, 0x21] },
  { tur: '7z', uzanti: '7z', imza: [0x37, 0x7A, 0xBC, 0xAF] },
  { tur: 'gzip', uzanti: 'gz', imza: [0x1F, 0x8B] },
  { tur: 'jpeg', uzanti: 'jpg', imza: [0xFF, 0xD8, 0xFF] },
  { tur: 'png', uzanti: 'png', imza: [0x89, 0x50, 0x4E, 0x47] },
  { tur: 'gif', uzanti: 'gif', imza: [0x47, 0x49, 0x46, 0x38] },
  { tur: 'bmp', uzanti: 'bmp', imza: [0x42, 0x4D] },
  { tur: 'tiff', uzanti: 'tif', imza: [0x49, 0x49, 0x2A, 0x00] },
  { tur: 'tiff', uzanti: 'tif', imza: [0x4D, 0x4D, 0x00, 0x2A] },
  { tur: 'ole2', uzanti: 'doc', imza: [0xD0, 0xCF, 0x11, 0xE0] },
  { tur: 'rtf', uzanti: 'rtf', imza: [0x7B, 0x5C, 0x72, 0x74] },
  { tur: 'elf', uzanti: 'bin', imza: [0x7F, 0x45, 0x4C, 0x46] },
  { tur: 'exe', uzanti: 'exe', imza: [0x4D, 0x5A] },
  { tur: 'class', uzanti: 'class', imza: [0xCA, 0xFE, 0xBA, 0xBE] },
  { tur: 'sqlite', uzanti: 'db', imza: [0x53, 0x51, 0x4C, 0x69, 0x74, 0x65] },
  { tur: 'mp3', uzanti: 'mp3', imza: [0x49, 0x44, 0x33] },
  { tur: 'ogg', uzanti: 'ogg', imza: [0x4F, 0x67, 0x67, 0x53] },
  { tur: 'flac', uzanti: 'flac', imza: [0x66, 0x4C, 0x61, 0x43] },
];

/** Sihirli baytlardan gercek dosya turunu bulur. */
function sihirliTur(tampon) {
  if (!Buffer.isBuffer(tampon) || tampon.length < 2) return null;
  for (const kayit of SIHIRLI) {
    let uyar = true;
    for (let i = 0; i < kayit.imza.length; i++) {
      if (tampon[i] !== kayit.imza[i]) { uyar = false; break; }
    }
    if (uyar) return kayit.tur;
  }
  if (tampon.toString('latin1', 0, 4) === 'RIFF') {
    const alt = tampon.toString('latin1', 8, 12);
    if (alt === 'WEBP') return 'webp';
    if (alt === 'WAVE') return 'wav';
    if (alt === 'AVI ') return 'avi';
  }
  if (tampon.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  return null;
}

/** ZIP tabanli bicimlerin (OOXML/ODF) alt turunu belirler. */
function zipAltTuru(girdiler) {
  const adlar = new Set(girdiler.map((g) => g.ad));
  const ara = (on) => girdiler.some((g) => g.ad.startsWith(on));

  if (adlar.has('word/document.xml') || ara('word/')) return 'docx';
  if (adlar.has('xl/workbook.xml') || ara('xl/')) return 'xlsx';
  if (ara('ppt/slides/')) return 'pptx';
  if (adlar.has('content.xml') && adlar.has('mimetype')) return 'odf';
  if (adlar.has('META-INF/container.xml')) return 'epub';
  return 'zip';
}

function uzantiAl(ad) {
  const m = String(ad || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : '';
}

// --------------------------------------------------------------- XML -> METIN

/** XML'den duz metin cikarir; verilen etiketlerde satir sonu uretir. */
function xmlMetin(xml, satirEtiketleri = [], sekmeEtiketleri = []) {
  let s = String(xml);

  s = s.replace(/<(w:instrText|w:proofErr|w:bookmarkStart|w:bookmarkEnd)[\s\S]*?\/?>/g, '');
  for (const etiket of sekmeEtiketleri) {
    s = s.replace(new RegExp(`<${etiket}\\b[^>]*\\/?>`, 'g'), '\t');
  }
  for (const etiket of satirEtiketleri) {
    s = s.replace(new RegExp(`</${etiket}>`, 'g'), '\n');
    s = s.replace(new RegExp(`<${etiket}\\b[^>]*\\/>`, 'g'), '\n');
  }

  s = s.replace(/<[^>]*>/g, '');
  return varligiCoz(s);
}

/** XML/HTML varlik referanslarini cozer. */
function varligiCoz(metin) {
  return String(metin)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&shy;/g, '')
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => {
      const k = parseInt(h, 16);
      return k > 0 && k < 0x110000 ? String.fromCodePoint(k) : '';
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const k = Number(d);
      return k > 0 && k < 0x110000 ? String.fromCodePoint(k) : '';
    })
    .replace(/&amp;/g, '&');
}

function temizle(metin) {
  return String(metin || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{3,}/g, '  ')
    .trim()
    .slice(0, MAX_METIN);
}

// ------------------------------------------------------------------- OOXML

function ooxmlCekirdekUstveri(dosyalar) {
  const ustveri = {};
  const cekirdek = dosyalar.get('docProps/core.xml');
  if (cekirdek) {
    const xml = cekirdek.toString('utf8');
    const al = (etiket) => {
      const m = xml.match(new RegExp(`<${etiket}[^>]*>([\\s\\S]*?)</${etiket}>`));
      return m ? varligiCoz(m[1]).trim().slice(0, 300) : null;
    };
    const esle = {
      baslik: al('dc:title'), konu: al('dc:subject'), yazar: al('dc:creator'),
      anahtar_kelimeler: al('cp:keywords'), aciklama: al('dc:description'),
      son_duzenleyen: al('cp:lastModifiedBy'), surum: al('cp:revision'),
      olusturma: al('dcterms:created'), degistirme: al('dcterms:modified'),
      kategori: al('cp:category'),
    };
    for (const [k, v] of Object.entries(esle)) if (v) ustveri[k] = v;
  }

  const uygulama = dosyalar.get('docProps/app.xml');
  if (uygulama) {
    const xml = uygulama.toString('utf8');
    const al = (etiket) => {
      const m = xml.match(new RegExp(`<${etiket}>([\\s\\S]*?)</${etiket}>`));
      return m ? varligiCoz(m[1]).trim().slice(0, 200) : null;
    };
    const esle = {
      uygulama: al('Application'), sirket: al('Company'), yonetici: al('Manager'),
      sayfa_sayisi: al('Pages'), kelime_sayisi_belge: al('Words'),
      slayt_sayisi: al('Slides'), duzenleme_suresi_dk: al('TotalTime'),
      sablon: al('Template'),
    };
    for (const [k, v] of Object.entries(esle)) if (v) ustveri[k] = v;
  }

  return ustveri;
}

function docxOku(dosyalar) {
  const parcalar = [];
  const ana = dosyalar.get('word/document.xml');
  if (ana) parcalar.push(xmlMetin(ana.toString('utf8'), ['w:p', 'w:tr'], ['w:tab', 'w:br']));

  // Ust/alt bilgi, dipnot, son not ve yorumlar: istihbarat icin degerli olabilir.
  const ekBolumler = [...dosyalar.keys()]
    .filter((ad) => /^word\/(header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(ad))
    .sort();
  for (const ad of ekBolumler) {
    const metin = xmlMetin(dosyalar.get(ad).toString('utf8'), ['w:p'], ['w:tab', 'w:br']).trim();
    if (metin) parcalar.push(`\n[${ad.replace('word/', '').replace('.xml', '').toUpperCase()}]\n${metin}`);
  }

  const bayraklar = [];
  if (dosyalar.has('word/vbaProject.bin')) bayraklar.push('makro_icerir');
  if ([...dosyalar.keys()].some((a) => a.startsWith('word/embeddings/'))) bayraklar.push('gomulu_nesne');

  // Harici baglantilar (uzak sablon / uzak resim yukleme = izleme riski)
  const iliskiler = dosyalar.get('word/_rels/document.xml.rels');
  if (iliskiler && /TargetMode="External"/.test(iliskiler.toString('utf8'))) bayraklar.push('dis_baglanti');

  return { metin: parcalar.join('\n'), bayraklar };
}

function xlsxOku(dosyalar) {
  // Paylasimli dize tablosu
  const paylasimli = [];
  const ss = dosyalar.get('xl/sharedStrings.xml');
  if (ss) {
    const xml = ss.toString('utf8');
    for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      const parcalar = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => varligiCoz(t[1]));
      paylasimli.push(parcalar.join(''));
    }
  }

  // Sayfa adlari
  const sayfaAdlari = [];
  const kitap = dosyalar.get('xl/workbook.xml');
  if (kitap) {
    for (const m of kitap.toString('utf8').matchAll(/<sheet\b[^>]*name="([^"]*)"/g)) {
      sayfaAdlari.push(varligiCoz(m[1]));
    }
  }

  const sayfaDosyalari = [...dosyalar.keys()]
    .filter((a) => /^xl\/worksheets\/sheet\d+\.xml$/.test(a))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  const parcalar = [];
  let hucreSayisi = 0;

  sayfaDosyalari.forEach((ad, dizin) => {
    const xml = dosyalar.get(ad).toString('utf8');
    const satirlar = [];

    for (const satirEslesme of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const hucreler = [];
      for (const h of satirEslesme[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const nitelik = h[1];
        const govde = h[2];
        const tur = (nitelik.match(/\bt="([^"]*)"/) || [])[1];
        let deger = '';

        if (tur === 's') {
          const v = (govde.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          deger = paylasimli[Number(v)] || '';
        } else if (tur === 'inlineStr') {
          deger = [...govde.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => varligiCoz(t[1])).join('');
        } else {
          const v = (govde.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          deger = v ? varligiCoz(v) : '';
        }

        if (deger !== '') hucreSayisi++;
        hucreler.push(deger);
      }
      // Bos satirlari atla
      if (hucreler.some((x) => x !== '')) satirlar.push(hucreler.join('\t'));
    }

    if (satirlar.length) {
      const baslik = sayfaAdlari[dizin] || `Sayfa${dizin + 1}`;
      parcalar.push(`[SAYFA: ${baslik}]\n${satirlar.join('\n')}`);
    }
  });

  const bayraklar = [];
  if (dosyalar.has('xl/vbaProject.bin')) bayraklar.push('makro_icerir');
  if ([...dosyalar.keys()].some((a) => a.includes('externalLink'))) bayraklar.push('dis_baglanti');

  return { metin: parcalar.join('\n\n'), bayraklar, ek: { sayfa_sayisi: sayfaDosyalari.length, dolu_hucre: hucreSayisi, sayfa_adlari: sayfaAdlari } };
}

function pptxOku(dosyalar) {
  const slaytlar = [...dosyalar.keys()]
    .filter((a) => /^ppt\/slides\/slide\d+\.xml$/.test(a))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  const parcalar = [];
  slaytlar.forEach((ad, dizin) => {
    const xml = dosyalar.get(ad).toString('utf8');
    const metinler = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => varligiCoz(m[1]).trim());
    const govde = metinler.filter(Boolean).join('\n');

    // Konusmaci notlari
    const notAd = `ppt/notesSlides/notesSlide${dizin + 1}.xml`;
    let notlar = '';
    if (dosyalar.has(notAd)) {
      notlar = [...dosyalar.get(notAd).toString('utf8').matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
        .map((m) => varligiCoz(m[1]).trim()).filter(Boolean).join(' ');
    }

    if (govde || notlar) {
      parcalar.push(`[SLAYT ${dizin + 1}]\n${govde}${notlar ? `\n(not) ${notlar}` : ''}`);
    }
  });

  return { metin: parcalar.join('\n\n'), bayraklar: [], ek: { slayt_sayisi: slaytlar.length } };
}

function odfOku(dosyalar) {
  const icerik = dosyalar.get('content.xml');
  const metin = icerik
    ? xmlMetin(icerik.toString('utf8'), ['text:p', 'text:h', 'table:table-row'], ['text:tab', 'text:line-break'])
    : '';

  const ustveri = {};
  const ust = dosyalar.get('meta.xml');
  if (ust) {
    const xml = ust.toString('utf8');
    const al = (etiket) => {
      const m = xml.match(new RegExp(`<${etiket}[^>]*>([\\s\\S]*?)</${etiket}>`));
      return m ? varligiCoz(m[1]).trim().slice(0, 300) : null;
    };
    const esle = {
      baslik: al('dc:title'), yazar: al('meta:initial-creator') || al('dc:creator'),
      olusturma: al('meta:creation-date'), degistirme: al('dc:date'),
      uygulama: al('meta:generator'),
    };
    for (const [k, v] of Object.entries(esle)) if (v) ustveri[k] = v;
  }

  return { metin, bayraklar: [], ustveri };
}

function epubOku(dosyalar) {
  const bolumler = [...dosyalar.keys()]
    .filter((a) => /\.(x?html|htm)$/i.test(a))
    .sort();
  const parcalar = [];
  for (const ad of bolumler.slice(0, 400)) {
    const metin = htmlMetin(dosyalar.get(ad).toString('utf8'));
    if (metin.trim()) parcalar.push(metin.trim());
  }
  return { metin: parcalar.join('\n\n'), bayraklar: [], ek: { bolum_sayisi: bolumler.length } };
}

// ------------------------------------------------------------------- HTML

function htmlMetin(ham) {
  let s = String(ham)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|td|th)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<\/?t[dh]\b[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, ' ');
  return varligiCoz(s);
}

function htmlUstveri(ham) {
  const ustveri = {};
  const baslik = ham.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (baslik) ustveri.baslik = varligiCoz(baslik[1]).trim().slice(0, 300);
  for (const m of ham.matchAll(/<meta\b[^>]*?(?:name|property)=["']([^"']+)["'][^>]*?content=["']([^"']*)["']/gi)) {
    const ad = m[1].toLowerCase();
    if (['author', 'description', 'keywords', 'generator', 'og:title', 'og:site_name', 'article:published_time'].includes(ad)) {
      ustveri[ad.replace(':', '_')] = varligiCoz(m[2]).trim().slice(0, 300);
    }
  }
  return ustveri;
}

// -------------------------------------------------------------------- RTF

/** RTF'te verilen hedef sozcukle baslayan DENGELI gruplari (ic ice suslu
 *  parantezler dahil) atar. Basit regex ic ice gruplarda yanlis yerde kesildigi
 *  icin elle dengeleme yapilir. */
function rtfGrupAt(metin, hedefler) {
  let s = metin;
  const isaretler = [];
  for (const h of hedefler) { isaretler.push(`{\\${h}`, `{\\*\\${h}`); }

  for (let tur = 0; tur < 256; tur++) {
    let bas = -1;
    for (const im of isaretler) {
      const d = s.indexOf(im);
      if (d >= 0 && (bas < 0 || d < bas)) bas = d;
    }
    if (bas < 0) break;

    let derinlik = 0;
    let i = bas;
    for (; i < s.length; i++) {
      if (s[i] === '\\') { i++; continue; }
      if (s[i] === '{') derinlik++;
      else if (s[i] === '}') { derinlik--; if (derinlik === 0) break; }
    }
    s = s.slice(0, bas) + ' ' + s.slice(Math.min(i + 1, s.length));
  }

  return s;
}

function rtfOku(ham) {
  let s = String(ham);

  s = rtfGrupAt(s, [
    'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'themedata',
    'datastore', 'rsidtbl', 'generator', 'listtable', 'listoverridetable',
    'latentstyles', 'xmlnstbl', 'filetbl', 'mmathPr',
  ]);
  s = s.replace(/\\u(-?\d+)\s*\??/g, (_, kod) => {
    let k = Number(kod);
    if (k < 0) k += 65536;
    return k > 0 && k < 0x110000 ? String.fromCodePoint(k) : '';
  });
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => kodlama.cp1254Coz(Buffer.from(hex, 'hex')));
  s = s.replace(/\\par[d]?\b/g, '\n').replace(/\\line\b/g, '\n').replace(/\\tab\b/g, '\t');
  s = s.replace(/\\[a-zA-Z]+-?\d*\s?/g, ' ');
  s = s.replace(/[{}]/g, ' ');
  s = s.replace(/\\\n/g, '\n');

  return s;
}

// -------------------------------------------------------------------- EML

function emlOku(tampon) {
  const ham = tampon.toString('latin1');
  const ayrim = ham.search(/\r?\n\r?\n/);
  const baslikBlogu = ayrim > 0 ? ham.slice(0, ayrim) : ham;
  const govdeHam = ayrim > 0 ? ham.slice(ayrim).replace(/^\r?\n\r?\n/, '') : '';

  // Katlanmis basliklari birlestir
  const basliklar = {};
  const satirlar = baslikBlogu.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
  const alinanlar = [];
  for (const satir of satirlar) {
    const m = satir.match(/^([A-Za-z0-9-]+):\s*([\s\S]*)$/);
    if (!m) continue;
    const ad = m[1].toLowerCase();
    const deger = kodlama.rfc2047Coz(m[2]).trim();
    if (ad === 'received') { alinanlar.push(deger.slice(0, 500)); continue; }
    if (basliklar[ad] === undefined) basliklar[ad] = deger.slice(0, 1000);
  }

  const ustveri = {};
  for (const ad of ['from', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'reply-to',
    'return-path', 'x-originating-ip', 'x-mailer', 'user-agent', 'authentication-results',
    'dkim-signature', 'received-spf', 'list-id']) {
    if (basliklar[ad]) ustveri[ad.replace(/-/g, '_')] = basliklar[ad];
  }
  if (alinanlar.length) ustveri.alinma_zinciri = alinanlar.slice(0, 12);

  const bayraklar = [];
  const ekler = [];
  const parcalar = [];

  /** Tek bir MIME parcasini isler. */
  function parcaIsle(baslikMetni, govde, derinlik) {
    if (derinlik > 8) return;
    const basliklarYerel = {};
    for (const satir of baslikMetni.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
      const m = satir.match(/^([A-Za-z0-9-]+):\s*([\s\S]*)$/);
      if (m) basliklarYerel[m[1].toLowerCase()] = m[2].trim();
    }

    const turSatiri = basliklarYerel['content-type'] || 'text/plain';
    const aktarim = (basliklarYerel['content-transfer-encoding'] || '').toLowerCase();
    const yerlesim = basliklarYerel['content-disposition'] || '';
    const sinir = (turSatiri.match(/boundary="?([^";]+)"?/i) || [])[1];
    const karakterSeti = (turSatiri.match(/charset="?([^";]+)"?/i) || [])[1] || '';

    if (/^multipart\//i.test(turSatiri) && sinir) {
      const bolumler = govde.split(new RegExp(`--${sinir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?`));
      for (const bolum of bolumler.slice(1)) {
        const ic = bolum.replace(/^\r?\n/, '');
        const icAyrim = ic.search(/\r?\n\r?\n/);
        if (icAyrim < 0) continue;
        parcaIsle(ic.slice(0, icAyrim), ic.slice(icAyrim).replace(/^\r?\n\r?\n/, ''), derinlik + 1);
      }
      return;
    }

    const dosyaAdi = kodlama.rfc2047Coz(
      (yerlesim.match(/filename="?([^";]+)"?/i) || turSatiri.match(/name="?([^";]+)"?/i) || [])[1] || '',
    );

    let veri;
    if (aktarim === 'base64') veri = kodlama.base64Coz(govde);
    else if (aktarim === 'quoted-printable') veri = kodlama.quotedPrintableCoz(govde);
    else veri = Buffer.from(govde, 'latin1');

    if (/attachment/i.test(yerlesim) || (dosyaAdi && !/^text\/(plain|html)/i.test(turSatiri))) {
      ekler.push({ ad: dosyaAdi || '(adsiz)', tur: turSatiri.split(';')[0].trim(), boyut: veri.length });
      const uz = uzantiAl(dosyaAdi);
      if (['exe', 'scr', 'bat', 'cmd', 'js', 'vbs', 'jar', 'ps1', 'lnk', 'iso', 'img', 'hta'].includes(uz)) {
        bayraklar.push('tehlikeli_ek');
      }
      if (['docm', 'xlsm', 'pptm', 'dotm'].includes(uz)) bayraklar.push('makrolu_ek');
      return;
    }

    let metin;
    if (karakterSeti && /1254|8859-9/i.test(karakterSeti)) metin = kodlama.cp1254Coz(veri);
    else if (karakterSeti && /1252|8859-1/i.test(karakterSeti)) metin = kodlama.cp1252Coz(veri);
    else metin = kodlama.metneCevir(veri).metin;

    if (/^text\/html/i.test(turSatiri)) {
      parcalar.push({ tur: 'html', metin: htmlMetin(metin) });
    } else {
      parcalar.push({ tur: 'duz', metin });
    }
  }

  parcaIsle(baslikBlogu, govdeHam, 0);

  const duz = parcalar.find((p) => p.tur === 'duz' && p.metin.trim());
  const htm = parcalar.find((p) => p.tur === 'html' && p.metin.trim());
  const govde = (duz || htm || { metin: '' }).metin;

  if (ekler.length) ustveri.ekler = ekler;
  if (basliklar['x-originating-ip']) bayraklar.push('kaynak_ip_basligi');

  const baslikOzeti = [
    basliklar.from ? `Kimden: ${basliklar.from}` : null,
    basliklar.to ? `Kime: ${basliklar.to}` : null,
    basliklar.cc ? `Bilgi: ${basliklar.cc}` : null,
    basliklar.date ? `Tarih: ${basliklar.date}` : null,
    basliklar.subject ? `Konu: ${basliklar.subject}` : null,
  ].filter(Boolean).join('\n');

  return {
    metin: `${baslikOzeti}\n\n${govde}`,
    ustveri,
    bayraklar,
    ek: { ek_sayisi: ekler.length },
  };
}

// --------------------------------------------------------------- DIL TAHMINI

const DIL_IPUCLARI = {
  tr: ['bir', 've', 'ile', 'icin', 'olarak', 'daha', 'bu', 'olan', 'gibi', 'ancak', 'degil', 'kadar', 'sonra', 'tarih', 'rapor'],
  en: ['the', 'and', 'for', 'that', 'with', 'this', 'from', 'have', 'which', 'been', 'report', 'date'],
  de: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'mit', 'auch', 'eine', 'werden'],
  fr: ['les', 'des', 'est', 'une', 'pour', 'dans', 'que', 'pas', 'avec', 'sur'],
};

/** Metnin dilini kaba sikliklarla tahmin eder. */
function dilTahmin(metin) {
  const ornek = String(metin || '').slice(0, 20_000);
  if (!ornek.trim()) return null;

  if (/[؀-ۿ]/.test(ornek)) return 'ar';
  if (/[Ѐ-ӿ]/.test(ornek)) return 'ru';
  if (/[Ͱ-Ͽ]/.test(ornek)) return 'el';
  if (/[一-鿿]/.test(ornek)) return 'zh';

  const kelimeler = ornek.toLowerCase()
    .replace(/[çğışöü]/g, (k) => ({ 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ş': 's', 'ö': 'o', 'ü': 'u' })[k])
    .match(/[a-z]+/g) || [];
  if (kelimeler.length < 8) return null;

  const kume = new Map();
  for (const k of kelimeler) kume.set(k, (kume.get(k) || 0) + 1);

  let enIyi = null;
  let enIyiPuan = 0;
  for (const [dil, ipuclari] of Object.entries(DIL_IPUCLARI)) {
    let puan = 0;
    for (const ip of ipuclari) puan += kume.get(ip) || 0;
    if (puan > enIyiPuan) { enIyiPuan = puan; enIyi = dil; }
  }

  // Turkce'ye ozgu harfler guclu kanittir.
  if (/[şğıçöü]/i.test(ornek) && (enIyi === null || enIyiPuan < kelimeler.length * 0.02)) return 'tr';
  return enIyiPuan >= 2 ? enIyi : null;
}

// --------------------------------------------------------------------- ANA

/**
 * Bir dosya tamponunu okuyup metin + ustveri + risk isaretleri uretir.
 *
 * @param {Buffer} tampon  dosya govdesi (cozulmus, duz hali)
 * @param {object} secenek
 * @param {string} secenek.ad      dosya adi (uzanti tespiti icin)
 * @param {string} secenek.mime    bildirilen MIME turu
 * @returns {{tamam:boolean, bicim:string, metin:string, sayfaSayisi:number|null,
 *            kelimeSayisi:number, karakterSayisi:number, dil:string|null,
 *            ustveri:object, bayraklar:string[], sihirli:string|null,
 *            uyusmazlik:boolean, entropi:number, durum:string, hata:string|null}}
 */
function oku(tampon, { ad = '', mime = '' } = {}) {
  const basla = Date.now();
  const sonuc = {
    tamam: false,
    bicim: 'bilinmiyor',
    metin: '',
    sayfaSayisi: null,
    kelimeSayisi: 0,
    karakterSayisi: 0,
    dil: null,
    ustveri: {},
    bayraklar: [],
    sihirli: null,
    uyusmazlik: false,
    entropi: 0,
    durum: 'hata',
    hata: null,
    sureMs: 0,
  };

  if (!Buffer.isBuffer(tampon) || tampon.length === 0) {
    sonuc.hata = 'Dosya bos.';
    return sonuc;
  }

  const uzanti = uzantiAl(ad);
  sonuc.entropi = kodlama.entropi(tampon);
  sonuc.sihirli = sihirliTur(tampon);

  // --- Uzanti / sihirli bayt uyusmazligi ---
  const beklenen = {
    pdf: 'pdf', jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', bmp: 'bmp',
    tif: 'tiff', tiff: 'tiff', webp: 'webp', zip: 'zip', rar: 'rar', '7z': '7z',
    gz: 'gzip', docx: 'zip', xlsx: 'zip', pptx: 'zip', odt: 'zip', ods: 'zip',
    odp: 'zip', epub: 'zip', doc: 'ole2', xls: 'ole2', ppt: 'ole2', rtf: 'rtf',
    exe: 'exe', dll: 'exe', mp3: 'mp3', mp4: 'mp4', sqlite: 'sqlite', db: 'sqlite',
  }[uzanti];

  if (beklenen && sonuc.sihirli && beklenen !== sonuc.sihirli) {
    sonuc.uyusmazlik = true;
    sonuc.bayraklar.push('uzanti_uyusmazligi');
  }
  if (/\.(pdf|docx?|xlsx?|jpg|png|txt)\.(exe|scr|bat|cmd|js|vbs|ps1|lnk|hta)$/i.test(ad)) {
    sonuc.bayraklar.push('cift_uzanti');
  }
  if (sonuc.entropi > 7.8 && !['zip', 'rar', '7z', 'gzip', 'jpeg', 'png', 'mp3', 'mp4', 'webp'].includes(sonuc.sihirli || '')) {
    sonuc.bayraklar.push('yuksek_entropi');
  }
  if (['exe', 'elf', 'class'].includes(sonuc.sihirli)) sonuc.bayraklar.push('calistirilabilir');

  try {
    // ---------------------------------------------------------------- PDF
    if (sonuc.sihirli === 'pdf' || uzanti === 'pdf') {
      sonuc.bicim = 'PDF';
      const p = pdf.oku(tampon);
      sonuc.metin = temizle(p.metin);
      sonuc.sayfaSayisi = p.sayfaSayisi || null;
      sonuc.ustveri = { ...p.ustveri };
      if (Object.keys(p.alanlar || {}).length) sonuc.ustveri.form_alanlari = p.alanlar;
      sonuc.bayraklar.push(...p.bayraklar);
      sonuc.tamam = Boolean(sonuc.metin);
      sonuc.durum = sonuc.tamam ? 'tamam' : (p.sifreli ? 'desteklenmiyor' : 'kismi');
      sonuc.hata = sonuc.tamam ? null : p.hata;

    // --------------------------------------------------------- ZIP TABANLI
    } else if (zip.zipMi(tampon)) {
      const girdiler = zip.listele(tampon);
      const alt = zipAltTuru(girdiler);

      if (alt === 'docx') {
        sonuc.bicim = 'DOCX';
        const dosyalar = zip.ac(tampon, (a) => a.startsWith('word/') || a.startsWith('docProps/'));
        const r = docxOku(dosyalar);
        sonuc.metin = temizle(r.metin);
        sonuc.bayraklar.push(...r.bayraklar);
        sonuc.ustveri = ooxmlCekirdekUstveri(dosyalar);
        if (sonuc.ustveri.sayfa_sayisi) sonuc.sayfaSayisi = Number(sonuc.ustveri.sayfa_sayisi) || null;
      } else if (alt === 'xlsx') {
        sonuc.bicim = 'XLSX';
        const dosyalar = zip.ac(tampon, (a) => a.startsWith('xl/') || a.startsWith('docProps/'));
        const r = xlsxOku(dosyalar);
        sonuc.metin = temizle(r.metin);
        sonuc.bayraklar.push(...r.bayraklar);
        sonuc.ustveri = { ...ooxmlCekirdekUstveri(dosyalar), ...r.ek };
        sonuc.sayfaSayisi = r.ek.sayfa_sayisi || null;
      } else if (alt === 'pptx') {
        sonuc.bicim = 'PPTX';
        const dosyalar = zip.ac(tampon, (a) => a.startsWith('ppt/') || a.startsWith('docProps/'));
        const r = pptxOku(dosyalar);
        sonuc.metin = temizle(r.metin);
        sonuc.ustveri = { ...ooxmlCekirdekUstveri(dosyalar), ...r.ek };
        sonuc.sayfaSayisi = r.ek.slayt_sayisi || null;
      } else if (alt === 'odf') {
        const mimeTampon = zip.ac(tampon, (a) => a === 'mimetype').get('mimetype');
        const mimeMetni = mimeTampon ? mimeTampon.toString('utf8') : '';
        sonuc.bicim = /spreadsheet/.test(mimeMetni) ? 'ODS' : /presentation/.test(mimeMetni) ? 'ODP' : 'ODT';
        const dosyalar = zip.ac(tampon, (a) => a === 'content.xml' || a === 'meta.xml');
        const r = odfOku(dosyalar);
        sonuc.metin = temizle(r.metin);
        sonuc.ustveri = r.ustveri;
      } else if (alt === 'epub') {
        sonuc.bicim = 'EPUB';
        const dosyalar = zip.ac(tampon, (a) => /\.(x?html|htm|opf)$/i.test(a));
        const r = epubOku(dosyalar);
        sonuc.metin = temizle(r.metin);
        sonuc.ustveri = r.ek;
      } else {
        sonuc.bicim = 'ZIP';
        const listeMetni = girdiler.slice(0, 500)
          .map((g) => `${g.ad}\t${g.acilmis} bayt`).join('\n');
        const metinDosyalari = zip.ac(
          tampon,
          (a) => /\.(txt|md|csv|json|log|xml|html?|ini|cfg|yml|yaml)$/i.test(a),
        );
        const icerikler = [];
        for (const [adIc, veri] of metinDosyalari) {
          const c = kodlama.metneCevir(veri).metin;
          if (c.trim()) icerikler.push(`[${adIc}]\n${c.slice(0, 40_000)}`);
        }
        sonuc.metin = temizle(`[ARSIV ICERIGI]\n${listeMetni}\n\n${icerikler.join('\n\n')}`);
        sonuc.ustveri = { girdi_sayisi: girdiler.length };
        if (girdiler.some((g) => /\.(exe|scr|bat|cmd|js|vbs|ps1|lnk|hta)$/i.test(g.ad))) {
          sonuc.bayraklar.push('arsivde_calistirilabilir');
        }
      }
      sonuc.tamam = Boolean(sonuc.metin);
      sonuc.durum = sonuc.tamam ? 'tamam' : 'kismi';

    // ---------------------------------------------------------------- RTF
    } else if (sonuc.sihirli === 'rtf' || uzanti === 'rtf') {
      sonuc.bicim = 'RTF';
      sonuc.metin = temizle(rtfOku(tampon.toString('latin1')));
      sonuc.tamam = Boolean(sonuc.metin);
      sonuc.durum = sonuc.tamam ? 'tamam' : 'kismi';
      if (/\\objdata|\\objemb/i.test(tampon.toString('latin1', 0, 200_000))) sonuc.bayraklar.push('gomulu_nesne');

    // -------------------------------------------------------------- E-POSTA
    } else if (['eml', 'mbox', 'msg'].includes(uzanti) ||
               /^(Received:|From:|Return-Path:|Message-ID:)/m.test(tampon.toString('latin1', 0, 2048))) {
      sonuc.bicim = 'EML';
      const r = emlOku(tampon);
      sonuc.metin = temizle(r.metin);
      sonuc.ustveri = { ...r.ustveri, ...r.ek };
      sonuc.bayraklar.push(...r.bayraklar);
      sonuc.tamam = Boolean(sonuc.metin);
      sonuc.durum = sonuc.tamam ? 'tamam' : 'kismi';

    // ----------------------------------------------------------- GORUNTULER
    } else if (['jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp'].includes(sonuc.sihirli)) {
      sonuc.bicim = sonuc.sihirli.toUpperCase();
      sonuc.ustveri = ustveriOkuyucu.goruntuUstverisi(tampon);

      const satirlar = [];
      const u = sonuc.ustveri;
      if (u.genislik && u.yukseklik) satirlar.push(`Olcu: ${u.genislik}x${u.yukseklik} piksel`);
      if (u.uretici || u.model) satirlar.push(`Cihaz: ${[u.uretici, u.model].filter(Boolean).join(' ')}`);
      if (u.cekim_tarihi || u.tarih) satirlar.push(`Cekim zamani: ${u.cekim_tarihi || u.tarih}`);
      if (u.yazilim) satirlar.push(`Yazilim: ${u.yazilim}`);
      if (u.sanatci || u.sahip || u.xmp_yazar) satirlar.push(`Sahip/Sanatci: ${u.sanatci || u.sahip || u.xmp_yazar}`);
      if (u.govde_seri_no) satirlar.push(`Govde seri no: ${u.govde_seri_no}`);
      if (u.gps_enlem !== undefined) {
        satirlar.push(`GPS konumu: ${u.gps_enlem}, ${u.gps_boylam}` +
          (u.gps_yukseklik !== undefined ? ` (${u.gps_yukseklik} m)` : ''));
        sonuc.bayraklar.push('gps_konum_var');
      }
      if (u.yorum) satirlar.push(`Yorum: ${u.yorum}`);
      if (u.png_metinleri) {
        for (const [k, v] of Object.entries(u.png_metinleri)) satirlar.push(`${k}: ${v}`);
      }

      sonuc.metin = temizle(satirlar.length ? `[GORUNTU USTVERISI]\n${satirlar.join('\n')}` : '');
      sonuc.tamam = satirlar.length > 0;
      sonuc.durum = sonuc.tamam ? 'kismi' : 'desteklenmiyor';
      sonuc.hata = sonuc.tamam
        ? 'Goruntuden metin okunmadi (OCR yok); yalnizca ustveri cikarildi.'
        : 'Goruntude okunabilir ustveri bulunamadi (OCR yapilmaz).';

    // ------------------------------------------------------------ HTML/XML
    } else if (['html', 'htm', 'xhtml', 'xml', 'svg', 'rss', 'atom'].includes(uzanti) ||
               /^\s*<(!doctype html|html|\?xml|svg)/i.test(tampon.toString('utf8', 0, 256))) {
      const cevrim = kodlama.metneCevir(tampon);
      const ham = cevrim.metin;
      sonuc.bicim = /^\s*<\?xml|<svg/i.test(ham) && !/<html/i.test(ham) ? 'XML' : 'HTML';
      sonuc.metin = temizle(htmlMetin(ham));
      sonuc.ustveri = { ...htmlUstveri(ham), kodlama: cevrim.kodlama };
      if (/<script/i.test(ham)) sonuc.bayraklar.push('betik_icerir');
      if (/<iframe|<object|<embed/i.test(ham)) sonuc.bayraklar.push('gomulu_cerceve');
      sonuc.tamam = Boolean(sonuc.metin);
      sonuc.durum = sonuc.tamam ? 'tamam' : 'kismi';

    // ------------------------------------------------- ESKI OFFICE (OLE2)
    } else if (sonuc.sihirli === 'ole2') {
      sonuc.bicim = 'OLE2 (eski Office)';
      // OLE2 bilesik dosyasi: tam ayristirma yapilmaz; okunabilir UTF-16LE
      // metin bloklari kurtarilir (eski .doc dosyalari metni boyle tutar).
      const kurtarilan = [];
      for (let i = 0; i + 1 < tampon.length; i += 2) {
        if (tampon[i] >= 0x20 && tampon[i] < 0x7F && tampon[i + 1] === 0x00) {
          let j = i;
          let parca = '';
          while (j + 1 < tampon.length && tampon[j + 1] === 0x00 &&
                 (tampon[j] >= 0x20 || tampon[j] === 0x0D || tampon[j] === 0x0A)) {
            parca += String.fromCharCode(tampon[j]);
            j += 2;
          }
          if (parca.length >= 12) kurtarilan.push(parca);
          i = j;
        }
      }
      sonuc.metin = temizle(kurtarilan.join('\n'));
      sonuc.tamam = sonuc.metin.length > 40;
      sonuc.durum = sonuc.tamam ? 'kismi' : 'desteklenmiyor';
      sonuc.hata = 'Eski Office bicimi (.doc/.xls): yalnizca kurtarilabilir metin bloklari okundu. ' +
        'Tam okuma icin dosyayi .docx/.xlsx olarak kaydedip yeniden yukleyin.';
      if (/Macros|VBA|_VBA_PROJECT/.test(tampon.toString('latin1', 0, Math.min(tampon.length, 1 << 20)))) {
        sonuc.bayraklar.push('makro_icerir');
      }

    // ------------------------------------------------------- DUZ METIN TURU
    } else {
      const cevrim = kodlama.metneCevir(tampon);
      const metin = cevrim.metin;

      // Okunamayan ikili govde mi?
      const ornek = metin.slice(0, 4096);
      const kontrol = (ornek.match(/[\u0000-\u0008\u000E-\u001F]/g) || []).length;
      if (kontrol > ornek.length * 0.05 || !metin.trim()) {
        sonuc.bicim = sonuc.sihirli ? sonuc.sihirli.toUpperCase() : 'IKILI';
        sonuc.durum = 'desteklenmiyor';
        sonuc.hata = 'Bu dosya turunden metin cikarilamiyor (ikili govde).';
        // Yine de okunabilir ASCII dizeleri kurtar (adli inceleme icin degerli)
        const dizeler = (tampon.toString('latin1').match(/[\x20-\x7E]{8,}/g) || []).slice(0, 2000);
        if (dizeler.length > 20) {
          sonuc.metin = temizle(`[KURTARILAN METIN DIZELERI]\n${dizeler.join('\n')}`);
          sonuc.durum = 'kismi';
          sonuc.tamam = true;
        }
      } else {
        const bicimler = {
          csv: 'CSV', tsv: 'TSV', md: 'MARKDOWN', json: 'JSON', log: 'LOG',
          ini: 'INI', cfg: 'CONF', conf: 'CONF', yml: 'YAML', yaml: 'YAML',
          sql: 'SQL', txt: 'METIN', vcf: 'VCARD', ics: 'ICALENDAR', srt: 'ALTYAZI',
        };
        sonuc.bicim = bicimler[uzanti] || (mime.startsWith('text/') ? 'METIN' : 'METIN');
        sonuc.metin = temizle(metin);
        sonuc.ustveri = { kodlama: cevrim.kodlama };

        if (uzanti === 'csv' || uzanti === 'tsv') {
          const satirlar = sonuc.metin.split('\n');
          sonuc.ustveri.satir_sayisi = satirlar.length;
          sonuc.ustveri.basliklar = (satirlar[0] || '').split(/[;,\t]/).slice(0, 40).map((s) => s.trim());
        }
        if (uzanti === 'json') {
          try {
            const nesne = JSON.parse(sonuc.metin);
            sonuc.ustveri.anahtarlar = Array.isArray(nesne)
              ? [`dizi(${nesne.length})`]
              : Object.keys(nesne).slice(0, 40);
          } catch { sonuc.bayraklar.push('bozuk_json'); }
        }
        sonuc.tamam = true;
        sonuc.durum = 'tamam';
      }
    }
  } catch (hata) {
    sonuc.durum = 'hata';
    sonuc.hata = `Okuma hatasi: ${hata.message}`;
  }

  sonuc.karakterSayisi = sonuc.metin.length;
  sonuc.kelimeSayisi = sonuc.metin ? (sonuc.metin.match(/\S+/g) || []).length : 0;
  sonuc.dil = dilTahmin(sonuc.metin);
  sonuc.bayraklar = [...new Set(sonuc.bayraklar)];
  sonuc.sureMs = Date.now() - basla;

  return sonuc;
}

module.exports = { oku, sihirliTur, dilTahmin, htmlMetin, varligiCoz, uzantiAl };
