'use strict';
/* ==========================================================================
   public/js/gecis.js
   Sayfa gecis animasyonu: dahili baglantilara tiklandiginda perde acilir,
   ses calinir ve kisa bir gecikmeyle gercek yonlendirme yapilir.
   JS kapali olsa bile baglantilar normal calisir (zarif bozulma).
   ========================================================================== */

(function (kuresel) {
  const belge = kuresel.document;
  const SURE = 230;

  let perde = null;
  let yazi = null;
  let aktif = true;

  function perdeKur() {
    if (perde) return perde;
    perde = belge.createElement('div');
    perde.className = 'gecis-perde';
    perde.setAttribute('aria-hidden', 'true');

    const cizgi = belge.createElement('div');
    cizgi.className = 'gecis-cizgi';

    yazi = belge.createElement('div');
    yazi.className = 'gecis-yazi';
    yazi.textContent = 'BAGLANTI KURULUYOR';

    perde.appendChild(cizgi);
    perde.appendChild(yazi);
    belge.body.appendChild(perde);
    return perde;
  }

  function gosterr(metin) {
    const p = perdeKur();
    if (metin && yazi) yazi.textContent = metin;
    p.classList.add('acik');
  }

  function kapat() {
    if (perde) perde.classList.remove('acik');
  }

  /** Dahili, ayni sekmede acilacak bir baglanti mi? */
  function dahiliBaglanti(bag) {
    if (!bag) return false;
    if (bag.target && bag.target !== '_self') return false;
    if (bag.hasAttribute('download')) return false;
    if (bag.dataset.gecisYok === '1') return false;
    const href = bag.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return false;
    try {
      const url = new kuresel.URL(bag.href, kuresel.location.href);
      if (url.origin !== kuresel.location.origin) return false;
      if (url.pathname === kuresel.location.pathname && url.search === kuresel.location.search) return false;
      return true;
    } catch (_) { return false; }
  }

  function tiklama(olay) {
    if (!aktif) return;
    if (olay.defaultPrevented || olay.button !== 0) return;
    if (olay.metaKey || olay.ctrlKey || olay.shiftKey || olay.altKey) return;

    const bag = olay.target.closest ? olay.target.closest('a[href]') : null;
    if (!dahiliBaglanti(bag)) return;

    olay.preventDefault();
    // Ses efekti istege baglidir: eksik ya da hatali bir ses metodu asla
    // yonlendirmeyi engellememelidir (aksi halde tum baglantilar olur).
    try {
      if (kuresel.Ses && typeof kuresel.Ses.gecis === 'function') kuresel.Ses.gecis();
    } catch (_) { /* ses hatasi yoksayilir */ }

    const etiket = bag.dataset.gecisYazi || 'BAGLANTI KURULUYOR';
    gosterr(etiket);

    kuresel.setTimeout(() => { kuresel.location.href = bag.href; }, SURE);
  }

  /** Form gonderimlerinde de perdeyi goster. */
  function formGonderim(olay) {
    if (!aktif) return;
    const form = olay.target;
    if (!form || form.dataset.gecisYok === '1' || form.dataset.ajax === '1') return;
    gosterr(form.dataset.gecisYazi || 'ISLENIYOR');
  }

  function baslat(etkin) {
    aktif = etkin !== false;
    const azHareket = kuresel.matchMedia && kuresel.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (azHareket) aktif = false;

    belge.addEventListener('click', tiklama, true);
    belge.addEventListener('submit', formGonderim, true);

    // Geri/ileri tuslariyla donuste perdeyi kapat
    kuresel.addEventListener('pageshow', kapat);
    kuresel.addEventListener('popstate', kapat);
  }

  kuresel.Gecis = { baslat, goster: gosterr, kapat };
})(window);
