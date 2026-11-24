'use strict';
/* ==========================================================================
   public/js/cambaz.js
   CAMBAZ: Jarvis tarzi sohbet arayuzu.
    - Metin + mikrofon (Web Speech API) girdisi
    - Kademeli TTS: sunucu (ElevenLabs/OpenAI) -> tarayici (SpeechSynthesis)
    - Konusurken dalgalanan "cyber-ses" waveform animasyonu (canvas)
    - Oturum (gorusme) ve hafiza (kalici bilgi) yonetimi, hepsi AJAX
   ========================================================================== */

(function (kuresel) {
  const belge = kuresel.document;

  function hazir(f) {
    if (belge.readyState === 'loading') belge.addEventListener('DOMContentLoaded', f);
    else f();
  }

  hazir(() => {
    const ekran = belge.getElementById('cambaz-ekran');
    if (!ekran || !kuresel.CMS) return;

    const d = {
      oturumId: ekran.dataset.aktifOturum ? Number(ekran.dataset.aktifOturum) : null,
      sesTur: ekran.dataset.sesTur || 'tarayici',
      sesAd: ekran.dataset.sesAd || '',
      sesHiz: Number(ekran.dataset.sesHiz) || 1,
      sesPerde: Number(ekran.dataset.sesPerde) || 1,
      sesAcik: true,
      gonderiliyor: false,
      dinliyor: false,
      audioCtx: null,
      analyser: null,
      dalgaRAF: null,
      pseudoKonusuyor: false,
    };

    const akis = belge.getElementById('cambaz-mesaj-akis');
    const girdi = belge.getElementById('cambaz-girdi');
    const gonderDugme = belge.getElementById('cambaz-gonder');
    const mikDugme = belge.getElementById('cambaz-mikrofon');
    const hataKutu = belge.getElementById('cambaz-hata-kutu');
    const durumMetin = belge.getElementById('cambaz-durum-metin');
    const orb = belge.getElementById('cambaz-orb');
    const dalgaTuval = belge.getElementById('cambaz-dalga');
    const sesDugme = belge.getElementById('cambaz-ses-ac-kapat');
    const yeniOturumDugme = belge.getElementById('cambaz-yeni-oturum');
    const oturumListe = belge.getElementById('cambaz-oturum-liste');
    const hafizaListe = belge.getElementById('cambaz-hafiza-liste');
    const hafizaForm = belge.getElementById('cambaz-hafiza-form');

    function hataGoster(mesaj) {
      if (!hataKutu) return;
      hataKutu.textContent = mesaj;
      hataKutu.classList.remove('gizli');
      kuresel.setTimeout(() => hataKutu.classList.add('gizli'), 6000);
    }

    function durumYaz(metin) { if (durumMetin) durumMetin.textContent = metin; }

    /* ------------------------------------------------------- SEKME GECISI */
    belge.querySelectorAll('.cambaz-sekme-dugme').forEach((b) => {
      b.addEventListener('click', () => {
        belge.querySelectorAll('.cambaz-sekme-dugme').forEach((x) => x.classList.remove('etkin'));
        b.classList.add('etkin');
        const hedef = b.dataset.sekme;
        belge.querySelectorAll('[data-sekme-govde]').forEach((g) => {
          g.classList.toggle('gizli', g.dataset.sekmeGovde !== hedef);
        });
      });
    });

    /* ------------------------------------------------------ MESAJ CIZIMI */
    function mesajEkleDom({ rol, icerik, zaman, sesli, hata, gecici }) {
      const kutu = belge.createElement('div');
      kutu.className = `cambaz-mesaj cambaz-mesaj--${rol}` + (gecici ? ' cambaz-mesaj--yazilyor' : '');
      const govde = belge.createElement('div');
      govde.className = 'cambaz-mesaj-govde';
      govde.textContent = icerik;
      const alt = belge.createElement('div');
      alt.className = 'kucuk sonuk cambaz-mesaj-zaman';
      let altMetin = zaman || new Date().toLocaleTimeString('tr-TR');
      if (sesli) altMetin += ' · 🎙';
      if (hata) altMetin += ' · hata';
      alt.textContent = altMetin;
      kutu.appendChild(govde);
      kutu.appendChild(alt);
      akis.appendChild(kutu);
      akis.scrollTop = akis.scrollHeight;
      return kutu;
    }

    function akisTemizle() {
      akis.innerHTML = '';
    }

    function bosDurumGoster(metin) {
      akisTemizle();
      const bos = belge.createElement('div');
      bos.className = 'bos cambaz-bos-durum';
      bos.innerHTML = '<span class="bos-im" aria-hidden="true">◉</span> ';
      bos.append(metin);
      akis.appendChild(bos);
    }

    /* --------------------------------------------------------- OTURUMLAR */
    async function yeniOturumOlustur(otomatikGonder) {
      const s = await kuresel.CMS.istek('/cambaz/oturum', { method: 'POST', govde: {} });
      if (!s.tamam || !s.govde || !s.govde.tamam) { hataGoster('Yeni gorusme olusturulamadi.'); return null; }
      d.oturumId = s.govde.oturum.id;
      ekran.dataset.aktifOturum = String(d.oturumId);

      const kart = belge.createElement('div');
      kart.className = 'kart kart-sarmal cambaz-oturum-kart etkin';
      kart.dataset.oturumId = String(d.oturumId);
      kart.style.borderLeftColor = '#a78bfa'; // renkleriUygula() yalnizca ilk yuklemede calisir
      kart.innerHTML =
        '<span class="kart-im" aria-hidden="true">◉</span>' +
        '<div class="kart-govde"><div class="kart-ad"></div>' +
        '<div class="kart-alt">0 mesaj</div></div>';
      kart.querySelector('.kart-ad').textContent = s.govde.oturum.baslik; // XSS'e karsi textContent (innerHTML degil)
      const form = belge.createElement('form');
      form.className = 'pano-sil-form';
      form.dataset.ajaxOturumSil = '1';
      form.innerHTML = '<button type="button" class="dugme dugme--tehlike dugme--kucuk" title="Sil">✕</button>';
      kart.appendChild(form);
      oturumKartlariniPasifEt();
      if (oturumListe.querySelector('.bos')) oturumListe.innerHTML = '';
      oturumListe.insertBefore(kart, oturumListe.firstChild);
      kartSilBagla(form, d.oturumId, kart);
      kartSecBagla(kart);

      bosDurumGoster('Yeni gorusme basladi.');
      return d.oturumId;
    }

    function oturumKartlariniPasifEt() {
      oturumListe.querySelectorAll('.cambaz-oturum-kart').forEach((k) => k.classList.remove('etkin'));
    }

    async function oturumSec(id, kartEl) {
      if (d.oturumId === id) return;
      const s = await kuresel.CMS.istek(`/cambaz/oturum/${id}/mesajlar`);
      if (!s.tamam || !s.govde || !s.govde.tamam) { hataGoster('Gorusme yuklenemedi.'); return; }
      d.oturumId = id;
      ekran.dataset.aktifOturum = String(id);
      oturumKartlariniPasifEt();
      if (kartEl) kartEl.classList.add('etkin');

      akisTemizle();
      if (s.govde.mesajlar.length === 0) {
        bosDurumGoster('Bu gorusmede henuz mesaj yok.');
      } else {
        s.govde.mesajlar.forEach((m) => {
          mesajEkleDom({
            rol: m.rol, icerik: m.icerik,
            zaman: new Date(m.olusturuldu_at).toLocaleTimeString('tr-TR'),
            sesli: m.sesli, hata: m.hata,
          });
        });
      }
    }

    function kartSecBagla(kart) {
      kart.addEventListener('click', (olay) => {
        if (olay.target.closest('form, button')) return;
        oturumSec(Number(kart.dataset.oturumId), kart);
      });
    }

    function kartSilBagla(form, id, kart) {
      const dugme = form.querySelector('button');
      dugme.addEventListener('click', async () => {
        if (!kuresel.confirm('Bu gorusmeyi silmek istediginize emin misiniz?')) return;
        const s = await kuresel.CMS.istek(`/cambaz/oturum/${id}/sil`, { method: 'POST', govde: {} });
        if (!s.tamam) { hataGoster('Gorusme silinemedi.'); return; }
        const aktifti = kart.classList.contains('etkin');
        kart.remove();
        if (aktifti) {
          const kalan = oturumListe.querySelector('.cambaz-oturum-kart');
          if (kalan) { oturumSec(Number(kalan.dataset.oturumId), kalan); } else {
            d.oturumId = null; ekran.dataset.aktifOturum = '';
            bosDurumGoster('Cambaz hazir. Sohbete baslamak icin bir mesaj yaz.');
          }
        }
        if (!oturumListe.querySelector('.cambaz-oturum-kart')) {
          oturumListe.innerHTML = '<div class="bos"><span class="bos-im" aria-hidden="true">◉</span> Henuz gorusme yok.</div>';
        }
      });
    }

    oturumListe.querySelectorAll('.cambaz-oturum-kart').forEach((kart) => {
      kartSecBagla(kart);
      const form = kart.querySelector('form[data-ajax-oturum-sil]');
      if (form) kartSilBagla(form, Number(kart.dataset.oturumId), kart);
    });

    if (yeniOturumDugme) yeniOturumDugme.addEventListener('click', () => yeniOturumOlustur());

    /* ----------------------------------------------------------- HAFIZA */
    function hafizaKartEkle(h) {
      const kart = belge.createElement('div');
      kart.className = 'kart kart-sarmal cambaz-hafiza-kart';
      kart.dataset.hafizaId = String(h.id);
      kart.style.borderLeftColor = h.kaynak === 'otomatik' ? '#22d3ee' : '#00ff9c'; // bkz. yukaridaki not
      kart.innerHTML =
        `<span class="kart-im" aria-hidden="true">${h.kaynak === 'otomatik' ? '◈' : '◇'}</span>` +
        '<div class="kart-govde">' +
        `<div class="kart-ad cambaz-hafiza-baslik" data-alan="baslik" contenteditable="true"></div>` +
        `<div class="kart-alt cambaz-hafiza-icerik" data-alan="icerik" contenteditable="true"></div>` +
        '</div>' +
        '<div class="kart-sag cambaz-hafiza-aksiyon">' +
        '<button type="button" class="dugme dugme--sonuk dugme--kucuk" data-hafiza-kaydet title="Degisikligi kaydet">💾</button>' +
        '<button type="button" class="dugme dugme--tehlike dugme--kucuk" data-hafiza-sil title="Sil">✕</button>' +
        '</div>';
      kart.querySelector('.cambaz-hafiza-baslik').textContent = h.baslik;
      kart.querySelector('.cambaz-hafiza-icerik').textContent = h.icerik;
      hafizaKartinaOlayBagla(kart);
      if (hafizaListe.querySelector('.bos')) hafizaListe.innerHTML = '';
      hafizaListe.insertBefore(kart, hafizaListe.firstChild);
    }

    function hafizaKartinaOlayBagla(kart) {
      const id = Number(kart.dataset.hafizaId);
      kart.querySelector('[data-hafiza-kaydet]').addEventListener('click', async () => {
        const baslik = kart.querySelector('[data-alan="baslik"]').textContent.trim();
        const icerik = kart.querySelector('[data-alan="icerik"]').textContent.trim();
        const s = await kuresel.CMS.istek(`/cambaz/hafiza/${id}`, { method: 'POST', govde: { baslik, icerik } });
        if (s.tamam && s.govde && s.govde.tamam) { if (kuresel.Ses) kuresel.Ses.onay(); }
        else { hataGoster('Hafiza guncellenemedi.'); if (kuresel.Ses) kuresel.Ses.ret(); }
      });
      kart.querySelector('[data-hafiza-sil]').addEventListener('click', async () => {
        if (!kuresel.confirm('Bu hafiza kaydini silmek istediginize emin misiniz?')) return;
        const s = await kuresel.CMS.istek(`/cambaz/hafiza/${id}/sil`, { method: 'POST', govde: {} });
        if (s.tamam) {
          kart.remove();
          if (!hafizaListe.querySelector('.cambaz-hafiza-kart')) {
            hafizaListe.innerHTML = '<div class="bos"><span class="bos-im" aria-hidden="true">◇</span> Kayitli hafiza yok.</div>';
          }
        } else hataGoster('Hafiza silinemedi.');
      });
    }

    hafizaListe.querySelectorAll('.cambaz-hafiza-kart').forEach(hafizaKartinaOlayBagla);

    if (hafizaForm) {
      hafizaForm.addEventListener('submit', async (olay) => {
        olay.preventDefault();
        const baslikGirdi = belge.getElementById('hafiza-baslik');
        const icerikGirdi = belge.getElementById('hafiza-icerik');
        const icerik = icerikGirdi.value.trim();
        if (!icerik) return;
        const s = await kuresel.CMS.istek('/cambaz/hafiza', {
          method: 'POST', govde: { baslik: baslikGirdi.value.trim() || 'Not', icerik },
        });
        if (s.tamam && s.govde && s.govde.tamam) {
          hafizaKartEkle(s.govde.kayit);
          baslikGirdi.value = ''; icerikGirdi.value = '';
          if (kuresel.Ses) kuresel.Ses.onay();
        } else {
          hataGoster('Hafiza eklenemedi.');
          if (kuresel.Ses) kuresel.Ses.ret();
        }
      });
    }

    /* -------------------------------------------------------- GIRDI KUTUSU */
    function textareaBoyutlandir() {
      girdi.style.height = 'auto';
      girdi.style.height = Math.min(girdi.scrollHeight, 120) + 'px';
    }
    girdi.addEventListener('input', textareaBoyutlandir);
    girdi.addEventListener('keydown', (olay) => {
      if (olay.key === 'Enter' && !olay.shiftKey) { olay.preventDefault(); mesajGonder(); }
    });
    if (gonderDugme) gonderDugme.addEventListener('click', () => mesajGonder());

    /* ------------------------------------------------------------- GONDER */
    async function mesajGonder(sesliMi) {
      const metin = girdi.value.trim();
      if (!metin || d.gonderiliyor) return;

      d.gonderiliyor = true;
      girdi.value = '';
      textareaBoyutlandir();
      if (akis.querySelector('.cambaz-bos-durum')) akisTemizle();

      mesajEkleDom({ rol: 'kullanici', icerik: metin, sesli: Boolean(sesliMi) });
      const yaziyorKutu = mesajEkleDom({ rol: 'ajan', icerik: 'dusunuyor...', gecici: true });
      durumYaz('ISLENIYOR...');
      if (orb) orb.classList.add('konusuyor');

      try {
        let oturumId = d.oturumId;
        if (!oturumId) {
          oturumId = await yeniOturumOlustur();
          if (!oturumId) throw new Error('Gorusme olusturulamadi.');
        }

        const s = await kuresel.CMS.istek(`/cambaz/oturum/${oturumId}/mesaj`, {
          method: 'POST', govde: { metin, sesli: Boolean(sesliMi) },
        });

        yaziyorKutu.remove();

        if (s.tamam && s.govde && s.govde.tamam) {
          mesajEkleDom({ rol: 'ajan', icerik: s.govde.yanit });
          if (kuresel.Ses) kuresel.Ses.onay();
          if (s.govde.hafizaEklendi && kuresel.Ses) kuresel.Ses.tarama();
          durumYaz('HAZIR');
          if (d.sesAcik) sesliOku(s.govde.yanit);
        } else {
          mesajEkleDom({ rol: 'ajan', icerik: (s.govde && s.govde.hata) || 'Bir sorun olustu.', hata: true });
          if (kuresel.Ses) kuresel.Ses.ret();
          durumYaz('HATA');
        }
      } catch (hata) {
        yaziyorKutu.remove();
        mesajEkleDom({ rol: 'ajan', icerik: 'Sunucuya ulasilamadi.', hata: true });
        durumYaz('BAGLANTI HATASI');
        if (kuresel.Ses) kuresel.Ses.ret();
      } finally {
        d.gonderiliyor = false;
        if (orb) orb.classList.remove('konusuyor');
      }
    }

    /* ------------------------------------------------------------ MIKROFON */
    const TanimaSinifi = kuresel.SpeechRecognition || kuresel.webkitSpeechRecognition;
    if (mikDugme && TanimaSinifi) {
      const tanima = new TanimaSinifi();
      tanima.lang = 'tr-TR';
      tanima.interimResults = true;
      tanima.continuous = false;

      tanima.addEventListener('start', () => {
        d.dinliyor = true;
        mikDugme.classList.add('dinliyor');
        durumYaz('DINLENIYOR...');
      });
      tanima.addEventListener('end', () => {
        d.dinliyor = false;
        mikDugme.classList.remove('dinliyor');
        durumYaz('HAZIR');
      });
      tanima.addEventListener('error', () => {
        d.dinliyor = false;
        mikDugme.classList.remove('dinliyor');
        hataGoster('Mikrofon erisimi alinamadi veya bir hata olustu.');
      });
      tanima.addEventListener('result', (olay) => {
        let metin = '';
        for (let i = 0; i < olay.results.length; i++) metin += olay.results[i][0].transcript;
        girdi.value = metin;
        textareaBoyutlandir();
        const sonSonuc = olay.results[olay.results.length - 1];
        if (sonSonuc.isFinal) mesajGonder(true);
      });

      mikDugme.addEventListener('click', () => {
        if (d.dinliyor) { tanima.stop(); return; }
        if (kuresel.Ses) kuresel.Ses.uyandir();
        try { tanima.start(); } catch (_) { /* zaten calisiyor olabilir */ }
      });
    } else if (mikDugme) {
      mikDugme.disabled = true;
      mikDugme.title = 'Bu tarayici sesli girdiyi desteklemiyor.';
    }

    /* ---------------------------------------------------- SES AC/KAPAT */
    if (sesDugme) {
      sesDugme.addEventListener('click', () => {
        d.sesAcik = !d.sesAcik;
        sesDugme.setAttribute('aria-pressed', d.sesAcik ? 'true' : 'false');
        sesDugme.querySelector('.dugme-metin').textContent = d.sesAcik ? '🔊 SES' : '🔇 SES';
        if (!d.sesAcik && kuresel.speechSynthesis) kuresel.speechSynthesis.cancel();
      });
    }

    /* -------------------------------------------------- DALGA (WAVEFORM) */
    function dalgaCizBaslat(analyserVeyaYok) {
      if (!dalgaTuval) return;
      const ctx2d = dalgaTuval.getContext('2d');
      const genislik = dalgaTuval.width, yukseklik = dalgaTuval.height;
      const merkezX = genislik / 2, merkezY = yukseklik / 2;
      const veriDizisi = analyserVeyaYok ? new Uint8Array(analyserVeyaYok.frequencyBinCount) : null;

      function kare() {
        ctx2d.clearRect(0, 0, genislik, yukseklik);
        const cubukSayisi = 24;
        for (let i = 0; i < cubukSayisi; i++) {
          let genlik;
          if (veriDizisi) {
            analyserVeyaYok.getByteFrequencyData(veriDizisi);
            genlik = veriDizisi[Math.floor((i / cubukSayisi) * veriDizisi.length)] / 255;
          } else {
            genlik = d.pseudoKonusuyor ? (0.25 + Math.random() * 0.55) : 0;
          }
          const aci = (i / cubukSayisi) * Math.PI * 2;
          const icYaricap = 20, disYaricap = icYaricap + genlik * 24;
          const x1 = merkezX + Math.cos(aci) * icYaricap, y1 = merkezY + Math.sin(aci) * icYaricap;
          const x2 = merkezX + Math.cos(aci) * disYaricap, y2 = merkezY + Math.sin(aci) * disYaricap;
          ctx2d.strokeStyle = 'rgba(0, 255, 156, ' + (0.35 + genlik * 0.5) + ')';
          ctx2d.lineWidth = 2;
          ctx2d.beginPath();
          ctx2d.moveTo(x1, y1);
          ctx2d.lineTo(x2, y2);
          ctx2d.stroke();
        }
        d.dalgaRAF = kuresel.requestAnimationFrame(kare);
      }
      if (d.dalgaRAF) kuresel.cancelAnimationFrame(d.dalgaRAF);
      kare();
    }

    function dalgaDurdur() {
      if (d.dalgaRAF) { kuresel.cancelAnimationFrame(d.dalgaRAF); d.dalgaRAF = null; }
      if (dalgaTuval) dalgaTuval.getContext('2d').clearRect(0, 0, dalgaTuval.width, dalgaTuval.height);
      if (orb) orb.classList.remove('konusuyor');
    }

    /* ---------------------------------------------------------------- TTS */
    async function sesliOku(metin) {
      durumYaz('KONUSUYOR...');
      if (orb) orb.classList.add('konusuyor');

      if (ekran.dataset.sunucuSesVar === '1') {
        try {
          const yanit = await kuresel.fetch('/cambaz/ses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': kuresel.CMS.csrf, Accept: '*/*' },
            credentials: 'same-origin',
            body: JSON.stringify({ metin }),
          });
          const turu = yanit.headers.get('content-type') || '';
          if (yanit.ok && turu.includes('audio')) {
            const tampon = await yanit.arrayBuffer();
            if (!d.audioCtx) d.audioCtx = new (kuresel.AudioContext || kuresel.webkitAudioContext)();
            if (d.audioCtx.state === 'suspended') await d.audioCtx.resume().catch(() => {});
            const ses = await d.audioCtx.decodeAudioData(tampon.slice(0));
            const kaynak = d.audioCtx.createBufferSource();
            kaynak.buffer = ses;
            const analyser = d.audioCtx.createAnalyser();
            analyser.fftSize = 64;
            kaynak.connect(analyser);
            analyser.connect(d.audioCtx.destination);
            dalgaCizBaslat(analyser);
            kaynak.onended = () => { dalgaDurdur(); durumYaz('HAZIR'); };
            kaynak.start();
            return;
          }
        } catch (_) { /* sunucu TTS basarisiz, tarayiciya dus */ }
      }

      // Tarayici motoru (ucretsiz, anahtarsiz)
      if (!kuresel.speechSynthesis) { dalgaDurdur(); durumYaz('HAZIR'); return; }
      const soylem = new kuresel.SpeechSynthesisUtterance(metin);
      soylem.lang = 'tr-TR';
      soylem.rate = d.sesHiz;
      soylem.pitch = d.sesPerde;
      if (d.sesAd) {
        const eslesen = kuresel.speechSynthesis.getVoices().find((s) => s.name === d.sesAd);
        if (eslesen) soylem.voice = eslesen;
      }
      soylem.onstart = () => { d.pseudoKonusuyor = true; dalgaCizBaslat(null); };
      soylem.onend = () => { d.pseudoKonusuyor = false; dalgaDurdur(); durumYaz('HAZIR'); };
      soylem.onerror = () => { d.pseudoKonusuyor = false; dalgaDurdur(); durumYaz('HAZIR'); };
      kuresel.speechSynthesis.cancel();
      kuresel.speechSynthesis.speak(soylem);
    }

    textareaBoyutlandir();
    akis.scrollTop = akis.scrollHeight;
  });
})(window);
