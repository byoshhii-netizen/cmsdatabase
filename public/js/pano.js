'use strict';
/* ==========================================================================
   public/js/pano.js
   /pano/:id  ->  Sonsuz tuval cizim/strateji editoru (Excalidraw tarzi).

   Tek dosyada: kamera (pan/zoom), tum arac modlari (secici, el, kalem,
   cizgi, ok, dikdortgen, elips, metin, yapiskan not, resim), geri al/ileri
   al, tum-pano ve tek-oge kilidi, anlik kaydetme (debounce + eszamanlilik
   kontrolu), JSON disa/ice aktarma.

   VERI MODELI (bkz. src/services/panoService.js)
     oge = { id, tur, veri:{...tur'e ozel}, x, y, genislik, yukseklik,
             renk, zSira, kilitli }
     - kalem            : veri.noktalar = [[x,y], ...] (DUNYA koordinati)
     - cizgi / ok        : (x,y) baslangic, (x+genislik, y+yukseklik) bitis
     - dikdortgen/elips  : (x,y) sol-ust, genislik/yukseklik boyut
     - metin             : (x,y) sol-ust, veri.metin, veri.boyut (punto)
     - not               : (x,y) sol-ust, genislik/yukseklik, veri.metin
     - resim             : (x,y) sol-ust, genislik/yukseklik, veri.src (b64)

   Her kaydet() cagrisi TUM oge listesini sunucuya yollar (enstantane);
   sunucu o panoya ait satirlari silip yeniden ekler. Bu yuzden istemci
   kendi urettigi negatif gecici id'leri sonsuza dek kullanabilir -
   sunucudan donen id'lerle hicbir zaman eslestirme yapmaya gerek yoktur
   (resim yukleme ucu haric; o dogrudan kalici positive id doner).
   ========================================================================== */

(function (kuresel) {
  const belge = kuresel.document;

  function hazir(f) {
    if (belge.readyState === 'loading') belge.addEventListener('DOMContentLoaded', f);
    else f();
  }

  hazir(() => {
    const kok = belge.getElementById('pano-editor');
    if (!kok) return; // bu sayfa /pano editoru degil

    /* --------------------------------------------------------- DOM REFS */
    const panoId = Number(kok.dataset.panoId);
    const resimMaxMb = Number(kok.dataset.resimMaxMb) || 6;

    const sarmal = belge.getElementById('pano-tuval-sarmal');
    const tuval = belge.getElementById('pano-tuval');
    const ctx = tuval.getContext('2d');
    const metinKatmani = belge.getElementById('pano-metin-katmani');
    const miniArac = belge.getElementById('pano-mini-arac');
    const kilitliPerde = belge.getElementById('pano-kilitli-perde');
    const kilitEtiket = belge.getElementById('pano-kilit-etiket');
    const kayitLamba = belge.getElementById('pano-kayit-lamba');
    const adGirdi = belge.getElementById('pano-ad-girdi');
    const renkGirdi = belge.getElementById('pano-renk');
    const kalinlikGirdi = belge.getElementById('pano-kalinlik');
    const zoomYuzde = belge.getElementById('pano-zoom-yuzde');
    const resimGirdi = belge.getElementById('pano-resim-girdi');
    const yedekGirdi = belge.getElementById('pano-yedek-girdi');
    const araclar = belge.getElementById('pano-arac-cubugu');

    if (!sarmal || !tuval || !ctx) return;

    /* ------------------------------------------------------------ DURUM */
    const GECMIS_LIMIT = 80;
    const IZGARA_ADIM = 50;

    const d = {
      kilitli: kok.dataset.kilitli === '1',
      surum: Number(kok.dataset.surum) || 1,
      kamera: { x: 0, y: 0, olcek: 1 },
      izgara: true,
      ogeler: [],
      seciliIdler: new Set(),
      aktifArac: 'secici',
      renk: '#00ff9c',
      kalinlik: 3,
      yeniIdSayaci: -1,
      dpr: kuresel.devicePixelRatio || 1,

      gecmis: [],
      ileri: [],

      // etkilesim
      isaretciler: new Map(), // pointerId -> {x,y}
      panSurukluyor: false,
      panBaslangic: null,       // {ekranX, ekranY, kameraX, kameraY}
      pinchBaslangic: null,     // {mesafe, olcek, ortaEkran, ortaDunya}
      cizimSurukluyor: false,
      cizimTaslak: null,        // yeni olusturulan oge (henuz listeye eklenmedi)
      seciciSurukluyor: false,
      seciciMod: null,          // 'tasima' | 'marquee' | 'yeniden-boyut' | 'uc-nokta'
      seciciBaslangic: null,
      marqueeDikdortgen: null,
      tutamacTur: null,
      tutamacOgeId: null,

      resimOnbellek: new Map(), // src -> HTMLImageElement
      metinDuzenleyici: null,   // aktif textarea duzenleyici referansi

      kaydediliyor: false,
      kaydetBekliyor: false,
      kaydetZamanlayici: null,
      sonIstekGovdesi: null,
    };

    /* ----------------------------------------------------- YARDIMCILAR */
    function sayiTemiz(v, varsayilan = 0) { return Number.isFinite(Number(v)) ? Number(v) : varsayilan; }

    function ekranKonum(olay) {
      const r = sarmal.getBoundingClientRect();
      return { x: olay.clientX - r.left, y: olay.clientY - r.top };
    }

    function ekrandanDunyaya(ex, ey) {
      return { x: (ex - d.kamera.x) / d.kamera.olcek, y: (ey - d.kamera.y) / d.kamera.olcek };
    }
    function dunyadanEkrana(wx, wy) {
      return { x: wx * d.kamera.olcek + d.kamera.x, y: wy * d.kamera.olcek + d.kamera.y };
    }

    function yeniId() { return d.yeniIdSayaci--; }

    function ogeBul(id) { return d.ogeler.find((o) => o.id === id) || null; }

    function enUstZSira() {
      let maks = 0;
      d.ogeler.forEach((o) => { if (o.zSira > maks) maks = o.zSira; });
      return maks + 1;
    }

    /** Herhangi bir oge turu icin DUNYA koordinatinda kapsayici kutu. */
    function ogeKutusu(o) {
      if (o.tur === 'kalem') {
        const noktalar = (o.veri && o.veri.noktalar) || [];
        if (noktalar.length === 0) return { x: o.x, y: o.y, genislik: 0, yukseklik: 0 };
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        noktalar.forEach(([px, py]) => {
          if (px < minX) minX = px; if (py < minY) minY = py;
          if (px > maxX) maxX = px; if (py > maxY) maxY = py;
        });
        return { x: minX, y: minY, genislik: maxX - minX, yukseklik: maxY - minY };
      }
      if (o.tur === 'cizgi' || o.tur === 'ok') {
        const x2 = o.x + (o.genislik || 0), y2 = o.y + (o.yukseklik || 0);
        return { x: Math.min(o.x, x2), y: Math.min(o.y, y2), genislik: Math.abs(o.genislik || 0), yukseklik: Math.abs(o.yukseklik || 0) };
      }
      if (o.tur === 'metin') {
        const boyut = (o.veri && o.veri.boyut) || 18;
        const satirlar = String((o.veri && o.veri.metin) || '').split('\n');
        let maksGenislik = 10;
        ctx.save();
        ctx.font = `${boyut}px "JetBrains Mono", monospace`;
        satirlar.forEach((s) => { const g = ctx.measureText(s).width; if (g > maksGenislik) maksGenislik = g; });
        ctx.restore();
        return { x: o.x, y: o.y, genislik: maksGenislik + 6, yukseklik: satirlar.length * boyut * 1.3 + 6 };
      }
      return { x: o.x, y: o.y, genislik: o.genislik || 0, yukseklik: o.yukseklik || 0 };
    }

    /** Nokta (dunya) bir ogenin icinde mi? */
    function noktaOgedeMi(o, wx, wy) {
      const tol = 6 / d.kamera.olcek;
      if (o.tur === 'kalem') {
        const noktalar = (o.veri && o.veri.noktalar) || [];
        for (let i = 1; i < noktalar.length; i++) {
          if (nokta_segment_mesafe(wx, wy, noktalar[i - 1][0], noktalar[i - 1][1], noktalar[i][0], noktalar[i][1]) < tol + 4) return true;
        }
        return false;
      }
      if (o.tur === 'cizgi' || o.tur === 'ok') {
        const x2 = o.x + (o.genislik || 0), y2 = o.y + (o.yukseklik || 0);
        return nokta_segment_mesafe(wx, wy, o.x, o.y, x2, y2) < tol + (((o.veri && o.veri.kalinlik) || 3) / 2 + 3);
      }
      if (o.tur === 'elips') {
        const kutu = ogeKutusu(o);
        const rx = kutu.genislik / 2 || 1, ry = kutu.yukseklik / 2 || 1;
        const cx = kutu.x + rx, cy = kutu.y + ry;
        const nx = (wx - cx) / rx, ny = (wy - cy) / ry;
        return (nx * nx + ny * ny) <= 1.08;
      }
      const kutu = ogeKutusu(o);
      return wx >= kutu.x - tol && wx <= kutu.x + kutu.genislik + tol && wy >= kutu.y - tol && wy <= kutu.y + kutu.yukseklik + tol;
    }

    function nokta_segment_mesafe(px, py, x1, y1, x2, y2) {
      const dx = x2 - x1, dy = y2 - y1;
      const uzunlukKare = dx * dx + dy * dy;
      let t = uzunlukKare === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / uzunlukKare;
      t = Math.max(0, Math.min(1, t));
      const ex = x1 + t * dx, ey = y1 + t * dy;
      return Math.hypot(px - ex, py - ey);
    }

    function dikdortgenlerKesisiyorMu(a, b) {
      return a.x < b.x + b.genislik && a.x + a.genislik > b.x && a.y < b.y + b.yukseklik && a.y + a.yukseklik > b.y;
    }

    /** En ustteki (zSira en buyuk) isabet eden ogeyi doner. */
    function noktadaOgeBul(wx, wy) {
      const siraliTersten = [...d.ogeler].sort((a, b) => b.zSira - a.zSira);
      for (const o of siraliTersten) {
        if (noktaOgedeMi(o, wx, wy)) return o;
      }
      return null;
    }

    /* --------------------------------------------------- GORUNUM / CIZIM */
    function tuvalBoyutlandir() {
      const genislik = sarmal.clientWidth;
      const yukseklik = sarmal.clientHeight;
      d.dpr = kuresel.devicePixelRatio || 1;
      tuval.width = Math.max(1, Math.round(genislik * d.dpr));
      tuval.height = Math.max(1, Math.round(yukseklik * d.dpr));
      ciz();
    }

    function yuvarlakDikdortgenYolu(x, y, g, h, r) {
      const yr = Math.min(r, Math.abs(g) / 2, Math.abs(h) / 2);
      ctx.beginPath();
      ctx.moveTo(x + yr, y);
      ctx.arcTo(x + g, y, x + g, y + h, yr);
      ctx.arcTo(x + g, y + h, x, y + h, yr);
      ctx.arcTo(x, y + h, x, y, yr);
      ctx.arcTo(x, y, x + g, y, yr);
      ctx.closePath();
    }

    function metinSarmaCiz(metin, x, y, maxGenislik, satirYuksekligi) {
      const kelimeler = String(metin || '').split(/\s+/).filter(Boolean);
      let satir = '';
      let ey = y;
      const satirlar = [];
      kelimeler.forEach((kelime) => {
        const aday = satir ? satir + ' ' + kelime : kelime;
        if (ctx.measureText(aday).width > maxGenislik && satir) {
          satirlar.push(satir);
          satir = kelime;
        } else {
          satir = aday;
        }
      });
      if (satir) satirlar.push(satir);
      satirlar.slice(0, 40).forEach((s) => { ctx.fillText(s, x, ey); ey += satirYuksekligi; });
    }

    function okUcuCiz(x1, y1, x2, y2, renk, kalinlik) {
      const aci = Math.atan2(y2 - y1, x2 - x1);
      const uzunluk = Math.max(10, kalinlik * 3.2);
      const genislikAci = Math.PI / 7;
      ctx.save();
      ctx.fillStyle = renk;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - uzunluk * Math.cos(aci - genislikAci), y2 - uzunluk * Math.sin(aci - genislikAci));
      ctx.lineTo(x2 - uzunluk * Math.cos(aci + genislikAci), y2 - uzunluk * Math.sin(aci + genislikAci));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    function resimYukle(src) {
      if (!src) return null;
      let girdi = d.resimOnbellek.get(src);
      if (!girdi) {
        const img = new Image();
        img.src = src;
        girdi = img;
        d.resimOnbellek.set(src, girdi);
      }
      return girdi;
    }

    function ogeCiz(o) {
      ctx.save();
      const kalinlik = (o.veri && o.veri.kalinlik) || 3;
      switch (o.tur) {
        case 'kalem': {
          const noktalar = (o.veri && o.veri.noktalar) || [];
          if (noktalar.length < 2) { ctx.restore(); return; }
          ctx.strokeStyle = o.renk;
          ctx.lineWidth = kalinlik;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(noktalar[0][0], noktalar[0][1]);
          for (let i = 1; i < noktalar.length; i++) ctx.lineTo(noktalar[i][0], noktalar[i][1]);
          ctx.stroke();
          break;
        }
        case 'cizgi':
        case 'ok': {
          const x2 = o.x + (o.genislik || 0), y2 = o.y + (o.yukseklik || 0);
          ctx.strokeStyle = o.renk;
          ctx.lineWidth = kalinlik;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(o.x, o.y);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          if (o.tur === 'ok') okUcuCiz(o.x, o.y, x2, y2, o.renk, kalinlik);
          break;
        }
        case 'dikdortgen': {
          ctx.strokeStyle = o.renk;
          ctx.lineWidth = kalinlik;
          ctx.strokeRect(o.x, o.y, o.genislik || 0, o.yukseklik || 0);
          break;
        }
        case 'elips': {
          const kutu = ogeKutusu(o);
          const rx = kutu.genislik / 2, ry = kutu.yukseklik / 2;
          ctx.strokeStyle = o.renk;
          ctx.lineWidth = kalinlik;
          ctx.beginPath();
          ctx.ellipse(kutu.x + rx, kutu.y + ry, Math.max(rx, 0.01), Math.max(ry, 0.01), 0, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'metin': {
          const boyut = (o.veri && o.veri.boyut) || 18;
          ctx.fillStyle = o.renk;
          ctx.font = `${boyut}px "JetBrains Mono", monospace`;
          ctx.textBaseline = 'top';
          const satirlar = String((o.veri && o.veri.metin) || '').split('\n');
          satirlar.forEach((s, i) => ctx.fillText(s, o.x, o.y + i * (boyut * 1.3)));
          break;
        }
        case 'not': {
          const g = o.genislik || 200, h = o.yukseklik || 140;
          ctx.fillStyle = o.renk || '#1d9c6e';
          yuvarlakDikdortgenYolu(o.x, o.y, g, h, 6);
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.35)';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = '#04120c';
          ctx.font = '13px "JetBrains Mono", monospace';
          ctx.textBaseline = 'top';
          metinSarmaCiz((o.veri && o.veri.metin) || '', o.x + 10, o.y + 10, g - 20, 17);
          break;
        }
        case 'resim': {
          const img = resimYukle(o.veri && o.veri.src);
          if (img && img.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, o.x, o.y, o.genislik || img.naturalWidth, o.yukseklik || img.naturalHeight);
          } else {
            ctx.strokeStyle = 'rgba(0,255,156,0.35)';
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(o.x, o.y, o.genislik || 100, o.yukseklik || 100);
            ctx.setLineDash([]);
          }
          break;
        }
        default: break;
      }
      ctx.restore();
    }

    function izgaraCiz() {
      if (!d.izgara) return;
      const genislikCss = tuval.width / d.dpr, yukseklikCss = tuval.height / d.dpr;
      const solUst = ekrandanDunyaya(0, 0);
      const sagAlt = ekrandanDunyaya(genislikCss, yukseklikCss);
      const baslaX = Math.floor(solUst.x / IZGARA_ADIM) * IZGARA_ADIM;
      const baslaY = Math.floor(solUst.y / IZGARA_ADIM) * IZGARA_ADIM;
      const dikeySayisi = (sagAlt.x - baslaX) / IZGARA_ADIM;
      const yataySayisi = (sagAlt.y - baslaY) / IZGARA_ADIM;
      if (dikeySayisi > 500 || yataySayisi > 500) return; // asiri yakinlastirma/uzaklastirma guvenligi

      ctx.save();
      ctx.strokeStyle = 'rgba(0, 255, 156, 0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let wx = baslaX; wx <= sagAlt.x; wx += IZGARA_ADIM) {
        const ex = Math.round(dunyadanEkrana(wx, 0).x) + 0.5;
        ctx.moveTo(ex, 0);
        ctx.lineTo(ex, yukseklikCss);
      }
      for (let wy = baslaY; wy <= sagAlt.y; wy += IZGARA_ADIM) {
        const ey = Math.round(dunyadanEkrana(0, wy).y) + 0.5;
        ctx.moveTo(0, ey);
        ctx.lineTo(genislikCss, ey);
      }
      ctx.stroke();
      ctx.restore();
    }

    function secimKutusuCiz(kutu) {
      const sol = dunyadanEkrana(kutu.x, kutu.y);
      const sag = dunyadanEkrana(kutu.x + kutu.genislik, kutu.y + kutu.yukseklik);
      ctx.save();
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(sol.x - 4, sol.y - 4, (sag.x - sol.x) + 8, (sag.y - sol.y) + 8);
      ctx.restore();
      return { sol, sag };
    }

    function tutamaclariCiz(o, ekranSol, ekranSag) {
      const tutamaclar = tutamacNoktalariniGetir(o, ekranSol, ekranSag);
      ctx.save();
      tutamaclar.forEach((t) => {
        ctx.fillStyle = '#04070a';
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(t.x, t.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
      ctx.restore();
    }

    /** Secili ogeye gore (ekran koordinatinda) tutamac noktalarini doner. */
    function tutamacNoktalariniGetir(o, ekranSol, ekranSag) {
      if (o.tur === 'cizgi' || o.tur === 'ok') {
        const p1 = dunyadanEkrana(o.x, o.y);
        const p2 = dunyadanEkrana(o.x + (o.genislik || 0), o.y + (o.yukseklik || 0));
        return [{ ad: 'uc-a', x: p1.x, y: p1.y }, { ad: 'uc-b', x: p2.x, y: p2.y }];
      }
      if (o.tur === 'dikdortgen' || o.tur === 'elips' || o.tur === 'not' || o.tur === 'resim') {
        return [
          { ad: 'sol-ust', x: ekranSol.x, y: ekranSol.y },
          { ad: 'sag-ust', x: ekranSag.x, y: ekranSol.y },
          { ad: 'sol-alt', x: ekranSol.x, y: ekranSag.y },
          { ad: 'sag-alt', x: ekranSag.x, y: ekranSag.y },
        ];
      }
      return [];
    }

    function ciz() {
      ctx.setTransform(d.dpr, 0, 0, d.dpr, 0, 0);
      const genislikCss = tuval.width / d.dpr, yukseklikCss = tuval.height / d.dpr;
      ctx.clearRect(0, 0, genislikCss, yukseklikCss);

      izgaraCiz();

      ctx.save();
      ctx.translate(d.kamera.x, d.kamera.y);
      ctx.scale(d.kamera.olcek, d.kamera.olcek);
      [...d.ogeler].sort((a, b) => a.zSira - b.zSira).forEach((o) => ogeCiz(o));
      if (d.cizimTaslak) ogeCiz(d.cizimTaslak);
      ctx.restore();

      // Secim gostergeleri (ekran uzayinda, zoom'dan bagimsiz kalinlik icin)
      if (d.seciliIdler.size > 0) {
        d.seciliIdler.forEach((id) => {
          const o = ogeBul(id);
          if (!o) return;
          const kutu = ogeKutusu(o);
          const { sol, sag } = secimKutusuCiz(kutu);
          if (d.seciliIdler.size === 1 && !o.kilitli && !d.kilitli) tutamaclariCiz(o, sol, sag);
        });
      }

      if (d.marqueeDikdortgen) {
        const m = d.marqueeDikdortgen;
        ctx.save();
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.8)';
        ctx.fillStyle = 'rgba(34, 211, 238, 0.08)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.fillRect(m.x, m.y, m.genislik, m.yukseklik);
        ctx.strokeRect(m.x, m.y, m.genislik, m.yukseklik);
        ctx.restore();
      }

      miniAracKonumla();
      if (d.metinDuzenleyici) d.metinDuzenleyici.konumla();
    }

    /* --------------------------------------------------- MINI ARAC KUTUSU */
    function miniAracKonumla() {
      if (d.seciliIdler.size !== 1 || d.kilitli) { miniArac.classList.add('gizli'); return; }
      const o = ogeBul([...d.seciliIdler][0]);
      if (!o) { miniArac.classList.add('gizli'); return; }
      const kutu = ogeKutusu(o);
      const ustOrta = dunyadanEkrana(kutu.x + kutu.genislik / 2, kutu.y);
      miniArac.classList.remove('gizli');
      miniArac.style.left = `${Math.round(ustOrta.x)}px`;
      miniArac.style.top = `${Math.round(ustOrta.y - 42)}px`;
      miniArac.style.transform = 'translateX(-50%)';
      const kilitDugme = miniArac.querySelector('[data-pano-aksiyon="oge-kilit"]');
      if (kilitDugme) kilitDugme.classList.toggle('etkin', Boolean(o.kilitli));
    }

    /* ----------------------------------------------------- GECMIS (UNDO) */
    function anlikGoruntu() {
      return JSON.stringify(d.ogeler);
    }
    function gecmiseKaydet() {
      d.gecmis.push(anlikGoruntu());
      if (d.gecmis.length > GECMIS_LIMIT) d.gecmis.shift();
      d.ileri.length = 0;
    }
    function geriAl() {
      if (d.kilitli || d.gecmis.length === 0) return;
      d.ileri.push(anlikGoruntu());
      const onceki = d.gecmis.pop();
      d.ogeler = JSON.parse(onceki);
      d.seciliIdler.clear();
      ciz();
      kaydetPlanla();
      if (kuresel.Ses) kuresel.Ses.tik();
    }
    function ileriAl() {
      if (d.kilitli || d.ileri.length === 0) return;
      d.gecmis.push(anlikGoruntu());
      const sonraki = d.ileri.pop();
      d.ogeler = JSON.parse(sonraki);
      d.seciliIdler.clear();
      ciz();
      kaydetPlanla();
      if (kuresel.Ses) kuresel.Ses.tik();
    }

    /* -------------------------------------------------------- KAYDETME */
    function kayitLambaGoster(durum) {
      // durum: 'kaydedildi' | 'kaydediliyor' | 'bekliyor' | 'hata'
      kayitLamba.classList.remove('lamba--aktif', 'lamba--bekle', 'lamba--hata');
      if (durum === 'kaydediliyor' || durum === 'bekliyor') {
        kayitLamba.classList.add('lamba--bekle');
        kayitLamba.textContent = 'KAYDEDILIYOR';
      } else if (durum === 'hata') {
        kayitLamba.classList.add('lamba--hata');
        kayitLamba.textContent = 'KAYDEDILEMEDI';
      } else {
        kayitLamba.classList.add('lamba--aktif');
        kayitLamba.textContent = 'KAYITLI';
      }
    }

    /**
     * Pano listesindeki kucuk onizleme resmi: tam panoyu yeniden cizmek
     * yerine, tuvalin O ANKI gorunen karesini (mevcut pan/zoom) kucultulmus
     * olarak kopyalar. Basit, hizli ve her zaman ekranda gorduguyle tutarli.
     */
    function onizlemeUret() {
      try {
        const HEDEF_G = 320, HEDEF_H = 200;
        const kucukTuval = belge.createElement('canvas');
        kucukTuval.width = HEDEF_G; kucukTuval.height = HEDEF_H;
        const kctx = kucukTuval.getContext('2d');
        kctx.fillStyle = '#04070a';
        kctx.fillRect(0, 0, HEDEF_G, HEDEF_H);

        if (tuval.width > 0 && tuval.height > 0) {
          const kaynakOran = tuval.width / tuval.height;
          const hedefOran = HEDEF_G / HEDEF_H;
          let sw = tuval.width, sh = tuval.height, sx = 0, sy = 0;
          if (kaynakOran > hedefOran) { sw = tuval.height * hedefOran; sx = (tuval.width - sw) / 2; }
          else { sh = tuval.width / hedefOran; sy = (tuval.height - sh) / 2; }
          kctx.drawImage(tuval, sx, sy, sw, sh, 0, 0, HEDEF_G, HEDEF_H);
        }
        return kucukTuval.toDataURL('image/jpeg', 0.55);
      } catch (_) {
        return null;
      }
    }

    async function kaydet({ zorla = false } = {}) {
      if (d.kaydediliyor) { d.kaydetBekliyor = true; return; }
      d.kaydediliyor = true;
      kayitLambaGoster('kaydediliyor');

      const govde = {
        ad: adGirdi.value,
        tuval: { kamera: d.kamera, izgara: d.izgara },
        onizleme: onizlemeUret(),
        ogeler: d.ogeler.map((o) => ({
          tur: o.tur, veri: o.veri, x: o.x, y: o.y,
          genislik: o.genislik, yukseklik: o.yukseklik,
          renk: o.renk, zSira: o.zSira, kilitli: Boolean(o.kilitli),
        })),
        beklenenSurum: d.surum,
        zorla,
      };

      try {
        const sonuc = await kuresel.CMS.istek(`/pano/${panoId}/kaydet`, { method: 'POST', govde });
        if (sonuc.durum === 200 && sonuc.govde && sonuc.govde.tamam) {
          d.surum = sonuc.govde.surum;
          kayitLambaGoster('kaydedildi');
        } else if (sonuc.durum === 409 && sonuc.govde) {
          // Celiski: baska yerden guncellenmis - sunucunun guncel halini yukle.
          if (kuresel.Ses) kuresel.Ses.ret();
          d.surum = sonuc.govde.surum || d.surum;
          d.ogeler = (sonuc.govde.ogeler || []).map(sunucuOgesiniYereleGetir);
          d.seciliIdler.clear();
          gecmiseKaydet();
          ciz();
          kayitLambaGoster('kaydedildi');
        } else {
          kayitLambaGoster('hata');
          if (kuresel.Ses) kuresel.Ses.ret();
        }
      } catch (_) {
        kayitLambaGoster('hata');
      } finally {
        d.kaydediliyor = false;
        if (d.kaydetBekliyor) { d.kaydetBekliyor = false; kaydet(); }
      }
    }

    function kaydetPlanla() {
      kayitLambaGoster('bekliyor');
      if (d.kaydetZamanlayici) kuresel.clearTimeout(d.kaydetZamanlayici);
      d.kaydetZamanlayici = kuresel.setTimeout(() => kaydet(), 900);
    }

    function sunucuOgesiniYereleGetir(satir) {
      return {
        id: yeniId(),
        tur: satir.tur, veri: satir.veri || {}, x: sayiTemiz(satir.x), y: sayiTemiz(satir.y),
        genislik: satir.genislik === null ? null : sayiTemiz(satir.genislik, null),
        yukseklik: satir.yukseklik === null ? null : sayiTemiz(satir.yukseklik, null),
        renk: satir.renk || '#00ff9c', zSira: sayiTemiz(satir.z_sira ?? satir.zSira, 0), kilitli: Boolean(satir.kilitli),
      };
    }

    /* --------------------------------------------------------- YUKLEME */
    async function ilkYukleme() {
      try {
        const sonuc = await kuresel.CMS.istek(`/pano/${panoId}/veri`);
        if (!sonuc.govde || !sonuc.govde.tamam) throw new Error('veri alinamadi');
        const { pano, ogeler } = sonuc.govde;
        d.surum = pano.surum;
        d.kilitli = Boolean(pano.kilitli);
        if (pano.tuval && pano.tuval.kamera) d.kamera = { ...d.kamera, ...pano.tuval.kamera };
        if (pano.tuval && typeof pano.tuval.izgara === 'boolean') d.izgara = pano.tuval.izgara;
        d.ogeler = ogeler.map(sunucuOgesiniYereleGetir);
        kilitDurumunuUygula();
        zoomGostergesiGuncelle();
        ciz();
      } catch (_) {
        kayitLambaGoster('hata');
      }
    }

    function kilitDurumunuUygula() {
      kilitEtiket.classList.toggle('gizli', !d.kilitli);
      kilitliPerde.classList.toggle('gizli', !d.kilitli);
      araclar.querySelectorAll('.arac-dugme[data-arac]').forEach((b) => {
        if (b.dataset.arac === 'secici' || b.dataset.arac === 'el') return;
        b.disabled = d.kilitli;
      });
    }

    /* --------------------------------------------------------- ARAC SECIMI */
    function aracSec(arac) {
      if (d.metinDuzenleyici) metinDuzenlemeyiBitir();
      d.aktifArac = arac;
      sarmal.dataset.arac = arac;
      araclar.querySelectorAll('.arac-dugme[data-arac]').forEach((b) => b.classList.toggle('etkin', b.dataset.arac === arac));
      if (arac === 'resim') {
        resimGirdi.click();
        aracSec('secici');
      }
      if (kuresel.Ses) kuresel.Ses.tik();
    }

    araclar.querySelectorAll('.arac-dugme[data-arac]').forEach((b) => {
      b.addEventListener('click', () => aracSec(b.dataset.arac));
    });

    renkGirdi.addEventListener('input', () => { d.renk = renkGirdi.value; });
    kalinlikGirdi.addEventListener('input', () => { d.kalinlik = Number(kalinlikGirdi.value) || 3; });

    /* --------------------------------------------------------- ZOOM/PAN */
    function zoomGostergesiGuncelle() {
      zoomYuzde.textContent = `${Math.round(d.kamera.olcek * 100)}%`;
    }

    function odaklanarakYakinlastir(ekranX, ekranY, carpan) {
      const oncekiDunya = ekrandanDunyaya(ekranX, ekranY);
      d.kamera.olcek = Math.max(0.1, Math.min(8, d.kamera.olcek * carpan));
      const sonrakiEkran = dunyadanEkrana(oncekiDunya.x, oncekiDunya.y);
      d.kamera.x += ekranX - sonrakiEkran.x;
      d.kamera.y += ekranY - sonrakiEkran.y;
      zoomGostergesiGuncelle();
      ciz();
    }

    // Standart tuval kurali: duz tekerlek = kaydirma (pan), Ctrl/Cmd+tekerlek
    // (veya trackpad sikistirmasi, tarayicida ctrlKey=true olarak gelir) = yakinlastirma.
    sarmal.addEventListener('wheel', (olay) => {
      olay.preventDefault();
      if (olay.ctrlKey || olay.metaKey) {
        const nokta = ekranKonum(olay);
        const carpan = olay.deltaY < 0 ? 1.08 : 1 / 1.08;
        odaklanarakYakinlastir(nokta.x, nokta.y, carpan);
      } else {
        d.kamera.x -= olay.deltaX;
        d.kamera.y -= olay.deltaY;
        ciz();
        kaydetPlanla();
      }
    }, { passive: false });

    belge.getElementById('pano-editor').addEventListener('click', (olay) => {
      const dugme = olay.target.closest('[data-pano-aksiyon]');
      if (!dugme) return;
      panoAksiyonCalistir(dugme.dataset.panoAksiyon, olay);
    });

    function panoAksiyonCalistir(aksiyon) {
      const merkezX = tuval.width / d.dpr / 2, merkezY = tuval.height / d.dpr / 2;
      if (aksiyon === 'yakinlastir') return odaklanarakYakinlastir(merkezX, merkezY, 1.2);
      if (aksiyon === 'uzaklastir') return odaklanarakYakinlastir(merkezX, merkezY, 1 / 1.2);
      if (aksiyon === 'sifirla-gorunum') {
        d.kamera = { x: 0, y: 0, olcek: 1 };
        zoomGostergesiGuncelle(); ciz(); kaydetPlanla();
        return;
      }
      if (aksiyon === 'geri-al') return geriAl();
      if (aksiyon === 'ileri-al') return ileriAl();
      if (aksiyon === 'kilit') return tumPanoKilidiDegistir();
      if (aksiyon === 'disa-aktar') return disaAktar();
      if (aksiyon === 'ice-aktar') return yedekGirdi.click();
      if (aksiyon === 'oge-kilit') return seciliOgeKilidiDegistir();
      if (aksiyon === 'one-al') return seciliZSiraTasi(1);
      if (aksiyon === 'arkaya-gonder') return seciliZSiraTasi(-1);
      if (aksiyon === 'oge-sil') return seciliSil();
    }

    /* --------------------------------------------------- TUM PANO KILIDI */
    async function tumPanoKilidiDegistir() {
      const yeniDurum = !d.kilitli;
      try {
        const sonuc = await kuresel.CMS.istek(`/pano/${panoId}/kilit`, { method: 'POST', govde: { kilitli: yeniDurum } });
        if (sonuc.govde && sonuc.govde.tamam) {
          d.kilitli = sonuc.govde.kilitli;
          kilitDurumunuUygula();
          if (d.kilitli) { d.seciliIdler.clear(); aracSec('secici'); }
          ciz();
          if (kuresel.Ses) kuresel.Ses.onay();
        }
      } catch (_) {
        if (kuresel.Ses) kuresel.Ses.ret();
      }
    }

    function seciliOgeKilidiDegistir() {
      if (d.kilitli || d.seciliIdler.size !== 1) return;
      const o = ogeBul([...d.seciliIdler][0]);
      if (!o) return;
      gecmiseKaydet();
      o.kilitli = !o.kilitli;
      ciz();
      kaydetPlanla();
      if (kuresel.Ses) kuresel.Ses.tik();
    }

    function seciliZSiraTasi(yon) {
      if (d.kilitli || d.seciliIdler.size === 0) return;
      gecmiseKaydet();
      if (yon > 0) {
        const maks = enUstZSira();
        d.seciliIdler.forEach((id, i) => { const o = ogeBul(id); if (o && !o.kilitli) o.zSira = maks + i; });
      } else {
        let minZ = 0;
        d.ogeler.forEach((o) => { if (o.zSira < minZ) minZ = o.zSira; });
        let i = 1;
        d.seciliIdler.forEach((id) => { const o = ogeBul(id); if (o && !o.kilitli) { o.zSira = minZ - i; i++; } });
      }
      ciz();
      kaydetPlanla();
      if (kuresel.Ses) kuresel.Ses.tik();
    }

    function seciliSil() {
      if (d.kilitli || d.seciliIdler.size === 0) return;
      gecmiseKaydet();
      d.ogeler = d.ogeler.filter((o) => !(d.seciliIdler.has(o.id) && !o.kilitli));
      d.seciliIdler.clear();
      ciz();
      kaydetPlanla();
      if (kuresel.Ses) kuresel.Ses.ret();
    }

    /* ------------------------------------------------------- DISA AKTAR */
    function disaAktar() {
      const a = belge.createElement('a');
      a.href = `/pano/${panoId}/disa-aktar`;
      a.rel = 'noopener';
      belge.body.appendChild(a);
      a.click();
      a.remove();
      if (kuresel.Ses) kuresel.Ses.tarama();
    }

    yedekGirdi.addEventListener('change', async () => {
      const dosya = yedekGirdi.files && yedekGirdi.files[0];
      yedekGirdi.value = '';
      if (!dosya) return;
      try {
        const govde = new FormData();
        govde.append('yedek', dosya);
        const yanit = await kuresel.fetch('/pano/ice-aktar', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'X-CSRF-Token': kuresel.CMS.csrf, Accept: 'application/json' },
          body: govde,
        });
        const veri = await yanit.json().catch(() => null);
        if (yanit.ok && veri && veri.tamam) {
          if (kuresel.Ses) kuresel.Ses.tarama();
          kuresel.location.href = `/pano/${veri.pano.id}`;
        } else if (kuresel.Ses) kuresel.Ses.ret();
      } catch (_) {
        if (kuresel.Ses) kuresel.Ses.ret();
      }
    });

    /* ----------------------------------------------------- RESIM EKLEME */
    let sonResimBirakmaKonumu = { x: 0, y: 0 };

    async function resimYukleVeEkle(dosya, dunyaKonum) {
      if (!dosya || !dosya.type.startsWith('image/')) return;
      if (dosya.size > resimMaxMb * 1024 * 1024) {
        if (kuresel.Ses) kuresel.Ses.ret();
        return;
      }
      try {
        const govde = new FormData();
        govde.append('resim', dosya);
        govde.append('x', Math.round(dunyaKonum.x));
        govde.append('y', Math.round(dunyaKonum.y));
        const yanit = await kuresel.fetch(`/pano/${panoId}/resim`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'X-CSRF-Token': kuresel.CMS.csrf, Accept: 'application/json' },
          body: govde,
        });
        const veri = await yanit.json().catch(() => null);
        if (!yanit.ok || !veri || !veri.tamam) { if (kuresel.Ses) kuresel.Ses.ret(); return; }

        gecmiseKaydet();
        const yerelOge = sunucuOgesiniYereleGetirSabitId(veri.oge);
        d.ogeler.push(yerelOge);

        // Gercek piksel boyutuna gore makul bir en/boy oranina oturt.
        const img = resimYukle(yerelOge.veri.src);
        const ayarla = () => {
          if (img.naturalWidth > 0) {
            const maksKenar = 320;
            const oran = img.naturalWidth > img.naturalHeight
              ? maksKenar / img.naturalWidth : maksKenar / img.naturalHeight;
            yerelOge.genislik = Math.round(img.naturalWidth * Math.min(oran, 1));
            yerelOge.yukseklik = Math.round(img.naturalHeight * Math.min(oran, 1));
            ciz();
            kaydetPlanla();
          }
        };
        if (img.complete) ayarla(); else img.addEventListener('load', ayarla, { once: true });

        ciz();
        kaydetPlanla();
        if (kuresel.Ses) kuresel.Ses.erisim();
      } catch (_) {
        if (kuresel.Ses) kuresel.Ses.ret();
      }
    }

    /** resimEkle ucu GERCEK (pozitif) id doner; onu oldugu gibi kullan. */
    function sunucuOgesiniYereleGetirSabitId(satir) {
      return {
        id: satir.id,
        tur: satir.tur, veri: satir.veri || {}, x: sayiTemiz(satir.x), y: sayiTemiz(satir.y),
        genislik: sayiTemiz(satir.genislik, 260), yukseklik: sayiTemiz(satir.yukseklik, 260),
        renk: satir.renk || '#00ff9c', zSira: sayiTemiz(satir.z_sira ?? satir.zSira, enUstZSira()), kilitli: Boolean(satir.kilitli),
      };
    }

    resimGirdi.addEventListener('change', () => {
      const dosya = resimGirdi.files && resimGirdi.files[0];
      resimGirdi.value = '';
      if (dosya) resimYukleVeEkle(dosya, sonResimBirakmaKonumu);
    });

    sarmal.addEventListener('dragover', (olay) => { olay.preventDefault(); });
    sarmal.addEventListener('drop', (olay) => {
      olay.preventDefault();
      if (d.kilitli) return;
      const dosya = olay.dataTransfer && olay.dataTransfer.files && olay.dataTransfer.files[0];
      if (!dosya) return;
      const ekran = ekranKonum(olay);
      resimYukleVeEkle(dosya, ekrandanDunyaya(ekran.x, ekran.y));
    });

    belge.addEventListener('paste', (olay) => {
      if (d.kilitli) return;
      // Bir metin girdisi/duzenleyici odaktaysa yapistirmayi tarayicinin
      // kendi (metin) davranisina birak; sadece bos odakta resmi tuvale al.
      const odakEtiketi = belge.activeElement && belge.activeElement.tagName;
      if (odakEtiketi === 'INPUT' || odakEtiketi === 'TEXTAREA') return;

      const ogelerListesi = olay.clipboardData && olay.clipboardData.items;
      if (!ogelerListesi) return;
      for (const item of ogelerListesi) {
        if (item.type.startsWith('image/')) {
          const dosya = item.getAsFile();
          if (dosya) resimYukleVeEkle(dosya, ekrandanDunyaya(tuval.width / d.dpr / 2, tuval.height / d.dpr / 2));
          break;
        }
      }
    });

    /* ------------------------------------------------- METIN DUZENLEME */
    function metinDuzenlemeBaslat(oge, { yeniMi = false } = {}) {
      if (d.metinDuzenleyici) metinDuzenlemeyiBitir();
      const boyut = (oge.veri && oge.veri.boyut) || 18;
      const textarea = belge.createElement('textarea');
      textarea.value = (oge.veri && oge.veri.metin) || '';
      textarea.spellcheck = false;
      textarea.style.color = oge.renk;
      const konumla = () => {
        const ekran = dunyadanEkrana(oge.x, oge.y);
        textarea.style.left = `${ekran.x}px`;
        textarea.style.top = `${ekran.y}px`;
        textarea.style.width = `${Math.max(120, (oge.genislik || 160) * d.kamera.olcek)}px`;
        textarea.style.height = `${Math.max(boyut * 1.6, (oge.yukseklik || boyut * 1.6) * d.kamera.olcek)}px`;
        textarea.style.fontSize = `${boyut * d.kamera.olcek}px`;
        textarea.style.lineHeight = `${boyut * 1.3 * d.kamera.olcek}px`;
      };
      konumla();
      metinKatmani.appendChild(textarea);
      textarea.focus();
      if (!yeniMi) textarea.select();

      d.metinDuzenleyici = { textarea, oge, yeniMi, konumla };

      textarea.addEventListener('keydown', (olay) => {
        olay.stopPropagation();
        if (olay.key === 'Escape') { metinDuzenlemeyiIptalEt(); }
        if (olay.key === 'Enter' && (olay.ctrlKey || olay.metaKey)) { metinDuzenlemeyiBitir(); }
      });
      textarea.addEventListener('blur', () => metinDuzenlemeyiBitir());
    }

    function metinDuzenlemeyiBitir() {
      if (!d.metinDuzenleyici) return;
      const { textarea, oge, yeniMi } = d.metinDuzenleyici;
      const metin = textarea.value;
      textarea.remove();
      d.metinDuzenleyici = null;

      if (!metin.trim()) {
        if (!yeniMi) { gecmiseKaydet(); d.ogeler = d.ogeler.filter((o) => o.id !== oge.id); ciz(); kaydetPlanla(); }
        return;
      }
      gecmiseKaydet();
      oge.veri = { ...oge.veri, metin };
      const kutu = ogeKutusu(oge);
      oge.genislik = kutu.genislik; oge.yukseklik = kutu.yukseklik;
      if (yeniMi && !d.ogeler.includes(oge)) d.ogeler.push(oge);
      ciz();
      kaydetPlanla();
    }

    function metinDuzenlemeyiIptalEt() {
      if (!d.metinDuzenleyici) return;
      const { textarea, oge, yeniMi } = d.metinDuzenleyici;
      textarea.remove();
      d.metinDuzenleyici = null;
      if (!yeniMi) ciz();
      void oge;
    }

    function notDuzenlemeBaslat(oge) {
      metinDuzenlemeBaslat(oge, { yeniMi: false });
    }

    /* --------------------------------------------------- CIZIM BASLATMA */
    function cizimBaslat(wx, wy) {
      const id = yeniId();
      const ortak = { id, renk: d.renk, zSira: enUstZSira(), kilitli: false };
      if (d.aktifArac === 'kalem') {
        d.cizimTaslak = { ...ortak, tur: 'kalem', x: wx, y: wy, genislik: null, yukseklik: null, veri: { noktalar: [[wx, wy]], kalinlik: d.kalinlik } };
      } else if (d.aktifArac === 'cizgi' || d.aktifArac === 'ok') {
        d.cizimTaslak = { ...ortak, tur: d.aktifArac, x: wx, y: wy, genislik: 0, yukseklik: 0, veri: { kalinlik: d.kalinlik } };
      } else if (d.aktifArac === 'dikdortgen' || d.aktifArac === 'elips') {
        d.cizimTaslak = { ...ortak, tur: d.aktifArac, x: wx, y: wy, genislik: 0, yukseklik: 0, veri: { kalinlik: Math.max(2, Math.round(d.kalinlik / 1.5)) } };
      } else if (d.aktifArac === 'metin') {
        const oge = { ...ortak, tur: 'metin', x: wx, y: wy, genislik: 10, yukseklik: 24, veri: { metin: '', boyut: 18 } };
        aracSec('secici');
        metinDuzenlemeBaslat(oge, { yeniMi: true });
        return;
      } else if (d.aktifArac === 'not') {
        const oge = { ...ortak, tur: 'not', x: wx - 100, y: wy - 70, genislik: 200, yukseklik: 140, renk: '#1d9c6e', veri: { metin: '' } };
        aracSec('secici');
        gecmiseKaydet();
        d.ogeler.push(oge);
        d.seciliIdler = new Set([oge.id]);
        ciz();
        notDuzenlemeBaslat(oge);
        return;
      }
      d.cizimSurukluyor = Boolean(d.cizimTaslak);
    }

    function cizimHareket(wx, wy) {
      if (!d.cizimTaslak) return;
      const o = d.cizimTaslak;
      if (o.tur === 'kalem') {
        const son = o.veri.noktalar[o.veri.noktalar.length - 1];
        if (!son || Math.hypot(wx - son[0], wy - son[1]) > 1.5 / d.kamera.olcek) o.veri.noktalar.push([wx, wy]);
      } else {
        o.genislik = wx - o.x;
        o.yukseklik = wy - o.y;
      }
      ciz();
    }

    function cizimBitir() {
      if (!d.cizimTaslak) return;
      const o = d.cizimTaslak;
      d.cizimTaslak = null;
      d.cizimSurukluyor = false;

      let gecerli = true;
      if (o.tur === 'kalem') gecerli = o.veri.noktalar.length >= 2;
      else if (o.tur === 'dikdortgen' || o.tur === 'elips') gecerli = Math.abs(o.genislik) > 2 && Math.abs(o.yukseklik) > 2;
      else if (o.tur === 'cizgi' || o.tur === 'ok') gecerli = Math.hypot(o.genislik, o.yukseklik) > 2;

      if ((o.tur === 'dikdortgen' || o.tur === 'elips')) {
        if (o.genislik < 0) { o.x += o.genislik; o.genislik = Math.abs(o.genislik); }
        if (o.yukseklik < 0) { o.y += o.yukseklik; o.yukseklik = Math.abs(o.yukseklik); }
      }

      if (gecerli) {
        gecmiseKaydet();
        d.ogeler.push(o);
        d.seciliIdler = new Set([o.id]);
        kaydetPlanla();
      }
      ciz();
      aracSec('secici');
    }

    /* --------------------------------------------------------- SECICI */
    function seciciBaslat(wx, wy, ekran, ekstraSecim) {
      if (!d.kilitli && d.seciliIdler.size === 1) {
        const o = ogeBul([...d.seciliIdler][0]);
        if (o && !o.kilitli) {
          const kutu = ogeKutusu(o);
          const { sol, sag } = { sol: dunyadanEkrana(kutu.x, kutu.y), sag: dunyadanEkrana(kutu.x + kutu.genislik, kutu.y + kutu.yukseklik) };
          const tutamaclar = tutamacNoktalariniGetir(o, sol, sag);
          for (const t of tutamaclar) {
            if (Math.hypot(ekran.x - t.x, ekran.y - t.y) < 9) {
              d.seciciMod = (o.tur === 'cizgi' || o.tur === 'ok') ? 'uc-nokta' : 'yeniden-boyut';
              d.tutamacTur = t.ad;
              d.tutamacOgeId = o.id;
              d.seciciSurukluyor = true;
              gecmiseKaydet();
              return;
            }
          }
        }
      }

      const isabet = noktadaOgeBul(wx, wy);
      if (isabet) {
        if (ekstraSecim) {
          const kume = new Set(d.seciliIdler);
          if (kume.has(isabet.id)) kume.delete(isabet.id); else kume.add(isabet.id);
          d.seciliIdler = kume;
        } else if (!d.seciliIdler.has(isabet.id)) {
          d.seciliIdler = new Set([isabet.id]);
        }
        if (!isabet.kilitli && !d.kilitli) {
          d.seciciMod = 'tasima';
          d.seciciSurukluyor = true;
          d.seciciBaslangic = { wx, wy };
          gecmiseKaydet();
        }
      } else {
        if (!ekstraSecim) d.seciliIdler.clear();
        d.seciciMod = 'marquee';
        d.seciciSurukluyor = true;
        d.marqueeDikdortgen = { x: wx, y: wy, genislik: 0, yukseklik: 0 };
      }
      ciz();
    }

    function seciciHareket(wx, wy) {
      if (!d.seciciSurukluyor) return;
      if (d.seciciMod === 'marquee') {
        const m = d.marqueeDikdortgen;
        m.genislik = wx - m.x;
        m.yukseklik = wy - m.y;
        ciz();
        return;
      }
      if (d.seciciMod === 'tasima') {
        const dx = wx - d.seciciBaslangic.wx, dy = wy - d.seciciBaslangic.wy;
        d.seciciBaslangic = { wx, wy };
        d.seciliIdler.forEach((id) => {
          const o = ogeBul(id);
          if (!o || o.kilitli) return;
          if (o.tur === 'kalem') o.veri.noktalar = o.veri.noktalar.map(([px, py]) => [px + dx, py + dy]);
          else { o.x += dx; o.y += dy; }
        });
        ciz();
        return;
      }
      if (d.seciciMod === 'uc-nokta') {
        const o = ogeBul(d.tutamacOgeId);
        if (!o) return;
        if (d.tutamacTur === 'uc-a') { o.genislik = (o.x + o.genislik) - wx; o.yukseklik = (o.y + o.yukseklik) - wy; o.x = wx; o.y = wy; }
        else { o.genislik = wx - o.x; o.yukseklik = wy - o.y; }
        ciz();
        return;
      }
      if (d.seciciMod === 'yeniden-boyut') {
        const o = ogeBul(d.tutamacOgeId);
        if (!o) return;
        const kutu = ogeKutusu(o);
        let { x, y, genislik, yukseklik } = kutu;
        const sagX = x + genislik, altY = y + yukseklik;
        if (d.tutamacTur.includes('sol')) { genislik = sagX - wx; x = wx; }
        if (d.tutamacTur.includes('sag')) { genislik = wx - x; }
        if (d.tutamacTur.includes('ust')) { yukseklik = altY - wy; y = wy; }
        if (d.tutamacTur.includes('alt')) { yukseklik = wy - y; }
        if (genislik < 8) genislik = 8;
        if (yukseklik < 8) yukseklik = 8;
        o.x = x; o.y = y; o.genislik = genislik; o.yukseklik = yukseklik;
        ciz();
      }
    }

    function seciciBitir() {
      if (!d.seciciSurukluyor) return;
      if (d.seciciMod === 'marquee' && d.marqueeDikdortgen) {
        const m = d.marqueeDikdortgen;
        const normal = { x: Math.min(m.x, m.x + m.genislik), y: Math.min(m.y, m.y + m.yukseklik), genislik: Math.abs(m.genislik), yukseklik: Math.abs(m.yukseklik) };
        if (normal.genislik > 3 || normal.yukseklik > 3) {
          const bulunanlar = d.ogeler.filter((o) => dikdortgenlerKesisiyorMu(normal, ogeKutusu(o)));
          d.seciliIdler = new Set(bulunanlar.map((o) => o.id));
        }
      }
      if (d.seciciMod === 'tasima' || d.seciciMod === 'yeniden-boyut' || d.seciciMod === 'uc-nokta') kaydetPlanla();

      d.seciciSurukluyor = false;
      d.seciciMod = null;
      d.marqueeDikdortgen = null;
      d.tutamacOgeId = null;
      ciz();
    }

    /* -------------------------------------------------- ISARETCI OLAYLARI */
    function isaretciSayisi() { return d.isaretciler.size; }

    sarmal.addEventListener('pointerdown', (olay) => {
      // Mini arac cubugu, metin duzenleyici textarea'si gibi tuvalin
      // UZERINE binen gercek DOM kontrolleri de sarmal'in cocugu oldugu
      // icin olay buraya kadar kabarcıklanir (bubble); yalnizca dogrudan
      // <canvas> uzerindeki etkilesimler tuval mantigini calistirmali.
      if (olay.target !== tuval) return;

      if (belge.activeElement && (belge.activeElement.tagName === 'TEXTAREA' || belge.activeElement.tagName === 'INPUT')) {
        belge.activeElement.blur();
      }
      sarmal.setPointerCapture(olay.pointerId);
      const ekran = ekranKonum(olay);
      d.isaretciler.set(olay.pointerId, ekran);
      sonResimBirakmaKonumu = ekrandanDunyaya(ekran.x, ekran.y);

      if (isaretciSayisi() === 2) {
        const noktalar = [...d.isaretciler.values()];
        d.pinchBaslangic = {
          mesafe: Math.hypot(noktalar[0].x - noktalar[1].x, noktalar[0].y - noktalar[1].y),
          olcek: d.kamera.olcek,
          orta: { x: (noktalar[0].x + noktalar[1].x) / 2, y: (noktalar[0].y + noktalar[1].y) / 2 },
          kamera: { ...d.kamera },
        };
        d.cizimSurukluyor = false; d.cizimTaslak = null; d.seciciSurukluyor = false;
        return;
      }
      if (isaretciSayisi() > 2) return;

      const orta2Buton = olay.button === 1;
      if (d.aktifArac === 'el' || orta2Buton) {
        d.panSurukluyor = true;
        d.panBaslangic = { ex: ekran.x, ey: ekran.y, kx: d.kamera.x, ky: d.kamera.y };
        sarmal.dataset.surukleniyor = '1';
        return;
      }

      const dunya = ekrandanDunyaya(ekran.x, ekran.y);
      if (d.aktifArac === 'secici') {
        seciciBaslat(dunya.x, dunya.y, ekran, olay.shiftKey);
      } else if (!d.kilitli) {
        cizimBaslat(dunya.x, dunya.y);
      }
    });

    sarmal.addEventListener('pointermove', (olay) => {
      if (!d.isaretciler.has(olay.pointerId)) return;
      const ekran = ekranKonum(olay);
      d.isaretciler.set(olay.pointerId, ekran);

      if (isaretciSayisi() === 2 && d.pinchBaslangic) {
        const noktalar = [...d.isaretciler.values()];
        const mesafe = Math.hypot(noktalar[0].x - noktalar[1].x, noktalar[0].y - noktalar[1].y) || 1;
        const orta = { x: (noktalar[0].x + noktalar[1].x) / 2, y: (noktalar[0].y + noktalar[1].y) / 2 };
        const yeniOlcek = Math.max(0.1, Math.min(8, d.pinchBaslangic.olcek * (mesafe / d.pinchBaslangic.mesafe)));
        d.kamera.olcek = yeniOlcek;
        d.kamera.x = d.pinchBaslangic.kamera.x + (orta.x - d.pinchBaslangic.orta.x);
        d.kamera.y = d.pinchBaslangic.kamera.y + (orta.y - d.pinchBaslangic.orta.y);
        zoomGostergesiGuncelle();
        ciz();
        return;
      }

      if (d.panSurukluyor && d.panBaslangic) {
        d.kamera.x = d.panBaslangic.kx + (ekran.x - d.panBaslangic.ex);
        d.kamera.y = d.panBaslangic.ky + (ekran.y - d.panBaslangic.ey);
        ciz();
        return;
      }

      const dunya = ekrandanDunyaya(ekran.x, ekran.y);
      if (d.cizimSurukluyor) cizimHareket(dunya.x, dunya.y);
      else if (d.seciciSurukluyor) seciciHareket(dunya.x, dunya.y);
    });

    function isaretciyiBirak(olay) {
      d.isaretciler.delete(olay.pointerId);
      if (isaretciSayisi() < 2) d.pinchBaslangic = null;
      if (isaretciSayisi() === 0) {
        if (d.panSurukluyor) { d.panSurukluyor = false; d.panBaslangic = null; sarmal.dataset.surukleniyor = '0'; kaydetPlanla(); }
        if (d.cizimSurukluyor) cizimBitir();
        if (d.seciciSurukluyor) seciciBitir();
      }
    }
    sarmal.addEventListener('pointerup', isaretciyiBirak);
    sarmal.addEventListener('pointercancel', isaretciyiBirak);

    sarmal.addEventListener('dblclick', (olay) => {
      if (olay.target !== tuval) return;
      if (d.kilitli || d.aktifArac !== 'secici') return;
      const ekran = ekranKonum(olay);
      const dunya = ekrandanDunyaya(ekran.x, ekran.y);
      const o = noktadaOgeBul(dunya.x, dunya.y);
      if (o && (o.tur === 'metin' || o.tur === 'not') && !o.kilitli) metinDuzenlemeBaslat(o, { yeniMi: false });
    });

    /* ---------------------------------------------------------- KLAVYE */
    const ARAC_TUSLARI = { v: 'secici', '1': 'secici', h: 'el', p: 'kalem', l: 'cizgi', a: 'ok', r: 'dikdortgen', o: 'elips', t: 'metin', n: 'not', i: 'resim' };

    belge.addEventListener('keydown', (olay) => {
      if (!kok.contains(belge.activeElement) && belge.activeElement !== belge.body) return;
      const etiket = belge.activeElement && belge.activeElement.tagName;
      if (etiket === 'INPUT' || etiket === 'TEXTAREA') return;

      if ((olay.ctrlKey || olay.metaKey) && olay.key.toLowerCase() === 'z') {
        olay.preventDefault();
        if (olay.shiftKey) ileriAl(); else geriAl();
        return;
      }
      if ((olay.ctrlKey || olay.metaKey) && olay.key.toLowerCase() === 'y') { olay.preventDefault(); ileriAl(); return; }

      if (olay.key === 'Delete' || olay.key === 'Backspace') { olay.preventDefault(); seciliSil(); return; }
      if (olay.key === 'Escape') { d.seciliIdler.clear(); ciz(); return; }
      if (olay.key === '+' || olay.key === '=') { panoAksiyonCalistir('yakinlastir'); return; }
      if (olay.key === '-') { panoAksiyonCalistir('uzaklastir'); return; }
      if (olay.key === '0') { panoAksiyonCalistir('sifirla-gorunum'); return; }

      const arac = ARAC_TUSLARI[olay.key.toLowerCase()];
      if (arac && !d.kilitli) aracSec(arac);
    });

    /* -------------------------------------------------- AD DUZENLEME */
    // Pano adi da ortak kaydet() hattindan gecer (govde.ad asagida her
    // zaman adGirdi.value'den okunur); burada sadece ayni debounce'u tetikler.
    adGirdi.addEventListener('input', () => kaydetPlanla());

    /* --------------------------------------------------- KAPANIRKEN KAYIT */
    belge.addEventListener('visibilitychange', () => {
      if (belge.visibilityState === 'hidden') kaydet();
    });
    kuresel.addEventListener('beforeunload', () => {
      if (d.kaydetZamanlayici) kaydet();
    });

    /* ------------------------------------------------------- BASLANGIC */
    const boyutIzleyici = new (kuresel.ResizeObserver || function () { return { observe() {} }; })(() => tuvalBoyutlandir());
    boyutIzleyici.observe(sarmal);
    tuvalBoyutlandir();
    ilkYukleme();
  });
})(window);
