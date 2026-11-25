'use strict';
/**
 * public/js/ses.js
 * Arayuz ses efektleri. Hicbir ses dosyasi yuklenmez; tum tonlar Web Audio
 * API ile anlik uretilir — kapali devre calisma ilkesine uygundur.
 *
 * Dis arayuz (cekirdek.js bunlari bekler):
 *   Ses.uyandir()        ilk kullanici hareketinde AudioContext'i acar
 *   Ses.acikMi()         ses acik mi
 *   Ses.degistir()       ac/kapat, tercihi localStorage'a yazar
 *   Ses.sunucuKapatti()  sunucu ayari kapaliysa butun sesleri susturur
 *   Ses.tik() .gezin() .onay() .yazma() .uyari() .hata() .basarili()
 */
(function (kuresel) {
  const ANAHTAR = 'cms.ses';
  const HAREKET_AZ = kuresel.matchMedia
    && kuresel.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let baglam = null;
  let anaKazanc = null;
  let sunucuIzni = true;
  let acik = true;
  let sonYazma = 0;

  try {
    const kayitli = kuresel.localStorage.getItem(ANAHTAR);
    if (kayitli !== null) acik = kayitli === '1';
  } catch (hata) { /* depolama yok: varsayilan acik */ }

  function kullanilabilir() {
    return acik && sunucuIzni && !HAREKET_AZ;
  }

  function uyandir() {
    if (baglam) {
      if (baglam.state === 'suspended') baglam.resume().catch(function () {});
      return baglam;
    }
    const Yapici = kuresel.AudioContext || kuresel.webkitAudioContext;
    if (!Yapici) return null;
    try {
      baglam = new Yapici();
      anaKazanc = baglam.createGain();
      anaKazanc.gain.value = 0.085;
      anaKazanc.connect(baglam.destination);
    } catch (hata) { baglam = null; }
    return baglam;
  }

  /**
   * Tek bir ton calar.
   * @param {number} frekans  Hz
   * @param {number} sure     saniye
   * @param {string} bicim    'sine' | 'square' | 'triangle' | 'sawtooth'
   * @param {number} hacim    0-1
   * @param {number} gecikme  saniye
   * @param {number} bitisFrekans  kaydirma hedefi (yoksa sabit)
   */
  function ton(frekans, sure, bicim, hacim, gecikme, bitisFrekans) {
    if (!kullanilabilir()) return;
    const b = uyandir();
    if (!b) return;

    const t0 = b.currentTime + (gecikme || 0);
    const osi = b.createOscillator();
    const kaz = b.createGain();

    osi.type = bicim || 'sine';
    osi.frequency.setValueAtTime(frekans, t0);
    if (bitisFrekans) osi.frequency.exponentialRampToValueAtTime(Math.max(20, bitisFrekans), t0 + sure);

    // Yumusak zarf: tiklama sesini onler
    const tepe = Math.max(0.0001, hacim === undefined ? 0.6 : hacim);
    kaz.gain.setValueAtTime(0.0001, t0);
    kaz.gain.exponentialRampToValueAtTime(tepe, t0 + Math.min(0.012, sure * 0.3));
    kaz.gain.exponentialRampToValueAtTime(0.0001, t0 + sure);

    osi.connect(kaz);
    kaz.connect(anaKazanc);
    osi.start(t0);
    osi.stop(t0 + sure + 0.02);
  }

  /** Kisa gurultu patlamasi: dokunsal geri bildirim hissi verir. */
  function gurultu(sure, hacim) {
    if (!kullanilabilir()) return;
    const b = uyandir();
    if (!b) return;

    const ornekSayisi = Math.floor(b.sampleRate * sure);
    const tampon = b.createBuffer(1, Math.max(1, ornekSayisi), b.sampleRate);
    const veri = tampon.getChannelData(0);
    for (let i = 0; i < ornekSayisi; i += 1) {
      veri[i] = (Math.random() * 2 - 1) * (1 - i / ornekSayisi);
    }

    const kaynak = b.createBufferSource();
    kaynak.buffer = tampon;

    const suzgec = b.createBiquadFilter();
    suzgec.type = 'bandpass';
    suzgec.frequency.value = 1800;
    suzgec.Q.value = 0.9;

    const kaz = b.createGain();
    kaz.gain.value = hacim === undefined ? 0.25 : hacim;

    kaynak.connect(suzgec);
    suzgec.connect(kaz);
    kaz.connect(anaKazanc);
    kaynak.start();
  }

  const Ses = {
    uyandir,
    acikMi: function () { return acik && sunucuIzni; },

    degistir: function () {
      acik = !acik;
      try { kuresel.localStorage.setItem(ANAHTAR, acik ? '1' : '0'); } catch (hata) { /* yoksay */ }
      if (acik) { uyandir(); ton(880, 0.07, 'sine', 0.5); }
      return acik;
    },

    sunucuKapatti: function () { sunucuIzni = false; },

    /** Dugme tiklamasi: kisa, kuru. */
    tik: function () { ton(1320, 0.035, 'square', 0.22); },

    /** Baglanti/kart gezinmesi: yukari dogru kucuk bir kaydirma. */
    gezin: function () { ton(660, 0.05, 'triangle', 0.3, 0, 880); },

    /** Sayfa gecisi: kisa, yukari dogru baglanti kurma tonu. */
    gecis: function () { ton(880, 0.12, 'sine', 0.3, 0, 1320); },

    /** Enter / onay: iki notali kisa arpej. */
    onay: function () {
      ton(784, 0.06, 'sine', 0.4);
      ton(1175, 0.08, 'sine', 0.33, 0.055);
    },

    /** Tus basimi: cok kisik, hizli tekrarda bogulmasin diye kisitlanir. */
    yazma: function () {
      const simdi = Date.now();
      if (simdi - sonYazma < 38) return;
      sonYazma = simdi;
      gurultu(0.012, 0.08);
    },

    /** Uyari: alcaktan yukari iki darbe. */
    uyari: function () {
      ton(540, 0.1, 'square', 0.3);
      ton(680, 0.14, 'square', 0.26, 0.11);
    },

    /** Hata: asagi dogru kaydirma. */
    hata: function () { ton(420, 0.22, 'sawtooth', 0.26, 0, 180); },

    /** Basarili islem: ucgen arpej. */
    basarili: function () {
      ton(659, 0.07, 'sine', 0.34);
      ton(880, 0.07, 'sine', 0.32, 0.07);
      ton(1319, 0.11, 'sine', 0.28, 0.14);
    },
  };

  kuresel.Ses = Ses;
})(window);
