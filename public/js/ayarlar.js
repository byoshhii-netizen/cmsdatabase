'use strict';
/* ==========================================================================
   public/js/ayarlar.js
   Ayarlar ekrani: sifre guc gostergesi, AJAX sifre degistirme,
   API anahtari kaydetme/silme onayi.
   ========================================================================== */

(function (kuresel) {
  const belge = kuresel.document;

  function hazir(f) {
    if (belge.readyState === 'loading') belge.addEventListener('DOMContentLoaded', f);
    else f();
  }

  /** Kaba istemci tarafi guc puani (sunucu tarafi ayrica dogrular). */
  function gucPuani(s) {
    if (!s) return 0;
    let p = Math.min(s.length * 4, 40);
    if (/[a-z]/.test(s)) p += 10;
    if (/[A-Z]/.test(s)) p += 12;
    if (/[0-9]/.test(s)) p += 12;
    if (/[^a-zA-Z0-9]/.test(s)) p += 16;
    if (new Set(s).size > 8) p += 10;
    return Math.max(0, Math.min(100, p));
  }

  hazir(() => {
    /* ------------------------------------------- Sifre guc gostergesi */
    const yeni = belge.getElementById('yeni_sifre');
    const tekrar = belge.getElementById('yeni_sifre_tekrar');
    const cubuk = belge.getElementById('guc-cubuk');
    const etiket = belge.getElementById('guc-etiket');
    const eslesme = belge.getElementById('eslesme-notu');

    function gucGuncelle() {
      if (!yeni || !cubuk) return;
      const p = gucPuani(yeni.value);
      const dilimSayisi = cubuk.children.length || 5;
      const dolu = Math.round((p / 100) * dilimSayisi);
      const sinif = p < 40 ? 'dolu-zayif' : p < 70 ? 'dolu-orta' : 'dolu-guclu';

      Array.prototype.forEach.call(cubuk.children, (d, i) => {
        d.className = 'guc-dilim' + (i < dolu ? ' ' + sinif : '');
      });

      if (etiket) {
        etiket.textContent = !yeni.value ? '—'
          : p < 40 ? 'ZAYIF' : p < 70 ? 'ORTA' : 'GUCLU';
        etiket.className = 'kucuk ' + (p < 40 ? 'kirmizi-metin' : p < 70 ? 'kehribar-metin' : 'zumrut');
      }
    }

    function eslesmeGuncelle() {
      if (!yeni || !tekrar || !eslesme) return;
      if (!tekrar.value) { eslesme.textContent = ''; return; }
      const ayni = yeni.value === tekrar.value;
      eslesme.textContent = ayni ? '✓ Sifreler uyusuyor' : '✗ Sifreler uyusmuyor';
      eslesme.className = 'kucuk ' + (ayni ? 'zumrut' : 'kirmizi-metin');
    }

    if (yeni) yeni.addEventListener('input', () => { gucGuncelle(); eslesmeGuncelle(); });
    if (tekrar) tekrar.addEventListener('input', eslesmeGuncelle);

    /* ------------------------------------------ AJAX sifre degistirme */
    const sifreForm = belge.getElementById('sifre-form');
    const sifreSonuc = belge.getElementById('sifre-sonuc');

    function sonucYaz(oge, mesaj, tur) {
      if (!oge) return;
      oge.textContent = mesaj;
      oge.className = 'uyari-kutu ' + (tur === 'hata' ? 'uyari-kutu--hata' : 'uyari-kutu--bilgi');
      oge.classList.remove('gizli');
    }

    if (sifreForm) {
      sifreForm.dataset.ajax = '1';
      sifreForm.addEventListener('submit', async (olay) => {
        if (!kuresel.fetch) return;
        olay.preventDefault();

        const dugme = sifreForm.querySelector('button[type="submit"]');
        if (dugme) { dugme.dataset.mesgul = '1'; dugme.disabled = true; }

        const govde = {
          mevcut_sifre: sifreForm.elements.mevcut_sifre.value,
          yeni_sifre: sifreForm.elements.yeni_sifre.value,
          yeni_sifre_tekrar: sifreForm.elements.yeni_sifre_tekrar.value,
        };

        try {
          const s = await kuresel.CMS.istek('/ayarlar/sifre', { method: 'POST', govde });
          if (s.tamam && s.govde && s.govde.tamam) {
            if (kuresel.Ses) kuresel.Ses.erisim();
            sonucYaz(sifreSonuc, s.govde.mesaj || 'Sifre guncellendi.', 'tamam');
            sifreForm.reset();
            gucGuncelle();
            eslesmeGuncelle();
          } else {
            if (kuresel.Ses) kuresel.Ses.ret();
            sonucYaz(sifreSonuc, (s.govde && s.govde.hata) || 'Sifre degistirilemedi.', 'hata');
          }
        } catch (_) {
          sonucYaz(sifreSonuc, 'Sunucuya ulasilamadi.', 'hata');
        } finally {
          if (dugme) { dugme.dataset.mesgul = '0'; dugme.disabled = false; }
        }
      });
    }

    // Not: form[data-onay] icin tarayici onay dialogu artik cekirdek.js
    // icindeki onayFormlariBaglat() tarafindan genel olarak yonetiliyor.

    gucGuncelle();

    /* ------------------------------------- API anahtari aktif/pasif AJAX */
    belge.querySelectorAll('form[data-ajax-anahtar-durum]').forEach((form) => {
      form.addEventListener('submit', async (olay) => {
        if (!kuresel.CMS) return;
        olay.preventDefault();
        const girdi = form.querySelector('input[name="aktif"]');
        const aktif = girdi.value === 'true';
        try {
          const s = await kuresel.CMS.istek(form.action, { method: 'POST', govde: { aktif } });
          if (s.tamam && s.govde && s.govde.tamam) {
            if (kuresel.Ses) kuresel.Ses.onay();
            kuresel.location.reload();
          } else if (kuresel.Ses) {
            kuresel.Ses.ret();
          }
        } catch (_) { if (kuresel.Ses) kuresel.Ses.ret(); }
      });
    });

    /* --------------------------------------------- CAMBAZ SES AYARLARI */
    const sesTurSec = belge.getElementById('ses-tur');
    const sesAdGirdi = belge.getElementById('ses-ad');
    const sesHiz = belge.getElementById('ses-hiz');
    const sesPerde = belge.getElementById('ses-perde');
    const sesHizDeger = belge.getElementById('ses-hiz-deger');
    const sesPerdeDeger = belge.getElementById('ses-perde-deger');
    const sesAdIpucu = belge.getElementById('ses-ad-liste-ipucu');
    const sesDinleDugme = belge.getElementById('ses-dinle-dugme');

    function tarayiciSesleriniListele() {
      if (!kuresel.speechSynthesis || !sesAdIpucu) return;
      const sesler = kuresel.speechSynthesis.getVoices().filter((s) => s.lang.toLowerCase().startsWith('tr') || true);
      if (sesler.length === 0) return;
      const adlar = sesler.slice(0, 8).map((s) => s.name).join(', ');
      sesAdIpucu.textContent = 'Tarayicida bulunan bazi sesler: ' + adlar;
    }
    if (kuresel.speechSynthesis) {
      tarayiciSesleriniListele();
      kuresel.speechSynthesis.addEventListener('voiceschanged', tarayiciSesleriniListele);
    }

    if (sesHiz && sesHizDeger) sesHiz.addEventListener('input', () => { sesHizDeger.textContent = sesHiz.value; });
    if (sesPerde && sesPerdeDeger) sesPerde.addEventListener('input', () => { sesPerdeDeger.textContent = sesPerde.value; });

    if (sesDinleDugme) {
      sesDinleDugme.addEventListener('click', () => {
        if (!kuresel.speechSynthesis) return;
        const metin = 'Merhaba operator, ben Cambaz. Ses ayarlarin boyle duyulacak.';
        const soylem = new kuresel.SpeechSynthesisUtterance(metin);
        soylem.rate = Number((sesHiz && sesHiz.value) || 1);
        soylem.pitch = Number((sesPerde && sesPerde.value) || 1);
        if (sesAdGirdi && sesAdGirdi.value) {
          const eslesen = kuresel.speechSynthesis.getVoices().find((s) => s.name === sesAdGirdi.value);
          if (eslesen) soylem.voice = eslesen;
        }
        kuresel.speechSynthesis.cancel();
        kuresel.speechSynthesis.speak(soylem);
      });
    }

    /* ------------------------------------------- OZEL SES ORNEGI YUKLEME */
    const sesOrnekGirdi = belge.getElementById('ses-ornek-girdi');
    const sesOrnekAd = belge.getElementById('ses-ornek-ad');
    const sesOrnekYukleDugme = belge.getElementById('ses-ornek-yukle-dugme');

    if (sesOrnekGirdi) {
      sesOrnekGirdi.addEventListener('change', () => {
        const dosya = sesOrnekGirdi.files && sesOrnekGirdi.files[0];
        if (sesOrnekAd) sesOrnekAd.textContent = dosya ? dosya.name : 'dosya secilmedi';
        if (sesOrnekYukleDugme) sesOrnekYukleDugme.disabled = !dosya;
      });
    }
  });
})(window);
