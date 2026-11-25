'use strict';
/**
 * public/js/merkez.js
 * Kontrol merkezi nabzi: /merkez/api/nabiz uc noktasini belirli araliklarla
 * yoklar, sayaclari ve hareket grafigini tazeler, yeni uyari gelirse
 * gorsel olarak bildirir. Sayfa arka plandaysa yoklama durur.
 */
(function () {
  const kadran = document.querySelector('.tehdit-kadran[data-puan]');
  const grafik = document.getElementById('hareket-grafigi');
  const serit = document.getElementById('nabiz-serit');
  if (!kadran && !grafik) return;

  const ARALIK_MS = 45000;
  let zamanlayici = null;
  let sonUyariKimligi = null;

  function sayacYaz(ad, deger) {
    document.querySelectorAll('[data-sayim="' + ad + '"]').forEach(function (dugum) {
      const eski = Number(String(dugum.textContent).replace(/\D/g, '')) || 0;
      dugum.textContent = Number(deger).toLocaleString('tr-TR');
      if (deger !== eski) {
        dugum.classList.add('deger-degisti');
        setTimeout(function () { dugum.classList.remove('deger-degisti'); }, 1600);
      }
    });
  }

  function seritYaz(metin, seviye) {
    if (!serit) return;
    serit.textContent = metin;
    serit.setAttribute('data-seviye', seviye || 'bilgi');
  }

  async function nabiz() {
    if (document.hidden) return;
    try {
      const yanit = await fetch('/merkez/api/nabiz', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!yanit.ok) return;
      const veri = await yanit.json();
      if (!veri.tamam) return;

      Object.keys(veri.sayim || {}).forEach(function (ad) {
        sayacYaz(ad, veri.sayim[ad]);
      });

      if (grafik && veri.hareket && veri.hareket.length) {
        grafik.setAttribute('data-seri', JSON.stringify(veri.hareket.map(function (h) {
          return { etiket: h.etiket, kayit: h.kayit, olay: h.olay };
        })));
        if (window.HUD && window.HUD.kur) window.HUD.kur(grafik.parentElement || document);
      }

      const yeni = (veri.uyarilar || [])[0];
      if (yeni && yeni.id !== sonUyariKimligi) {
        if (sonUyariKimligi !== null) {
          seritYaz('YENI UYARI · ' + yeni.baslik, yeni.seviye);
          const rozet = document.querySelector('.gez-rozet');
          if (rozet) {
            rozet.textContent = String((Number(rozet.textContent) || 0) + 1);
            rozet.classList.add('rozet-yeni');
          }
          if (window.Ses && typeof window.Ses.uyari === 'function') window.Ses.uyari();
        }
        sonUyariKimligi = yeni.id;
      }

      const saat = document.getElementById('nabiz-zaman');
      if (saat) {
        saat.textContent = new Date(veri.zaman).toLocaleTimeString('tr-TR');
      }
    } catch (hata) { /* ag kesildi: sessizce bir sonraki turu bekle */ }
  }

  function basla() {
    durdur();
    zamanlayici = setInterval(nabiz, ARALIK_MS);
  }

  function durdur() {
    if (zamanlayici) clearInterval(zamanlayici);
    zamanlayici = null;
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) durdur(); else { nabiz(); basla(); }
  });

  document.addEventListener('DOMContentLoaded', function () {
    const ilk = document.querySelector('[data-son-uyari]');
    if (ilk) sonUyariKimligi = Number(ilk.getAttribute('data-son-uyari')) || null;
    basla();
  });
})();
