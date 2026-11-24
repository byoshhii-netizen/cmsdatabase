'use strict';
/* ==========================================================================
   public/js/pano-liste.js
   /pano (liste sayfasi) icin: yedekten ice aktarma dosya secimi ve yuklemesi.
   Modal acma/kapama ve silme onayi public/js/cekirdek.js icinde geneldir.
   ========================================================================== */

(function (kuresel) {
  const belge = kuresel.document;

  function hazir(f) {
    if (belge.readyState === 'loading') belge.addEventListener('DOMContentLoaded', f);
    else f();
  }

  hazir(() => {
    const girdi = belge.getElementById('pano-liste-yedek-girdi');
    const adAlani = belge.getElementById('pano-liste-yedek-ad');
    const dugme = belge.getElementById('pano-liste-ice-aktar-dugme');
    const hataKutu = belge.getElementById('pano-liste-ice-aktar-hata');
    if (!girdi || !dugme) return;

    girdi.addEventListener('change', () => {
      const dosya = girdi.files && girdi.files[0];
      adAlani.textContent = dosya ? dosya.name : 'dosya secilmedi';
      dugme.disabled = !dosya;
      hataKutu.classList.add('gizli');
    });

    dugme.addEventListener('click', async () => {
      const dosya = girdi.files && girdi.files[0];
      if (!dosya) return;

      dugme.dataset.mesgul = '1';
      dugme.disabled = true;
      hataKutu.classList.add('gizli');

      try {
        const govde = new FormData();
        govde.append('yedek', dosya);

        const yanit = await kuresel.fetch('/pano/ice-aktar', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'X-CSRF-Token': kuresel.CMS ? kuresel.CMS.csrf : '', Accept: 'application/json' },
          body: govde,
        });
        const veri = await yanit.json().catch(() => null);

        if (yanit.ok && veri && veri.tamam) {
          if (kuresel.Ses) kuresel.Ses.tarama();
          kuresel.location.href = `/pano/${veri.pano.id}`;
          return;
        }

        if (kuresel.Ses) kuresel.Ses.ret();
        hataKutu.textContent = (veri && veri.hata) || 'Yedek ice aktarilamadi.';
        hataKutu.classList.remove('gizli');
      } catch (_) {
        if (kuresel.Ses) kuresel.Ses.ret();
        hataKutu.textContent = 'Sunucuya ulasilamadi.';
        hataKutu.classList.remove('gizli');
      } finally {
        dugme.dataset.mesgul = '0';
        dugme.disabled = false;
      }
    });
  });
})(window);
