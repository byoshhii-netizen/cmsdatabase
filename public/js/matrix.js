'use strict';
/* ==========================================================================
   public/js/matrix.js
   Matrix karakter yagmuru. Mobilde dusuk yogunluk, sekme gizliyken durur,
   "prefers-reduced-motion" tercihine saygi gosterir.
   ========================================================================== */

(function (kuresel) {
  const KARAKTERLER =
    'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン' +
    '0123456789CMSKARTRIDEX<>/\\[]{}#$%&*+=-';

  function baslat(tuval) {
    if (!tuval || !tuval.getContext) return null;

    const azHareket = kuresel.matchMedia && kuresel.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (azHareket) { tuval.style.display = 'none'; return null; }

    const ctx = tuval.getContext('2d', { alpha: true });
    if (!ctx) return null;

    let genislik = 0;
    let yukseklik = 0;
    let adim = 16;
    let kolonlar = 0;
    let damlalar = [];
    let hizlar = [];
    let cerceve = null;
    let sonCizim = 0;
    const hedefFps = kuresel.innerWidth < 760 ? 18 : 26;
    const cerceveAraligi = 1000 / hedefFps;

    function olcekle() {
      const dpr = Math.min(kuresel.devicePixelRatio || 1, 1.5);
      genislik = kuresel.innerWidth;
      yukseklik = kuresel.innerHeight;
      tuval.width = Math.floor(genislik * dpr);
      tuval.height = Math.floor(yukseklik * dpr);
      tuval.style.width = genislik + 'px';
      tuval.style.height = yukseklik + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      adim = genislik < 760 ? 18 : 15;
      kolonlar = Math.ceil(genislik / adim);
      damlalar = new Array(kolonlar);
      hizlar = new Array(kolonlar);
      for (let i = 0; i < kolonlar; i++) {
        damlalar[i] = Math.random() * -yukseklik;
        hizlar[i] = 0.55 + Math.random() * 0.95;
      }
      ctx.font = `${adim - 2}px ui-monospace, monospace`;
      ctx.textBaseline = 'top';
    }

    function ciz(zaman) {
      cerceve = kuresel.requestAnimationFrame(ciz);
      if (zaman - sonCizim < cerceveAraligi) return;
      sonCizim = zaman;

      // Iz birakma efekti
      ctx.fillStyle = 'rgba(4, 7, 10, 0.1)';
      ctx.fillRect(0, 0, genislik, yukseklik);

      for (let i = 0; i < kolonlar; i++) {
        const x = i * adim;
        const y = damlalar[i];
        const harf = KARAKTERLER.charAt((Math.random() * KARAKTERLER.length) | 0);

        // Bas karakter parlak, govde sonuk
        ctx.fillStyle = '#d7fff0';
        ctx.fillText(harf, x, y);
        ctx.fillStyle = 'rgba(0, 255, 156, 0.5)';
        ctx.fillText(
          KARAKTERLER.charAt((Math.random() * KARAKTERLER.length) | 0),
          x,
          y - adim,
        );

        damlalar[i] += adim * hizlar[i] * 0.55;
        if (damlalar[i] > yukseklik + adim * 2 && Math.random() > 0.975) {
          damlalar[i] = Math.random() * -160;
          hizlar[i] = 0.55 + Math.random() * 0.95;
        }
      }
    }

    function durdur() {
      if (cerceve) { kuresel.cancelAnimationFrame(cerceve); cerceve = null; }
    }

    function devam() {
      if (!cerceve) cerceve = kuresel.requestAnimationFrame(ciz);
    }

    let zamanlayici = null;
    function yenidenBoyutla() {
      kuresel.clearTimeout(zamanlayici);
      zamanlayici = kuresel.setTimeout(olcekle, 160);
    }

    olcekle();
    devam();

    kuresel.addEventListener('resize', yenidenBoyutla, { passive: true });
    kuresel.document.addEventListener('visibilitychange', () => {
      if (kuresel.document.hidden) durdur(); else devam();
    });

    return { durdur, devam, olcekle };
  }

  kuresel.Matrix = { baslat };
})(window);
