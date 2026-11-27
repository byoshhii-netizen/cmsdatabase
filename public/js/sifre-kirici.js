'use strict';
/* ==========================================================================
   public/js/sifre-kirici.js   —   SIFRE KIRICI / COZUMLEYICI
   Klasik sifreleme ve kodlamalari tarayicida (kapali devre) cozer. Girdiye
   konan metni butun yontemlerle dener, "okunabilirlik" puanina gore en olasi
   cozumleri siralar. Desteklenen: Base64/Base64URL, Base32, Hex, İkilik,
   Ondalik/Sekizlik ASCII, URL/HTML cozme, ROT13, ROT47, Atbash, Sezar (tum
   kaymalar), Vigenère (anahtarli), tek-bayt XOR (kaba kuvvet), Mors, A1Z26,
   ters cevirme.

   Not: Bu arac klasik/akademik sifreleri ve kodlamalari cozer; modern guclu
   kriptografiyi (AES, bcrypt, SHA vb.) "kirmaz" — onlar matematiksel olarak
   anahtarsiz geri cevrilemez.
   ========================================================================== */
(function () {
  var girdiEl = document.getElementById('sk-girdi');
  if (!girdiEl) return;

  var sonucEl = document.getElementById('sk-sonuc');
  var ozetEl = document.getElementById('sk-ozet');

  // ------------------------------------------------------- YARDIMCILAR
  var TR_HARF = 'abcçdefgğhıijklmnoöprsştuüvyz';
  var EN_HARF = 'abcdefghijklmnopqrstuvwxyz';

  // Turkce + Ingilizce sik kelimeler (puanlama icin).
  var SOZLUK = ('bir ve bu ile için çok daha ama değil olarak var yok ben sen '
    + 'biz onlar evet hayır merkez veri sistem sifre kod gizli acil rapor hedef '
    + 'konum analiz the and you that was for are with his they this have from one '
    + 'had word but not what all were when your can said there use each which she '
    + 'password secret target agent mission report data system access key code')
    .split(' ');

  function utf8Coz(baytlar) {
    try { return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(baytlar)); }
    catch (e) {
      var s = '';
      for (var i = 0; i < baytlar.length; i++) s += String.fromCharCode(baytlar[i]);
      try { return decodeURIComponent(escape(s)); } catch (_) { return s; }
    }
  }

  function yazdirilabilirOran(s) {
    if (!s) return 0;
    var iyi = 0;
    for (var i = 0; i < s.length; i++) {
      var k = s.charCodeAt(i);
      if (k === 9 || k === 10 || k === 13 || (k >= 32 && k <= 126) || k >= 160) iyi++;
    }
    return iyi / s.length;
  }

  /** Metni "anlamli metne benziyor mu" diye puanlar (0..~100). */
  function skor(s) {
    if (!s || s.length < 1) return 0;
    var yo = yazdirilabilirOran(s);
    if (yo < 0.85) return yo * 10;           // bozuk/binary cikti -> cok dusuk

    var kucuk = s.toLocaleLowerCase('tr-TR');
    var toplam = s.length;
    var harf = 0, bosluk = 0, sesli = 0;
    var sesliler = 'aeıioöuüAEIİOÖUÜ';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (/[a-zçğıöşü]/i.test(c)) harf++;
      if (c === ' ') bosluk++;
      if (sesliler.indexOf(c) >= 0) sesli++;
    }
    var harfOran = harf / toplam;
    var puan = yo * 20 + harfOran * 30;

    // Bosluk varligi (makul oranda) metni olumlu etkiler
    var bosOran = bosluk / toplam;
    if (bosOran > 0.03 && bosOran < 0.25) puan += 12;

    // Sesli/sessiz dengesi (anlamli dillerde ~%35-55)
    if (harf > 0) {
      var sO = sesli / harf;
      if (sO > 0.25 && sO < 0.62) puan += 10;
    }

    // Sozluk kelimesi eslesmeleri
    var kelimeler = kucuk.split(/[^a-zçğıöşü]+/).filter(Boolean);
    var vurus = 0;
    for (var j = 0; j < kelimeler.length; j++) {
      if (SOZLUK.indexOf(kelimeler[j]) >= 0) vurus++;
    }
    puan += Math.min(40, vurus * 9);

    // Asiri sembol/rakam yogunlugu cezasi
    var semboller = toplam - harf - bosluk;
    if (semboller / toplam > 0.5) puan *= 0.5;

    return puan;
  }

  // ------------------------------------------------------- COZUCULER
  // Her cozucu: (metin) -> string|null  (null = uygulanamaz/basarisiz)

  function base64Coz(s) {
    var t = s.replace(/\s+/g, '');
    if (t.length < 4) return null;
    var urlMod = /[-_]/.test(t);
    if (urlMod) t = t.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4 !== 0) t += '=';
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return null;
    try {
      var ikili = atob(t);
      var baytlar = [];
      for (var i = 0; i < ikili.length; i++) baytlar.push(ikili.charCodeAt(i));
      return utf8Coz(baytlar);
    } catch (e) { return null; }
  }

  function base32Coz(s) {
    var alfabe = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    var t = s.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
    if (t.length < 2 || !/^[A-Z2-7]+$/.test(t)) return null;
    var bit = 0, deger = 0, out = [];
    for (var i = 0; i < t.length; i++) {
      var idx = alfabe.indexOf(t[i]);
      if (idx < 0) return null;
      deger = (deger << 5) | idx; bit += 5;
      if (bit >= 8) { bit -= 8; out.push((deger >> bit) & 0xff); }
    }
    if (!out.length) return null;
    return utf8Coz(out);
  }

  function hexCoz(s) {
    var t = s.replace(/0x/gi, '').replace(/[\s:,-]+/g, '');
    if (t.length < 2 || t.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(t)) return null;
    var out = [];
    for (var i = 0; i < t.length; i += 2) out.push(parseInt(t.substr(i, 2), 16));
    return utf8Coz(out);
  }

  function ikilikCoz(s) {
    var parcalar = s.trim().split(/\s+/);
    if (parcalar.length > 1 && parcalar.every(function (p) { return /^[01]{1,8}$/.test(p); })) {
      return utf8Coz(parcalar.map(function (p) { return parseInt(p, 2); }));
    }
    var t = s.replace(/\s+/g, '');
    if (t.length >= 8 && t.length % 8 === 0 && /^[01]+$/.test(t)) {
      var out = [];
      for (var i = 0; i < t.length; i += 8) out.push(parseInt(t.substr(i, 8), 2));
      return utf8Coz(out);
    }
    return null;
  }

  function ondalikCoz(s) {
    var parcalar = s.trim().split(/[\s,]+/).filter(Boolean);
    if (parcalar.length < 1 || !parcalar.every(function (p) { return /^\d{1,3}$/.test(p); })) return null;
    var baytlar = parcalar.map(Number);
    if (!baytlar.every(function (n) { return n >= 0 && n <= 255; })) return null;
    return utf8Coz(baytlar);
  }

  function sekizlikCoz(s) {
    var parcalar = s.trim().split(/[\s,]+/).filter(Boolean);
    if (parcalar.length < 1 || !parcalar.every(function (p) { return /^[0-7]{1,3}$/.test(p); })) return null;
    var baytlar = parcalar.map(function (p) { return parseInt(p, 8); });
    if (!baytlar.every(function (n) { return n >= 0 && n <= 255; })) return null;
    return utf8Coz(baytlar);
  }

  function urlCoz(s) {
    if (!/%[0-9a-fA-F]{2}/.test(s)) return null;
    try { return decodeURIComponent(s); } catch (e) { return null; }
  }

  function htmlCoz(s) {
    if (!/&(#\d+|#x[0-9a-fA-F]+|[a-z]+);/i.test(s)) return null;
    var h = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return s.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-z]+);/gi, function (tam, g) {
      if (g[0] === '#') {
        var kod = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        return isNaN(kod) ? tam : String.fromCodePoint(kod);
      }
      return Object.prototype.hasOwnProperty.call(h, g.toLowerCase()) ? h[g.toLowerCase()] : tam;
    });
  }

  function rot13(s) {
    return s.replace(/[a-z]/gi, function (c) {
      var t = c <= 'Z' ? 65 : 97;
      return String.fromCharCode((c.charCodeAt(0) - t + 13) % 26 + t);
    });
  }

  function rot47(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var k = s.charCodeAt(i);
      out += (k >= 33 && k <= 126) ? String.fromCharCode(33 + (k - 33 + 47) % 94) : s[i];
    }
    return out;
  }

  function atbash(s) {
    return s.replace(/[a-z]/gi, function (c) {
      if (c >= 'a' && c <= 'z') return String.fromCharCode(219 - c.charCodeAt(0));
      return String.fromCharCode(155 - c.charCodeAt(0));
    });
  }

  function sezar(s, kayma) {
    return s.replace(/[a-z]/gi, function (c) {
      var t = c <= 'Z' ? 65 : 97;
      return String.fromCharCode((c.charCodeAt(0) - t + kayma + 26) % 26 + t);
    });
  }

  function sezarTurkce(s, kayma) {
    var n = TR_HARF.length;
    return s.replace(/[a-zçğıöşü]/gi, function (c) {
      var kc = c.toLocaleLowerCase('tr-TR');
      var idx = TR_HARF.indexOf(kc);
      if (idx < 0) return c;
      var yeni = TR_HARF[(idx + kayma % n + n) % n];
      return c === c.toLocaleUpperCase('tr-TR') ? yeni.toLocaleUpperCase('tr-TR') : yeni;
    });
  }

  function vigenere(s, anahtar, coz) {
    if (!anahtar) return null;
    var a = anahtar.toLowerCase().replace(/[^a-z]/g, '');
    if (!a.length) return null;
    var ki = 0;
    return s.replace(/[a-z]/gi, function (c) {
      var t = c <= 'Z' ? 65 : 97;
      var k = a.charCodeAt(ki % a.length) - 97;
      ki++;
      var yon = coz ? -k : k;
      return String.fromCharCode((c.charCodeAt(0) - t + yon + 26) % 26 + t);
    });
  }

  function xorBayt(s, anahtar) {
    var out = [];
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) ^ anahtar);
    return utf8Coz(out);
  }

  var MORS = {
    '.-': 'a', '-...': 'b', '-.-.': 'c', '-..': 'd', '.': 'e', '..-.': 'f',
    '--.': 'g', '....': 'h', '..': 'i', '.---': 'j', '-.-': 'k', '.-..': 'l',
    '--': 'm', '-.': 'n', '---': 'o', '.--.': 'p', '--.-': 'q', '.-.': 'r',
    '...': 's', '-': 't', '..-': 'u', '...-': 'v', '.--': 'w', '-..-': 'x',
    '-.--': 'y', '--..': 'z', '-----': '0', '.----': '1', '..---': '2',
    '...--': '3', '....-': '4', '.....': '5', '-....': '6', '--...': '7',
    '---..': '8', '----.': '9'
  };
  function morsCoz(s) {
    if (!/^[.\-\s/|]+$/.test(s.trim()) || !/[.\-]/.test(s)) return null;
    var kelimeler = s.trim().split(/\s*[/|]\s*|\s{2,}/);
    var cikti = kelimeler.map(function (kel) {
      return kel.trim().split(/\s+/).map(function (h) { return MORS[h] || ''; }).join('');
    }).join(' ').trim();
    return cikti || null;
  }

  function a1z26Coz(s) {
    var parcalar = s.trim().split(/[\s,.\-]+/).filter(Boolean);
    if (parcalar.length < 1 || !parcalar.every(function (p) { return /^\d{1,2}$/.test(p); })) return null;
    var nums = parcalar.map(Number);
    if (!nums.every(function (n) { return n >= 1 && n <= 26; })) return null;
    return nums.map(function (n) { return EN_HARF[n - 1]; }).join('');
  }

  function tersCevir(s) { return s.split('').reverse().join(''); }

  // ------------------------------------------------------- TOPLAYICI
  /** Tum yontemleri dener; {ad, sonuc, skor} listesi dondurur. */
  function hepsiniDene(metin) {
    var adaylar = [];
    function ekle(ad, sonuc) {
      if (sonuc && typeof sonuc === 'string' && sonuc !== metin && sonuc.trim()) {
        adaylar.push({ ad: ad, sonuc: sonuc, skor: skor(sonuc) });
      }
    }

    ekle('Base64', base64Coz(metin));
    ekle('Base32', base32Coz(metin));
    ekle('Onaltılık (Hex)', hexCoz(metin));
    ekle('İkilik (Binary)', ikilikCoz(metin));
    ekle('Ondalık ASCII', ondalikCoz(metin));
    ekle('Sekizlik ASCII', sekizlikCoz(metin));
    ekle('URL çözme', urlCoz(metin));
    ekle('HTML varlık', htmlCoz(metin));
    ekle('ROT13', rot13(metin));
    ekle('ROT47', rot47(metin));
    ekle('Atbash', atbash(metin));
    ekle('Mors kodu', morsCoz(metin));
    ekle('A1Z26', a1z26Coz(metin));
    ekle('Ters çevirme', tersCevir(metin));

    // Sezar: en iyi 3 kayma (Latin)
    var sezarlar = [];
    for (var k = 1; k < 26; k++) {
      var c = sezar(metin, k);
      sezarlar.push({ ad: 'Sezar (kayma ' + k + ')', sonuc: c, skor: skor(c) });
    }
    sezarlar.sort(function (a, b) { return b.skor - a.skor; });
    for (var si = 0; si < 3; si++) if (sezarlar[si]) adaylar.push(sezarlar[si]);

    // Sezar Turkce alfabe: en iyi 2
    var sezarTr = [];
    for (var kt = 1; kt < TR_HARF.length; kt++) {
      var ct = sezarTurkce(metin, kt);
      if (ct !== metin) sezarTr.push({ ad: 'Sezar TR (kayma ' + kt + ')', sonuc: ct, skor: skor(ct) });
    }
    sezarTr.sort(function (a, b) { return b.skor - a.skor; });
    for (var sti = 0; sti < 2; sti++) if (sezarTr[sti]) adaylar.push(sezarTr[sti]);

    // Tek-bayt XOR: en iyi 2
    var xorlar = [];
    for (var x = 1; x < 256; x++) {
      var cx = xorBayt(metin, x);
      if (yazdirilabilirOran(cx) > 0.9) xorlar.push({ ad: 'XOR (anahtar ' + x + ' / 0x' + x.toString(16) + ')', sonuc: cx, skor: skor(cx) });
    }
    xorlar.sort(function (a, b) { return b.skor - a.skor; });
    for (var xi = 0; xi < 2; xi++) if (xorlar[xi]) adaylar.push(xorlar[xi]);

    // Tekrarlari ele, skora gore sirala
    var gorulen = {};
    adaylar = adaylar.filter(function (a) {
      if (gorulen[a.sonuc]) return false;
      gorulen[a.sonuc] = true;
      return true;
    });
    adaylar.sort(function (a, b) { return b.skor - a.skor; });
    return adaylar;
  }

  // ------------------------------------------------------- ARAYUZ
  function kacir(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function guvenBandi(s) {
    var yuzde = Math.max(0, Math.min(100, Math.round(s)));
    var seviye = yuzde >= 55 ? 'iyi' : yuzde >= 30 ? 'orta' : 'zayif';
    return '<span class="sk-guven" data-seviye="' + seviye + '"><i style="width:' + yuzde + '%"></i></span>';
  }

  function kartlariYaz(adaylar, baslik) {
    if (!adaylar.length) {
      sonucEl.innerHTML = '<div class="bos-durum"><span class="bos-durum-im" aria-hidden="true">⊘</span>'
        + '<p>Bilinen bir kodlama/şifre kalıbı bulunamadı. Metni kontrol et ya da elle bir yöntem seç. '
        + '(Modern güçlü şifreleme — AES, bcrypt, SHA — anahtarsız geri çevrilemez.)</p></div>';
      if (ozetEl) ozetEl.textContent = '0 aday';
      return;
    }
    if (ozetEl) ozetEl.textContent = adaylar.length + ' aday' + (baslik ? ' · ' + baslik : '');
    sonucEl.innerHTML = adaylar.map(function (a, i) {
      return '<div class="sk-kart' + (i === 0 ? ' sk-kart--ust' : '') + '">'
        + '<div class="sk-kart-bas">'
        + '<span class="sk-yontem">' + kacir(a.ad) + '</span>'
        + (i === 0 ? '<span class="sk-rozet">EN OLASI</span>' : '')
        + guvenBandi(a.skor)
        + '<button type="button" class="sk-kopyala" data-kopya="' + i + '" title="Kopyala">⧉</button>'
        + '</div>'
        + '<pre class="sk-cikti" data-metin="' + i + '">' + kacir(a.sonuc) + '</pre>'
        + '</div>';
    }).join('');
    // kopyalama icin sonuclari sakla
    sonucEl._adaylar = adaylar;
  }

  // ------------------------------------------------------- OLAYLAR
  var btnOto = document.getElementById('sk-otomatik');
  var btnTum = document.getElementById('sk-tumu');
  var btnTemizle = document.getElementById('sk-temizle');
  var yontemSec = document.getElementById('sk-yontem');
  var anahtarEl = document.getElementById('sk-anahtar');
  var anahtarSarmal = document.getElementById('sk-anahtar-sarmal');
  var yonSec = document.getElementById('sk-yon');
  var btnUygula = document.getElementById('sk-uygula');

  function girdi() { return girdiEl.value || ''; }

  if (btnOto) btnOto.addEventListener('click', function () {
    var g = girdi().trim();
    if (!g) { kartlariYaz([]); return; }
    kartlariYaz(hepsiniDene(g).slice(0, 10), 'otomatik');
  });

  if (btnTum) btnTum.addEventListener('click', function () {
    var g = girdi().trim();
    if (!g) { kartlariYaz([]); return; }
    kartlariYaz(hepsiniDene(g), 'tüm yöntemler');
  });

  if (btnTemizle) btnTemizle.addEventListener('click', function () {
    girdiEl.value = '';
    sonucEl.innerHTML = '';
    if (ozetEl) ozetEl.textContent = '';
    girdiEl.focus();
  });

  // Elle yontem: anahtar alani gerektiren yontemlerde goster
  var ANAHTARLI = { vigenere: 'anahtar kelime', xor: 'anahtar (0-255 ya da 0x..)', sezar: 'kayma sayısı', sezar_tr: 'kayma sayısı' };
  function anahtarGorunur() {
    if (!yontemSec || !anahtarSarmal) return;
    var y = yontemSec.value;
    if (ANAHTARLI[y]) { anahtarSarmal.hidden = false; anahtarEl.placeholder = ANAHTARLI[y]; }
    else { anahtarSarmal.hidden = true; }
  }
  if (yontemSec) { yontemSec.addEventListener('change', anahtarGorunur); anahtarGorunur(); }

  function elleUygula() {
    var g = girdi();
    if (!g.trim()) { kartlariYaz([]); return; }
    var y = yontemSec ? yontemSec.value : 'base64';
    var coz = !yonSec || yonSec.value === 'coz';
    var anahtar = anahtarEl ? anahtarEl.value.trim() : '';
    var sonuc = null, ad = yontemSec.options[yontemSec.selectedIndex].text;

    switch (y) {
      case 'base64': sonuc = coz ? base64Coz(g) : btoa(unescape(encodeURIComponent(g))); break;
      case 'base32': sonuc = coz ? base32Coz(g) : base32Kodla(g); break;
      case 'hex': sonuc = coz ? hexCoz(g) : hexKodla(g); break;
      case 'ikilik': sonuc = coz ? ikilikCoz(g) : ikilikKodla(g); break;
      case 'url': sonuc = coz ? (urlCoz(g) || g) : encodeURIComponent(g); break;
      case 'html': sonuc = coz ? (htmlCoz(g) || g) : g.replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); break;
      case 'rot13': sonuc = rot13(g); break;
      case 'rot47': sonuc = rot47(g); break;
      case 'atbash': sonuc = atbash(g); break;
      case 'mors': sonuc = coz ? morsCoz(g) : morsKodla(g); break;
      case 'a1z26': sonuc = a1z26Coz(g); break;
      case 'ters': sonuc = tersCevir(g); break;
      case 'sezar': sonuc = sezar(g, (coz ? -1 : 1) * (parseInt(anahtar, 10) || 3)); break;
      case 'sezar_tr': sonuc = sezarTurkce(g, (coz ? -1 : 1) * (parseInt(anahtar, 10) || 3)); break;
      case 'vigenere': sonuc = vigenere(g, anahtar, coz); break;
      case 'xor': sonuc = xorBayt(g, anahtar.indexOf('0x') === 0 ? parseInt(anahtar, 16) : (parseInt(anahtar, 10) || 0)); break;
      default: sonuc = null;
    }
    if (sonuc === null || sonuc === undefined) {
      kartlariYaz([]);
      if (ozetEl) ozetEl.textContent = ad + ': uygulanamadı';
      return;
    }
    kartlariYaz([{ ad: ad + (coz ? '' : ' (kodlama)'), sonuc: String(sonuc), skor: skor(String(sonuc)) }], 'elle');
  }
  if (btnUygula) btnUygula.addEventListener('click', elleUygula);

  // Kodlama yardimcilari (elle "kodla" yonu icin)
  function hexKodla(s) {
    var b = unescape(encodeURIComponent(s)), o = '';
    for (var i = 0; i < b.length; i++) o += b.charCodeAt(i).toString(16).padStart(2, '0');
    return o;
  }
  function ikilikKodla(s) {
    var b = unescape(encodeURIComponent(s)), o = [];
    for (var i = 0; i < b.length; i++) o.push(b.charCodeAt(i).toString(2).padStart(8, '0'));
    return o.join(' ');
  }
  function base32Kodla(s) {
    var alfabe = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    var b = unescape(encodeURIComponent(s)), bit = 0, deger = 0, o = '';
    for (var i = 0; i < b.length; i++) {
      deger = (deger << 8) | b.charCodeAt(i); bit += 8;
      while (bit >= 5) { bit -= 5; o += alfabe[(deger >> bit) & 31]; }
    }
    if (bit > 0) o += alfabe[(deger << (5 - bit)) & 31];
    while (o.length % 8 !== 0) o += '=';
    return o;
  }
  var MORS_TERS = {};
  Object.keys(MORS).forEach(function (k) { MORS_TERS[MORS[k]] = k; });
  function morsKodla(s) {
    return s.toLowerCase().split('').map(function (c) {
      if (c === ' ') return '/';
      return MORS_TERS[c] || '';
    }).filter(Boolean).join(' ');
  }

  // Kopyalama (delege)
  if (sonucEl) sonucEl.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-kopya]') : null;
    if (!b) return;
    var i = Number(b.getAttribute('data-kopya'));
    var aday = sonucEl._adaylar && sonucEl._adaylar[i];
    if (!aday) return;
    var yaz = function (ok) { b.textContent = ok ? '✓' : '⧉'; setTimeout(function () { b.textContent = '⧉'; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(aday.sonuc).then(function () { yaz(true); }, function () { yaz(false); });
    } else {
      try {
        var ta = document.createElement('textarea'); ta.value = aday.sonuc;
        document.body.appendChild(ta); ta.select(); document.execCommand('copy');
        document.body.removeChild(ta); yaz(true);
      } catch (_) { yaz(false); }
    }
  });

  // Ctrl+Enter -> otomatik kır
  girdiEl.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (btnOto) btnOto.click(); }
  });
})();
