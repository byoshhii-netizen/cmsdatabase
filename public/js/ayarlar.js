'use strict';
/**
 * public/js/ayarlar.js
 * Ayarlar ekrani: sifre gucu olcumu, eslesme denetimi, ses motoru
 * onizlemesi, dosya secimi geri bildirimi ve #zeka bolumunun bakim
 * islerinde (dizin kurma, model egitimi) kullaniciyi bilgilendirme.
 */
(function () {
  // ===================================================== 1. SIFRE GUCU
  const yeni = document.getElementById('yeni_sifre');
  const tekrar = document.getElementById('yeni_sifre_tekrar');
  const gucCubuk = document.getElementById('guc-cubuk');
  const gucEtiket = document.getElementById('guc-etiket');
  const eslesmeNotu = document.getElementById('eslesme-notu');

  /**
   * Sifre gucunu entropi yaklasimiyla olcer: alfabe buyuklugu x uzunluk.
   * Yaygin kaliplar (tekrar, artan dizi, klavye sirasi, sozluk parcasi)
   * dusurucu olarak uygulanir. 0-100 arasi puan dondurur.
   */
  function gucOlc(s) {
    if (!s) return { puan: 0, ad: '—', notlar: [] };

    const notlar = [];
    let alfabe = 0;
    if (/[a-z]/.test(s)) alfabe += 26;
    if (/[A-Z]/.test(s)) alfabe += 26;
    if (/[0-9]/.test(s)) alfabe += 10;
    if (/[^A-Za-z0-9]/.test(s)) alfabe += 32;
    if (/[çğıöşüÇĞİÖŞÜ]/.test(s)) alfabe += 12;

    let entropi = s.length * (Math.log(Math.max(2, alfabe)) / Math.log(2));

    // Tekrar eden karakterler
    const tekilOran = new Set(s.split('')).size / s.length;
    if (tekilOran < 0.5) { entropi *= 0.65; notlar.push('cok tekrar eden karakter var'); }

    // Artan/azalan diziler ve klavye siralari
    const kaliplar = ['abcdefghijklmnopqrstuvwxyz', '0123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
    const kucuk = s.toLowerCase();
    for (let i = 0; i < kaliplar.length; i += 1) {
      for (let j = 0; j + 4 <= kaliplar[i].length; j += 1) {
        const parca = kaliplar[i].slice(j, j + 4);
        if (kucuk.indexOf(parca) >= 0 || kucuk.indexOf(parca.split('').reverse().join('')) >= 0) {
          entropi *= 0.7;
          notlar.push('tahmin edilebilir dizi (' + parca + ')');
          i = kaliplar.length;
          break;
        }
      }
    }

    // Sik kullanilan parcalar
    ['sifre', 'password', '1234', 'admin', 'qwerty', 'cms', 'merkez', 'veri'].forEach(function (p) {
      if (kucuk.indexOf(p) >= 0) { entropi *= 0.6; notlar.push('"' + p + '" cok yaygin bir parca'); }
    });

    if (s.length < 12) notlar.push('en az 12 karakter onerilir');

    // 0-100'e olcekle: 100 bit entropi tam puan sayilir
    const puan = Math.max(0, Math.min(100, Math.round((entropi / 100) * 100)));
    const ad = puan >= 80 ? 'COK GUCLU' : puan >= 60 ? 'GUCLU' : puan >= 40 ? 'ORTA' : puan >= 20 ? 'ZAYIF' : 'COK ZAYIF';
    return { puan, ad, notlar, entropi: Math.round(entropi) };
  }

  function gucGuncelle() {
    if (!yeni) return;
    const olcum = gucOlc(yeni.value);

    if (gucCubuk) {
      let dolgu = gucCubuk.querySelector('.guc-dolgu');
      if (!dolgu) {
        dolgu = document.createElement('span');
        dolgu.className = 'guc-dolgu';
        gucCubuk.textContent = '';
        gucCubuk.appendChild(dolgu);
      }
      dolgu.style.width = olcum.puan + '%';
      gucCubuk.setAttribute('data-seviye',
        olcum.puan >= 60 ? 'iyi' : olcum.puan >= 40 ? 'orta' : 'zayif');
    }

    if (gucEtiket) {
      gucEtiket.textContent = yeni.value
        ? olcum.ad + ' · ~' + olcum.entropi + ' bit'
          + (olcum.notlar.length ? ' · ' + olcum.notlar[0] : '')
        : '—';
      gucEtiket.className = 'kucuk ' + (olcum.puan >= 60 ? 'zumrut' : olcum.puan >= 40 ? 'kehribar-metin' : 'kirmizi-metin');
    }
  }

  function eslesmeGuncelle() {
    if (!eslesmeNotu || !yeni || !tekrar) return;
    if (!tekrar.value) { eslesmeNotu.textContent = ''; return; }
    const esit = yeni.value === tekrar.value;
    eslesmeNotu.textContent = esit ? '✓ sifreler esliyor' : '✕ sifreler eslesmiyor';
    eslesmeNotu.className = 'kucuk ' + (esit ? 'zumrut' : 'kirmizi-metin');
  }

  if (yeni) {
    yeni.addEventListener('input', function () { gucGuncelle(); eslesmeGuncelle(); });
    gucGuncelle();
  }
  if (tekrar) tekrar.addEventListener('input', eslesmeGuncelle);

  // ================================================== 2. SES AYARLARI
  const sesTur = document.getElementById('ses-tur');
  const sesAd = document.getElementById('ses-ad');
  const sesHiz = document.getElementById('ses-hiz');
  const sesPerde = document.getElementById('ses-perde');
  const hizDeger = document.getElementById('ses-hiz-deger');
  const perdeDeger = document.getElementById('ses-perde-deger');
  const adIpucu = document.getElementById('ses-ad-liste-ipucu');
  const dinleDugme = document.getElementById('ses-dinle-dugme');

  const ONERILEN_ADLAR = {
    openai: 'onyx · nova · alloy · echo · fable · shimmer',
    elevenlabs: 'ElevenLabs panelindeki ses kimligi ya da adi',
  };

  function tarayiciSesleri() {
    if (!window.speechSynthesis) return [];
    return window.speechSynthesis.getVoices()
      .filter(function (s) { return /^tr/i.test(s.lang); })
      .map(function (s) { return s.name; });
  }

  function adIpucuGuncelle() {
    if (!adIpucu || !sesTur) return;
    if (sesTur.value === 'tarayici') {
      const adlar = tarayiciSesleri();
      adIpucu.textContent = adlar.length
        ? 'Bu tarayicida bulunan Turkce sesler: ' + adlar.slice(0, 6).join(' · ')
        : 'Bu tarayicida Turkce sistem sesi bulunamadi; bos birakirsan varsayilan ses kullanilir.';
    } else {
      adIpucu.textContent = ONERILEN_ADLAR[sesTur.value] || '';
    }
  }

  if (sesTur) {
    sesTur.addEventListener('change', adIpucuGuncelle);
    adIpucuGuncelle();
    if (window.speechSynthesis) {
      window.speechSynthesis.addEventListener('voiceschanged', adIpucuGuncelle);
    }
  }

  function kaydirmaBagla(girdi, hedef) {
    if (!girdi || !hedef) return;
    girdi.addEventListener('input', function () { hedef.textContent = girdi.value; });
  }
  kaydirmaBagla(sesHiz, hizDeger);
  kaydirmaBagla(sesPerde, perdeDeger);

  if (dinleDugme) {
    dinleDugme.addEventListener('click', async function () {
      const ornek = 'Cekirdek zeka hazir. Arsivde yirmi dort yeni kayit ve uc acik uyari var.';
      const metinDugum = dinleDugme.querySelector('.dugme-metin');
      const eski = metinDugum ? metinDugum.textContent : '';

      function geriAl() { if (metinDugum) metinDugum.textContent = eski; dinleDugme.disabled = false; }

      dinleDugme.disabled = true;
      if (metinDugum) metinDugum.textContent = 'SESLENDIRILIYOR…';

      // Sunucu tarafli motor secilmisse once onu dene
      if (sesTur && sesTur.value !== 'tarayici') {
        try {
          const yanit = await fetch('/cambaz/ses', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': document.body.getAttribute('data-csrf') || '',
            },
            body: JSON.stringify({ metin: ornek }),
          });
          const tur = yanit.headers.get('Content-Type') || '';
          if (yanit.ok && tur.indexOf('audio') >= 0) {
            const veri = await yanit.blob();
            const ses = new Audio(URL.createObjectURL(veri));
            ses.addEventListener('ended', geriAl, { once: true });
            ses.addEventListener('error', geriAl, { once: true });
            await ses.play();
            return;
          }
        } catch (hata) { /* tarayici motoruna dus */ }
      }

      // Tarayici motoru
      if (!window.speechSynthesis) {
        if (adIpucu) adIpucu.textContent = 'Bu tarayici konusma sentezini desteklemiyor.';
        geriAl();
        return;
      }
      const soyle = new SpeechSynthesisUtterance(ornek);
      soyle.lang = 'tr-TR';
      soyle.rate = Number(sesHiz ? sesHiz.value : 1) || 1;
      soyle.pitch = Number(sesPerde ? sesPerde.value : 1) || 1;
      if (sesAd && sesAd.value) {
        const bulunan = window.speechSynthesis.getVoices()
          .find(function (s) { return s.name === sesAd.value; });
        if (bulunan) soyle.voice = bulunan;
      }
      soyle.addEventListener('end', geriAl);
      soyle.addEventListener('error', geriAl);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(soyle);
    });
  }

  // ============================================ 3. SES ORNEGI DOSYA SECIMI
  const ornekGirdi = document.getElementById('ses-ornek-girdi');
  const ornekAd = document.getElementById('ses-ornek-ad');
  const ornekDugme = document.getElementById('ses-ornek-yukle-dugme');

  if (ornekGirdi) {
    ornekGirdi.addEventListener('change', function () {
      const dosya = ornekGirdi.files && ornekGirdi.files[0];
      if (ornekAd) {
        ornekAd.textContent = dosya
          ? dosya.name + ' · ' + Math.round(dosya.size / 1024) + ' KB'
          : 'dosya secilmedi';
      }
      if (ornekDugme) ornekDugme.disabled = !dosya;
    });
  }

  // ======================================= 4. BAKIM ISLERI GERI BILDIRIMI
  // Dizin kurma / model egitimi uzun surebilir: dugmeyi kilitle, durumu yaz.
  document.querySelectorAll('form[action^="/ayarlar/zeka"]').forEach(function (form) {
    form.addEventListener('submit', function () {
      const dugme = form.querySelector('button[type="submit"]');
      if (!dugme || dugme.disabled) return;
      const metinDugum = dugme.querySelector('.dugme-metin');
      dugme.disabled = true;
      if (metinDugum) metinDugum.textContent = 'ISLENIYOR… BEKLE';
      dugme.setAttribute('aria-busy', 'true');
    });
  });

  // #zeka bagina gelindiyse bolumu gorunur kil ve kisa sure vurgula
  if (window.location.hash === '#zeka') {
    const bolum = document.getElementById('zeka');
    if (bolum) {
      bolum.scrollIntoView({ block: 'start', behavior: 'smooth' });
      bolum.classList.add('bolum-vurgulu');
      setTimeout(function () { bolum.classList.remove('bolum-vurgulu'); }, 2200);
    }
  }
})();
  // ================================================ 3. SIFRE DEGISTIRME SONUCU
  const sifreFormu = document.getElementById('sifre-form');
  const sifreSonuc = document.getElementById('sifre-sonuc');

  if (sifreFormu && sifreSonuc) {
    sifreFormu.addEventListener('submit', async function (olay) {
      olay.preventDefault();
      const mevcutSifre = sifreFormu.querySelector('[name="mevcut_sifre"]');
      const yeniSifre = sifreFormu.querySelector('[name="yeni_sifre"]');
      const yeniTekrar = sifreFormu.querySelector('[name="yeni_sifre_tekrar"]');

      const yanit = await fetch(sifreFormu.action, {
        method: sifreFormu.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mevcut: mevcutSifre.value,
          yeni: yeniSifre.value,
          tekrar: yeniTekrar.value,
        }),
      });

      const sonuc = await yanit.json();
      if (sonuc.durum === 'basarili') {
        sifreSonuc.textContent = 'Sifreniz degistirildi.';
        sifreSonuc.className = 'bildirim zumrut';
        mevcutSifre.value = '';
        yeniSifre.value = '';
        yeniTekrar.value = '';
        gucGuncelle();
        eslesmeGuncelle();
      } else {
        sifreSonuc.textContent = sonuc.hata || 'Sifre guncellenemedi, lutfen tekrar deneyin.';
        sifreSonuc.className = 'bildirim kirmizi';
      }
    });
  }
