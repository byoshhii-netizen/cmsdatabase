'use strict';
/**
 * public/js/komut.js
 * Komut paleti (Ctrl+K / Cmd+K). Uc isi bir arada yapar:
 *   1. Gezinti   — sayfa adlarinda bulanik arama
 *   2. Arsiv     — /arsiv/api/varlik-ara ile canli varlik arama
 *   3. Soru      — "?" ile baslayan ya da soru gibi gorunen metni dogrudan
 *                  cekirdek zekaya gonderir ve cevabi palette gosterir
 *
 * Veri data-* niteliginden okunur; satir ici betik yoktur (siki CSP).
 */
(function () {
  const ortu = document.getElementById('komut-ortu');
  const girdi = document.getElementById('komut-girdi');
  const liste = document.getElementById('komut-liste');
  const veriDugum = document.getElementById('komut-verisi');
  if (!ortu || !girdi || !liste || !veriDugum) return;

  function jsonOku(ad, varsayilan) {
    try { return JSON.parse(veriDugum.getAttribute(ad) || 'null') || varsayilan; }
    catch (hata) { return varsayilan; }
  }

  const KOMUTLAR = jsonOku('data-komutlar', []);
  const ORNEKLER = jsonOku('data-ornekler', []);

  let sonuclar = [];
  let secili = 0;
  let aramaZaman = null;
  let sorguSayaci = 0;

  // ------------------------------------------------------- TURKCE NORMALIZE
  function normalize(m) {
    const kaynak = 'ÇĞİIÖŞÜçğıiöşüÂÎÛâîû';
    const hedef = 'cgiiosucgiiosuaiuaiu';
    let s = String(m == null ? '' : m);
    let c = '';
    for (let i = 0; i < s.length; i += 1) {
      const j = kaynak.indexOf(s[i]);
      c += j >= 0 ? hedef[j] : s[i].toLowerCase();
    }
    return c;
  }

  /** Harfleri sirayla iceriyor mu (bulanik eslesme) + puan. */
  function bulanik(aday, sorgu) {
    const a = normalize(aday);
    const s = normalize(sorgu);
    if (!s) return 1;
    if (a.indexOf(s) === 0) return 1000;
    const yer = a.indexOf(s);
    if (yer > 0) return 500 - yer;

    let i = 0;
    let puan = 0;
    let oncekiYer = -1;
    for (let k = 0; k < a.length && i < s.length; k += 1) {
      if (a[k] === s[i]) {
        puan += oncekiYer === k - 1 ? 6 : 2;
        oncekiYer = k;
        i += 1;
      }
    }
    return i === s.length ? puan : 0;
  }

  // ------------------------------------------------------------------- CIZIM
  function ogeYap(s, i) {
    const li = document.createElement('li');
    li.className = 'komut-oge';
    li.setAttribute('role', 'option');
    li.setAttribute('data-secili', i === secili ? '1' : '0');

    const im = document.createElement('span');
    im.className = 'komut-oge-im';
    im.setAttribute('aria-hidden', 'true');
    im.textContent = s.im || '›';

    const ad = document.createElement('span');
    ad.className = 'komut-oge-ad';
    ad.textContent = s.ad;
    if (s.alt) {
      const alt = document.createElement('span');
      alt.className = 'satir-alt';
      alt.textContent = s.alt;
      ad.appendChild(alt);
    }

    const tur = document.createElement('span');
    tur.className = 'komut-oge-tur';
    tur.textContent = s.tur || '';

    li.appendChild(im);
    li.appendChild(ad);
    li.appendChild(tur);
    li.addEventListener('mousedown', function (olay) { olay.preventDefault(); uygula(i); });
    return li;
  }

  function ciz() {
    liste.textContent = '';
    if (!sonuclar.length) {
      const bos = document.createElement('li');
      bos.className = 'komut-oge';
      bos.textContent = 'Sonuc yok. "?" ile baslayan bir soru yazarsan cekirdek zekaya sorarim.';
      liste.appendChild(bos);
      return;
    }
    sonuclar.forEach(function (s, i) { liste.appendChild(ogeYap(s, i)); });

    const etkin = liste.children[secili];
    if (etkin && etkin.scrollIntoView) etkin.scrollIntoView({ block: 'nearest' });
  }

  // ----------------------------------------------------------------- UYGULA
  function uygula(i) {
    const s = sonuclar[i];
    if (!s) return;
    if (s.islev) { s.islev(); return; }
    if (s.yol) { window.location.href = s.yol; }
  }

  // ------------------------------------------------------------------- ARAMA
  function soruMu(metin) {
    if (metin.startsWith('?')) return true;
    const n = normalize(metin);
    return /\b(ne|neden|nasil|kim|kime|kimin|kimle|nerede|nereye|hangi|kac|mi|mu|var mi)\b/.test(n)
      || metin.trim().endsWith('?');
  }

  async function sorSor(soru) {
    const benimSayim = sorguSayaci;
    sonuclar = [{ im: '◌', ad: 'Cekirdek zeka dusunuyor…', tur: 'motor' }];
    ciz();

    try {
      const yanit = await fetch('/analiz/api/sor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-CSRF-Token': document.body.getAttribute('data-csrf') || '',
        },
        body: JSON.stringify({ soru }),
      });
      if (benimSayim !== sorguSayaci) return;

      const veri = await yanit.json();
      if (!veri.tamam) {
        sonuclar = [{ im: '△', ad: veri.hata || 'Motor yanit vermedi.', tur: 'hata' }];
        ciz();
        return;
      }

      const yeni = [];
      const satirlar = String(veri.cevap || '').split('\n')
        .map(function (s) { return s.replace(/^[-•>#\s]+/, '').replace(/\*\*/g, '').trim(); })
        .filter(Boolean);

      satirlar.slice(0, 7).forEach(function (satir, i) {
        yeni.push({
          im: i === 0 ? '◉' : '·',
          ad: satir.length > 160 ? satir.slice(0, 159) + '…' : satir,
          tur: i === 0 ? (veri.niyet || 'cevap').replace(/_/g, ' ') : '',
          islev: function () { window.location.href = '/cambaz'; },
        });
      });

      (veri.bulgular || []).slice(0, 5).forEach(function (b) {
        yeni.push({ im: '▤', ad: b.baslik, alt: b.alinti ? String(b.alinti).slice(0, 110) : '', tur: b.etiket, yol: b.yol });
      });

      (veri.eylemler || []).slice(0, 4).forEach(function (e) {
        yeni.push({ im: '→', ad: e.etiket, tur: 'eylem', yol: e.yol });
      });

      yeni.push({ im: '◉', ad: 'Cambaz\'da tam cevabi ac', tur: 'motor', yol: '/cambaz' });

      sonuclar = yeni;
      secili = 0;
      ciz();
    } catch (hata) {
      if (benimSayim !== sorguSayaci) return;
      sonuclar = [{ im: '△', ad: 'Motora ulasilamadi: ' + hata.message, tur: 'hata' }];
      ciz();
    }
  }

  async function varlikAra(metin) {
    try {
      const yanit = await fetch('/arsiv/api/varlik-ara?q=' + encodeURIComponent(metin), {
        headers: { Accept: 'application/json' },
      });
      if (!yanit.ok) return [];
      const veri = await yanit.json();
      return (veri.varliklar || []).slice(0, 8).map(function (v) {
        return {
          im: '◆',
          ad: v.ad,
          alt: (v.kod || '') + (v.tur ? ' · ' + v.tur : ''),
          tur: 'varlik',
          yol: '/arsiv/varlik/' + v.id,
        };
      });
    } catch (hata) { return []; }
  }

  function yerelSonuclar(metin) {
    if (!metin) {
      const bas = KOMUTLAR.slice(0, 9).map(function (k) { return Object.assign({}, k); });
      ORNEKLER.slice(0, 5).forEach(function (o) {
        bas.push({
          im: '◉', ad: o, tur: 'soru',
          islev: function () { girdi.value = '?' + o; girdiDegisti(); },
        });
      });
      return bas;
    }

    return KOMUTLAR
      .map(function (k) { return { k: k, p: bulanik(k.ad, metin) }; })
      .filter(function (o) { return o.p > 0; })
      .sort(function (a, b) { return b.p - a.p; })
      .slice(0, 8)
      .map(function (o) { return Object.assign({}, o.k); });
  }

  function girdiDegisti() {
    const ham = girdi.value;
    const metin = ham.trim();
    sorguSayaci += 1;
    clearTimeout(aramaZaman);

    if (metin.startsWith('?')) {
      const soru = metin.slice(1).trim();
      if (soru.length < 3) {
        sonuclar = [{ im: '◉', ad: 'Sorunu yaz, Enter\'a bas: motor arsivi tarayip cevaplayacak.', tur: 'motor' }];
        secili = 0;
        ciz();
        return;
      }
      sonuclar = [{
        im: '◉', ad: 'Sor: ' + soru, tur: 'enter ile sor',
        islev: function () { sorSor(soru); },
      }];
      secili = 0;
      ciz();
      return;
    }

    sonuclar = yerelSonuclar(metin);
    secili = 0;
    ciz();

    if (metin.length >= 2) {
      const benimSayim = sorguSayaci;
      aramaZaman = setTimeout(async function () {
        const varliklar = await varlikAra(metin);
        if (benimSayim !== sorguSayaci || !varliklar.length) return;
        sonuclar = sonuclar.concat(varliklar);
        if (soruMu(metin)) {
          sonuclar.push({
            im: '◉', ad: 'Bunu cekirdek zekaya sor: "' + metin + '"', tur: 'motor',
            islev: function () { sorSor(metin); },
          });
        }
        ciz();
      }, 200);
    }
  }

  // ------------------------------------------------------------- AC / KAPAT
  function ac() {
    ortu.setAttribute('data-acik', '1');
    girdi.value = '';
    girdiDegisti();
    girdi.focus();
    document.body.classList.add('komut-acik');
  }

  function kapat() {
    ortu.setAttribute('data-acik', '0');
    document.body.classList.remove('komut-acik');
    sorguSayaci += 1;
  }

  girdi.addEventListener('input', girdiDegisti);

  girdi.addEventListener('keydown', function (olay) {
    if (olay.key === 'ArrowDown') {
      secili = Math.min(sonuclar.length - 1, secili + 1); ciz(); olay.preventDefault();
    } else if (olay.key === 'ArrowUp') {
      secili = Math.max(0, secili - 1); ciz(); olay.preventDefault();
    } else if (olay.key === 'Enter') {
      uygula(secili); olay.preventDefault();
    } else if (olay.key === 'Escape') {
      kapat(); olay.preventDefault();
    }
  });

  ortu.addEventListener('mousedown', function (olay) {
    if (olay.target === ortu) kapat();
  });

  document.addEventListener('keydown', function (olay) {
    const kisayol = (olay.ctrlKey || olay.metaKey) && (olay.key === 'k' || olay.key === 'K');
    if (kisayol) {
      olay.preventDefault();
      if (ortu.getAttribute('data-acik') === '1') kapat(); else ac();
      return;
    }
    if (olay.key === 'Escape' && ortu.getAttribute('data-acik') === '1') kapat();

    // "/" ile hizli acilis: bir girdi alaninda degilsen
    if (olay.key === '/' && ortu.getAttribute('data-acik') !== '1') {
      const hedef = olay.target;
      const yaziyor = hedef && (hedef.tagName === 'INPUT' || hedef.tagName === 'TEXTAREA' || hedef.isContentEditable);
      if (!yaziyor) { olay.preventDefault(); ac(); }
    }
  });

  document.addEventListener('click', function (olay) {
    const tetik = olay.target.closest ? olay.target.closest('[data-komut-ac]') : null;
    if (tetik) { olay.preventDefault(); ac(); }
  });

  window.KOMUT = { ac, kapat };
})();
