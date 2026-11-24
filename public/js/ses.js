'use strict';
/* ==========================================================================
   public/js/ses.js
   Web Audio API ile uretilen terminal ses efektleri.
   Hicbir ses dosyasi indirilmez; tum sesler osilatorle sentezlenir.
   Tarayici politikasi geregi AudioContext ilk kullanici hareketinde acilir.
   ========================================================================== */

(function (kuresel) {
  const DEPO_ANAHTARI = 'cms_ses_acik';

  let baglam = null;
  let anaKazanc = null;
  let acik = true;
  let hazir = false;

  /** Kullanicinin daha once kaydettigi tercihi oku. */
  try {
    const kayit = kuresel.localStorage.getItem(DEPO_ANAHTARI);
    if (kayit !== null) acik = kayit === '1';
  } catch (_) { /* localStorage kapali olabilir */ }

  function baglamAc() {
    if (baglam) return baglam;
    const AC = kuresel.AudioContext || kuresel.webkitAudioContext;
    if (!AC) return null;
    try {
      baglam = new AC();
      anaKazanc = baglam.createGain();
      anaKazanc.gain.value = 0.16;          // genel ses seviyesi (kisik)
      anaKazanc.connect(baglam.destination);
      hazir = true;
    } catch (_) {
      baglam = null;
    }
    return baglam;
  }

  function devamEt() {
    if (baglam && baglam.state === 'suspended') baglam.resume().catch(() => {});
  }

  /** Tek ton uretir. */
  function ton({ frekans = 440, sure = 0.08, tur = 'square', hacim = 0.5, bitisFrekans = null, gecikme = 0 }) {
    if (!acik) return;
    const b = baglamAc();
    if (!b) return;
    devamEt();

    const t0 = b.currentTime + gecikme;
    const osilator = b.createOscillator();
    const kazanc = b.createGain();

    osilator.type = tur;
    osilator.frequency.setValueAtTime(frekans, t0);
    if (bitisFrekans) osilator.frequency.exponentialRampToValueAtTime(Math.max(bitisFrekans, 1), t0 + sure);

    // Yumusak zarf: tiklama sesini (click artifact) engeller
    kazanc.gain.setValueAtTime(0.0001, t0);
    kazanc.gain.exponentialRampToValueAtTime(hacim, t0 + 0.006);
    kazanc.gain.exponentialRampToValueAtTime(0.0001, t0 + sure);

    osilator.connect(kazanc);
    kazanc.connect(anaKazanc);
    osilator.start(t0);
    osilator.stop(t0 + sure + 0.02);
  }

  /** Filtrelenmis gurultu (tarama, parazit efektleri icin). */
  function gurultu({ sure = 0.18, hacim = 0.25, baslangicHz = 400, bitisHz = 2600, q = 6 }) {
    if (!acik) return;
    const b = baglamAc();
    if (!b) return;
    devamEt();

    const ornekSayisi = Math.floor(b.sampleRate * sure);
    const tampon = b.createBuffer(1, ornekSayisi, b.sampleRate);
    const veri = tampon.getChannelData(0);
    for (let i = 0; i < ornekSayisi; i++) veri[i] = Math.random() * 2 - 1;

    const kaynak = b.createBufferSource();
    kaynak.buffer = tampon;

    const suzgec = b.createBiquadFilter();
    suzgec.type = 'bandpass';
    suzgec.Q.value = q;
    suzgec.frequency.setValueAtTime(baslangicHz, b.currentTime);
    suzgec.frequency.exponentialRampToValueAtTime(bitisHz, b.currentTime + sure);

    const kazanc = b.createGain();
    kazanc.gain.setValueAtTime(hacim, b.currentTime);
    kazanc.gain.exponentialRampToValueAtTime(0.0001, b.currentTime + sure);

    kaynak.connect(suzgec);
    suzgec.connect(kazanc);
    kazanc.connect(anaKazanc);
    kaynak.start();
  }

  /* --------------------------------------------------------- SES PALETI */

  const Ses = {
    /** Kisa mekanik tus tiklamasi */
    tik() { ton({ frekans: 1180, bitisFrekans: 620, sure: 0.035, tur: 'square', hacim: 0.3 }); },

    /** Daha yumusak gezinme tiklamasi */
    gezin() { ton({ frekans: 760, bitisFrekans: 1240, sure: 0.055, tur: 'triangle', hacim: 0.32 }); },

    /** Klavye yazma blipi (rastgele perdeli) */
    yazma() {
      const f = 1500 + Math.random() * 700;
      ton({ frekans: f, bitisFrekans: f * 0.6, sure: 0.022, tur: 'square', hacim: 0.14 });
    },

    /** Erisim onaylandi: yukselen arpej */
    erisim() {
      ton({ frekans: 523.25, sure: 0.09, tur: 'triangle', hacim: 0.45, gecikme: 0 });
      ton({ frekans: 659.25, sure: 0.09, tur: 'triangle', hacim: 0.45, gecikme: 0.085 });
      ton({ frekans: 783.99, sure: 0.09, tur: 'triangle', hacim: 0.45, gecikme: 0.17 });
      ton({ frekans: 1046.5, sure: 0.24, tur: 'sine', hacim: 0.4, gecikme: 0.255 });
      gurultu({ sure: 0.3, hacim: 0.07, baslangicHz: 900, bitisHz: 3600, q: 3 });
    },

    /** Erisim reddedildi: alcalan sert ikili */
    ret() {
      ton({ frekans: 220, bitisFrekans: 110, sure: 0.16, tur: 'sawtooth', hacim: 0.4 });
      ton({ frekans: 180, bitisFrekans: 70, sure: 0.26, tur: 'sawtooth', hacim: 0.36, gecikme: 0.14 });
    },

    /** Uyari: cift bip */
    uyari() {
      ton({ frekans: 880, sure: 0.07, tur: 'square', hacim: 0.34 });
      ton({ frekans: 880, sure: 0.07, tur: 'square', hacim: 0.34, gecikme: 0.12 });
    },

    /** Onay: tek net bip */
    onay() { ton({ frekans: 1046.5, bitisFrekans: 1568, sure: 0.12, tur: 'triangle', hacim: 0.38 }); },

    /** Sayfa gecisi: supurme */
    gecis() {
      gurultu({ sure: 0.26, hacim: 0.16, baslangicHz: 220, bitisHz: 3200, q: 2 });
      ton({ frekans: 320, bitisFrekans: 1100, sure: 0.2, tur: 'sine', hacim: 0.2 });
    },

    /** Tarama / veri yukleme */
    tarama() { gurultu({ sure: 0.45, hacim: 0.12, baslangicHz: 500, bitisHz: 4200, q: 8 }); },

    /** Acilis sinyali */
    acilis() {
      ton({ frekans: 196, sure: 0.3, tur: 'sine', hacim: 0.3 });
      ton({ frekans: 392, sure: 0.3, tur: 'sine', hacim: 0.22, gecikme: 0.06 });
      gurultu({ sure: 0.5, hacim: 0.06, baslangicHz: 180, bitisHz: 2400, q: 2 });
    },

    /** Kritik alarm */
    alarm() {
      for (let i = 0; i < 3; i++) {
        ton({ frekans: 740, bitisFrekans: 480, sure: 0.12, tur: 'sawtooth', hacim: 0.3, gecikme: i * 0.18 });
      }
    },

    /* -------------------------------------------------------- Yonetim */

    acikMi() { return acik; },

    ayarla(durum) {
      acik = Boolean(durum);
      try { kuresel.localStorage.setItem(DEPO_ANAHTARI, acik ? '1' : '0'); } catch (_) {}
      if (acik) { baglamAc(); devamEt(); Ses.onay(); }
      return acik;
    },

    degistir() { return Ses.ayarla(!acik); },

    /** Sunucu ayarı sesi kapattiysa tamamen devre disi birak. */
    sunucuKapatti() { acik = false; },

    hazirMi() { return hazir; },

    /** Ilk kullanici hareketinde baglami ac. */
    uyandir() { baglamAc(); devamEt(); },
  };

  kuresel.Ses = Ses;
})(window);
