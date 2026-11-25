'use strict';
/**
 * public/js/giris.js
 * Giris ekrani: CAPS LOCK uyarisi, bos alan denetimi, gonderim sirasinda
 * dugmenin kilitlenmesi ve hata seridinin yonetimi.
 */
(function () {
  const form = document.getElementById('giris-form');
  const kullanici = document.getElementById('kullanici_adi');
  const sifre = document.getElementById('sifre');
  const capsUyari = document.getElementById('caps-uyari');
  const dugme = document.getElementById('giris-dugme');
  const hataKutu = document.getElementById('giris-hata');
  if (!form) return;

  // ------------------------------------------------------------ CAPS LOCK
  function capsDenetle(olay) {
    if (!capsUyari || typeof olay.getModifierState !== 'function') return;
    const acik = olay.getModifierState('CapsLock');
    capsUyari.classList.toggle('gizli', !acik);
  }

  [kullanici, sifre].forEach(function (alan) {
    if (!alan) return;
    alan.addEventListener('keydown', capsDenetle);
    alan.addEventListener('keyup', capsDenetle);
    alan.addEventListener('focus', capsDenetle);
    alan.addEventListener('blur', function () {
      if (capsUyari) capsUyari.classList.add('gizli');
    });
  });

  // -------------------------------------------------------------- GONDERIM
  function hataGoster(metin) {
    if (!hataKutu) return;
    hataKutu.textContent = metin;
    hataKutu.classList.remove('gizli');
    if (window.Ses && window.Ses.hata) window.Ses.hata();
  }

  form.addEventListener('submit', function (olay) {
    const ka = kullanici ? kullanici.value.trim() : '';
    const sf = sifre ? sifre.value : '';

    if (!ka || !sf) {
      olay.preventDefault();
      hataGoster('Kullanici adi ve sifre zorunludur.');
      (!ka ? kullanici : sifre).focus();
      return;
    }

    if (dugme) {
      dugme.disabled = true;
      const metin = dugme.querySelector('.dugme-metin');
      if (metin) metin.textContent = 'DOGRULANIYOR…';
      // Sunucu hata dondurup sayfayi yeniden cizmezse kilidi birak
      setTimeout(function () {
        dugme.disabled = false;
        if (metin) metin.textContent = 'ERISIM TALEP ET';
      }, 8000);
    }
  });

  // Hata seridi varsa odagi ilgili alana ver
  if (hataKutu && !hataKutu.classList.contains('gizli')) {
    if (kullanici && !kullanici.value) kullanici.focus();
    else if (sifre) { sifre.focus(); sifre.select(); }
  } else if (kullanici && !kullanici.value) {
    kullanici.focus();
  }
})();
