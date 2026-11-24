'use strict';
/* ==========================================================================
   public/js/depo.js
   /depo sayfasina ozel davranislar:
   - Belge (dahili metin editoru) modalini olustur/duzenle/sil modlari arasinda yonetir
   - Dosya yukleme alaninda surukle-birak + secilen dosya listesi
   - "Disariya Ac" formunda sifre alaninin acilir/kapanir gorunumu
   - Paylasim baglantisi kopyalama
   Modal acma/kapama ve onay dialoglari public/js/cekirdek.js icinde geneldir.
   ========================================================================== */

(function (kuresel) {
  const belge = kuresel.document;

  function hazir(f) {
    if (belge.readyState === 'loading') belge.addEventListener('DOMContentLoaded', f);
    else f();
  }

  hazir(() => {
    /* ============================== BELGE MODALI ============================== */
    const belgeForm = belge.getElementById('belge-form');
    const belgeBaslikAlani = belge.getElementById('b-baslik');
    const belgeIcerikAlani = belge.getElementById('b-icerik');
    const belgeImzaAlani = belge.getElementById('b-imza');
    const belgeIdGizli = belge.getElementById('belge-id');
    const belgeModalBaslik = belge.getElementById('belge-modal-baslik');
    const belgeKaydetMetin = belge.getElementById('belge-kaydet-metin');
    const belgeSilDugme = belge.getElementById('belge-sil-dugme');
    const belgeHashSatiri = belge.getElementById('belge-hash-satiri');
    const belgeHashAlani = belge.getElementById('belge-hash');

    function belgeModalSifirla() {
      if (!belgeForm) return;
      belgeForm.reset();
      belgeForm.action = '/depo/belge';
      belgeIdGizli.value = '';
      if (belgeModalBaslik) belgeModalBaslik.textContent = 'YENI BELGE';
      if (belgeKaydetMetin) belgeKaydetMetin.textContent = 'OLUSTUR';
      if (belgeSilDugme) belgeSilDugme.classList.add('gizli');
      if (belgeHashSatiri) belgeHashSatiri.classList.add('gizli');
    }

    belge.querySelectorAll('[data-belge-yeni]').forEach((d) => d.addEventListener('click', belgeModalSifirla));

    belge.querySelectorAll('[data-belge-ac]').forEach((kart) => {
      kart.addEventListener('click', async () => {
        const id = kart.dataset.id;
        if (!id || !belgeForm) return;
        try {
          const sonuc = await kuresel.CMS.istek(`/depo/belge/${id}`);
          if (!sonuc.tamam || !sonuc.govde || !sonuc.govde.tamam) {
            if (kuresel.Ses) kuresel.Ses.ret();
            return;
          }
          const b = sonuc.govde.belge;
          belgeForm.action = `/depo/belge/${id}/guncelle`;
          belgeIdGizli.value = id;
          belgeBaslikAlani.value = b.baslik || '';
          belgeIcerikAlani.value = b.icerik || '';
          belgeImzaAlani.value = b.imza || '';
          if (belgeModalBaslik) belgeModalBaslik.textContent = 'BELGEYI DUZENLE';
          if (belgeKaydetMetin) belgeKaydetMetin.textContent = 'GUNCELLE';
          if (belgeSilDugme) belgeSilDugme.classList.remove('gizli');
          if (belgeHashAlani) belgeHashAlani.textContent = b.butunluk_hash || '';
          if (belgeHashSatiri) belgeHashSatiri.classList.remove('gizli');
          if (kuresel.CMSModal) kuresel.CMSModal.ac('modal-belge');
        } catch (_) {
          if (kuresel.Ses) kuresel.Ses.ret();
        }
      });
    });

    if (belgeSilDugme) {
      belgeSilDugme.addEventListener('click', () => {
        const id = belgeIdGizli.value;
        if (!id) return;
        if (!kuresel.confirm('Bu belgeyi silmek istediginize emin misiniz?')) return;

        const form = belge.createElement('form');
        form.method = 'post';
        form.action = `/depo/belge/${id}/sil`;
        form.style.display = 'none';
        const csrfGirdi = belge.createElement('input');
        csrfGirdi.type = 'hidden';
        csrfGirdi.name = '_csrf';
        csrfGirdi.value = kuresel.CMS ? kuresel.CMS.csrf : '';
        form.appendChild(csrfGirdi);
        belge.body.appendChild(form);
        form.submit();
      });
    }

    /* ============================== DOSYA YUKLEME ============================== */
    const surukleAlan = belge.getElementById('surukle-birak');
    const yukleGirdi = belge.getElementById('yukle-girdi');
    const yukleListe = belge.getElementById('yukle-liste');

    function boyutBicimle(bayt) {
      if (bayt > 1024 * 1024) return (bayt / (1024 * 1024)).toFixed(1) + ' MB';
      return (bayt / 1024).toFixed(0) + ' KB';
    }

    function secilenleriGoster() {
      if (!yukleGirdi || !yukleListe) return;
      const dosyalar = Array.from(yukleGirdi.files || []);
      if (dosyalar.length === 0) { yukleListe.textContent = ''; return; }
      yukleListe.textContent = dosyalar.map((d) => `• ${d.name} (${boyutBicimle(d.size)})`).join('\n');
      yukleListe.style.whiteSpace = 'pre-line';
    }

    if (yukleGirdi) yukleGirdi.addEventListener('change', secilenleriGoster);

    if (surukleAlan && yukleGirdi) {
      ['dragenter', 'dragover'].forEach((tur) => {
        surukleAlan.addEventListener(tur, (olay) => {
          olay.preventDefault();
          surukleAlan.classList.add('surukle-birak--aktif');
        });
      });
      ['dragleave', 'drop'].forEach((tur) => {
        surukleAlan.addEventListener(tur, (olay) => {
          olay.preventDefault();
          surukleAlan.classList.remove('surukle-birak--aktif');
        });
      });
      surukleAlan.addEventListener('drop', (olay) => {
        const dosyalar = olay.dataTransfer && olay.dataTransfer.files;
        if (dosyalar && dosyalar.length) {
          yukleGirdi.files = dosyalar;
          secilenleriGoster();
        }
      });
    }

    /* ============================== DISARIYA AC ============================== */
    const sifreAktifKutu = belge.getElementById('p-sifre-aktif');
    const sifreAlani = belge.getElementById('p-sifre-alani');
    if (sifreAktifKutu && sifreAlani) {
      sifreAktifKutu.addEventListener('change', () => {
        sifreAlani.classList.toggle('gizli', !sifreAktifKutu.checked);
        if (sifreAktifKutu.checked) belge.getElementById('p-sifre').focus();
      });
    }

    /* ============================== LINK KOPYALAMA ============================== */
    belge.querySelectorAll('[data-kopyala]').forEach((dugme) => {
      dugme.addEventListener('click', async () => {
        const metin = dugme.dataset.kopyala;
        const eskiMetin = dugme.textContent;
        try {
          if (kuresel.navigator.clipboard && kuresel.navigator.clipboard.writeText) {
            await kuresel.navigator.clipboard.writeText(metin);
          } else {
            throw new Error('clipboard yok');
          }
          dugme.textContent = 'KOPYALANDI';
          if (kuresel.Ses) kuresel.Ses.onay();
        } catch (_) {
          dugme.textContent = 'KOPYALANAMADI';
        }
        kuresel.setTimeout(() => { dugme.textContent = eskiMetin; }, 1600);
      });
    });
  });
})(window);
