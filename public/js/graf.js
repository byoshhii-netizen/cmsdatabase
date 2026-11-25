'use strict';
/**
 * public/js/graf.js
 * Kuvvet tabanli baglanti grafigi. Tamamen tarayicida hesaplanir; dis
 * kutuphane yok. Veri sunucudan data-graf niteligiyle gelir.
 *
 * Yerlesim:  Fruchterman-Reingold benzeri itme/cekme + merkeze cekim,
 *            Barnes-Hut yerine izgara tabanli komsuluk (O(n) yaklasim).
 */
(function () {
  const tuval = document.getElementById('graf-tuval');
  if (!tuval) return;

  const HUD = window.HUD || {};
  const veri = HUD.jsonNitelik ? HUD.jsonNitelik(tuval, 'data-graf') : null;
  if (!veri || !veri.dugumler || !veri.dugumler.length) return;

  const odakId = tuval.getAttribute('data-odak');
  const hedefId = tuval.getAttribute('data-hedef');
  let yolDizisi = [];
  try { yolDizisi = JSON.parse(tuval.getAttribute('data-yol') || '[]') || []; } catch (h) { yolDizisi = []; }
  const yolKumesi = new Set(yolDizisi.map(String));

  const bilgiKutu = document.getElementById('graf-bilgi');
  const t = HUD.tema ? HUD.tema() : { vurgu: '#00ff9c', kehribar: '#f0b429', camgobegi: '#22d3ee', kirmizi: '#ff4d5e', sonuk: '#6b7f8a', metin: '#9fb4bf', cizgi: 'rgba(255,255,255,.08)' };

  const TUR_RENK = {
    kisi: t.vurgu, kurum: t.kehribar, konum: t.camgobegi,
    arac: t.metin, telefon: t.metin, hesap: t.metin, cihaz: t.metin,
  };
  function dugumRenk(d) { return TUR_RENK[d.tur] || t.sonuk; }

  // ---------------------------------------------------------- VERI HAZIRLIK
  const dugumler = veri.dugumler.map(function (d, i) {
    const aci = (i / veri.dugumler.length) * Math.PI * 2;
    const yaricap = 120 + (i % 7) * 26;
    return {
      id: String(d.id),
      ad: d.ad || ('#' + d.id),
      tur: d.tur || 'diger',
      etki: Number(d.etki) || 20,
      derece: Number(d.derece) || 0,
      kod: d.kod || '',
      x: Math.cos(aci) * yaricap,
      y: Math.sin(aci) * yaricap,
      vx: 0, vy: 0,
      sabit: false,
    };
  });

  const harita = new Map();
  dugumler.forEach(function (d) { harita.set(d.id, d); });

  const kenarlar = [];
  veri.kenarlar.forEach(function (k) {
    const a = harita.get(String(k.a !== undefined ? k.a : k.kaynak));
    const b = harita.get(String(k.b !== undefined ? k.b : k.hedef));
    if (!a || !b || a === b) return;
    kenarlar.push({
      a, b,
      guc: Math.max(1, Number(k.guc) || 50),
      tur: k.tur || '',
      yolda: yolKumesi.has(a.id) && yolKumesi.has(b.id),
    });
  });

  // Dugum yaricapi: etki puanindan
  dugumler.forEach(function (d) {
    d.r = 4 + Math.sqrt(Math.max(0, d.etki)) * 1.25;
    if (d.id === odakId || d.id === hedefId) d.r += 3;
  });

  // ----------------------------------------------------------- GORUNUM / GIRDI
  const gorunum = { olcek: 1, kx: 0, ky: 0 };
  let etiketGoster = dugumler.length <= 120;
  let calisiyor = true;
  let surukle = null;
  let kaydir = null;
  let vurgulu = null;

  function olcuAl() {
    const dik = tuval.getBoundingClientRect();
    return { g: dik.width, y: dik.height, dik };
  }

  function ekranaCevir(d, olcu) {
    return {
      x: olcu.g / 2 + (d.x + gorunum.kx) * gorunum.olcek,
      y: olcu.y / 2 + (d.y + gorunum.ky) * gorunum.olcek,
    };
  }

  function enYakin(ex, ey, olcu) {
    let bulunan = null;
    let enIyi = 18 * 18;
    dugumler.forEach(function (d) {
      const p = ekranaCevir(d, olcu);
      const mesafe = (p.x - ex) * (p.x - ex) + (p.y - ey) * (p.y - ey);
      const esik = Math.max(enIyi, (d.r * gorunum.olcek + 6) * (d.r * gorunum.olcek + 6));
      if (mesafe < esik) { enIyi = mesafe; bulunan = d; }
    });
    return bulunan;
  }

  // ------------------------------------------------------------- YERLESIM
  const ITME = 2600;
  const YAY = 0.012;
  const MERKEZ = 0.0016;
  const SONUMLEME = 0.82;
  let sogutma = 1;

  function adim() {
    // Izgara ile komsu bulma: her hucre ~ 70 birim
    const hucre = 90;
    const izgara = new Map();
    dugumler.forEach(function (d) {
      const ax = Math.floor(d.x / hucre);
      const ay = Math.floor(d.y / hucre);
      const anahtar = ax + ':' + ay;
      if (!izgara.has(anahtar)) izgara.set(anahtar, []);
      izgara.get(anahtar).push(d);
      d.fx = 0; d.fy = 0;
    });

    // Itme: yalnizca komsu huclerdeki dugumler
    dugumler.forEach(function (d) {
      const ax = Math.floor(d.x / hucre);
      const ay = Math.floor(d.y / hucre);
      for (let i = -1; i <= 1; i += 1) {
        for (let j = -1; j <= 1; j += 1) {
          const komsular = izgara.get((ax + i) + ':' + (ay + j));
          if (!komsular) continue;
          for (let k = 0; k < komsular.length; k += 1) {
            const o = komsular[k];
            if (o === d) continue;
            let dx = d.x - o.x;
            let dy = d.y - o.y;
            let kare = dx * dx + dy * dy;
            if (kare < 0.01) { dx = (Math.random() - 0.5) * 2; dy = (Math.random() - 0.5) * 2; kare = 1; }
            if (kare > hucre * hucre * 4) continue;
            const kuvvet = ITME / kare;
            const uzaklik = Math.sqrt(kare);
            d.fx += (dx / uzaklik) * kuvvet;
            d.fy += (dy / uzaklik) * kuvvet;
          }
        }
      }
    });

    // Cekme: kenarlar yay gibi davranir, bag gucu yayi sertlestirir
    kenarlar.forEach(function (k) {
      const dx = k.b.x - k.a.x;
      const dy = k.b.y - k.a.y;
      const uzaklik = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const idealUzaklik = 150 - (k.guc / 100) * 70;
      const kuvvet = (uzaklik - idealUzaklik) * YAY * (0.4 + k.guc / 160);
      const bx = (dx / uzaklik) * kuvvet;
      const by = (dy / uzaklik) * kuvvet;
      k.a.fx += bx; k.a.fy += by;
      k.b.fx -= bx; k.b.fy -= by;
    });

    // Merkeze cekim: ag dagilmasin
    dugumler.forEach(function (d) {
      d.fx -= d.x * MERKEZ * (1 + d.derece * 0.02);
      d.fy -= d.y * MERKEZ * (1 + d.derece * 0.02);
    });

    let hareket = 0;
    dugumler.forEach(function (d) {
      if (d.sabit) { d.vx = 0; d.vy = 0; return; }
      d.vx = (d.vx + d.fx) * SONUMLEME;
      d.vy = (d.vy + d.fy) * SONUMLEME;
      const enfazla = 14 * sogutma + 0.6;
      const hiz = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
      if (hiz > enfazla) { d.vx = (d.vx / hiz) * enfazla; d.vy = (d.vy / hiz) * enfazla; }
      d.x += d.vx;
      d.y += d.vy;
      hareket += Math.abs(d.vx) + Math.abs(d.vy);
    });

    sogutma = Math.max(0.05, sogutma * 0.995);
    return hareket / Math.max(1, dugumler.length);
  }

  // ---------------------------------------------------------------- CIZIM
  function ciz() {
    const h = HUD.tuvalHazirla ? HUD.tuvalHazirla(tuval) : null;
    if (!h) return;
    const { ciz: c, g, y } = h;
    const olcu = { g, y };

    c.clearRect(0, 0, g, y);

    // Izgara zemin
    c.strokeStyle = t.cizgi;
    c.lineWidth = 1;
    const ara = 48 * gorunum.olcek;
    if (ara > 14) {
      const kx = (g / 2 + gorunum.kx * gorunum.olcek) % ara;
      const ky = (y / 2 + gorunum.ky * gorunum.olcek) % ara;
      c.globalAlpha = 0.5;
      for (let x = kx; x < g; x += ara) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, y); c.stroke(); }
      for (let yy = ky; yy < y; yy += ara) { c.beginPath(); c.moveTo(0, yy); c.lineTo(g, yy); c.stroke(); }
      c.globalAlpha = 1;
    }

    // Kenarlar
    kenarlar.forEach(function (k) {
      const pa = ekranaCevir(k.a, olcu);
      const pb = ekranaCevir(k.b, olcu);
      const komsuVurgu = vurgulu && (k.a === vurgulu || k.b === vurgulu);

      c.beginPath();
      c.moveTo(pa.x, pa.y);
      c.lineTo(pb.x, pb.y);
      if (k.yolda) {
        c.strokeStyle = t.kehribar;
        c.lineWidth = 2.6;
        c.globalAlpha = 0.95;
      } else if (komsuVurgu) {
        c.strokeStyle = t.vurgu;
        c.lineWidth = 1.6;
        c.globalAlpha = 0.9;
      } else {
        c.strokeStyle = t.metin;
        c.lineWidth = 0.4 + (k.guc / 100) * 1.8;
        c.globalAlpha = vurgulu ? 0.12 : 0.26;
      }
      c.stroke();
      c.globalAlpha = 1;
    });

    // Dugumler
    dugumler.forEach(function (d) {
      const p = ekranaCevir(d, olcu);
      if (p.x < -40 || p.x > g + 40 || p.y < -40 || p.y > y + 40) return;
      const r = Math.max(2.5, d.r * Math.sqrt(gorunum.olcek));
      const renk = dugumRenk(d);
      const onemli = d.id === odakId || d.id === hedefId || yolKumesi.has(d.id);
      const sonuklesti = vurgulu && vurgulu !== d
        && !kenarlar.some(function (k) {
          return (k.a === vurgulu && k.b === d) || (k.b === vurgulu && k.a === d);
        });

      c.globalAlpha = sonuklesti ? 0.22 : 1;

      if (onemli || d === vurgulu) {
        c.shadowColor = renk;
        c.shadowBlur = 16;
      }
      c.beginPath();
      c.arc(p.x, p.y, r, 0, Math.PI * 2);
      c.fillStyle = renk;
      c.fill();
      c.shadowBlur = 0;

      if (onemli) {
        c.beginPath();
        c.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
        c.strokeStyle = d.id === odakId ? t.vurgu : t.kehribar;
        c.lineWidth = 1.4;
        c.stroke();
      }

      if ((etiketGoster && r > 3.2) || d === vurgulu || onemli) {
        c.fillStyle = sonuklesti ? t.sonuk : '#dce9ef';
        c.font = (d === vurgulu ? 'bold ' : '') + '10px ' + getComputedStyle(document.body).fontFamily;
        c.textAlign = 'center';
        const ad = d.ad.length > 22 ? d.ad.slice(0, 21) + '…' : d.ad;
        c.fillText(ad, p.x, p.y - r - 5);
      }
      c.globalAlpha = 1;
    });
  }

  // ----------------------------------------------------------------- DONGU
  function dongu() {
    if (calisiyor) {
      const hareket = adim();
      if (hareket < 0.05 && sogutma < 0.3) calisiyor = false;
    }
    ciz();
    requestAnimationFrame(dongu);
  }

  // ---------------------------------------------------------------- OLAYLAR
  tuval.addEventListener('mousedown', function (olay) {
    const olcu = olcuAl();
    const ex = olay.clientX - olcu.dik.left;
    const ey = olay.clientY - olcu.dik.top;
    const d = enYakin(ex, ey, olcu);
    if (d) {
      surukle = { d, basX: ex, basY: ey, tasindi: false };
      d.sabit = true;
    } else {
      kaydir = { x: ex, y: ey, kx: gorunum.kx, ky: gorunum.ky };
    }
  });

  window.addEventListener('mousemove', function (olay) {
    const olcu = olcuAl();
    const ex = olay.clientX - olcu.dik.left;
    const ey = olay.clientY - olcu.dik.top;

    if (surukle) {
      surukle.d.x = (ex - olcu.g / 2) / gorunum.olcek - gorunum.kx;
      surukle.d.y = (ey - olcu.y / 2) / gorunum.olcek - gorunum.ky;
      surukle.d.vx = 0; surukle.d.vy = 0;
      if (Math.abs(ex - surukle.basX) + Math.abs(ey - surukle.basY) > 4) surukle.tasindi = true;
      calisiyor = true;
      sogutma = Math.max(sogutma, 0.35);
      return;
    }
    if (kaydir) {
      gorunum.kx = kaydir.kx + (ex - kaydir.x) / gorunum.olcek;
      gorunum.ky = kaydir.ky + (ey - kaydir.y) / gorunum.olcek;
      return;
    }
    if (ex < 0 || ey < 0 || ex > olcu.g || ey > olcu.y) { vurgulu = null; return; }

    const d = enYakin(ex, ey, olcu);
    if (d !== vurgulu) {
      vurgulu = d;
      if (bilgiKutu) {
        if (d) {
          const komsuSayisi = kenarlar.filter(function (k) { return k.a === d || k.b === d; }).length;
          bilgiKutu.hidden = false;
          bilgiKutu.textContent = d.ad + '  ·  ' + d.tur
            + '  ·  ' + komsuSayisi + ' bag  ·  etki ' + Math.round(d.etki)
            + (d.kod ? '  ·  ' + d.kod : '');
        } else {
          bilgiKutu.hidden = true;
        }
      }
    }
  });

  window.addEventListener('mouseup', function () {
    if (surukle && !surukle.tasindi) {
      window.location.href = '/arsiv/varlik/' + encodeURIComponent(surukle.d.id);
    }
    if (surukle) surukle.d.sabit = false;
    surukle = null;
    kaydir = null;
  });

  tuval.addEventListener('wheel', function (olay) {
    olay.preventDefault();
    const kat = olay.deltaY < 0 ? 1.12 : 1 / 1.12;
    gorunum.olcek = Math.max(0.15, Math.min(6, gorunum.olcek * kat));
  }, { passive: false });

  // Dokunmatik: tek parmak kaydirma, iki parmak yakinlastirma
  let dokunmaBas = null;
  tuval.addEventListener('touchstart', function (olay) {
    const olcu = olcuAl();
    if (olay.touches.length === 1) {
      const d = olay.touches[0];
      dokunmaBas = {
        tur: 'kaydir',
        x: d.clientX - olcu.dik.left, y: d.clientY - olcu.dik.top,
        kx: gorunum.kx, ky: gorunum.ky,
      };
    } else if (olay.touches.length === 2) {
      const a = olay.touches[0]; const b = olay.touches[1];
      dokunmaBas = {
        tur: 'olcek',
        uzaklik: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        olcek: gorunum.olcek,
      };
    }
  }, { passive: true });

  tuval.addEventListener('touchmove', function (olay) {
    if (!dokunmaBas) return;
    const olcu = olcuAl();
    if (dokunmaBas.tur === 'kaydir' && olay.touches.length === 1) {
      const d = olay.touches[0];
      gorunum.kx = dokunmaBas.kx + ((d.clientX - olcu.dik.left) - dokunmaBas.x) / gorunum.olcek;
      gorunum.ky = dokunmaBas.ky + ((d.clientY - olcu.dik.top) - dokunmaBas.y) / gorunum.olcek;
      olay.preventDefault();
    } else if (dokunmaBas.tur === 'olcek' && olay.touches.length === 2) {
      const a = olay.touches[0]; const b = olay.touches[1];
      const yeni = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      gorunum.olcek = Math.max(0.15, Math.min(6, dokunmaBas.olcek * (yeni / (dokunmaBas.uzaklik || 1))));
      olay.preventDefault();
    }
  }, { passive: false });

  tuval.addEventListener('touchend', function () { dokunmaBas = null; }, { passive: true });

  // Arac cubugu
  function dugmeBagla(kimlik, islev) {
    const d = document.getElementById(kimlik);
    if (d) d.addEventListener('click', islev);
  }
  dugmeBagla('graf-yakinlas', function () { gorunum.olcek = Math.min(6, gorunum.olcek * 1.25); });
  dugmeBagla('graf-uzaklas', function () { gorunum.olcek = Math.max(0.15, gorunum.olcek / 1.25); });
  dugmeBagla('graf-sifirla', function () {
    gorunum.olcek = 1; gorunum.kx = 0; gorunum.ky = 0;
    dugumler.forEach(function (d) { d.sabit = false; });
    sogutma = 1; calisiyor = true;
  });
  dugmeBagla('graf-etiket', function () { etiketGoster = !etiketGoster; });
  dugmeBagla('graf-dondur', function () {
    calisiyor = !calisiyor;
    if (calisiyor) sogutma = Math.max(sogutma, 0.4);
    const d = document.getElementById('graf-dondur');
    if (d) d.textContent = calisiyor ? '⏸' : '▶';
  });

  // Klavye erisimi: tuval odakliyken oklarla kaydirma
  tuval.setAttribute('tabindex', '0');
  tuval.addEventListener('keydown', function (olay) {
    const adimBoyu = 40 / gorunum.olcek;
    if (olay.key === 'ArrowLeft') gorunum.kx += adimBoyu;
    else if (olay.key === 'ArrowRight') gorunum.kx -= adimBoyu;
    else if (olay.key === 'ArrowUp') gorunum.ky += adimBoyu;
    else if (olay.key === 'ArrowDown') gorunum.ky -= adimBoyu;
    else if (olay.key === '+' || olay.key === '=') gorunum.olcek = Math.min(6, gorunum.olcek * 1.2);
    else if (olay.key === '-') gorunum.olcek = Math.max(0.15, gorunum.olcek / 1.2);
    else return;
    olay.preventDefault();
  });

  // Ilk 240 adimi gorunmeden isletip daha dengeli bir baslangic ver
  for (let i = 0; i < 240; i += 1) adim();
  sogutma = 0.6;
  requestAnimationFrame(dongu);
})();
