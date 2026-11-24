'use strict';
/* ==========================================================================
   public/js/oynatici.js
   Cyber/terminal temali dahili medya goruntuleyici.
   Fotograf/video/ses/PDF dosyalarini indirmeye gerek kalmadan, sayfa
   icinde (hem /depo hem /paylas sayfalarinda) acar. Kaynak olarak sunucunun
   kimlik dogrulamali/paylasim-token'li "goruntule" ucu kullanilir; tarayici
   video/ses etiketleri Range basliklarini kendiliginden gonderir, bu sayede
   ileri/geri sarma calisir.
   ========================================================================== */

(function (kuresel) {
  const belge = kuresel.document;

  function hazir(f) {
    if (belge.readyState === 'loading') belge.addEventListener('DOMContentLoaded', f);
    else f();
  }

  hazir(() => {
    const perde = belge.getElementById('oynatici-perde');
    const govde = belge.getElementById('oynatici-govde');
    const baslikEl = belge.getElementById('oynatici-baslik');
    const indirLink = belge.getElementById('oynatici-indir');
    const kapatDugme = belge.getElementById('oynatici-kapat');
    if (!perde || !govde) return; // bu sayfada oynatici markup'i yok

    function temizle() {
      // Oynayan video/sesi durdurup kaynaklarini birak.
      govde.querySelectorAll('video, audio').forEach((el) => {
        try { el.pause(); el.removeAttribute('src'); el.load(); } catch (_) { /* yoksay */ }
      });
      govde.textContent = '';
    }

    function kapat() {
      perde.classList.remove('acik');
      perde.setAttribute('aria-hidden', 'true');
      temizle();
    }

    function hataGoster(mesaj) {
      const satir = belge.createElement('div');
      satir.className = 'terminal-satir terminal-satir--hata';
      satir.textContent = mesaj;
      govde.appendChild(satir);
    }

    function ac({ ad, mime, goruntuleUrl, indirUrl, onizlenebilir }) {
      temizle();
      if (baslikEl) baslikEl.textContent = ad || 'adsiz dosya';

      if (indirUrl) {
        indirLink.href = indirUrl;
        indirLink.classList.remove('gizli');
      } else {
        indirLink.classList.add('gizli');
      }

      const m = String(mime || '');
      const sarmal = belge.createElement('div');
      sarmal.className = 'oynatici-icerik';

      if (m.startsWith('image/')) {
        const img = belge.createElement('img');
        img.src = goruntuleUrl;
        img.alt = ad || '';
        img.className = 'oynatici-resim';
        sarmal.appendChild(img);
      } else if (m.startsWith('video/')) {
        const video = belge.createElement('video');
        video.controls = true;
        video.autoplay = true;
        video.className = 'oynatici-video';
        video.setAttribute('playsinline', '');
        const kaynak = belge.createElement('source');
        kaynak.src = goruntuleUrl;
        kaynak.type = m;
        video.appendChild(kaynak);
        sarmal.appendChild(video);
      } else if (m.startsWith('audio/')) {
        const sarilan = belge.createElement('div');
        sarilan.className = 'oynatici-ses-sarmal';
        const im = belge.createElement('div');
        im.className = 'oynatici-ses-im';
        im.setAttribute('aria-hidden', 'true');
        im.textContent = '♪';
        const audio = belge.createElement('audio');
        audio.controls = true;
        audio.autoplay = true;
        audio.className = 'oynatici-ses';
        const kaynak = belge.createElement('source');
        kaynak.src = goruntuleUrl;
        kaynak.type = m;
        audio.appendChild(kaynak);
        sarilan.appendChild(im);
        sarilan.appendChild(audio);
        sarmal.appendChild(sarilan);
      } else if (m === 'application/pdf') {
        const gomme = belge.createElement('embed');
        gomme.src = goruntuleUrl;
        gomme.type = 'application/pdf';
        gomme.className = 'oynatici-pdf';
        sarmal.appendChild(gomme);
      } else if (onizlenebilir) {
        // Metin vb. onizlenebilir ama ozel oynatici yok: yeni sekmede ac.
        const baglanti = belge.createElement('a');
        baglanti.href = goruntuleUrl;
        baglanti.target = '_blank';
        baglanti.rel = 'noopener';
        baglanti.className = 'dugme';
        baglanti.textContent = 'YENI SEKMEDE AC';
        sarmal.appendChild(baglanti);
      } else {
        const not = belge.createElement('div');
        not.className = 'bos';
        not.textContent = indirUrl
          ? 'Bu dosya turu icin dahili onizleme yok. Indirerek acabilirsiniz.'
          : 'Bu dosya turu icin dahili onizleme yok ve bu baglantida indirme kapali.';
        sarmal.appendChild(not);
      }

      govde.appendChild(sarmal);

      perde.classList.add('acik');
      perde.setAttribute('aria-hidden', 'false');
      if (kuresel.Ses) kuresel.Ses.tarama();
    }

    // Delege tiklama: sayfada sonradan eklenen kartlar icin de calisir.
    belge.addEventListener('click', (olay) => {
      const kart = olay.target.closest ? olay.target.closest('[data-medya-ac]') : null;
      if (!kart) return;
      ac({
        ad: kart.dataset.ad,
        mime: kart.dataset.mime,
        goruntuleUrl: kart.dataset.goruntule,
        indirUrl: kart.dataset.indir || '',
        onizlenebilir: kart.dataset.onizlenebilir === '1',
      });
    });

    if (kapatDugme) kapatDugme.addEventListener('click', kapat);
    perde.addEventListener('click', (olay) => { if (olay.target === perde) kapat(); });
    belge.addEventListener('keydown', (olay) => { if (olay.key === 'Escape') kapat(); });

    kuresel.Oynatici = { ac, kapat };
  });
})(window);
