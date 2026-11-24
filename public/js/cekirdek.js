'use strict';
/* ==========================================================================
   public/js/cekirdek.js
   Tum sayfalarda calisan cekirdek: modul baslatma, ses baglama, saat,
   dinamik stil uygulama (CSP satir ici stil kullanmadigimiz icin) ve
   CSRF korumali fetch yardimcisi.
   ========================================================================== */

(function (kuresel) {
  const belge = kuresel.document;
  const govde = belge.body;
  const veri = govde ? govde.dataset : {};

  const CMS = {
    rota: veri.rota || '',
    csrf: veri.csrf || '',
    girisYapildi: veri.giris === '1',
    sesAyari: veri.ses !== '0',
    matrixAyari: veri.matrix !== '0',
    gecisAyari: veri.gecis !== '0',
  };

  /* ------------------------------------------------- 1. DINAMIK STILLER */
  /** data-oran="0..100" olan ogelerin genisligini uygular. */
  function oranlariUygula() {
    belge.querySelectorAll('[data-oran]').forEach((oge) => {
      const oran = Math.max(0, Math.min(100, Number(oge.dataset.oran) || 0));
      oge.style.width = oran + '%';
    });
  }

  /** data-renk="#00ff9c" olan ogelere sol kenar rengi verir. */
  function renkleriUygula() {
    belge.querySelectorAll('[data-renk]').forEach((oge) => {
      const renk = String(oge.dataset.renk || '');
      if (/^#[0-9a-fA-F]{3,8}$/.test(renk)) {
        oge.style.borderLeftColor = renk;
        const im = oge.querySelector('.kart-im');
        if (im) im.style.color = renk;
      }
    });
  }

  /** Acilis satirlarini sirayla gosterir (animasyon gecikmesi JS ile). */
  function acilisSatirlari() {
    belge.querySelectorAll('.acilis-satir').forEach((oge, sira) => {
      oge.style.animationDelay = (sira * 0.14).toFixed(2) + 's';
    });
  }

  /* ---------------------------------------------------------- 2. SAAT */
  function saatBaslat() {
    const kutu = belge.getElementById('saat');
    if (!kutu) return;
    function yaz() {
      const t = new Date();
      const ik = (n) => String(n).padStart(2, '0');
      kutu.textContent =
        `${t.getFullYear()}.${ik(t.getMonth() + 1)}.${ik(t.getDate())} ` +
        `${ik(t.getHours())}:${ik(t.getMinutes())}:${ik(t.getSeconds())}`;
    }
    yaz();
    kuresel.setInterval(yaz, 1000);
  }

  /* ----------------------------------------------------- 3. SES BAGLAMA */
  function sesBaglant() {
    if (!CMS.sesAyari && kuresel.Ses) kuresel.Ses.sunucuKapatti();

    const dugme = belge.getElementById('ses-dugme');
    if (dugme && kuresel.Ses) {
      const yenile = () => {
        const a = kuresel.Ses.acikMi();
        dugme.setAttribute('aria-pressed', a ? 'true' : 'false');
        dugme.textContent = a ? '◉' : '○';
        dugme.title = a ? 'Ses efektleri acik' : 'Ses efektleri kapali';
      };
      yenile();
      dugme.addEventListener('click', () => { kuresel.Ses.degistir(); yenile(); });
    }

    if (!kuresel.Ses) return;

    // Ilk hareket: AudioContext'i ac
    const uyandir = () => {
      kuresel.Ses.uyandir();
      belge.removeEventListener('pointerdown', uyandir);
      belge.removeEventListener('keydown', uyandir);
    };
    belge.addEventListener('pointerdown', uyandir, { once: false });
    belge.addEventListener('keydown', uyandir, { once: false });

    // Dugme ve baglanti tiklamalari
    belge.addEventListener('pointerdown', (olay) => {
      const t = olay.target.closest ? olay.target.closest('button, .dugme, a, .kart, .menu-bag, .alt-bag') : null;
      if (!t) return;
      if (t.matches('a, .menu-bag, .alt-bag, .kart')) kuresel.Ses.gezin();
      else kuresel.Ses.tik();
    }, { passive: true });

    // Yazi yazma blipi (sifre alanlarinda da calisir, icerik okunmaz)
    belge.addEventListener('keydown', (olay) => {
      if (!(olay.target instanceof kuresel.HTMLElement)) return;
      if (!olay.target.matches('input, textarea')) return;
      if (olay.key === 'Enter') { kuresel.Ses.onay(); return; }
      if (olay.key.length === 1 || olay.key === 'Backspace') kuresel.Ses.yazma();
    });
  }

  /* --------------------------------------------- 4. CSRF KORUMALI FETCH */
  /**
   * Sunucuya JSON istegi gonderir. CSRF belirteci otomatik eklenir.
   * @returns {Promise<{durum:number, govde:any}>}
   */
  async function istek(adres, secenekler = {}) {
    const ayarlar = {
      method: secenekler.method || 'GET',
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'fetch',
        ...(secenekler.headers || {}),
      },
      credentials: 'same-origin',
      redirect: 'follow',
    };

    if (ayarlar.method !== 'GET' && ayarlar.method !== 'HEAD') {
      ayarlar.headers['X-CSRF-Token'] = CMS.csrf;
      if (secenekler.govde !== undefined) {
        ayarlar.headers['Content-Type'] = 'application/json';
        ayarlar.body = JSON.stringify(secenekler.govde);
      }
    }

    const yanit = await kuresel.fetch(adres, ayarlar);
    let govdeVeri = null;
    try { govdeVeri = await yanit.json(); } catch (_) { govdeVeri = null; }

    // Oturum dustuyse giris ekranina al
    if (yanit.status === 401 && govdeVeri && govdeVeri.yonlendir) {
      kuresel.location.href = govdeVeri.yonlendir;
    }
    // CSRF belirteci eskimisse tazele
    if (yanit.status === 403 && govdeVeri && govdeVeri.kod === 'CSRF_GECERSIZ') {
      await belirtecTazele();
    }

    return { durum: yanit.status, govde: govdeVeri, tamam: yanit.ok };
  }

  async function belirtecTazele() {
    try {
      const y = await kuresel.fetch('/api/kimlik/belirtec', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      const v = await y.json();
      if (v && v.csrf) {
        CMS.csrf = v.csrf;
        govde.dataset.csrf = v.csrf;
        belge.querySelectorAll('input[name="_csrf"]').forEach((g) => { g.value = v.csrf; });
      }
    } catch (_) { /* sessiz */ }
  }

  /* ------------------------------------------- 5. DUGME MESGUL DURUMU */
  function formMesgul() {
    belge.addEventListener('submit', (olay) => {
      const form = olay.target;
      if (!form || form.dataset.ajax === '1') return;
      form.querySelectorAll('button[type="submit"], .dugme[type="submit"]').forEach((d) => {
        d.dataset.mesgul = '1';
        d.disabled = true;
      });
    }, true);
  }

  /** form[data-onay] gonderilmeden once tarayici onayi ister (silme vb.). */
  function onayFormlariBaglat() {
    belge.addEventListener('submit', (olay) => {
      const form = olay.target;
      if (!form || !form.dataset || !form.dataset.onay) return;
      if (!kuresel.confirm(form.dataset.onay)) {
        olay.preventDefault();
        olay.stopImmediatePropagation();
        if (kuresel.Ses) kuresel.Ses.uyari();
      }
    }, true);
  }

  /**
   * Genel modal sistemi: [data-modal-ac="id"] -> acar, [data-modal-kapat] ->
   * en yakin .modal-perde'yi kapatir, arka plana veya Escape'e tiklamak da
   * kapatir. Sayfalar modal govdesini kendileri doldurur (depo.js vb.).
   */
  function modalSistemiBaglat() {
    function ac(id) {
      const perde = belge.getElementById(id);
      if (!perde) return;
      perde.classList.add('acik');
      perde.setAttribute('aria-hidden', 'false');
      const ilkGirdi = perde.querySelector('input, textarea, select');
      if (ilkGirdi) kuresel.setTimeout(() => ilkGirdi.focus(), 60);
      if (kuresel.Ses) kuresel.Ses.onay();
    }
    function kapatHepsi() {
      belge.querySelectorAll('.modal-perde.acik').forEach((p) => {
        p.classList.remove('acik');
        p.setAttribute('aria-hidden', 'true');
      });
    }

    belge.addEventListener('click', (olay) => {
      const acTetik = olay.target.closest ? olay.target.closest('[data-modal-ac]') : null;
      if (acTetik) { ac(acTetik.dataset.modalAc); return; }

      const kapatTetik = olay.target.closest ? olay.target.closest('[data-modal-kapat]') : null;
      if (kapatTetik) { kapatHepsi(); return; }

      // Modal arka planina (perdenin kendisine) tiklama da kapatir.
      if (olay.target.classList && olay.target.classList.contains('modal-perde')) kapatHepsi();
    });

    belge.addEventListener('keydown', (olay) => {
      if (olay.key === 'Escape') kapatHepsi();
    });

    kuresel.CMSModal = { ac, kapatHepsi };
  }

  /* ----------------------------------------- 6. OTURUM NABIZ KONTROLU */
  function nabiz() {
    if (!CMS.girisYapildi) return;
    kuresel.setInterval(async () => {
      try {
        const y = await kuresel.fetch('/api/kimlik/durum', {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        });
        const v = await y.json();
        if (v && v.oturumAcik === false) {
          if (kuresel.Ses) kuresel.Ses.uyari();
          kuresel.location.href = '/giris?sebep=mutlak';
        }
      } catch (_) { /* ag kesilmis olabilir, sessiz gec */ }
    }, 120000);  // 2 dakikada bir
  }

  /* ---------------------------------------------------- 7. BASLATICI */
  function baslat() {
    oranlariUygula();
    renkleriUygula();
    acilisSatirlari();
    saatBaslat();
    sesBaglant();
    formMesgul();
    onayFormlariBaglat();
    modalSistemiBaglat();
    nabiz();

    if (kuresel.Matrix && CMS.matrixAyari) {
      const tuval = belge.getElementById('matrix-tuval');
      if (tuval) CMS.matrixOrnek = kuresel.Matrix.baslat(tuval);
    }

    if (kuresel.Gecis) kuresel.Gecis.baslat(CMS.gecisAyari);

    govde.classList.add('hazir');
  }

  CMS.istek = istek;
  CMS.belirtecTazele = belirtecTazele;
  CMS.oranlariUygula = oranlariUygula;
  kuresel.CMS = CMS;

  if (belge.readyState === 'loading') {
    belge.addEventListener('DOMContentLoaded', baslat);
  } else {
    baslat();
  }
})(window);
