'use strict';
/**
 * public/js/harita.js
 * Kapali devre konum haritasi. Dis karo (tile) servisi kullanilmaz; hicbir
 * istek disariya gitmez. Izgara (graticule) ve basitlestirilmis sinir hatti
 * tarayicida cizilir, uzerine arsivin konumlu ogeleri yerlestirilir.
 *
 * Izdusum: esdikdortgen (equirectangular) — enlem/boylam dogrudan olceklenir.
 * Sinir hatti semaktiktir, haritacilik dogrulugu iddia etmez.
 */
(function () {
  const tuval = document.getElementById('harita-tuval');
  if (!tuval) return;

  const HUD = window.HUD || {};
  const noktalar = (HUD.jsonNitelik ? HUD.jsonNitelik(tuval, 'data-noktalar') : null) || [];
  const bilgiKutu = document.getElementById('harita-bilgi');
  const t = HUD.tema ? HUD.tema() : {
    vurgu: '#00ff9c', kehribar: '#f0b429', camgobegi: '#22d3ee',
    kirmizi: '#ff4d5e', sonuk: '#6b7f8a', metin: '#9fb4bf', cizgi: 'rgba(255,255,255,.08)',
  };

  const KAYNAK_RENK = {
    varlik: t.vurgu, olay: t.kehribar, kayit: t.camgobegi, dosya: t.sonuk,
  };

  /* Basitlestirilmis Turkiye sinir hatti (boylam, enlem) — semaktik. */
  const TURKIYE = [
    [26.32, 41.72], [27.55, 41.95], [28.02, 41.98], [28.98, 41.18], [31.40, 41.10],
    [33.05, 42.02], [35.15, 42.02], [36.33, 41.30], [37.90, 41.00], [39.72, 41.00],
    [41.42, 41.43], [41.55, 41.52], [42.85, 41.58], [43.45, 41.10], [43.12, 40.62],
    [43.65, 40.10], [44.80, 39.72], [44.05, 39.38], [44.42, 38.35], [44.30, 37.90],
    [44.58, 37.45], [44.00, 37.30], [42.35, 37.25], [41.20, 37.10], [40.20, 36.90],
    [38.80, 36.70], [37.10, 36.66], [36.68, 36.22], [36.16, 36.00], [36.20, 36.60],
    [35.55, 36.57], [34.60, 36.78], [33.70, 36.15], [32.50, 36.10], [31.40, 36.80],
    [30.60, 36.25], [30.10, 36.30], [29.10, 36.55], [28.25, 36.70], [27.30, 36.70],
    [27.25, 37.70], [26.70, 38.20], [27.05, 38.45], [26.40, 38.65], [26.70, 39.30],
    [26.15, 39.50], [26.20, 40.10], [26.70, 40.40], [27.45, 40.35], [26.10, 40.60],
    [25.95, 40.75], [26.32, 41.72],
  ];

  /* Cevre ulkelerin kaba hatlari: baglam icin, isimsiz. */
  const KOMSU_HATLAR = [
    /* Kibris */
    [[32.30, 35.17], [33.90, 35.28], [34.60, 35.68], [33.30, 35.38], [32.30, 35.17]],
    /* Ege adalari semaktik dizisi */
    [[25.15, 35.30], [26.30, 35.20]],
    /* Karadeniz kuzey kiyisi (semaktik) */
    [[28.60, 43.75], [31.00, 46.50], [36.60, 45.30], [41.70, 42.20]],
  ];

  /* Baslica sehirler: operator yon bulsun diye referans noktalari. */
  const SEHIRLER = [
    ['Istanbul', 28.98, 41.01], ['Ankara', 32.85, 39.93], ['Izmir', 27.14, 38.42],
    ['Antalya', 30.71, 36.90], ['Adana', 35.33, 37.00], ['Gaziantep', 37.38, 37.07],
    ['Diyarbakir', 40.23, 37.91], ['Van', 43.38, 38.49], ['Trabzon', 39.72, 41.00],
    ['Samsun', 36.33, 41.29], ['Konya', 32.48, 37.87], ['Bursa', 29.06, 40.19],
    ['Erzurum', 41.27, 39.90], ['Mersin', 34.64, 36.81],
  ];

  const TURKIYE_GORUNUM = { bLon: 25.5, sLon: 45.2, bLat: 35.5, sLat: 42.5 };
  const DUNYA_GORUNUM = { bLon: -180, sLon: 180, bLat: -60, sLat: 80 };

  let gorunum = Object.assign({}, TURKIYE_GORUNUM);
  let vurgulu = null;

  /* Noktalar Turkiye kutusunun disindaysa basta dunya gorunumune gec. */
  if (noktalar.length) {
    const disarida = noktalar.filter(function (n) {
      return n.boylam < TURKIYE_GORUNUM.bLon - 1 || n.boylam > TURKIYE_GORUNUM.sLon + 1
        || n.enlem < TURKIYE_GORUNUM.bLat - 1 || n.enlem > TURKIYE_GORUNUM.sLat + 1;
    }).length;
    if (disarida > noktalar.length * 0.3) gorunum = Object.assign({}, DUNYA_GORUNUM);
  }

  function olcuAl() {
    const dik = tuval.getBoundingClientRect();
    return { g: dik.width, y: dik.height, dik };
  }

  function ekrana(lon, lat, olcu) {
    return {
      x: ((lon - gorunum.bLon) / (gorunum.sLon - gorunum.bLon)) * olcu.g,
      y: olcu.y - ((lat - gorunum.bLat) / (gorunum.sLat - gorunum.bLat)) * olcu.y,
    };
  }

  function hatCiz(c, dizi, olcu, renk, kalinlik, kapali) {
    c.beginPath();
    dizi.forEach(function (p, i) {
      const e = ekrana(p[0], p[1], olcu);
      if (i === 0) c.moveTo(e.x, e.y); else c.lineTo(e.x, e.y);
    });
    if (kapali) c.closePath();
    c.strokeStyle = renk;
    c.lineWidth = kalinlik;
    c.stroke();
  }

  /** Izgara araligi: yakinlastikca inceltilir. */
  function izgaraAdimi() {
    const genislik = gorunum.sLon - gorunum.bLon;
    if (genislik > 120) return 30;
    if (genislik > 40) return 10;
    if (genislik > 16) return 5;
    if (genislik > 6) return 2;
    if (genislik > 2) return 1;
    return 0.5;
  }

  function ciz() {
    const h = HUD.tuvalHazirla ? HUD.tuvalHazirla(tuval) : null;
    if (!h) return;
    const { ciz: c, g, y } = h;
    const olcu = { g, y };
    const yaziTipi = getComputedStyle(document.body).fontFamily;

    c.clearRect(0, 0, g, y);

    // Izgara
    const adim = izgaraAdimi();
    c.strokeStyle = t.cizgi;
    c.lineWidth = 1;
    c.fillStyle = t.sonuk;
    c.font = '9px ' + yaziTipi;

    for (let lon = Math.ceil(gorunum.bLon / adim) * adim; lon <= gorunum.sLon; lon += adim) {
      const e = ekrana(lon, gorunum.bLat, olcu);
      c.globalAlpha = Math.abs(lon) < 0.001 ? 0.7 : 0.4;
      c.beginPath(); c.moveTo(e.x, 0); c.lineTo(e.x, y); c.stroke();
      c.globalAlpha = 1;
      c.textAlign = 'center';
      c.fillText(lon.toFixed(adim < 1 ? 1 : 0) + '°', e.x, y - 4);
    }
    for (let lat = Math.ceil(gorunum.bLat / adim) * adim; lat <= gorunum.sLat; lat += adim) {
      const e = ekrana(gorunum.bLon, lat, olcu);
      c.globalAlpha = Math.abs(lat) < 0.001 ? 0.7 : 0.4;
      c.beginPath(); c.moveTo(0, e.y); c.lineTo(g, e.y); c.stroke();
      c.globalAlpha = 1;
      c.textAlign = 'left';
      c.fillText(lat.toFixed(adim < 1 ? 1 : 0) + '°', 4, e.y - 3);
    }

    // Sinir hatlari
    c.globalAlpha = 0.85;
    hatCiz(c, TURKIYE, olcu, t.metin, 1.3, true);
    c.globalAlpha = 0.4;
    KOMSU_HATLAR.forEach(function (d) { hatCiz(c, d, olcu, t.metin, 1, false); });
    c.globalAlpha = 1;

    // Sehir referanslari
    if (gorunum.sLon - gorunum.bLon < 60) {
      c.fillStyle = t.sonuk;
      c.font = '9px ' + yaziTipi;
      c.textAlign = 'left';
      SEHIRLER.forEach(function (s) {
        const e = ekrana(s[1], s[2], olcu);
        if (e.x < -20 || e.x > g + 20 || e.y < -20 || e.y > y + 20) return;
        c.globalAlpha = 0.55;
        c.beginPath(); c.arc(e.x, e.y, 1.6, 0, Math.PI * 2); c.fill();
        c.fillText(s[0], e.x + 4, e.y + 3);
        c.globalAlpha = 1;
      });
    }

    // Arsiv noktalari
    noktalar.forEach(function (n) {
      if (!Number.isFinite(n.enlem) || !Number.isFinite(n.boylam)) return;
      const e = ekrana(n.boylam, n.enlem, olcu);
      if (e.x < -30 || e.x > g + 30 || e.y < -30 || e.y > y + 30) return;
      const renk = KAYNAK_RENK[n.kaynak] || t.sonuk;
      const r = 3 + Math.sqrt(Math.max(0, Number(n.onem) || 40)) * 0.42;

      // Halka: onem arttikca belirginlesir
      c.globalAlpha = 0.22;
      c.fillStyle = renk;
      c.beginPath(); c.arc(e.x, e.y, r * 2.6, 0, Math.PI * 2); c.fill();
      c.globalAlpha = 1;

      if (n === vurgulu) { c.shadowColor = renk; c.shadowBlur = 14; }
      c.fillStyle = renk;
      c.beginPath(); c.arc(e.x, e.y, r, 0, Math.PI * 2); c.fill();
      c.shadowBlur = 0;

      if (n === vurgulu || noktalar.length <= 40) {
        c.fillStyle = '#dce9ef';
        c.font = (n === vurgulu ? 'bold ' : '') + '10px ' + yaziTipi;
        c.textAlign = 'center';
        const ad = String(n.baslik || '').slice(0, 26);
        c.fillText(ad, e.x, e.y - r - 5);
      }
    });

    // Olcek cubugu: bir derecenin ekranda kac piksel oldugundan hesaplanir
    const derecePiksel = g / (gorunum.sLon - gorunum.bLon);
    const kmPerDerece = 111.32 * Math.cos((((gorunum.bLat + gorunum.sLat) / 2) * Math.PI) / 180);
    let hedefKm = 100;
    [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500].forEach(function (k) {
      if (k * (derecePiksel / kmPerDerece) < g * 0.25) hedefKm = k;
    });
    const olcekPiksel = hedefKm * (derecePiksel / kmPerDerece);
    c.strokeStyle = t.metin;
    c.fillStyle = t.metin;
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(g - olcekPiksel - 14, y - 24);
    c.lineTo(g - 14, y - 24);
    c.stroke();
    c.font = '9px ' + yaziTipi;
    c.textAlign = 'right';
    c.fillText(hedefKm + ' km', g - 14, y - 29);
  }

  // ---------------------------------------------------------------- OLAYLAR
  function enYakin(ex, ey, olcu) {
    let bulunan = null;
    let enIyi = 14 * 14;
    noktalar.forEach(function (n) {
      if (!Number.isFinite(n.enlem)) return;
      const e = ekrana(n.boylam, n.enlem, olcu);
      const d = (e.x - ex) * (e.x - ex) + (e.y - ey) * (e.y - ey);
      if (d < enIyi) { enIyi = d; bulunan = n; }
    });
    return bulunan;
  }

  function yakinlastir(kat, merkezX, merkezY) {
    const olcu = olcuAl();
    const mx = merkezX === undefined ? olcu.g / 2 : merkezX;
    const my = merkezY === undefined ? olcu.y / 2 : merkezY;
    const lon = gorunum.bLon + (mx / olcu.g) * (gorunum.sLon - gorunum.bLon);
    const lat = gorunum.bLat + ((olcu.y - my) / olcu.y) * (gorunum.sLat - gorunum.bLat);

    const yeniGenislik = Math.max(0.05, Math.min(360, (gorunum.sLon - gorunum.bLon) / kat));
    const yeniYukseklik = Math.max(0.03, Math.min(170, (gorunum.sLat - gorunum.bLat) / kat));
    const oranX = (lon - gorunum.bLon) / (gorunum.sLon - gorunum.bLon);
    const oranY = (lat - gorunum.bLat) / (gorunum.sLat - gorunum.bLat);

    gorunum.bLon = lon - yeniGenislik * oranX;
    gorunum.sLon = gorunum.bLon + yeniGenislik;
    gorunum.bLat = lat - yeniYukseklik * oranY;
    gorunum.sLat = gorunum.bLat + yeniYukseklik;
    ciz();
  }

  let kaydir = null;
  tuval.addEventListener('mousedown', function (olay) {
    const olcu = olcuAl();
    kaydir = {
      x: olay.clientX - olcu.dik.left, y: olay.clientY - olcu.dik.top,
      g: Object.assign({}, gorunum), tasindi: false,
    };
  });

  window.addEventListener('mousemove', function (olay) {
    const olcu = olcuAl();
    const ex = olay.clientX - olcu.dik.left;
    const ey = olay.clientY - olcu.dik.top;

    if (kaydir) {
      const dLon = ((ex - kaydir.x) / olcu.g) * (kaydir.g.sLon - kaydir.g.bLon);
      const dLat = ((ey - kaydir.y) / olcu.y) * (kaydir.g.sLat - kaydir.g.bLat);
      gorunum.bLon = kaydir.g.bLon - dLon;
      gorunum.sLon = kaydir.g.sLon - dLon;
      gorunum.bLat = kaydir.g.bLat + dLat;
      gorunum.sLat = kaydir.g.sLat + dLat;
      if (Math.abs(ex - kaydir.x) + Math.abs(ey - kaydir.y) > 4) kaydir.tasindi = true;
      ciz();
      return;
    }
    if (ex < 0 || ey < 0 || ex > olcu.g || ey > olcu.y) return;

    const n = enYakin(ex, ey, olcu);
    if (n !== vurgulu) {
      vurgulu = n;
      if (bilgiKutu) {
        if (n) {
          bilgiKutu.hidden = false;
          bilgiKutu.textContent = n.baslik + '  ·  ' + n.kaynak
            + '  ·  ' + Number(n.enlem).toFixed(4) + ', ' + Number(n.boylam).toFixed(4);
        } else { bilgiKutu.hidden = true; }
      }
      tuval.style.cursor = n ? 'pointer' : 'grab';
      ciz();
    }
  });

  window.addEventListener('mouseup', function () {
    if (kaydir && !kaydir.tasindi && vurgulu) {
      const n = vurgulu;
      const yollar = {
        varlik: '/arsiv/varlik/', olay: '/arsiv/olay/',
        kayit: '/arsiv/kayit/', dosya: '/depo/dosya/',
      };
      const temel = yollar[n.kaynak];
      if (temel) {
        window.location.href = temel + encodeURIComponent(n.id) + (n.kaynak === 'dosya' ? '/cozumleme' : '');
      }
    }
    kaydir = null;
  });

  tuval.addEventListener('wheel', function (olay) {
    olay.preventDefault();
    const olcu = olcuAl();
    yakinlastir(olay.deltaY < 0 ? 1.2 : 1 / 1.2,
      olay.clientX - olcu.dik.left, olay.clientY - olcu.dik.top);
  }, { passive: false });

  function dugmeBagla(kimlik, islev) {
    const d = document.getElementById(kimlik);
    if (d) d.addEventListener('click', islev);
  }
  dugmeBagla('harita-yakinlas', function () { yakinlastir(1.4); });
  dugmeBagla('harita-uzaklas', function () { yakinlastir(1 / 1.4); });
  dugmeBagla('harita-sifirla', function () { gorunum = Object.assign({}, TURKIYE_GORUNUM); ciz(); });
  dugmeBagla('harita-dunya', function () { gorunum = Object.assign({}, DUNYA_GORUNUM); ciz(); });

  let zamanlayici = null;
  window.addEventListener('resize', function () {
    clearTimeout(zamanlayici);
    zamanlayici = setTimeout(ciz, 160);
  });

  document.addEventListener('DOMContentLoaded', ciz);
  ciz();
})();
