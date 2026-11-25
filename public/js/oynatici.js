'use strict';
/**
 * public/js/oynatici.js
 * Depo medya oynaticisi. [data-medya-ac] dugmesine basildiginda dosyanin
 * mime turune gore <img>/<video>/<audio>/<embed> ogesini modal govdesine
 * yerlestirir. Onizlenemeyen turlerde indirme yoluna yonlendirir.
 *
 * Govde DOM API ile kurulur; hicbir yerde innerHTML ile dis veri basilmaz.
 */
(function () {
  const perde = document.getElementById('oynatici-perde');
  const govde = document.getElementById('oynatici-govde');
  const baslikDugum = document.getElementById('oynatici-baslik');
  const indirBag = document.getElementById('oynatici-indir');
  const kapatDugme = document.getElementById('oynatici-kapat');
  if (!perde || !govde) return;

  let sonOdak = null;

  function temizle() {
    // Akislari durdur: video/audio bellekte calmaya devam etmesin
    govde.querySelectorAll('video, audio').forEach(function (m) {
      try { m.pause(); m.removeAttribute('src'); m.load(); } catch (hata) { /* yoksay */ }
    });
    govde.textContent = '';
  }

  function kapat() {
    temizle();
    perde.setAttribute('aria-hidden', 'true');
    perde.classList.remove('acik');
    document.body.classList.remove('modal-acik');
    if (sonOdak && sonOdak.focus) sonOdak.focus();
    sonOdak = null;
  }

  function bekleyenSatir(metin) {
    const satir = document.createElement('div');
    satir.className = 'terminal-satir terminal-satir--cikti';
    satir.textContent = metin;
    const imlec = document.createElement('span');
    imlec.className = 'imlec';
    satir.appendChild(imlec);
    return satir;
  }

  function hataSatiri(metin) {
    const kutu = document.createElement('div');
    kutu.className = 'uyari-kutu uyari-kutu--hata';
    kutu.textContent = metin;
    return kutu;
  }

  function medyaKur(bilgi) {
    temizle();
    govde.appendChild(bekleyenSatir('akis baslatiliyor'));

    const mime = String(bilgi.mime || '');
    let oge = null;

    if (mime.startsWith('image/')) {
      oge = document.createElement('img');
      oge.className = 'oynatici-resim';
      oge.alt = bilgi.ad;
      oge.src = bilgi.goruntule;
    } else if (mime.startsWith('video/')) {
      oge = document.createElement('video');
      oge.className = 'oynatici-video';
      oge.controls = true;
      oge.preload = 'metadata';
      oge.playsInline = true;
      oge.src = bilgi.goruntule;
    } else if (mime.startsWith('audio/')) {
      const sarmal = document.createElement('div');
      sarmal.className = 'oynatici-ses-sarmal';

      const ses = document.createElement('audio');
      ses.className = 'oynatici-ses';
      ses.controls = true;
      ses.preload = 'metadata';
      ses.src = bilgi.goruntule;

      const ad = document.createElement('div');
      ad.className = 'oynatici-ses-ad';
      ad.textContent = bilgi.ad;

      sarmal.appendChild(ad);
      sarmal.appendChild(ses);
      oge = sarmal;
    } else if (mime === 'application/pdf') {
      oge = document.createElement('embed');
      oge.className = 'oynatici-belge';
      oge.type = 'application/pdf';
      oge.src = bilgi.goruntule;
    }

    if (!oge) {
      temizle();
      govde.appendChild(hataSatiri(
        'Bu tur tarayicida onizlenemiyor (' + (mime || 'bilinmeyen tur') + '). '
        + 'Indirip yerel bir uygulamayla acabilirsin.',
      ));
      return;
    }

    oge.addEventListener('error', function () {
      temizle();
      govde.appendChild(hataSatiri('Dosya yuklenemedi. Silinmis ya da erisim izni kaldirilmis olabilir.'));
    }, { once: true });

    const hazir = function () { 
      const bekleyen = govde.querySelector('.terminal-satir');
      if (bekleyen) bekleyen.remove();
    };
    oge.addEventListener('load', hazir, { once: true });
    oge.addEventListener('loadeddata', hazir, { once: true });
    oge.addEventListener('loadedmetadata', hazir, { once: true });
    setTimeout(hazir, 2500);

    govde.appendChild(oge);
  }

  function ac(bilgi) {
    sonOdak = document.activeElement;
    if (baslikDugum) baslikDugum.textContent = bilgi.ad || '—';

    if (indirBag) {
      if (bilgi.indir) {
        indirBag.href = bilgi.indir;
        indirBag.classList.remove('gizli');
      } else {
        indirBag.classList.add('gizli');
      }
    }

    perde.setAttribute('aria-hidden', 'false');
    perde.classList.add('acik');
    document.body.classList.add('modal-acik');

    if (bilgi.onizlenebilir === '1') medyaKur(bilgi);
    else {
      temizle();
      govde.appendChild(hataSatiri(
        'Bu dosya turu tarayicida gosterilemiyor. Icerigini okumak icin '
        + 'belge cozumlemesini kullanabilir ya da dosyayi indirebilirsin.',
      ));

      const baglantilar = document.createElement('div');
      baglantilar.className = 'dugme-sirasi bosluk-ust';

      const coz = document.createElement('a');
      coz.className = 'dugme dugme--kucuk';
      coz.href = '/depo/dosya/' + encodeURIComponent(bilgi.id) + '/cozumleme';
      const cozMetin = document.createElement('span');
      cozMetin.className = 'dugme-metin';
      cozMetin.textContent = '▤ BELGE COZUMLEMESI';
      coz.appendChild(cozMetin);

      baglantilar.appendChild(coz);
      govde.appendChild(baglantilar);
    }

    if (kapatDugme && kapatDugme.focus) kapatDugme.focus();
  }

  document.addEventListener('click', function (olay) {
    const dugme = olay.target.closest ? olay.target.closest('[data-medya-ac]') : null;
    if (!dugme) return;
    olay.preventDefault();
    ac({
      id: dugme.getAttribute('data-id'),
      ad: dugme.getAttribute('data-ad'),
      mime: dugme.getAttribute('data-mime'),
      goruntule: dugme.getAttribute('data-goruntule'),
      indir: dugme.getAttribute('data-indir'),
      onizlenebilir: dugme.getAttribute('data-onizlenebilir'),
    });
  });

  if (kapatDugme) kapatDugme.addEventListener('click', kapat);

  perde.addEventListener('mousedown', function (olay) {
    if (olay.target === perde) kapat();
  });

  document.addEventListener('keydown', function (olay) {
    if (olay.key === 'Escape' && perde.getAttribute('aria-hidden') === 'false') kapat();
  });

  window.Oynatici = { ac, kapat };
})();
