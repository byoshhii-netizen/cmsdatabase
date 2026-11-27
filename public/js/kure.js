'use strict';
/* ==========================================================================
   public/js/kure.js   —   MUKTEBES / KURE
   Kapali devre istihbarat kuresi. Disariya HICBIR istek gitmez: kita hatlari,
   kabartma, gece isiklari, gece/gunduz terminatoru ve uydu yorungeleri
   tarayicida uretilir. Uydu konumlari sadelestirilmis dairesel yorunge
   kestirimidir (gercek TLE/SGP4 degildir); operator yon bulsun diyedir.

   Katmanlar:
     - Yuzey: cizgisel (vektor) | uydu (kabartma + gece isiklari)
     - Izgara (graticule), onemli paraleller, terminator
     - CMS varliklari/olaylari/kayitlari/foto-GPS noktalari
     - Operator isaretleri (ekle / sil / baglanti)
     - Baglanti yaylari (buyuk daire)
     - Uydu yorungeleri + yer izi
   ========================================================================== */
(function () {
  var tuval = document.getElementById('kure-tuval');
  if (!tuval) return;

  var HUD = window.HUD || {};
  var CMS = window.CMS || { csrf: (document.body.dataset || {}).csrf || '' };
  var DUNYA = window.DUNYA || { KITALAR: {}, SEHIRLER: [], ONEMLI_PARALELLER: [] };

  var DEG = Math.PI / 180;
  var RAD = 180 / Math.PI;

  // --------------------------------------------------------------- VERI
  function jn(ad) { return (HUD.jsonNitelik ? HUD.jsonNitelik(tuval, ad) : null) || []; }
  var noktalar = jn('data-noktalar');      // CMS varliklari
  var baglantilar = jn('data-baglantilar'); // [{a:{lon,lat},b:{lon,lat},guc}]
  var isaretler = jn('data-isaretler');     // operator isaretleri (sunucudan)

  var elBilgi = document.getElementById('kure-koordinat');
  var elDurum = document.getElementById('kure-durum');

  // --------------------------------------------------------------- TEMA
  function tema() {
    var t = HUD.tema ? HUD.tema() : {};
    return {
      vurgu: t.vurgu || '#34d399',
      kehribar: t.kehribar || '#f5b728',
      kirmizi: t.kirmizi || '#f05367',
      camgobegi: t.camgobegi || '#38bdf8',
      mor: '#a78bfa',
      metin: t.metin || '#c6d2de',
      sonuk: t.sonuk || '#7c8b9c',
      cizgi: t.cizgi || 'rgba(255,255,255,.08)'
    };
  }
  var T = tema();

  var KAYNAK_RENK = { varlik: T.vurgu, olay: T.kehribar, kayit: T.camgobegi, dosya: T.sonuk };

  // --------------------------------------------------------------- DURUM
  var durum = {
    yuzey: 'uydu',          // 'cizgisel' | 'uydu'
    merkezLon: 35,          // kameranin baktigi boylam
    merkezLat: 39,          // enlem
    yakin: 1,               // olcek carpani (1 = kure ekrana sigar)
    katman: {
      izgara: true, terminator: true, varliklar: true,
      isaretler: true, baglantilar: true, uydular: true,
      etiketler: true, isiklar: true, atmosfer: true
    },
    secili: null,           // secili nokta/isaret/uydu
    olcumModu: false,
    olcumNoktalari: [],
    isaretModu: false
  };

  // --------------------------------------------------------------- OLCU
  function olcu() {
    var dik = tuval.getBoundingClientRect();
    return { g: dik.width, y: dik.height, dik: dik };
  }
  function kureYari(o) { return Math.min(o.g, o.y) * 0.46 * durum.yakin; }
  function kureMerkez(o) { return { x: o.g / 2, y: o.y / 2 }; }

  // --------------------------------------------------------------- IZDUSUM
  // Ortografik: (lon,lat) -> ekran; gorunurluk cosc>0.
  function izdusum(lon, lat, o, R, M) {
    var la = lat * DEG, lo = (lon - durum.merkezLon) * DEG;
    var la0 = durum.merkezLat * DEG;
    var cosc = Math.sin(la0) * Math.sin(la) + Math.cos(la0) * Math.cos(la) * Math.cos(lo);
    var x = Math.cos(la) * Math.sin(lo);
    var y = Math.cos(la0) * Math.sin(la) - Math.sin(la0) * Math.cos(la) * Math.cos(lo);
    return { x: M.x + R * x, y: M.y - R * y, gorunur: cosc > 0, cosc: cosc };
  }
  // Ters izdusum: ekran -> (lon,lat); disaridaysa null.
  function tersIzdusum(sx, sy, o, R, M) {
    var x = sx - M.x, y = -(sy - M.y);
    var rho = Math.sqrt(x * x + y * y);
    if (rho > R) return null;
    var c = Math.asin(Math.min(1, rho / R));
    var la0 = durum.merkezLat * DEG;
    var sinc = Math.sin(c), cosc = Math.cos(c);
    var lat = Math.asin(cosc * Math.sin(la0) + (rho === 0 ? 0 : (y * sinc * Math.cos(la0)) / rho));
    var lon = durum.merkezLon * DEG + Math.atan2(x * sinc, rho * cosc * Math.cos(la0) - y * sinc * Math.sin(la0));
    return { lon: ((lon * RAD + 540) % 360) - 180, lat: lat * RAD };
  }

  // --------------------------------------------------------------- GUNES
  function subsolar() {
    var d = new Date();
    var baslangic = Date.UTC(d.getUTCFullYear(), 0, 0);
    var gun = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - baslangic) / 86400000;
    var decl = -23.44 * Math.cos((360 / 365) * (gun + 10) * DEG);
    var saat = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    var lon = (12 - saat) * 15;
    return { lon: ((lon + 540) % 360) - 180, lat: decl };
  }
  function kureVektor(lon, lat) {
    var la = lat * DEG, lo = lon * DEG;
    return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  }
  function gunduzMu(lon, lat, S) {
    var v = kureVektor(lon, lat);
    return v[0] * S.v[0] + v[1] * S.v[1] + v[2] * S.v[2] > -0.08;
  }

  // --------------------------------------------------------------- GMST (uydu yer izi)
  function gmstDeg() {
    var now = Date.now() / 86400000 + 2440587.5; // Julian gun
    var d = now - 2451545.0;
    var g = 280.46061837 + 360.98564736629 * d;
    return ((g % 360) + 360) % 360;
  }

  // --------------------------------------------------------------- UYDULAR
  // Sadelestirilmis dairesel yorunge: {ad, egik(deg), yuk(km), raan(deg), faz(deg), renk}
  var MU = 398600.4418; // km^3/s^2
  var RE = 6371;        // km
  var UYDULAR = [
    { ad: 'KEYHOLE-1', egik: 97.9, yuk: 410, raan: 20, faz: 0, renk: '#38bdf8' },
    { ad: 'LACROSSE-2', egik: 68.0, yuk: 670, raan: 120, faz: 40, renk: '#34d399' },
    { ad: 'SENTINEL-G', egik: 98.6, yuk: 790, raan: 250, faz: 90, renk: '#a78bfa' },
    { ad: 'MERIDYEN-4', egik: 62.8, yuk: 1200, raan: 300, faz: 150, renk: '#f5b728' },
    { ad: 'JEO-STAT-1', egik: 0.1, yuk: 35786, raan: 0, faz: 30, renk: '#f05367' },
    { ad: 'ORBITAL-9', egik: 51.6, yuk: 420, raan: 75, faz: 200, renk: '#22d3ee' },
    { ad: 'POLARIS-7', egik: 86.4, yuk: 850, raan: 190, faz: 260, renk: '#5eead4' },
    { ad: 'GLONASS-K', egik: 64.8, yuk: 19100, raan: 145, faz: 310, renk: '#c084fc' }
  ];
  function uyduKonum(s, tMs) {
    var a = RE + s.yuk;
    var periyot = 2 * Math.PI * Math.sqrt((a * a * a) / MU); // saniye
    var n = 360 / periyot; // derece/sn
    var M = (s.faz + n * (tMs / 1000)) % 360;
    var u = M * DEG, inc = s.egik * DEG, raan = s.raan * DEG;
    // Yorunge duzleminde birim konum
    var xp = Math.cos(u), yp = Math.sin(u), zp = 0;
    // Egiklik (x ekseni etrafinda)
    var x1 = xp, y1 = yp * Math.cos(inc) - zp * Math.sin(inc), z1 = yp * Math.sin(inc) + zp * Math.cos(inc);
    // RAAN (z ekseni etrafinda)
    var xe = x1 * Math.cos(raan) - y1 * Math.sin(raan);
    var ye = x1 * Math.sin(raan) + y1 * Math.cos(raan);
    var ze = z1;
    var latE = Math.asin(Math.max(-1, Math.min(1, ze)));
    var lonEci = Math.atan2(ye, xe) * RAD;
    var lon = ((lonEci - gmstDeg() + 540) % 360) - 180;
    return { lon: lon, lat: latE * RAD, yuk: s.yuk, periyot: periyot, hiz: Math.sqrt(MU / a) };
  }
  function uyduYerIzi(s, tMs) {
    var noktalar = [], a = RE + s.yuk;
    var periyot = 2 * Math.PI * Math.sqrt((a * a * a) / MU);
    var adim = periyot / 90;
    for (var i = -45; i <= 45; i++) {
      noktalar.push(uyduKonum(s, tMs + i * adim * 1000));
    }
    return noktalar;
  }

  // --------------------------------------------------------------- CIZIM
  var animasyon = false;

  function buyukDaireAra(p1, p2, n) {
    // İki nokta arasi buyuk daire noktalari (lon,lat).
    var v1 = kureVektor(p1.lon, p1.lat), v2 = kureVektor(p2.lon, p2.lat);
    var dot = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]));
    var omega = Math.acos(dot);
    var cikti = [];
    if (omega < 1e-6) return [p1, p2];
    for (var i = 0; i <= n; i++) {
      var f = i / n;
      var s1 = Math.sin((1 - f) * omega) / Math.sin(omega);
      var s2 = Math.sin(f * omega) / Math.sin(omega);
      var x = s1 * v1[0] + s2 * v2[0], y = s1 * v1[1] + s2 * v2[1], z = s1 * v1[2] + s2 * v2[2];
      cikti.push({ lon: Math.atan2(y, x) * RAD, lat: Math.asin(Math.max(-1, Math.min(1, z))) * RAD });
    }
    return cikti;
  }

  function cokgenCiz(c, halka, o, R, M, dolgu, cizgiRenk, cizgiKalin) {
    // Gorunur parcalari tek tek cizer (arka yuz kirpilir).
    var baslat = false, basladi = false;
    c.beginPath();
    for (var i = 0; i < halka.length; i++) {
      var e = izdusum(halka[i][0], halka[i][1], o, R, M);
      if (e.gorunur) {
        if (!basladi) { c.moveTo(e.x, e.y); basladi = true; }
        else c.lineTo(e.x, e.y);
      }
    }
    if (dolgu) { c.closePath(); c.fillStyle = dolgu; c.fill(); }
    if (cizgiRenk) {
      c.lineWidth = cizgiKalin || 1;
      c.strokeStyle = cizgiRenk;
      c.lineJoin = 'round';
      c.stroke();
    }
    return baslat;
  }

  // Kabartma dolgu rengi (enleme gore): kutup buzu / orman / col kusagi.
  function araziRengi(lat) {
    var a = Math.abs(lat);
    if (a > 68) return '#2b3a46';          // buz / tundra
    if (a > 55) return '#243b34';          // boreal
    if (a > 38) return '#2c4a35';          // ilimli
    if (a > 23) return '#4a4a2e';          // col kusagi
    if (a > 12) return '#3b5131';          // savan
    return '#2f5236';                      // tropik
  }

  // Canvas'i yalnizca baslangicta ve yeniden boyutlandirmada olcekle (her
  // karede degil): aksi halde surekli yeniden tahsis jank yaratir.
  var GEOM = { c: null, g: 0, y: 0 };
  function boyutlandir() {
    var h = HUD.tuvalHazirla ? HUD.tuvalHazirla(tuval) : null;
    if (!h) return false;
    GEOM = { c: h.ciz, g: h.g, y: h.y };
    return true;
  }

  function ciz() {
    if (!GEOM.c && !boyutlandir()) return;
    var c = GEOM.c, o = { g: GEOM.g, y: GEOM.y };
    var R = kureYari(o), M = kureMerkez(o);
    var uydu = durum.yuzey === 'uydu';
    c.clearRect(0, 0, o.g, o.y);

    // --- Uzay arka plani (hafif yildiz alani) ---
    c.save();

    // --- Atmosfer halesi ---
    if (durum.katman.atmosfer) {
      var hale = c.createRadialGradient(M.x, M.y, R * 0.92, M.x, M.y, R * 1.14);
      hale.addColorStop(0, 'rgba(56,189,248,0.14)');
      hale.addColorStop(0.55, 'rgba(56,189,248,0.05)');
      hale.addColorStop(1, 'rgba(56,189,248,0)');
      c.fillStyle = hale;
      c.beginPath(); c.arc(M.x, M.y, R * 1.14, 0, Math.PI * 2); c.fill();
    }

    // --- Okyanus kuresi ---
    c.beginPath(); c.arc(M.x, M.y, R, 0, Math.PI * 2);
    c.save(); c.clip();
    if (uydu) {
      var dny = c.createRadialGradient(M.x - R * 0.3, M.y - R * 0.3, R * 0.2, M.x, M.y, R);
      dny.addColorStop(0, '#0d2740');
      dny.addColorStop(0.6, '#0a1c2e');
      dny.addColorStop(1, '#040c16');
      c.fillStyle = dny;
    } else {
      c.fillStyle = '#070d15';
    }
    c.fillRect(M.x - R, M.y - R, R * 2, R * 2);

    // --- Izgara (graticule) ---
    if (durum.katman.izgara) {
      c.strokeStyle = uydu ? 'rgba(120,170,200,0.10)' : 'rgba(120,170,200,0.14)';
      c.lineWidth = 1;
      for (var lon = -180; lon < 180; lon += 15) {
        c.beginPath(); var bas = false;
        for (var lat = -90; lat <= 90; lat += 3) {
          var e = izdusum(lon, lat, o, R, M);
          if (e.gorunur) { if (!bas) { c.moveTo(e.x, e.y); bas = true; } else c.lineTo(e.x, e.y); }
          else bas = false;
        }
        c.stroke();
      }
      for (var lat2 = -75; lat2 <= 75; lat2 += 15) {
        c.beginPath(); var bas2 = false;
        for (var lon2 = -180; lon2 <= 180; lon2 += 3) {
          var e2 = izdusum(lon2, lat2, o, R, M);
          if (e2.gorunur) { if (!bas2) { c.moveTo(e2.x, e2.y); bas2 = true; } else c.lineTo(e2.x, e2.y); }
          else bas2 = false;
        }
        c.stroke();
      }
      // Onemli paraleller (ekvator/tropikler/kutup)
      c.setLineDash([3, 4]);
      c.strokeStyle = 'rgba(245,183,40,0.22)';
      (DUNYA.ONEMLI_PARALELLER || []).forEach(function (pl) {
        c.beginPath(); var b = false;
        for (var ln = -180; ln <= 180; ln += 3) {
          var e3 = izdusum(ln, pl, o, R, M);
          if (e3.gorunur) { if (!b) { c.moveTo(e3.x, e3.y); b = true; } else c.lineTo(e3.x, e3.y); }
          else b = false;
        }
        c.stroke();
      });
      c.setLineDash([]);
    }

    // --- Kitalar ---
    var K = DUNYA.KITALAR || {};
    Object.keys(K).forEach(function (ad) {
      var halka = K[ad];
      if (!halka || halka.length < 3) return;
      if (uydu) {
        // Ortalama enlemden arazi rengi
        var ort = 0; for (var i = 0; i < halka.length; i++) ort += halka[i][1];
        ort /= halka.length;
        cokgenCiz(c, halka, o, R, M, araziRengi(ort), 'rgba(140,200,170,0.28)', 1);
      } else {
        cokgenCiz(c, halka, o, R, M, 'rgba(52,211,153,0.06)', T.vurgu, 1.1);
      }
    });

    // --- Gece/gunduz: terminator + karartma + isiklar ---
    var S = { v: null };
    if (durum.katman.terminator || durum.katman.isiklar) {
      var ss = subsolar();
      S.lonlat = ss; S.v = kureVektor(ss.lon, ss.lat);
    }
    if (durum.katman.terminator && S.v) {
      // Gece tarafini karart: gunesin ekran izdusumunden radyal gradyan
      var gs = izdusum(S.lonlat.lon, S.lonlat.lat, o, R, M);
      var cx = gs.x, cy = gs.y;
      if (!gs.gorunur) { cx = M.x - (gs.x - M.x); cy = M.y - (gs.y - M.y); }
      var karart = c.createRadialGradient(cx, cy, R * 0.15, cx, cy, R * 2.0);
      karart.addColorStop(0, 'rgba(0,0,0,0)');
      karart.addColorStop(0.5, gs.gorunur ? 'rgba(2,8,16,0.08)' : 'rgba(2,8,16,0.35)');
      karart.addColorStop(1, 'rgba(1,4,10,0.72)');
      c.fillStyle = karart;
      c.fillRect(M.x - R, M.y - R, R * 2, R * 2);
      // Terminator cizgisi
      var u = S.v, up = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      var e1 = [u[1] * up[2] - u[2] * up[1], u[2] * up[0] - u[0] * up[2], u[0] * up[1] - u[1] * up[0]];
      var n1 = Math.hypot(e1[0], e1[1], e1[2]); e1 = [e1[0] / n1, e1[1] / n1, e1[2] / n1];
      var e2v = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]];
      c.beginPath(); var bter = false;
      for (var tt = 0; tt <= 360; tt += 4) {
        var a2 = tt * DEG;
        var px = Math.cos(a2) * e1[0] + Math.sin(a2) * e2v[0];
        var py = Math.cos(a2) * e1[1] + Math.sin(a2) * e2v[1];
        var pz = Math.cos(a2) * e1[2] + Math.sin(a2) * e2v[2];
        var plon = Math.atan2(py, px) * RAD, plat = Math.asin(Math.max(-1, Math.min(1, pz))) * RAD;
        var et = izdusum(plon, plat, o, R, M);
        if (et.gorunur) { if (!bter) { c.moveTo(et.x, et.y); bter = true; } else c.lineTo(et.x, et.y); }
        else bter = false;
      }
      c.strokeStyle = 'rgba(245,183,40,0.5)'; c.lineWidth = 1.2; c.stroke();
    }

    // --- Sehir isiklari / etiketleri ---
    if (durum.katman.isiklar || durum.katman.etiketler) {
      (DUNYA.SEHIRLER || []).forEach(function (s) {
        var e = izdusum(s[1], s[2], o, R, M);
        if (!e.gorunur) return;
        var gece = S.v ? !gunduzMu(s[1], s[2], S) : false;
        if (uydu && durum.katman.isiklar && gece) {
          var p = c.createRadialGradient(e.x, e.y, 0, e.x, e.y, 4 - s[3]);
          p.addColorStop(0, 'rgba(255,220,150,0.95)');
          p.addColorStop(1, 'rgba(255,190,90,0)');
          c.fillStyle = p;
          c.beginPath(); c.arc(e.x, e.y, 4 - s[3], 0, Math.PI * 2); c.fill();
        }
        if (durum.katman.etiketler && durum.yakin > 1.6 && s[3] <= 2) {
          c.fillStyle = 'rgba(198,210,222,0.72)';
          c.font = '9px ui-monospace, monospace';
          c.textAlign = 'left';
          c.fillText(s[0], e.x + 4, e.y + 3);
          c.fillStyle = gece ? 'rgba(255,210,140,0.9)' : 'rgba(150,180,200,0.7)';
          c.beginPath(); c.arc(e.x, e.y, 1.4, 0, Math.PI * 2); c.fill();
        }
      });
    }

    c.restore(); // clip kaldir

    // --- Kure kenari ---
    c.beginPath(); c.arc(M.x, M.y, R, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(120,180,210,0.35)'; c.lineWidth = 1.2; c.stroke();

    // --- Baglanti yaylari ---
    if (durum.katman.baglantilar && baglantilar.length) {
      baglantilar.forEach(function (b) {
        if (!b.a || !b.b) return;
        var yol = buyukDaireAra(b.a, b.b, 48);
        c.beginPath(); var bb = false;
        for (var i = 0; i < yol.length; i++) {
          var e = izdusum(yol[i].lon, yol[i].lat, o, R, M);
          if (e.gorunur) { if (!bb) { c.moveTo(e.x, e.y); bb = true; } else c.lineTo(e.x, e.y); }
          else bb = false;
        }
        c.strokeStyle = 'rgba(167,139,250,' + (0.25 + Math.min(0.5, (b.guc || 1) * 0.06)) + ')';
        c.lineWidth = 1; c.stroke();
      });
    }

    // --- Uydular ---
    if (durum.katman.uydular) {
      var tMs = Date.now();
      UYDULAR.forEach(function (s) {
        var iz = uyduYerIzi(s, tMs);
        c.beginPath(); var bi = false;
        for (var i = 0; i < iz.length; i++) {
          var e = izdusum(iz[i].lon, iz[i].lat, o, R, M);
          if (e.gorunur) { if (!bi) { c.moveTo(e.x, e.y); bi = true; } else c.lineTo(e.x, e.y); }
          else bi = false;
        }
        c.strokeStyle = s.renk + '55'; c.setLineDash([2, 3]); c.lineWidth = 1; c.stroke(); c.setLineDash([]);
        var k = uyduKonum(s, tMs);
        var e2 = izdusum(k.lon, k.lat, o, R, M);
        if (e2.gorunur) {
          s._ekran = e2; s._k = k;
          c.save();
          c.translate(e2.x, e2.y);
          c.fillStyle = s.renk; c.shadowColor = s.renk; c.shadowBlur = 8;
          c.beginPath();
          c.moveTo(0, -4); c.lineTo(3.4, 3); c.lineTo(-3.4, 3); c.closePath(); c.fill();
          c.restore();
          if (durum.secili === s) {
            c.strokeStyle = s.renk; c.lineWidth = 1.4;
            c.beginPath(); c.arc(e2.x, e2.y, 8, 0, Math.PI * 2); c.stroke();
          }
        } else { s._ekran = null; }
      });
    }

    // --- CMS varlik noktalari ---
    if (durum.katman.varliklar) {
      noktalar.forEach(function (n) {
        if (!Number.isFinite(n.enlem) || !Number.isFinite(n.boylam)) return;
        var e = izdusum(n.boylam, n.enlem, o, R, M);
        if (!e.gorunur) { n._ekran = null; return; }
        n._ekran = e;
        var renk = KAYNAK_RENK[n.kaynak] || T.sonuk;
        var r = 3 + Math.sqrt(Math.max(0, Number(n.onem) || 40)) * 0.34;
        c.globalAlpha = 0.20; c.fillStyle = renk;
        c.beginPath(); c.arc(e.x, e.y, r * 2.4, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1;
        if (durum.secili === n) { c.shadowColor = renk; c.shadowBlur = 12; }
        c.fillStyle = renk;
        c.beginPath(); c.arc(e.x, e.y, r, 0, Math.PI * 2); c.fill();
        c.shadowBlur = 0;
        if (durum.secili === n || (durum.katman.etiketler && noktalar.length <= 60)) {
          c.fillStyle = '#dce9ef'; c.textAlign = 'center';
          c.font = (durum.secili === n ? 'bold ' : '') + '10px ui-monospace, monospace';
          c.fillText(String(n.baslik || '').slice(0, 24), e.x, e.y - r - 5);
        }
      });
    }

    // --- Operator isaretleri ---
    if (durum.katman.isaretler) {
      isaretler.forEach(function (m) {
        var lon = Number(m.boylam), lat = Number(m.enlem);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
        var e = izdusum(lon, lat, o, R, M);
        if (!e.gorunur) { m._ekran = null; return; }
        m._ekran = e;
        var renk = m.renk || T.kehribar;
        c.save(); c.translate(e.x, e.y); c.rotate(Math.PI / 4);
        if (durum.secili === m) { c.shadowColor = renk; c.shadowBlur = 12; }
        c.fillStyle = renk; c.fillRect(-4, -4, 8, 8);
        c.restore();
        c.fillStyle = '#0a0e14'; c.beginPath(); c.arc(e.x, e.y, 1.6, 0, Math.PI * 2); c.fill();
        if (durum.secili === m || durum.katman.etiketler) {
          c.fillStyle = '#ffe3ad'; c.textAlign = 'center';
          c.font = (durum.secili === m ? 'bold ' : '') + '10px ui-monospace, monospace';
          c.fillText(String(m.baslik || '').slice(0, 24), e.x, e.y - 9);
        }
      });
    }

    // --- Olcum ---
    if (durum.olcumNoktalari.length) {
      durum.olcumNoktalari.forEach(function (p) {
        var e = izdusum(p.lon, p.lat, o, R, M);
        if (!e.gorunur) return;
        c.strokeStyle = T.camgobegi; c.lineWidth = 1.4;
        c.beginPath(); c.moveTo(e.x - 6, e.y); c.lineTo(e.x + 6, e.y);
        c.moveTo(e.x, e.y - 6); c.lineTo(e.x, e.y + 6); c.stroke();
      });
      if (durum.olcumNoktalari.length === 2) {
        var yol = buyukDaireAra(durum.olcumNoktalari[0], durum.olcumNoktalari[1], 48);
        c.beginPath(); var bm = false;
        for (var i = 0; i < yol.length; i++) {
          var e = izdusum(yol[i].lon, yol[i].lat, o, R, M);
          if (e.gorunur) { if (!bm) { c.moveTo(e.x, e.y); bm = true; } else c.lineTo(e.x, e.y); }
          else bm = false;
        }
        c.strokeStyle = T.camgobegi; c.setLineDash([4, 4]); c.lineWidth = 1.2; c.stroke(); c.setLineDash([]);
      }
    }

    c.restore();
  }

  // --------------------------------------------------------------- DOGSEL DONGU
  var cizBekliyor = false;
  var sonCizim = 0;
  var ANIM_ARALIK = 45; // ~22 fps (uydu hareketi icin yeterli, CPU dostu)
  function istegeCiz() { cizBekliyor = true; }
  function dongu(zaman) {
    var animVar = durum.katman.uydular || durum.katman.terminator;
    if (cizBekliyor) { cizBekliyor = false; ciz(); sonCizim = zaman || 0; }
    else if (animVar && (zaman - sonCizim) >= ANIM_ARALIK) { ciz(); sonCizim = zaman; }
    requestAnimationFrame(dongu);
  }

  // --------------------------------------------------------------- SECIM
  function enYakinNokta(sx, sy, o, R, M) {
    var en = null, enIyi = 16 * 16, tur = null;
    function dene(el, t) {
      if (!el._ekran) return;
      var dx = el._ekran.x - sx, dy = el._ekran.y - sy, d = dx * dx + dy * dy;
      if (d < enIyi) { enIyi = d; en = el; tur = t; }
    }
    if (durum.katman.uydular) UYDULAR.forEach(function (s) { dene(s, 'uydu'); });
    if (durum.katman.isaretler) isaretler.forEach(function (m) { dene(m, 'isaret'); });
    if (durum.katman.varliklar) noktalar.forEach(function (n) { dene(n, 'nokta'); });
    return en ? { el: en, tur: tur } : null;
  }

  function seciliGoster(sec) {
    durum.secili = sec ? sec.el : null;
    var panel = document.getElementById('kure-secim');
    if (!panel) { istegeCiz(); return; }
    if (!sec) { panel.hidden = true; istegeCiz(); return; }
    panel.hidden = false;
    var el = sec.el;
    var baslikEl = document.getElementById('kure-secim-baslik');
    var turEl = document.getElementById('kure-secim-tur');
    var govdeEl = document.getElementById('kure-secim-govde');
    var bagEl = document.getElementById('kure-secim-bag');
    if (sec.tur === 'uydu') {
      turEl.textContent = 'UYDU · YAKLAŞIK YÖRÜNGE';
      baslikEl.textContent = el.ad;
      var k = el._k || uyduKonum(el, Date.now());
      govdeEl.innerHTML = satir('ENLEM', k.lat.toFixed(2) + '°') + satir('BOYLAM', k.lon.toFixed(2) + '°')
        + satir('YÜKSEKLİK', Math.round(k.yuk).toLocaleString('tr-TR') + ' km')
        + satir('HIZ', k.hiz.toFixed(2) + ' km/s')
        + satir('EĞİKLİK', el.egik.toFixed(1) + '°')
        + satir('PERİYOT', Math.round(k.periyot / 60) + ' dk');
      bagEl.hidden = true;
    } else if (sec.tur === 'isaret') {
      turEl.textContent = 'OPERATÖR İŞARETİ';
      baslikEl.textContent = el.baslik || 'İşaret';
      govdeEl.innerHTML = satir('ENLEM', Number(el.enlem).toFixed(4) + '°') + satir('BOYLAM', Number(el.boylam).toFixed(4) + '°')
        + (el.not ? '<p class="kure-secim-not">' + kacir(el.not) + '</p>' : '')
        + (el.tasnif ? satir('TASNİF', String(el.tasnif).toUpperCase()) : '');
      bagEl.hidden = false;
      bagEl.innerHTML = '<button type="button" class="dugme dugme--tehlike dugme--kucuk" data-isaret-sil="' + el.id + '"><span class="dugme-metin">İŞARETİ SİL</span></button>';
    } else {
      turEl.textContent = (el.kaynak || 'nokta').toUpperCase();
      baslikEl.textContent = el.baslik || 'Öğe';
      govdeEl.innerHTML = satir('ENLEM', Number(el.enlem).toFixed(4) + '°') + satir('BOYLAM', Number(el.boylam).toFixed(4) + '°')
        + (el.onem ? satir('ÖNEM', el.onem) : '');
      var yollar = { varlik: '/arsiv/varlik/', olay: '/arsiv/olay/', kayit: '/arsiv/kayit/', dosya: '/depo/dosya/' };
      var temel = yollar[el.kaynak];
      bagEl.hidden = !temel;
      if (temel) bagEl.innerHTML = '<a class="dugme dugme--sonuk dugme--kucuk" href="' + temel + encodeURIComponent(el.id) + (el.kaynak === 'dosya' ? '/cozumleme' : '') + '"><span class="dugme-metin">ARŞİV KAYDINA GİT</span></a>';
    }
    istegeCiz();
  }
  function satir(a, b) { return '<div class="kure-tel"><span>' + a + '</span><strong>' + b + '</strong></div>'; }
  function kacir(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // --------------------------------------------------------------- ETKILESIM
  var surukle = null;
  tuval.addEventListener('mousedown', function (olay) {
    var o = olcu();
    surukle = { x: olay.clientX - o.dik.left, y: olay.clientY - o.dik.top, lon: durum.merkezLon, lat: durum.merkezLat, tasindi: false };
  });
  window.addEventListener('mousemove', function (olay) {
    var o = olcu(), R = kureYari(o), M = kureMerkez(o);
    var ex = olay.clientX - o.dik.left, ey = olay.clientY - o.dik.top;
    if (surukle) {
      var dx = ex - surukle.x, dy = ey - surukle.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) surukle.tasindi = true;
      durum.merkezLon = surukle.lon - dx * (90 / R) * 0.9;
      durum.merkezLat = Math.max(-89, Math.min(89, surukle.lat + dy * (90 / R) * 0.9));
      durum.merkezLon = ((durum.merkezLon + 540) % 360) - 180;
      istegeCiz();
      return;
    }
    if (ex < 0 || ey < 0 || ex > o.g || ey > o.y) return;
    var ll = tersIzdusum(ex, ey, o, R, M);
    if (elBilgi) elBilgi.textContent = ll ? (ll.lat.toFixed(3) + '°, ' + ll.lon.toFixed(3) + '°') : 'UZAY';
    var yk = enYakinNokta(ex, ey, o, R, M);
    tuval.style.cursor = durum.isaretModu ? 'crosshair' : (yk ? 'pointer' : (ll ? 'grab' : 'default'));
  });
  window.addEventListener('mouseup', function (olay) {
    if (!surukle) return;
    var tasindi = surukle.tasindi; surukle = null;
    if (tasindi) return;
    var o = olcu(), R = kureYari(o), M = kureMerkez(o);
    var ex = olay.clientX - o.dik.left, ey = olay.clientY - o.dik.top;
    if (ex < 0 || ey < 0 || ex > o.g || ey > o.y) return;
    var ll = tersIzdusum(ex, ey, o, R, M);

    if (durum.olcumModu && ll) {
      durum.olcumNoktalari.push({ lon: ll.lon, lat: ll.lat });
      if (durum.olcumNoktalari.length > 2) durum.olcumNoktalari = [{ lon: ll.lon, lat: ll.lat }];
      if (durum.olcumNoktalari.length === 2) {
        var d = buyukDaireMesafe(durum.olcumNoktalari[0], durum.olcumNoktalari[1]);
        if (elDurum) elDurum.textContent = 'MESAFE: ' + Math.round(d).toLocaleString('tr-TR') + ' km';
      }
      istegeCiz(); return;
    }
    if (durum.isaretModu && ll) { isaretModaliAc(ll); return; }

    var yk = enYakinNokta(ex, ey, o, R, M);
    seciliGoster(yk);
  });

  tuval.addEventListener('wheel', function (olay) {
    olay.preventDefault();
    durum.yakin = Math.max(0.6, Math.min(9, durum.yakin * (olay.deltaY < 0 ? 1.15 : 1 / 1.15)));
    istegeCiz();
  }, { passive: false });

  function buyukDaireMesafe(a, b) {
    var v1 = kureVektor(a.lon, a.lat), v2 = kureVektor(b.lon, b.lat);
    var dot = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]));
    return Math.acos(dot) * RE;
  }

  // --------------------------------------------------------------- ISARET MODALI
  function isaretModaliAc(ll) {
    var modal = document.getElementById('kure-isaret-modal');
    if (!modal) return;
    modal.hidden = false;
    modal.querySelector('[name="enlem"]').value = ll.lat.toFixed(5);
    modal.querySelector('[name="boylam"]').value = ll.lon.toFixed(5);
    var koor = document.getElementById('kure-isaret-koordinat');
    if (koor) koor.textContent = ll.lat.toFixed(4) + '°, ' + ll.lon.toFixed(4) + '°';
    var baslik = modal.querySelector('[name="baslik"]');
    if (baslik) { baslik.value = ''; setTimeout(function () { baslik.focus(); }, 60); }
    var hataEl = document.getElementById('kure-isaret-hata'); if (hataEl) hataEl.textContent = '';
  }
  function isaretModaliKapat() {
    var modal = document.getElementById('kure-isaret-modal');
    if (modal) modal.hidden = true;
  }

  async function isaretKaydet(form) {
    var hataEl = document.getElementById('kure-isaret-hata');
    var govde = {
      baslik: form.baslik.value.trim(),
      not: form.not.value.trim(),
      tasnif: form.tasnif.value,
      enlem: Number(form.enlem.value),
      boylam: Number(form.boylam.value),
      renk: form.renk ? form.renk.value : ''
    };
    if (!govde.baslik) { if (hataEl) hataEl.textContent = 'İşaret adı gerekli.'; return; }
    try {
      var yanit = CMS.istek
        ? await CMS.istek('/analiz/api/isaret', { method: 'POST', govde: govde })
        : await yedekIstek('/analiz/api/isaret', govde);
      if (yanit && yanit.govde && yanit.govde.tamam) {
        var yeni = yanit.govde.isaret;
        isaretler.push(yeni);
        isaretModaliKapat();
        durum.isaretModu = false;
        isaretModuGuncelle();
        isaretListesiYenile();
        istegeCiz();
      } else {
        if (hataEl) hataEl.textContent = (yanit && yanit.govde && yanit.govde.hata) || 'Kaydedilemedi.';
      }
    } catch (e) {
      if (hataEl) hataEl.textContent = 'Ağ hatası: kaydedilemedi.';
    }
  }
  async function yedekIstek(url, govde) {
    var y = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CMS.csrf || '', Accept: 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(govde)
    });
    return { govde: await y.json().catch(function () { return null; }) };
  }

  async function isaretSil(id) {
    try {
      var yanit = CMS.istek
        ? await CMS.istek('/analiz/api/isaret/' + encodeURIComponent(id) + '/sil', { method: 'POST', govde: {} })
        : await yedekIstek('/analiz/api/isaret/' + encodeURIComponent(id) + '/sil', {});
      if (yanit && yanit.govde && yanit.govde.tamam) {
        isaretler = isaretler.filter(function (m) { return String(m.id) !== String(id); });
        durum.secili = null;
        seciliGoster(null);
        isaretListesiYenile();
        istegeCiz();
      }
    } catch (e) { /* sessiz */ }
  }

  function isaretListesiYenile() {
    var liste = document.getElementById('kure-isaret-liste');
    var sayac = document.getElementById('kure-isaret-sayac');
    if (sayac) sayac.textContent = isaretler.length;
    if (!liste) return;
    if (!isaretler.length) { liste.innerHTML = '<p class="bos kucuk sonuk">Henüz işaret yok.</p>'; return; }
    liste.innerHTML = isaretler.map(function (m) {
      return '<button type="button" class="kure-liste-oge" data-isaret-git="' + m.id + '">'
        + '<span class="kure-liste-im" style="background:' + (m.renk || T.kehribar) + '"></span>'
        + '<span class="kure-liste-ad">' + kacir(m.baslik || 'İşaret') + '</span>'
        + '<span class="kure-liste-koor">' + Number(m.enlem).toFixed(2) + ', ' + Number(m.boylam).toFixed(2) + '</span>'
        + '</button>';
    }).join('');
  }

  function odaklan(lon, lat) {
    durum.merkezLon = lon; durum.merkezLat = Math.max(-89, Math.min(89, lat));
    if (durum.yakin < 2.2) durum.yakin = 2.6;
    istegeCiz();
  }

  // --------------------------------------------------------------- UI BAGLAMA
  function dugme(id, islev) { var d = document.getElementById(id); if (d) d.addEventListener('click', islev); }

  dugme('kure-yakin', function () { durum.yakin = Math.min(9, durum.yakin * 1.3); istegeCiz(); });
  dugme('kure-uzak', function () { durum.yakin = Math.max(0.6, durum.yakin / 1.3); istegeCiz(); });
  dugme('kure-dunya', function () { durum.yakin = 1; durum.merkezLon = 35; durum.merkezLat = 25; istegeCiz(); });
  dugme('kure-turkiye', function () { odaklan(35, 39); });

  function isaretModuGuncelle() {
    var d = document.getElementById('kure-isaret-ekle');
    if (d) d.classList.toggle('etkin', durum.isaretModu);
    if (elDurum && durum.isaretModu) elDurum.textContent = 'İŞARET MODU: haritada bir nokta seç';
  }
  dugme('kure-isaret-ekle', function () {
    durum.isaretModu = !durum.isaretModu;
    durum.olcumModu = false;
    var om = document.getElementById('kure-olcum'); if (om) om.classList.remove('etkin');
    isaretModuGuncelle();
  });
  dugme('kure-olcum', function () {
    durum.olcumModu = !durum.olcumModu;
    durum.olcumNoktalari = [];
    durum.isaretModu = false; isaretModuGuncelle();
    var d = document.getElementById('kure-olcum'); if (d) d.classList.toggle('etkin', durum.olcumModu);
    if (elDurum) elDurum.textContent = durum.olcumModu ? 'ÖLÇÜM: iki nokta seç' : '';
  });

  // Yuzey anahtari
  document.querySelectorAll('[data-yuzey]').forEach(function (b) {
    b.addEventListener('click', function () {
      durum.yuzey = b.getAttribute('data-yuzey');
      document.querySelectorAll('[data-yuzey]').forEach(function (x) { x.classList.toggle('etkin', x === b); });
      istegeCiz();
    });
  });

  // Katman anahtarlari
  document.querySelectorAll('[data-katman]').forEach(function (g) {
    g.addEventListener('change', function () {
      durum.katman[g.getAttribute('data-katman')] = g.checked;
      istegeCiz();
    });
  });

  // Isaret modali
  var isaretForm = document.getElementById('kure-isaret-form');
  if (isaretForm) isaretForm.addEventListener('submit', function (e) { e.preventDefault(); isaretKaydet(isaretForm); });
  dugme('kure-isaret-vazgec', isaretModaliKapat);
  dugme('kure-isaret-kapat', isaretModaliKapat);
  dugme('kure-secim-kapat', function () { seciliGoster(null); });

  // Delege: liste tiklama, isaret sil
  document.addEventListener('click', function (e) {
    var git = e.target.closest ? e.target.closest('[data-isaret-git]') : null;
    if (git) {
      var id = git.getAttribute('data-isaret-git');
      var m = isaretler.find(function (x) { return String(x.id) === String(id); });
      if (m) { odaklan(Number(m.boylam), Number(m.enlem)); durum.secili = m; seciliGoster({ el: m, tur: 'isaret' }); }
      return;
    }
    var sil = e.target.closest ? e.target.closest('[data-isaret-sil]') : null;
    if (sil) { isaretSil(sil.getAttribute('data-isaret-sil')); return; }
  });

  // Varlik arama/filtre
  var arama = document.getElementById('kure-arama');
  if (arama) {
    arama.addEventListener('input', function () {
      var q = arama.value.trim().toLocaleLowerCase('tr-TR');
      var liste = document.getElementById('kure-nokta-liste');
      if (!liste) return;
      liste.querySelectorAll('[data-ad]').forEach(function (el) {
        var ad = el.getAttribute('data-ad') || '';
        el.hidden = q && ad.indexOf(q) < 0;
      });
    });
  }
  // Nokta listesi -> odaklan
  var noktaListe = document.getElementById('kure-nokta-liste');
  if (noktaListe) {
    noktaListe.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-nokta]') : null;
      if (!b) return;
      var i = Number(b.getAttribute('data-nokta'));
      var n = noktalar[i];
      if (n) { odaklan(Number(n.boylam), Number(n.enlem)); durum.secili = n; seciliGoster({ el: n, tur: 'nokta' }); }
    });
  }

  var boyutZamanlayici = null;
  window.addEventListener('resize', function () {
    clearTimeout(boyutZamanlayici);
    boyutZamanlayici = setTimeout(function () { boyutlandir(); istegeCiz(); }, 140);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { isaretModaliKapat(); if (durum.isaretModu) { durum.isaretModu = false; isaretModuGuncelle(); } }
  });

  // --------------------------------------------------------------- BASLAT
  // Noktalar cogunlukla Turkiye disindaysa dunyaya ac.
  if (noktalar.length) {
    var ortLon = 0, ortLat = 0, s = 0;
    noktalar.forEach(function (n) { if (Number.isFinite(n.enlem)) { ortLon += n.boylam; ortLat += n.enlem; s++; } });
    if (s) { durum.merkezLon = ortLon / s; durum.merkezLat = ortLat / s; }
  }
  isaretListesiYenile();
  boyutlandir();
  istegeCiz();
  requestAnimationFrame(dongu);
})();
