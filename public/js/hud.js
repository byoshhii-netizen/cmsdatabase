'use strict';
/**
 * public/js/hud.js
 * Istihbarat arayuzunun ortak istemci davranislari. Hicbir satir inline
 * degildir; tum veri sunucudan data-* niteligiyle gelir (katı CSP uyumlu).
 *
 *   data-genislik  -> yuzdeyi geniseltilen cubuk
 *   data-oran      -> olcer dolgusu
 *   data-puan      -> tehdit kadrani (yay cizimi)
 *   data-seri      -> zaman serisi grafigi (kayit/olay)
 *   data-sekme     -> sekme dugmesi + [data-sekme-govde]
 *   data-onay      -> gonderim oncesi onay
 *   data-sayac     -> sayi animasyonu
 *   data-kopya     -> panoya kopyalama
 */
(function () {
  const HAREKET_AZ = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** data-* niteliginden JSON cozer; bozuksa null doner. */
  function jsonNitelik(dugum, ad) {
    const ham = dugum.getAttribute(ad);
    if (!ham) return null;
    try { return JSON.parse(ham); } catch (hata) { return null; }
  }

  function tema() {
    const g = getComputedStyle(document.body);
    return {
      vurgu: (g.getPropertyValue('--vurgu') || '#00ff9c').trim(),
      vurguKoyu: (g.getPropertyValue('--vurgu-koyu') || '#0b6b45').trim(),
      kehribar: (g.getPropertyValue('--kehribar') || '#f0b429').trim(),
      kirmizi: (g.getPropertyValue('--kirmizi') || '#ff4d5e').trim(),
      camgobegi: (g.getPropertyValue('--camgobegi') || '#22d3ee').trim(),
      cizgi: (g.getPropertyValue('--cizgi') || 'rgba(255,255,255,.08)').trim(),
      sonuk: (g.getPropertyValue('--metin-sonuk') || '#6b7f8a').trim(),
      metin: (g.getPropertyValue('--metin') || '#9fb4bf').trim(),
    };
  }

  /** Yuksek cozunurluklu tuval hazirlar; gercek piksel olcegini dondurur. */
  function tuvalHazirla(tuval) {
    const o = window.devicePixelRatio || 1;
    const dik = tuval.getBoundingClientRect();
    if (dik.width < 2 || dik.height < 2) return null;
    tuval.width = Math.round(dik.width * o);
    tuval.height = Math.round(dik.height * o);
    const ciz = tuval.getContext('2d');
    ciz.setTransform(o, 0, 0, o, 0, 0);
    return { ciz, g: dik.width, y: dik.height };
  }

  // ------------------------------------------------------------- 1. CUBUKLAR
  function cubuklariDoldur(kap) {
    kap.querySelectorAll('[data-genislik]').forEach(function (i) {
      const yuzde = Math.max(0, Math.min(100, Number(i.getAttribute('data-genislik')) || 0));
      if (HAREKET_AZ) { i.style.width = yuzde + '%'; return; }
      i.style.width = '0%';
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { i.style.width = yuzde + '%'; });
      });
    });

    kap.querySelectorAll('[data-oran]').forEach(function (i) {
      const yuzde = Math.max(0, Math.min(100, Number(i.getAttribute('data-oran')) || 0));
      if (HAREKET_AZ) { i.style.width = yuzde + '%'; return; }
      i.style.width = '0%';
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { i.style.width = yuzde + '%'; });
      });
    });
  }

  // ------------------------------------------------------- 2. TEHDIT KADRANI
  function kadranCiz(kap) {
    const puan = Math.max(0, Math.min(100, Number(kap.getAttribute('data-puan')) || 0));
    let tuval = kap.querySelector('canvas');
    if (!tuval) {
      tuval = document.createElement('canvas');
      tuval.setAttribute('aria-hidden', 'true');
      kap.insertBefore(tuval, kap.firstChild);
    }
    const h = tuvalHazirla(tuval);
    if (!h) return;
    const { ciz, g, y } = h;
    const t = tema();

    const mx = g / 2;
    const my = y * 0.92;
    const r = Math.min(g / 2, y * 0.88) - 14;
    const bas = Math.PI * 0.84;
    const bit = Math.PI * 2.16;

    ciz.clearRect(0, 0, g, y);

    // Arka yay
    ciz.lineWidth = 11;
    ciz.lineCap = 'butt';
    ciz.strokeStyle = t.cizgi;
    ciz.beginPath();
    ciz.arc(mx, my, r, bas, bit);
    ciz.stroke();

    // Bolge isaretleri: yesil / kehribar / kirmizi
    const bolgeler = [[0, 40, t.vurgu], [40, 70, t.kehribar], [70, 100, t.kirmizi]];
    ciz.lineWidth = 3;
    bolgeler.forEach(function (b) {
      ciz.strokeStyle = b[2];
      ciz.globalAlpha = 0.28;
      ciz.beginPath();
      ciz.arc(mx, my, r + 10, bas + (bit - bas) * (b[0] / 100), bas + (bit - bas) * (b[1] / 100));
      ciz.stroke();
    });
    ciz.globalAlpha = 1;

    const renk = puan >= 70 ? t.kirmizi : puan >= 40 ? t.kehribar : t.vurgu;

    function kare(oran) {
      ciz.clearRect(0, 0, g, y);

      ciz.lineWidth = 11;
      ciz.strokeStyle = t.cizgi;
      ciz.beginPath();
      ciz.arc(mx, my, r, bas, bit);
      ciz.stroke();

      ciz.lineWidth = 3;
      bolgeler.forEach(function (b) {
        ciz.strokeStyle = b[2];
        ciz.globalAlpha = 0.28;
        ciz.beginPath();
        ciz.arc(mx, my, r + 10, bas + (bit - bas) * (b[0] / 100), bas + (bit - bas) * (b[1] / 100));
        ciz.stroke();
      });
      ciz.globalAlpha = 1;

      // Dolu yay
      const aci = bas + (bit - bas) * (oran / 100);
      ciz.lineWidth = 11;
      ciz.strokeStyle = renk;
      ciz.shadowColor = renk;
      ciz.shadowBlur = 14;
      ciz.beginPath();
      ciz.arc(mx, my, r, bas, Math.max(bas + 0.001, aci));
      ciz.stroke();
      ciz.shadowBlur = 0;

      // Ibre
      ciz.strokeStyle = renk;
      ciz.lineWidth = 2;
      ciz.beginPath();
      ciz.moveTo(mx, my);
      ciz.lineTo(mx + Math.cos(aci) * (r - 6), my + Math.sin(aci) * (r - 6));
      ciz.stroke();

      ciz.fillStyle = renk;
      ciz.beginPath();
      ciz.arc(mx, my, 4, 0, Math.PI * 2);
      ciz.fill();

      // Olcek yazilari
      ciz.fillStyle = t.sonuk;
      ciz.font = '10px ' + getComputedStyle(document.body).fontFamily;
      ciz.textAlign = 'center';
      [0, 25, 50, 75, 100].forEach(function (d) {
        const a = bas + (bit - bas) * (d / 100);
        ciz.fillText(String(d), mx + Math.cos(a) * (r + 22), my + Math.sin(a) * (r + 22) + 3);
      });
    }

    if (HAREKET_AZ) { kare(puan); return; }
    const sure = 900;
    const t0 = performance.now();
    (function dongu(simdi) {
      const p = Math.min(1, (simdi - t0) / sure);
      // easeOutCubic
      kare(puan * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(dongu);
    })(t0);
  }

  // ----------------------------------------------------- 3. ZAMAN SERISI
  /**
   * data-seri: [{ etiket, kayit, olay }] bicimli dizi.
   * Kayitlar dolgulu alan, olaylar ustune cubuk olarak cizilir.
   * data-ongoru varsa kesikli cizgiyle devam ettirilir.
   */
  function seriCiz(tuval) {
    const seri = jsonNitelik(tuval, 'data-seri');
    if (!seri || !seri.length) return;
    const h = tuvalHazirla(tuval);
    if (!h) return;
    const { ciz, g, y } = h;
    const t = tema();

    const patlama = jsonNitelik(tuval, 'data-patlama') || [];
    const ongoru = jsonNitelik(tuval, 'data-ongoru') || [];
    const patSet = new Set(patlama);

    const solBosluk = 34;
    const altBosluk = 18;
    const ustBosluk = 10;
    const genislik = g - solBosluk - 6;
    const yukseklik = y - altBosluk - ustBosluk;

    const kayitlar = seri.map(function (n) { return Number(n.kayit) || 0; });
    const olaylar = seri.map(function (n) { return Number(n.olay) || 0; });
    const hepsi = kayitlar.concat(olaylar, ongoru.map(Number));
    const tepe = Math.max(1, hepsi.reduce(function (a, b) { return Math.max(a, b || 0); }, 0));

    const toplamNokta = seri.length + ongoru.length;
    const adim = toplamNokta > 1 ? genislik / (toplamNokta - 1) : genislik;

    function xKo(i) { return solBosluk + adim * i; }
    function yKo(v) { return ustBosluk + yukseklik - (Math.max(0, v) / tepe) * yukseklik; }

    ciz.clearRect(0, 0, g, y);

    // Izgara + eksen yazilari
    ciz.strokeStyle = t.cizgi;
    ciz.lineWidth = 1;
    ciz.fillStyle = t.sonuk;
    ciz.font = '9px ' + getComputedStyle(document.body).fontFamily;
    ciz.textAlign = 'right';
    for (let i = 0; i <= 4; i += 1) {
      const deger = Math.round((tepe / 4) * i);
      const yy = yKo(deger);
      ciz.beginPath();
      ciz.moveTo(solBosluk, yy);
      ciz.lineTo(g - 6, yy);
      ciz.stroke();
      ciz.fillText(String(deger), solBosluk - 5, yy + 3);
    }

    // Olay cubuklari
    const cubukG = Math.max(1.5, Math.min(9, adim * 0.45));
    ciz.fillStyle = t.kehribar;
    ciz.globalAlpha = 0.55;
    olaylar.forEach(function (v, i) {
      if (!v) return;
      const yy = yKo(v);
      ciz.fillRect(xKo(i) - cubukG / 2, yy, cubukG, ustBosluk + yukseklik - yy);
    });
    ciz.globalAlpha = 1;

    // Kayit alani
    const egim = ciz.createLinearGradient(0, ustBosluk, 0, ustBosluk + yukseklik);
    egim.addColorStop(0, t.vurgu + '55');
    egim.addColorStop(1, 'rgba(0,0,0,0)');
    ciz.beginPath();
    ciz.moveTo(xKo(0), ustBosluk + yukseklik);
    kayitlar.forEach(function (v, i) { ciz.lineTo(xKo(i), yKo(v)); });
    ciz.lineTo(xKo(kayitlar.length - 1), ustBosluk + yukseklik);
    ciz.closePath();
    ciz.fillStyle = egim;
    ciz.fill();

    ciz.beginPath();
    kayitlar.forEach(function (v, i) {
      if (i === 0) ciz.moveTo(xKo(i), yKo(v)); else ciz.lineTo(xKo(i), yKo(v));
    });
    ciz.strokeStyle = t.vurgu;
    ciz.lineWidth = 1.8;
    ciz.stroke();

    // Ongoru: kesikli devam
    if (ongoru.length) {
      ciz.save();
      ciz.setLineDash([4, 3]);
      ciz.strokeStyle = t.kehribar;
      ciz.lineWidth = 1.6;
      ciz.beginPath();
      ciz.moveTo(xKo(kayitlar.length - 1), yKo(kayitlar[kayitlar.length - 1]));
      ongoru.forEach(function (v, i) { ciz.lineTo(xKo(kayitlar.length + i), yKo(Number(v) || 0)); });
      ciz.stroke();
      ciz.restore();
    }

    // Sicrama isaretleri
    ciz.fillStyle = t.kirmizi;
    kayitlar.forEach(function (v, i) {
      if (!patSet.has(i)) return;
      ciz.beginPath();
      ciz.arc(xKo(i), yKo(v), 3, 0, Math.PI * 2);
      ciz.fill();
    });

    // Ilk / orta / son etiket
    ciz.fillStyle = t.sonuk;
    ciz.textAlign = 'left';
    if (seri[0]) ciz.fillText(String(seri[0].etiket), solBosluk, y - 5);
    ciz.textAlign = 'center';
    const orta = Math.floor(seri.length / 2);
    if (seri.length > 4 && seri[orta]) ciz.fillText(String(seri[orta].etiket), xKo(orta), y - 5);
    ciz.textAlign = 'right';
    if (seri.length > 1) ciz.fillText(String(seri[seri.length - 1].etiket), g - 6, y - 5);

    // Imlec takibi: en yakin noktanin degerini gosterir
    tuval.addEventListener('mousemove', function (olay) {
      const dik = tuval.getBoundingClientRect();
      const i = Math.round((olay.clientX - dik.left - solBosluk) / adim);
      const n = seri[i];
      if (!n) { tuval.removeAttribute('title'); return; }
      tuval.title = n.etiket + ' · ' + (n.kayit || 0) + ' kayit · ' + (n.olay || 0) + ' olay';
    });
  }

  // ---------------------------------------------------------------- 4. SEKME
  function sekmeleriKur(kap) {
    kap.querySelectorAll('[data-sekme]').forEach(function (dugme) {
      dugme.addEventListener('click', function () {
        const ad = dugme.getAttribute('data-sekme');
        const grup = dugme.closest('[data-sekme-grup]') || document;

        grup.querySelectorAll('[data-sekme]').forEach(function (d) {
          const etkin = d === dugme;
          d.classList.toggle('etkin', etkin);
          d.setAttribute('data-etkin', etkin ? '1' : '0');
          d.setAttribute('aria-selected', etkin ? 'true' : 'false');
        });
        grup.querySelectorAll('[data-sekme-govde]').forEach(function (govde) {
          govde.classList.toggle('gizli', govde.getAttribute('data-sekme-govde') !== ad);
        });
      });
    });
  }

  // ----------------------------------------------------------------- 5. ONAY
  function onaylariKur(kap) {
    kap.querySelectorAll('[data-onay]').forEach(function (dugme) {
      if (dugme.dataset.onayKurulu === '1') return;
      dugme.dataset.onayKurulu = '1';
      dugme.addEventListener('click', function (olay) {
        const soru = dugme.getAttribute('data-onay');
        if (window.confirm(soru)) return;
        olay.preventDefault();
        olay.stopPropagation();
      });
    });
  }

  // --------------------------------------------------------------- 6. SAYAC
  function sayaclariKur(kap) {
    kap.querySelectorAll('[data-sayac]').forEach(function (dugum) {
      const hedef = Number(dugum.getAttribute('data-sayac'));
      if (!Number.isFinite(hedef)) return;
      if (HAREKET_AZ || hedef === 0) { dugum.textContent = hedef.toLocaleString('tr-TR'); return; }
      const sure = 700;
      const t0 = performance.now();
      (function dongu(simdi) {
        const p = Math.min(1, (simdi - t0) / sure);
        dugum.textContent = Math.round(hedef * (1 - Math.pow(1 - p, 3))).toLocaleString('tr-TR');
        if (p < 1) requestAnimationFrame(dongu);
      })(t0);
    });
  }

  // -------------------------------------------------------------- 7. KOPYALA
  function kopyalariKur(kap) {
    kap.querySelectorAll('[data-kopya]').forEach(function (dugme) {
      dugme.addEventListener('click', async function () {
        const metin = dugme.getAttribute('data-kopya');
        try {
          await navigator.clipboard.writeText(metin);
          const eski = dugme.textContent;
          dugme.textContent = 'KOPYALANDI';
          setTimeout(function () { dugme.textContent = eski; }, 1400);
        } catch (hata) { /* pano izni yok: sessizce gec */ }
      });
    });
  }

  // ------------------------------------------------------------------- KURUL
  function kur(kap) {
    const k = kap || document;
    cubuklariDoldur(k);
    sekmeleriKur(k);
    onaylariKur(k);
    sayaclariKur(k);
    kopyalariKur(k);
    k.querySelectorAll('.tehdit-kadran[data-puan]').forEach(kadranCiz);
    k.querySelectorAll('canvas[data-seri]').forEach(seriCiz);
  }

  document.addEventListener('DOMContentLoaded', function () { kur(document); });

  let zamanlayici = null;
  window.addEventListener('resize', function () {
    clearTimeout(zamanlayici);
    zamanlayici = setTimeout(function () {
      document.querySelectorAll('.tehdit-kadran[data-puan]').forEach(kadranCiz);
      document.querySelectorAll('canvas[data-seri]').forEach(seriCiz);
    }, 180);
  });

  // Diger betiklerin yararlanmasi icin ortak araclar
  window.HUD = { kur, tema, tuvalHazirla, jsonNitelik, HAREKET_AZ };
})();
