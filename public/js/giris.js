'use strict';
/* ==========================================================================
   public/js/giris.js
   Giris ekrani: acilis dizisi, AJAX kimlik dogrulama, hata geri bildirimi.
   JS kapali olsa bile form normal POST ile calisir.
   ========================================================================== */

(function (kuresel) {
  const belge = kuresel.document;

  function hazir(isFonksiyonu) {
    if (belge.readyState === 'loading') belge.addEventListener('DOMContentLoaded', isFonksiyonu);
    else isFonksiyonu();
  }

  hazir(() => {
    const form = belge.getElementById('giris-form');
    if (!form) return;

    const kutu = belge.getElementById('giris-kutu');
    const hataAlani = belge.getElementById('giris-hata');
    const dugme = belge.getElementById('giris-dugme');
    const kullaniciAlani = belge.getElementById('kullanici_adi');
    const sifreAlani = belge.getElementById('sifre');
    const capsUyari = belge.getElementById('caps-uyari');

    // Acilis sesi
    if (kuresel.Ses) {
      const basla = () => {
        kuresel.Ses.uyandir();
        kuresel.Ses.acilis();
        belge.removeEventListener('pointerdown', basla);
        belge.removeEventListener('keydown', basla);
      };
      belge.addEventListener('pointerdown', basla, { once: true });
      belge.addEventListener('keydown', basla, { once: true });
    }

    // Odagi uygun alana ver
    if (kullaniciAlani && !kullaniciAlani.value) kullaniciAlani.focus();
    else if (sifreAlani) sifreAlani.focus();

    // Caps Lock uyarisi
    function capsKontrol(olay) {
      if (!capsUyari || typeof olay.getModifierState !== 'function') return;
      const acik = olay.getModifierState('CapsLock');
      capsUyari.classList.toggle('gizli', !acik);
    }
    if (sifreAlani) {
      sifreAlani.addEventListener('keyup', capsKontrol);
      sifreAlani.addEventListener('keydown', capsKontrol);
    }

    function hataGoster(mesaj, kalanDeneme) {
      if (!hataAlani) return;
      let metin = mesaj || 'Kimlik dogrulanamadi.';
      if (typeof kalanDeneme === 'number' && kalanDeneme > 0) {
        metin += ` Kalan deneme: ${kalanDeneme}.`;
      }
      hataAlani.textContent = metin;
      hataAlani.classList.remove('gizli');
      if (kutu) {
        kutu.classList.remove('sarsil');
        // Yeniden akis (reflow) tetikleyerek animasyonu tekrar baslat
        void kutu.offsetWidth;
        kutu.classList.add('sarsil');
      }
      if (kuresel.Ses) kuresel.Ses.ret();
      if (sifreAlani) { sifreAlani.value = ''; sifreAlani.focus(); }
    }

    form.dataset.ajax = '1';

    form.addEventListener('submit', async (olay) => {
      // fetch desteklenmiyorsa normal POST'a izin ver
      if (!kuresel.fetch) return;
      olay.preventDefault();

      if (hataAlani) hataAlani.classList.add('gizli');
      if (dugme) { dugme.dataset.mesgul = '1'; dugme.disabled = true; }
      if (kuresel.Ses) kuresel.Ses.tarama();

      const govde = {
        kullanici_adi: kullaniciAlani ? kullaniciAlani.value : '',
        sifre: sifreAlani ? sifreAlani.value : '',
        hedef: form.elements.hedef ? form.elements.hedef.value : '/merkez',
      };

      try {
        const sonuc = await kuresel.CMS.istek('/giris', { method: 'POST', govde });

        if (sonuc.tamam && sonuc.govde && sonuc.govde.tamam) {
          if (kuresel.Ses) kuresel.Ses.erisim();
          if (kuresel.Gecis) kuresel.Gecis.goster('ERISIM ONAYLANDI');
          kuresel.setTimeout(() => {
            kuresel.location.href = sonuc.govde.yonlendir || '/merkez';
          }, 620);
          return;
        }

        const v = sonuc.govde || {};
        if (v.kod === 'KILITLI' && v.kalanSaniye) {
          hataGoster(`${v.hata} Kalan sure: ${Math.ceil(v.kalanSaniye / 60)} dakika.`);
        } else {
          hataGoster(v.hata, v.kalanDeneme);
        }
      } catch (_) {
        hataGoster('Sunucuya ulasilamadi. Ag baglantisini kontrol edin.');
      } finally {
        if (dugme) { dugme.dataset.mesgul = '0'; dugme.disabled = false; }
      }
    });
  });
})(window);
