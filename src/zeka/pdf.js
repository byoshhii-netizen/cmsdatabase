'use strict';
/**
 * src/zeka/pdf.js
 * Bagimliliksiz PDF metin ve ustveri cikarici.
 *
 * Yaptigi isler:
 *   - Nesne tablosunu tarar (xref'e guvenmez, dosyayi dogrudan gezer)
 *   - FlateDecode / ASCII85 / ASCIIHex / RunLength filtrelerini cozer,
 *     PNG ongorucusunu (predictor 10-15) geri alir
 *   - Nesne akislarini (/ObjStm, PDF 1.5+) acip icindeki nesneleri de ekler
 *   - Sayfa agacini (/Pages -> /Kids) gezerek SAYFA SIRASINI korur
 *   - Her sayfanin kendi /Resources /Font haritasini kullanir, boylece
 *     alt kume (subset) yazi tiplerinin /ToUnicode CMap'leri dogru eslenir
 *   - Icerik akisindaki Tj / TJ / ' / " operatorlerinden metni toplar
 *   - /Info ve XMP ustverisini, AcroForm alan degerlerini okur
 *   - Aktif icerik (JavaScript, OpenAction, Launch, gomulu dosya) isaretler
 *
 * Sinirlar: sifreli (/Encrypt) PDF'ler cozulemez; taranmis (goruntu) PDF'ler
 * metin icermedigi icin "metin yok" olarak bildirilir (OCR yapilmaz).
 */

const zlib = require('node:zlib');
const kodlama = require('./kodlama');

const MAX_AKIS = 48 * 1024 * 1024;
const MAX_METIN = 8 * 1024 * 1024;

// ---------------------------------------------------------------- YARDIMCI

/** PDF tarihini (D:20240115103000+03'00') ISO metne cevirir. */
function pdfTarih(deger) {
  const m = String(deger || '').match(/D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return null;
  const [, y, ay = '01', g = '01', s = '00', d = '00', sn = '00'] = m;
  const tarih = new Date(Date.UTC(Number(y), Number(ay) - 1, Number(g), Number(s), Number(d), Number(sn)));
  return Number.isNaN(tarih.getTime()) ? null : tarih.toISOString();
}

/** PDF dizesini (latin1 ham hali) okunabilir metne cevirir. */
function pdfDize(ham) {
  if (!ham) return '';
  const tampon = Buffer.from(ham, 'latin1');
  if (tampon.length >= 2 && tampon[0] === 0xFE && tampon[1] === 0xFF) {
    const ters = Buffer.from(tampon.subarray(2));
    ters.swap16();
    return ters.toString('utf16le');
  }
  let s = '';
  for (let i = 0; i < tampon.length; i++) s += kodlama.winAnsiKarakter(tampon[i]);
  return s;
}

/** "( ... )" dizesindeki PDF kacis dizilerini cozer; latin1 ham dize doner. */
function dizeKacisCoz(icerik) {
  let s = '';
  for (let i = 0; i < icerik.length; i++) {
    const k = icerik[i];
    if (k !== '\\') { s += k; continue; }
    const sonraki = icerik[++i];
    if (sonraki === undefined) break;
    if (sonraki === 'n') s += '\n';
    else if (sonraki === 'r') s += '\r';
    else if (sonraki === 't') s += '\t';
    else if (sonraki === 'b') s += '\b';
    else if (sonraki === 'f') s += '\f';
    else if (sonraki === '\n') { /* satir devami */ }
    else if (sonraki === '\r') { if (icerik[i + 1] === '\n') i++; }
    else if (sonraki >= '0' && sonraki <= '7') {
      let sekizlik = sonraki;
      while (sekizlik.length < 3 && icerik[i + 1] >= '0' && icerik[i + 1] <= '7') sekizlik += icerik[++i];
      s += String.fromCharCode(parseInt(sekizlik, 8) & 0xFF);
    } else s += sonraki;
  }
  return s;
}

/** PNG ongorucusunu (predictor >= 10) geri alir. */
function ongoruculGeriAl(veri, ongorucu, sutun, renk, bit) {
  if (ongorucu < 10) return veri;
  const baytPerPiksel = Math.max(1, Math.ceil((renk * bit) / 8));
  const satirBayt = Math.ceil((sutun * renk * bit) / 8);
  const satirBoyu = satirBayt + 1;
  const satirSayisi = Math.floor(veri.length / satirBoyu);
  const cikti = Buffer.alloc(satirSayisi * satirBayt);
  let oncekiSatir = Buffer.alloc(satirBayt);

  for (let s = 0; s < satirSayisi; s++) {
    const tur = veri[s * satirBoyu];
    const satir = Buffer.from(veri.subarray(s * satirBoyu + 1, s * satirBoyu + 1 + satirBayt));
    for (let i = 0; i < satirBayt; i++) {
      const sol = i >= baytPerPiksel ? satir[i - baytPerPiksel] : 0;
      const ust = oncekiSatir[i];
      const solUst = i >= baytPerPiksel ? oncekiSatir[i - baytPerPiksel] : 0;
      let d = satir[i];
      if (tur === 1) d = (d + sol) & 0xFF;
      else if (tur === 2) d = (d + ust) & 0xFF;
      else if (tur === 3) d = (d + ((sol + ust) >> 1)) & 0xFF;
      else if (tur === 4) {
        const p = sol + ust - solUst;
        const a = Math.abs(p - sol);
        const b = Math.abs(p - ust);
        const c = Math.abs(p - solUst);
        d = (d + (a <= b && a <= c ? sol : b <= c ? ust : solUst)) & 0xFF;
      }
      satir[i] = d;
    }
    satir.copy(cikti, s * satirBayt);
    oncekiSatir = satir;
  }
  return cikti;
}

/** RunLengthDecode filtresi. */
function runLengthCoz(veri) {
  const cikti = [];
  let i = 0;
  while (i < veri.length) {
    const n = veri[i++];
    if (n === 128) break;
    if (n < 128) {
      for (let j = 0; j <= n && i < veri.length; j++) cikti.push(veri[i++]);
    } else {
      const b = veri[i++];
      for (let j = 0; j < 257 - n; j++) cikti.push(b);
    }
  }
  return Buffer.from(cikti);
}

function flateCoz(veri) {
  const denemeler = [
    () => zlib.inflateSync(veri, { maxOutputLength: MAX_AKIS }),
    () => zlib.inflateRawSync(veri, { maxOutputLength: MAX_AKIS }),
    () => zlib.inflateSync(veri, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_AKIS }),
    () => zlib.inflateRawSync(veri, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_AKIS }),
    () => zlib.inflateSync(veri.subarray(1), { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_AKIS }),
  ];
  for (const deneme of denemeler) {
    try {
      const sonuc = deneme();
      if (sonuc && sonuc.length) return sonuc;
    } catch { /* sonraki denemeye gec */ }
  }
  return null;
}

// -------------------------------------------------------------- SOZLUK OKUMA

/** Sozlukten /Ad degerini ham metin olarak ceker (ic ice sozlukleri atlar). */
function sozlukDeger(sozluk, ad) {
  const dizin = sozluk.indexOf(`/${ad}`);
  if (dizin < 0) return null;
  let i = dizin + ad.length + 1;
  while (i < sozluk.length && /\s/.test(sozluk[i])) i++;
  const k = sozluk[i];

  if (k === '(') {
    let derinlik = 0;
    const bas = i;
    for (; i < sozluk.length; i++) {
      if (sozluk[i] === '\\') { i++; continue; }
      if (sozluk[i] === '(') derinlik++;
      else if (sozluk[i] === ')') { derinlik--; if (derinlik === 0) break; }
    }
    return { tur: 'dize', deger: dizeKacisCoz(sozluk.slice(bas + 1, i)) };
  }
  if (k === '<' && sozluk[i + 1] === '<') {
    let derinlik = 0;
    const bas = i;
    for (; i < sozluk.length - 1; i++) {
      if (sozluk[i] === '<' && sozluk[i + 1] === '<') { derinlik++; i++; }
      else if (sozluk[i] === '>' && sozluk[i + 1] === '>') { derinlik--; i++; if (derinlik === 0) break; }
    }
    return { tur: 'sozluk', deger: sozluk.slice(bas, i + 1) };
  }
  if (k === '<') {
    const son = sozluk.indexOf('>', i);
    return { tur: 'dize', deger: Buffer.from(sozluk.slice(i + 1, son).replace(/[^0-9A-Fa-f]/g, ''), 'hex').toString('latin1') };
  }
  if (k === '[') {
    let derinlik = 0;
    const bas = i;
    for (; i < sozluk.length; i++) {
      if (sozluk[i] === '[') derinlik++;
      else if (sozluk[i] === ']') { derinlik--; if (derinlik === 0) break; }
    }
    return { tur: 'dizi', deger: sozluk.slice(bas + 1, i) };
  }
  if (k === '/') {
    const m = sozluk.slice(i).match(/^\/([^\s/[\]<>()]*)/);
    return { tur: 'ad', deger: m ? m[1] : '' };
  }
  const m = sozluk.slice(i).match(/^(-?\d+(?:\.\d+)?)\s+(\d+)\s+R\b/);
  if (m) return { tur: 'basvuru', deger: Number(m[1]) };
  const n = sozluk.slice(i).match(/^(-?\d+(?:\.\d+)?)/);
  if (n) return { tur: 'sayi', deger: Number(n[1]) };
  const b = sozluk.slice(i).match(/^(true|false)/);
  if (b) return { tur: 'mantik', deger: b[1] === 'true' };
  return null;
}

// ------------------------------------------------------------- NESNE TARAMA

/**
 * Dosyayi gezip tum nesneleri toplar.
 * @returns {Map<number, {sozluk:string, akis:Buffer|null}>}
 */
function nesneleriTopla(tampon) {
  const ham = tampon.toString('latin1');
  const nesneler = new Map();
  const desen = /(\d+)\s+(\d+)\s+obj\b/g;
  let eslesme;

  while ((eslesme = desen.exec(ham)) !== null) {
    const numara = Number(eslesme[1]);
    const govdeBas = eslesme.index + eslesme[0].length;

    const akisDizin = ham.indexOf('stream', govdeBas);
    const endobjDizin = ham.indexOf('endobj', govdeBas);
    const akisVar = akisDizin >= 0 && (endobjDizin < 0 || akisDizin < endobjDizin);

    if (!akisVar) {
      const son = endobjDizin < 0 ? Math.min(govdeBas + 65_536, ham.length) : endobjDizin;
      nesneler.set(numara, { sozluk: ham.slice(govdeBas, son), akis: null });
      continue;
    }

    const sozluk = ham.slice(govdeBas, akisDizin);
    let veriBas = akisDizin + 6;
    if (ham[veriBas] === '\r') veriBas++;
    if (ham[veriBas] === '\n') veriBas++;

    let veriSon = -1;
    const uzunlukDeger = sozlukDeger(sozluk, 'Length');
    if (uzunlukDeger && uzunlukDeger.tur === 'sayi') {
      const aday = veriBas + uzunlukDeger.deger;
      if (aday <= ham.length && /^\s*endstream/.test(ham.slice(aday, aday + 20))) veriSon = aday;
    }
    if (veriSon < 0) {
      veriSon = ham.indexOf('endstream', veriBas);
      if (veriSon < 0) veriSon = Math.min(veriBas + MAX_AKIS, ham.length);
      while (veriSon > veriBas && (ham[veriSon - 1] === '\n' || ham[veriSon - 1] === '\r')) veriSon--;
    }

    nesneler.set(numara, { sozluk, akis: tampon.subarray(veriBas, veriSon) });
    desen.lastIndex = Math.max(desen.lastIndex, veriSon);
  }

  return nesneler;
}

/** Nesnenin akisini filtrelerini uygulayarak cozer. */
function akisCoz(nesne) {
  if (!nesne || !nesne.akis || !nesne.akis.length) return null;

  const filtreDeger = sozlukDeger(nesne.sozluk, 'Filter');
  let filtreler = [];
  if (filtreDeger) {
    if (filtreDeger.tur === 'ad') filtreler = [filtreDeger.deger];
    else if (filtreDeger.tur === 'dizi') filtreler = (filtreDeger.deger.match(/\/(\w+)/g) || []).map((s) => s.slice(1));
  }

  let veri = nesne.akis;
  for (const f of filtreler) {
    if (f === 'FlateDecode' || f === 'Fl') {
      const cozulen = flateCoz(veri);
      if (!cozulen) return null;
      veri = cozulen;
    } else if (f === 'ASCII85Decode' || f === 'A85') {
      veri = kodlama.ascii85Coz(veri.toString('latin1'));
    } else if (f === 'ASCIIHexDecode' || f === 'AHx') {
      veri = kodlama.asciiHexCoz(veri.toString('latin1'));
    } else if (f === 'RunLengthDecode' || f === 'RL') {
      veri = runLengthCoz(veri);
    } else if (f === 'DCTDecode' || f === 'JPXDecode' || f === 'JBIG2Decode' || f === 'CCITTFaxDecode') {
      return null; // goruntu akisi: metin yok
    } else if (f === 'LZWDecode') {
      return null; // desteklenmiyor
    }
  }

  const parmDeger = sozlukDeger(nesne.sozluk, 'DecodeParms') || sozlukDeger(nesne.sozluk, 'DP');
  if (parmDeger && parmDeger.tur === 'sozluk') {
    const ongorucu = sozlukDeger(parmDeger.deger, 'Predictor');
    if (ongorucu && ongorucu.tur === 'sayi' && ongorucu.deger >= 10) {
      const sutun = sozlukDeger(parmDeger.deger, 'Columns');
      const renk = sozlukDeger(parmDeger.deger, 'Colors');
      const bit = sozlukDeger(parmDeger.deger, 'BitsPerComponent');
      veri = ongoruculGeriAl(
        veri, ongorucu.deger,
        sutun && sutun.tur === 'sayi' ? sutun.deger : 1,
        renk && renk.tur === 'sayi' ? renk.deger : 1,
        bit && bit.tur === 'sayi' ? bit.deger : 8,
      );
    }
  }

  return veri;
}

/** /ObjStm nesne akislarini acip icindeki nesneleri haritaya ekler. */
function nesneAkislariniAc(nesneler) {
  for (const [, nesne] of [...nesneler]) {
    if (!/\/Type\s*\/ObjStm/.test(nesne.sozluk)) continue;
    const veri = akisCoz(nesne);
    if (!veri) continue;

    const sayiDeger = sozlukDeger(nesne.sozluk, 'N');
    const ilkDeger = sozlukDeger(nesne.sozluk, 'First');
    if (!sayiDeger || !ilkDeger) continue;

    const metin = veri.toString('latin1');
    const basliklar = metin.slice(0, ilkDeger.deger).trim().split(/\s+/).map(Number);
    const govde = metin.slice(ilkDeger.deger);

    for (let i = 0; i < sayiDeger.deger; i++) {
      const numara = basliklar[i * 2];
      const ofset = basliklar[i * 2 + 1];
      if (!Number.isFinite(numara) || !Number.isFinite(ofset)) continue;
      const sonrakiOfset = Number.isFinite(basliklar[i * 2 + 3]) ? basliklar[i * 2 + 3] : govde.length;
      if (nesneler.has(numara) && nesneler.get(numara).akis) continue;
      nesneler.set(numara, { sozluk: govde.slice(ofset, sonrakiOfset), akis: null });
    }
  }
}

// ------------------------------------------------------------------- CMAP

/** Bir CMap akisini { harita:Map<number,string>, baytSayisi:number } yapar. */
function cmapAyristir(metin) {
  const harita = new Map();
  let baytSayisi = 1;

  const charBlok = /beginbfchar([\s\S]*?)endbfchar/g;
  let blok;
  while ((blok = charBlok.exec(metin)) !== null) {
    const ciftler = blok[1].match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g) || [];
    for (const cift of ciftler) {
      const m = cift.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/);
      if (!m) continue;
      if (m[1].length >= 4) baytSayisi = 2;
      harita.set(parseInt(m[1], 16), hexUtf16(m[2]));
    }
  }

  const rangeBlok = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((blok = rangeBlok.exec(metin)) !== null) {
    const govde = blok[1];
    // <lo> <hi> <dst>
    const tekil = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
    let m;
    while ((m = tekil.exec(govde)) !== null) {
      if (m[1].length >= 4) baytSayisi = 2;
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      const taban = m[3];
      if (hi - lo > 65_535) continue;
      for (let k = lo; k <= hi; k++) {
        const kayma = k - lo;
        if (taban.length <= 4) {
          harita.set(k, String.fromCharCode(parseInt(taban || '0', 16) + kayma));
        } else {
          const bas = taban.slice(0, taban.length - 4);
          const son = (parseInt(taban.slice(-4), 16) + kayma).toString(16).padStart(4, '0');
          harita.set(k, hexUtf16(bas + son));
        }
      }
    }
    // <lo> <hi> [ <d1> <d2> ... ]
    const dizili = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
    while ((m = dizili.exec(govde)) !== null) {
      if (m[1].length >= 4) baytSayisi = 2;
      const lo = parseInt(m[1], 16);
      const ogeler = m[3].match(/<([0-9A-Fa-f]*)>/g) || [];
      ogeler.forEach((oge, i) => {
        harita.set(lo + i, hexUtf16(oge.replace(/[<>]/g, '')));
      });
    }
  }

  if (/\/Identity-H|\/Identity-V|begincidrange/.test(metin)) baytSayisi = 2;
  return { harita, baytSayisi };
}

/** UTF-16BE hex dizisini metne cevirir (vekil ciftleri dahil). */
function hexUtf16(hex) {
  const temiz = String(hex || '').replace(/[^0-9A-Fa-f]/g, '');
  if (temiz.length === 2) return String.fromCharCode(parseInt(temiz, 16));

  let s = '';
  let i = 0;
  while (i + 4 <= temiz.length) {
    const kod = parseInt(temiz.substr(i, 4), 16);
    if (kod >= 0xD800 && kod <= 0xDBFF && i + 8 <= temiz.length) {
      const alt = parseInt(temiz.substr(i + 4, 4), 16);
      s += String.fromCharCode(kod, alt);
      i += 8;
    } else {
      if (kod) s += String.fromCharCode(kod);
      i += 4;
    }
  }
  return s;
}

// ------------------------------------------------------- SAYFA AGACI GEZINME

function basvuruNumaralari(diziMetni) {
  return [...String(diziMetni || '').matchAll(/(\d+)\s+(\d+)\s+R/g)].map((m) => Number(m[1]));
}

/** Kok /Pages dugumunden baslayip sayfa nesne numaralarini SIRAYLA toplar. */
function sayfaSirasi(nesneler) {
  const sayfaNumaralari = [];
  const gorulen = new Set();

  const kokler = [];
  for (const [numara, nesne] of nesneler) {
    if (/\/Type\s*\/Pages/.test(nesne.sozluk) && !/\/Parent/.test(nesne.sozluk)) kokler.push(numara);
  }

  function gez(numara, derinlik) {
    if (derinlik > 64 || gorulen.has(numara)) return;
    gorulen.add(numara);
    const nesne = nesneler.get(numara);
    if (!nesne) return;

    if (/\/Type\s*\/Page[^s]/.test(nesne.sozluk) || /\/Type\s*\/Page$/.test(nesne.sozluk.trim())) {
      sayfaNumaralari.push(numara);
      return;
    }
    const kids = sozlukDeger(nesne.sozluk, 'Kids');
    if (kids && kids.tur === 'dizi') {
      for (const alt of basvuruNumaralari(kids.deger)) gez(alt, derinlik + 1);
    }
  }

  for (const kok of kokler) gez(kok, 0);

  if (sayfaNumaralari.length === 0) {
    for (const [numara, nesne] of nesneler) {
      if (/\/Type\s*\/Page(?![s])/.test(nesne.sozluk)) sayfaNumaralari.push(numara);
    }
    sayfaNumaralari.sort((a, b) => a - b);
  }

  return sayfaNumaralari;
}

/** Sayfanin (gerekirse ebeveynden miras alarak) kaynak sozlugunu bulur. */
function kaynakSozlugu(nesneler, sayfaNumarasi) {
  let numara = sayfaNumarasi;
  for (let derinlik = 0; derinlik < 32; derinlik++) {
    const nesne = nesneler.get(numara);
    if (!nesne) return null;
    const kaynak = sozlukDeger(nesne.sozluk, 'Resources');
    if (kaynak) {
      if (kaynak.tur === 'sozluk') return kaynak.deger;
      if (kaynak.tur === 'basvuru') {
        const hedef = nesneler.get(kaynak.deger);
        if (hedef) return hedef.sozluk;
      }
    }
    const ebeveyn = sozlukDeger(nesne.sozluk, 'Parent');
    if (!ebeveyn || ebeveyn.tur !== 'basvuru') return null;
    numara = ebeveyn.deger;
  }
  return null;
}

/** Kaynak sozlugunden { yaziTipiAdi -> cmap } haritasi uretir. */
function yaziTipiHaritasi(nesneler, kaynakMetni, cmapOnbellek) {
  const harita = new Map();
  if (!kaynakMetni) return harita;

  const yaziTipi = sozlukDeger(kaynakMetni, 'Font');
  let fontSozluk = null;
  if (yaziTipi && yaziTipi.tur === 'sozluk') fontSozluk = yaziTipi.deger;
  else if (yaziTipi && yaziTipi.tur === 'basvuru') {
    const hedef = nesneler.get(yaziTipi.deger);
    if (hedef) fontSozluk = hedef.sozluk;
  }
  if (!fontSozluk) return harita;

  for (const m of fontSozluk.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const ad = m[1];
    const fontNumarasi = Number(m[2]);
    const font = nesneler.get(fontNumarasi);
    if (!font) continue;

    let bilgi = cmapOnbellek.get(fontNumarasi);
    if (bilgi === undefined) {
      bilgi = null;
      const toUnicode = sozlukDeger(font.sozluk, 'ToUnicode');
      if (toUnicode && toUnicode.tur === 'basvuru') {
        const cmapNesne = nesneler.get(toUnicode.deger);
        const veri = cmapNesne ? akisCoz(cmapNesne) : null;
        if (veri) bilgi = cmapAyristir(veri.toString('latin1'));
      }
      if (!bilgi) {
        const altTur = sozlukDeger(font.sozluk, 'Subtype');
        const kodlamaDeger = sozlukDeger(font.sozluk, 'Encoding');
        const ikiBayt = (altTur && altTur.deger === 'Type0')
          || (kodlamaDeger && /Identity/.test(String(kodlamaDeger.deger)));
        bilgi = { harita: new Map(), baytSayisi: ikiBayt ? 2 : 1 };
      }
      cmapOnbellek.set(fontNumarasi, bilgi);
    }
    harita.set(ad, bilgi);
  }

  return harita;
}

// --------------------------------------------------------- ICERIK COZUMLEME

/** Ham dizeyi secili yazi tipinin cmap'ine gore metne cevirir. */
function dizeyiCevir(hamDize, font) {
  if (!font || !font.harita || font.harita.size === 0) {
    if (font && font.baytSayisi === 2) {
      // Kodlama bilinmiyor ama 2 baytlik: ASCII'ye yakin degerleri kurtar.
      let s = '';
      for (let i = 0; i + 1 < hamDize.length; i += 2) {
        const kod = (hamDize.charCodeAt(i) << 8) | hamDize.charCodeAt(i + 1);
        s += kod >= 32 && kod < 0xFFFD ? String.fromCharCode(kod) : '';
      }
      return s;
    }
    let s = '';
    for (let i = 0; i < hamDize.length; i++) s += kodlama.winAnsiKarakter(hamDize.charCodeAt(i) & 0xFF);
    return s;
  }

  let s = '';
  if (font.baytSayisi === 2) {
    for (let i = 0; i + 1 < hamDize.length; i += 2) {
      const kod = (hamDize.charCodeAt(i) << 8) | hamDize.charCodeAt(i + 1);
      const es = font.harita.get(kod);
      s += es !== undefined ? es : (kod >= 32 && kod < 0xFFFD ? String.fromCharCode(kod) : '');
    }
  } else {
    for (let i = 0; i < hamDize.length; i++) {
      const kod = hamDize.charCodeAt(i) & 0xFF;
      const es = font.harita.get(kod);
      s += es !== undefined ? es : kodlama.winAnsiKarakter(kod);
    }
  }
  return s;
}

/** Bir icerik akisindan metni cikarir. */
function icerikMetni(icerik, fontlar) {
  let cikti = '';
  let aktifFont = null;
  let sonY = null;
  const dizeYigin = [];

  let i = 0;
  const n = icerik.length;

  function dizeOku(baslangic) {
    let derinlik = 0;
    let j = baslangic;
    for (; j < n; j++) {
      const k = icerik[j];
      if (k === '\\') { j++; continue; }
      if (k === '(') derinlik++;
      else if (k === ')') { derinlik--; if (derinlik === 0) break; }
    }
    return { ham: dizeKacisCoz(icerik.slice(baslangic + 1, j)), son: j + 1 };
  }

  while (i < n) {
    const k = icerik[i];

    if (k === '(') {
      const d = dizeOku(i);
      dizeYigin.push({ tur: 'dize', deger: d.ham });
      i = d.son;
      continue;
    }
    if (k === '<' && icerik[i + 1] !== '<') {
      const son = icerik.indexOf('>', i);
      if (son < 0) break;
      const hex = icerik.slice(i + 1, son).replace(/[^0-9A-Fa-f]/g, '');
      const duz = hex.length % 2 ? hex + '0' : hex;
      dizeYigin.push({ tur: 'dize', deger: Buffer.from(duz, 'hex').toString('latin1') });
      i = son + 1;
      continue;
    }
    if (k === '[') {
      // TJ dizisi: parcalari ve araliklari topla
      let derinlik = 0;
      let j = i;
      for (; j < n; j++) {
        if (icerik[j] === '\\') { j++; continue; }
        if (icerik[j] === '[') derinlik++;
        else if (icerik[j] === ']') { derinlik--; if (derinlik === 0) break; }
      }
      dizeYigin.push({ tur: 'dizi', deger: icerik.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (k === '/') {
      const m = icerik.slice(i).match(/^\/([^\s/[\]<>()]*)/);
      dizeYigin.push({ tur: 'ad', deger: m ? m[1] : '' });
      i += m ? m[0].length : 1;
      continue;
    }
    if (/[-+.\d]/.test(k)) {
      const m = icerik.slice(i).match(/^[-+]?\d*\.?\d+/);
      if (m) { dizeYigin.push({ tur: 'sayi', deger: Number(m[0]) }); i += m[0].length; continue; }
      i++;
      continue;
    }
    if (/[A-Za-z'"*]/.test(k)) {
      const m = icerik.slice(i).match(/^[A-Za-z*'"]+[01*]?/);
      const op = m ? m[0] : k;
      i += op.length;

      if (op === 'Tf') {
        for (let s = dizeYigin.length - 1; s >= 0; s--) {
          if (dizeYigin[s].tur === 'ad') { aktifFont = fontlar.get(dizeYigin[s].deger) || null; break; }
        }
      } else if (op === 'Tj') {
        const son = dizeYigin[dizeYigin.length - 1];
        if (son && son.tur === 'dize') cikti += dizeyiCevir(son.deger, aktifFont);
      } else if (op === 'TJ') {
        const son = dizeYigin[dizeYigin.length - 1];
        if (son && son.tur === 'dizi') cikti += tjDizisi(son.deger, aktifFont);
      } else if (op === "'" || op === '"') {
        const son = dizeYigin[dizeYigin.length - 1];
        cikti += '\n';
        if (son && son.tur === 'dize') cikti += dizeyiCevir(son.deger, aktifFont);
      } else if (op === 'Td' || op === 'TD') {
        const dy = dizeYigin[dizeYigin.length - 1];
        cikti += dy && dy.tur === 'sayi' && Math.abs(dy.deger) > 0.5 ? '\n' : ' ';
      } else if (op === 'T*') {
        cikti += '\n';
      } else if (op === 'Tm') {
        const y = dizeYigin[dizeYigin.length - 1];
        if (y && y.tur === 'sayi') {
          if (sonY !== null && Math.abs(y.deger - sonY) > 1.5) cikti += '\n';
          sonY = y.deger;
        }
      } else if (op === 'ET' || op === 'Do') {
        cikti += '\n';
      }

      dizeYigin.length = 0;
      if (cikti.length > MAX_METIN) break;
      continue;
    }
    i++;
  }

  return cikti;
}

function tjDizisi(govde, font) {
  let cikti = '';
  let i = 0;
  const n = govde.length;
  while (i < n) {
    const k = govde[i];
    if (k === '(') {
      let derinlik = 0;
      let j = i;
      for (; j < n; j++) {
        if (govde[j] === '\\') { j++; continue; }
        if (govde[j] === '(') derinlik++;
        else if (govde[j] === ')') { derinlik--; if (derinlik === 0) break; }
      }
      cikti += dizeyiCevir(dizeKacisCoz(govde.slice(i + 1, j)), font);
      i = j + 1;
      continue;
    }
    if (k === '<') {
      const son = govde.indexOf('>', i);
      if (son < 0) break;
      const hex = govde.slice(i + 1, son).replace(/[^0-9A-Fa-f]/g, '');
      cikti += dizeyiCevir(Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex').toString('latin1'), font);
      i = son + 1;
      continue;
    }
    const m = govde.slice(i).match(/^[-+]?\d*\.?\d+/);
    if (m) {
      const sayi = Number(m[0]);
      if (sayi < -120) cikti += ' ';
      i += m[0].length;
      continue;
    }
    i++;
  }
  return cikti;
}

// ------------------------------------------------------------------- ANA

/**
 * PDF'ten metin ve ustveri cikarir.
 * @param {Buffer} tampon
 * @returns {{tamam:boolean, metin:string, sayfaSayisi:number, sifreli:boolean,
 *            ustveri:object, bayraklar:string[], alanlar:object, hata?:string}}
 */
function oku(tampon) {
  const sonuc = {
    tamam: false, metin: '', sayfaSayisi: 0, sifreli: false,
    ustveri: {}, bayraklar: [], alanlar: {},
  };

  if (!Buffer.isBuffer(tampon) || tampon.length < 8) {
    sonuc.hata = 'Dosya PDF olarak okunamadi (cok kisa).';
    return sonuc;
  }

  const basHam = tampon.subarray(0, Math.min(2048, tampon.length)).toString('latin1');
  const surum = (basHam.match(/%PDF-(\d\.\d)/) || [])[1];
  if (surum) sonuc.ustveri.pdf_surumu = surum;

  const tamHam = tampon.toString('latin1');
  if (/\/Encrypt[\s/<\d]/.test(tamHam)) {
    sonuc.sifreli = true;
    sonuc.bayraklar.push('sifreli_pdf');
  }

  // Aktif icerik isaretleri
  const aktifDesenler = [
    [/\/JavaScript|\/JS[\s(<]/, 'pdf_javascript'],
    [/\/OpenAction/, 'pdf_acilis_eylemi'],
    [/\/Launch/, 'pdf_dis_program'],
    [/\/EmbeddedFile/, 'pdf_gomulu_dosya'],
    [/\/SubmitForm/, 'pdf_form_gonderimi'],
    [/\/RichMedia|\/Movie|\/Sound/, 'pdf_zengin_medya'],
    [/\/AA[\s/<]/, 'pdf_otomatik_eylem'],
  ];
  for (const [desen, bayrak] of aktifDesenler) {
    if (desen.test(tamHam)) sonuc.bayraklar.push(bayrak);
  }

  let nesneler;
  try {
    nesneler = nesneleriTopla(tampon);
    nesneAkislariniAc(nesneler);
  } catch (hata) {
    sonuc.hata = 'PDF nesne tablosu okunamadi: ' + hata.message;
    return sonuc;
  }

  // --- /Info ustverisi ---
  for (const [, nesne] of nesneler) {
    if (!/\/(Producer|Creator|CreationDate|ModDate|Author|Title)/.test(nesne.sozluk)) continue;
    if (/\/Type\s*\/(Page|Font|XObject|Catalog|Pages)/.test(nesne.sozluk)) continue;
    const alanlar = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate'];
    for (const alan of alanlar) {
      if (sonuc.ustveri[alan.toLowerCase()]) continue;
      const d = sozlukDeger(nesne.sozluk, alan);
      if (d && d.tur === 'dize' && d.deger) {
        const deger = alan.endsWith('Date') ? pdfTarih(d.deger) : pdfDize(d.deger);
        if (deger) sonuc.ustveri[alan.toLowerCase()] = String(deger).slice(0, 400);
      }
    }
  }

  // --- Sayfalar ---
  const sayfalar = sayfaSirasi(nesneler);
  sonuc.sayfaSayisi = sayfalar.length;

  const cmapOnbellek = new Map();
  const parcalar = [];

  for (const sayfaNumarasi of sayfalar) {
    const sayfa = nesneler.get(sayfaNumarasi);
    if (!sayfa) continue;

    const fontlar = yaziTipiHaritasi(nesneler, kaynakSozlugu(nesneler, sayfaNumarasi), cmapOnbellek);

    const icerikDeger = sozlukDeger(sayfa.sozluk, 'Contents');
    const icerikNumaralari = [];
    if (icerikDeger) {
      if (icerikDeger.tur === 'basvuru') icerikNumaralari.push(icerikDeger.deger);
      else if (icerikDeger.tur === 'dizi') icerikNumaralari.push(...basvuruNumaralari(icerikDeger.deger));
    }

    let sayfaMetni = '';
    for (const numara of icerikNumaralari) {
      const akis = nesneler.get(numara);
      const veri = akis ? akisCoz(akis) : null;
      if (!veri) continue;
      sayfaMetni += icerikMetni(veri.toString('latin1'), fontlar);
    }

    if (sayfaMetni.trim()) parcalar.push(sayfaMetni);
    if (parcalar.join('').length > MAX_METIN) break;
  }

  // Sayfa agaci bulunamadiysa tum icerik akislarini sirayla dene.
  if (parcalar.length === 0) {
    const genelFontlar = new Map();
    for (const [numara, nesne] of nesneler) {
      if (!nesne.akis) continue;
      if (/\/Type\s*\/(XObject|Metadata|ObjStm|XRef)/.test(nesne.sozluk) && !/\/Subtype\s*\/Form/.test(nesne.sozluk)) continue;
      const veri = akisCoz(nesne);
      if (!veri) continue;
      const metin = veri.toString('latin1');
      if (!/\bTj\b|\bTJ\b/.test(metin)) continue;
      const fontlar = yaziTipiHaritasi(nesneler, kaynakSozlugu(nesneler, numara), cmapOnbellek) || genelFontlar;
      const parca = icerikMetni(metin, fontlar);
      if (parca.trim()) parcalar.push(parca);
      if (parcalar.join('').length > MAX_METIN) break;
    }
  }

  // --- AcroForm alan degerleri ---
  for (const [, nesne] of nesneler) {
    if (!/\/FT\s*\//.test(nesne.sozluk)) continue;
    const ad = sozlukDeger(nesne.sozluk, 'T');
    const deger = sozlukDeger(nesne.sozluk, 'V');
    if (ad && ad.tur === 'dize' && deger) {
      const anahtar = pdfDize(ad.deger).slice(0, 80);
      const icerik = deger.tur === 'dize' ? pdfDize(deger.deger) : String(deger.deger);
      if (anahtar && icerik) sonuc.alanlar[anahtar] = String(icerik).slice(0, 400);
    }
  }

  // --- XMP ustverisi (yalnizca birkac alan) ---
  for (const [, nesne] of nesneler) {
    if (!/\/Type\s*\/Metadata/.test(nesne.sozluk)) continue;
    const veri = akisCoz(nesne) || nesne.akis;
    if (!veri) continue;
    const xmp = veri.toString('utf8');
    const yazar = xmp.match(/<dc:creator>[\s\S]*?<rdf:li[^>]*>([^<]{1,200})</);
    const baslik = xmp.match(/<dc:title>[\s\S]*?<rdf:li[^>]*>([^<]{1,200})</);
    const arac = xmp.match(/<xmp:CreatorTool>([^<]{1,200})</);
    if (yazar && !sonuc.ustveri.author) sonuc.ustveri.author = yazar[1].trim();
    if (baslik && !sonuc.ustveri.title) sonuc.ustveri.title = baslik[1].trim();
    if (arac && !sonuc.ustveri.creator) sonuc.ustveri.creator = arac[1].trim();
    break;
  }

  const metin = parcalar.join('\n\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  sonuc.metin = metin.slice(0, MAX_METIN);
  sonuc.tamam = metin.length > 0;

  if (!sonuc.tamam) {
    sonuc.hata = sonuc.sifreli
      ? 'PDF sifreli: metin katmani cozulemedi.'
      : 'PDF metin katmani bulunamadi (taranmis goruntu olabilir).';
    if (!sonuc.sifreli) sonuc.bayraklar.push('metin_katmani_yok');
  }

  return sonuc;
}

module.exports = { oku, pdfTarih };
