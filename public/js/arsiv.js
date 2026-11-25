'use strict';
/**
 * public/js/arsiv.js
 * Arsiv formlarinin yardimcilari:
 *  - .varlik-arama  : /arsiv/api/varlik-ara ile otomatik tamamlama
 *  - [data-dosye-sekme] : dosye sekmeleri (hud.js ile ayni sozlesme)
 *  - [data-derece-secim]: kaynak derecesi secildiginde aciklamayi gosterir
 */
(function () {
  const ADMIRALTY_GUVENILIRLIK = {
    A: 'Tamamen guvenilir — gecmiste hic yanilmadi, dogrulugu kanitli.',
    B: 'Genellikle guvenilir — cogu bilgisi dogru cikti, kucuk sapmalar oldu.',
    C: 'Oldukca guvenilir — bazi bilgileri dogrulandi.',
    D: 'Genellikle guvenilmez — gecmiste cok hata yapti.',
    E: 'Guvenilmez — bilgisi tutarli bicimde yanlis cikti.',
    F: 'Degerlendirilemez — kaynak hakkinda yeterli gecmis yok.',
  };

  const ADMIRALTY_DOGRULUK = {
    1: 'Dogrulandi — bagimsiz baska kaynaklarca teyit edildi.',
    2: 'Muhtemelen dogru — mantikli ve bilinenlerle uyumlu.',
    3: 'Belki dogru — makul ama teyit edilmedi.',
    4: 'Kuskulu — bilinen bilgilerle celisiyor.',
    5: 'Olasi degil — bilinenlerle acikca celisiyor.',
    6: 'Degerlendirilemez — dogrulamak icin dayanak yok.',
  };

  function csrf() {
    return document.body.getAttribute('data-csrf') || '';
  }

  // ------------------------------------------------- VARLIK OTOMATIK TAMAMLAMA
  function varlikAramaKur(kap) {
    kap.querySelectorAll('.varlik-arama').forEach(function (sarmal) {
      if (sarmal.dataset.kurulu === '1') return;
      sarmal.dataset.kurulu = '1';

      const girdi = sarmal.querySelector('input[type="text"], input[type="search"]');
      if (!girdi) return;
      const kimlikAlani = sarmal.querySelector('input[type="hidden"]');

      let liste = sarmal.querySelector('.varlik-oneri');
      if (!liste) {
        liste = document.createElement('ul');
        liste.className = 'varlik-oneri';
        liste.setAttribute('role', 'listbox');
        sarmal.appendChild(liste);
      }

      let zamanlayici = null;
      let sonuclar = [];
      let secili = -1;
      let sonSorgu = '';

      function kapat() {
        liste.hidden = true;
        liste.textContent = '';
        secili = -1;
      }

      function sec(i) {
        const s = sonuclar[i];
        if (!s) return;
        girdi.value = s.ad;
        if (kimlikAlani) kimlikAlani.value = s.id;
        girdi.dispatchEvent(new Event('change', { bubbles: true }));
        kapat();
      }

      function ciz() {
        liste.textContent = '';
        if (!sonuclar.length) {
          const bos = document.createElement('li');
          bos.className = 'varlik-oneri-bos';
          bos.textContent = sonSorgu.length < 2
            ? 'En az iki harf yaz.'
            : '"' + sonSorgu + '" icin arsivde kayit yok.';
          liste.appendChild(bos);
          liste.hidden = false;
          return;
        }

        sonuclar.forEach(function (s, i) {
          const oge = document.createElement('li');
          oge.setAttribute('role', 'option');
          oge.setAttribute('data-secili', i === secili ? '1' : '0');

          const ad = document.createElement('span');
          ad.className = 'varlik-oneri-ad';
          ad.textContent = s.ad + (s.kod ? '  (' + s.kod + ')' : '');

          const tur = document.createElement('span');
          tur.className = 'varlik-oneri-tur';
          tur.textContent = s.tur || '';

          oge.appendChild(ad);
          oge.appendChild(tur);
          oge.addEventListener('mousedown', function (olay) { olay.preventDefault(); sec(i); });
          liste.appendChild(oge);
        });
        liste.hidden = false;
      }

      async function ara(metin) {
        sonSorgu = metin;
        if (metin.length < 2) { sonuclar = []; ciz(); return; }
        try {
          const yanit = await fetch('/arsiv/api/varlik-ara?q=' + encodeURIComponent(metin), {
            headers: { Accept: 'application/json', 'X-Requested-With': 'fetch' },
          });
          if (!yanit.ok) { sonuclar = []; ciz(); return; }
          const veri = await yanit.json();
          sonuclar = (veri.varliklar || veri.sonuclar || []).slice(0, 12);
          secili = sonuclar.length ? 0 : -1;
          ciz();
        } catch (hata) { sonuclar = []; ciz(); }
      }

      girdi.setAttribute('autocomplete', 'off');
      girdi.setAttribute('role', 'combobox');
      girdi.setAttribute('aria-expanded', 'false');

      girdi.addEventListener('input', function () {
        if (kimlikAlani) kimlikAlani.value = '';
        clearTimeout(zamanlayici);
        const metin = girdi.value.trim();
        zamanlayici = setTimeout(function () { ara(metin); }, 180);
      });

      girdi.addEventListener('keydown', function (olay) {
        if (liste.hidden) return;
        if (olay.key === 'ArrowDown') {
          secili = Math.min(sonuclar.length - 1, secili + 1); ciz(); olay.preventDefault();
        } else if (olay.key === 'ArrowUp') {
          secili = Math.max(0, secili - 1); ciz(); olay.preventDefault();
        } else if (olay.key === 'Enter' && secili >= 0) {
          sec(secili); olay.preventDefault();
        } else if (olay.key === 'Escape') {
          kapat();
        }
      });

      girdi.addEventListener('blur', function () { setTimeout(kapat, 120); });
      kapat();
    });
  }

  // ------------------------------------------------ DERECE ACIKLAMA YARDIMCISI
  function dereceAciklamaKur(kap) {
    kap.querySelectorAll('[data-derece-secim]').forEach(function (secim) {
      const tur = secim.getAttribute('data-derece-secim'); // 'guvenilirlik' | 'dogruluk'
      const hedefAd = secim.getAttribute('data-derece-hedef');
      const hedef = hedefAd ? document.getElementById(hedefAd) : secim.parentElement.querySelector('.ipucu');
      if (!hedef) return;

      function guncelle() {
        const sozluk = tur === 'dogruluk' ? ADMIRALTY_DOGRULUK : ADMIRALTY_GUVENILIRLIK;
        hedef.textContent = sozluk[secim.value] || '';
      }
      secim.addEventListener('change', guncelle);
      guncelle();
    });
  }

  // --------------------------------------- COKLU SECIM: TUMUNU SEC / TEMIZLE
  function toplulukSecimKur(kap) {
    kap.querySelectorAll('[data-tumunu-sec]').forEach(function (dugme) {
      dugme.addEventListener('click', function () {
        const kapsam = dugme.closest('form') || document;
        const kutular = kapsam.querySelectorAll('input[type="checkbox"][name="secim"]');
        const hepsiSecili = Array.prototype.every.call(kutular, function (k) { return k.checked; });
        kutular.forEach(function (k) { k.checked = !hepsiSecili; });
        dugme.textContent = hepsiSecili ? 'TUMUNU SEC' : 'SECIMI TEMIZLE';
      });
    });
  }

  // ------------------------------------------- IZLEME KURALI ONIZLEMESI
  function kuralOnizleKur(kap) {
    const alan = kap.querySelector('[data-kural-onizleme]');
    if (!alan) return;
    const desenGirdi = document.getElementById('kural-desen');
    const turSecim = document.getElementById('kural-tur');
    if (!desenGirdi || !turSecim) return;

    function guncelle() {
      const desen = desenGirdi.value.trim();
      const tur = turSecim.value;
      if (!desen) { alan.textContent = 'Desen gir: ne zaman uyari uretilecegini burada gosterecegim.'; return; }

      if (tur === 'duzenli_ifade') {
        try {
          new RegExp(desen, 'iu');
          alan.textContent = 'Gecerli duzenli ifade. Kayit ya da olay metni bu kalibi icerirse uyari uretilir.';
          alan.classList.remove('kirmizi-metin');
        } catch (hata) {
          alan.textContent = 'Gecersiz duzenli ifade: ' + hata.message;
          alan.classList.add('kirmizi-metin');
        }
        return;
      }
      alan.classList.remove('kirmizi-metin');
      if (tur === 'anahtar_kelime') {
        const sozcukler = desen.split(/[,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
        alan.textContent = sozcukler.length > 1
          ? sozcukler.length + ' anahtar sozcukten biri gectiginde uyari uretilir: ' + sozcukler.join(' / ')
          : '"' + desen + '" sozcugu (ek almis bicimleri dahil) gectiginde uyari uretilir.';
      } else {
        alan.textContent = 'Secilen varlik bir kayda, olaya ya da vakaya baglandiginda uyari uretilir.';
      }
    }

    desenGirdi.addEventListener('input', guncelle);
    turSecim.addEventListener('change', guncelle);
    guncelle();
  }

  document.addEventListener('DOMContentLoaded', function () {
    varlikAramaKur(document);
    dereceAciklamaKur(document);
    toplulukSecimKur(document);
    kuralOnizleKur(document);
  });

  window.ARSIV = { varlikAramaKur, csrf };
})();
