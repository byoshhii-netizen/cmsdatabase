'use strict';
/**
 * src/zeka/dogalDil.js
 * TURKCE YUZEY URETIMI — motorun cevaplarini dogal Turkce yazmasi icin.
 *
 * Sablonla cumle kurmanin en kirilgan yani eklerdir: "Ankara'de", "Sinop'da",
 * "3 kayit bulundu" yerine "3 kayıt bulundu" gibi hatalar metni hemen
 * makine isi gosterir. Bu modul unlu uyumu, sessiz benzesmesi ve kesme
 * isareti kurallarini uygulayarak bunu onler.
 */

const KALIN_UNLU = new Set(['a', 'ı', 'o', 'u', 'A', 'I', 'O', 'U']);
const INCE_UNLU = new Set(['e', 'i', 'ö', 'ü', 'E', 'İ', 'Ö', 'Ü']);
const DUZ_GENIS = new Set(['a', 'e', 'A', 'E']);
const UNLULER = new Set([...KALIN_UNLU, ...INCE_UNLU]);
const SERT_SESSIZ = new Set(['f', 's', 't', 'k', 'ç', 'ş', 'h', 'p', 'F', 'S', 'T', 'K', 'Ç', 'Ş', 'H', 'P']);

/** Sozcugun son unlusunu dondurur. */
function sonUnlu(kelime) {
  const s = String(kelime || '');
  for (let i = s.length - 1; i >= 0; i--) {
    if (UNLULER.has(s[i])) return s[i];
  }
  return null;
}

function kalinMi(kelime) {
  const u = sonUnlu(kelime);
  if (!u) return true;
  return KALIN_UNLU.has(u);
}

/** Son unluye gore dar unlu seceneklerinden birini dondurur (ı/i/u/ü). */
function darUnlu(kelime) {
  const u = sonUnlu(kelime);
  if (!u) return 'ı';
  const k = u.toLowerCase();
  if (k === 'a' || k === 'ı') return 'ı';
  if (k === 'e' || k === 'i') return 'i';
  if (k === 'o' || k === 'u') return 'u';
  return 'ü';
}

function sonSessizSertMi(kelime) {
  const s = String(kelime || '').trim();
  if (!s) return false;
  return SERT_SESSIZ.has(s[s.length - 1]);
}

function sonHarfUnluMu(kelime) {
  const s = String(kelime || '').trim();
  if (!s) return false;
  return UNLULER.has(s[s.length - 1]);
}

/** Ozel ad mi? (ilk harf buyuk ve en az iki harfli) */
function ozelAdMi(kelime) {
  const s = String(kelime || '').trim();
  if (s.length < 2) return false;
  const ilk = s[0];
  return ilk === ilk.toLocaleUpperCase('tr-TR') && ilk !== ilk.toLocaleLowerCase('tr-TR');
}

function ayirici(kelime, kesme) {
  return kesme && ozelAdMi(kelime) ? "'" : '';
}

// Unlu ile baslayan ek gelince son sert sessizin yumusamasi:
//   kitap -> kitabı, sokak -> sokağı, ağaç -> ağacı
// Tek heceli sozcuklerde ve ozel adlarda yazimda yumusama YAPILMAZ
// (at -> atı, ok -> oku, Sinop'a).
const YUMUSAMA = { p: 'b', ç: 'c', t: 'd', k: 'ğ' };

// Unlu dusmesi gorulen duzensiz sozcukler (arsiv dilinde sik gecenler).
const UNLU_DUSMESI = {
  kayıt: 'kayd', şehir: 'şehr', isim: 'ism', resim: 'resm', vakit: 'vakt',
  hüküm: 'hükm', fikir: 'fikr', emir: 'emr', devir: 'devr', ilim: 'ilm',
  sabır: 'sabr', beyin: 'beyn', burun: 'burn', ağız: 'ağz', karın: 'karn',
  omuz: 'omz', gönül: 'gönl', boyun: 'boyn', oğul: 'oğl', neden: 'neden',
};

/** Unlu ile baslayan ek oncesi govdeyi hazirlar. */
function unluOncesiGovde(kelime) {
  const k = String(kelime || '').trim();
  if (!k) return k;
  if (ozelAdMi(k)) return k;

  const kucuk = k.toLocaleLowerCase('tr-TR');
  if (UNLU_DUSMESI[kucuk]) return UNLU_DUSMESI[kucuk];

  const unluSayisi = [...k].filter((h) => UNLULER.has(h)).length;
  if (unluSayisi < 2) return k;

  const son = k[k.length - 1];
  const yeni = YUMUSAMA[son.toLocaleLowerCase('tr-TR')];
  if (!yeni) return k;
  return k.slice(0, -1) + yeni;
}

/**
 * Bulunma hali: -de / -da / -te / -ta
 *   Ankara'da, İzmir'de, Sinop'ta, Kadıköy'de
 */
function bulunma(kelime, { kesme = true } = {}) {
  const k = String(kelime || '').trim();
  if (!k) return '';
  const sert = sonSessizSertMi(k);
  const ek = kalinMi(k) ? (sert ? 'ta' : 'da') : (sert ? 'te' : 'de');
  return `${k}${ayirici(k, kesme)}${ek}`;
}

/** Cikma hali: -den / -dan / -ten / -tan */
function cikma(kelime, { kesme = true } = {}) {
  const k = String(kelime || '').trim();
  if (!k) return '';
  const sert = sonSessizSertMi(k);
  const ek = kalinMi(k) ? (sert ? 'tan' : 'dan') : (sert ? 'ten' : 'den');
  return `${k}${ayirici(k, kesme)}${ek}`;
}

/** Yonelme hali: -e / -a (unluden sonra -ye / -ya) */
function yonelme(kelime, { kesme = true } = {}) {
  const ham = String(kelime || '').trim();
  if (!ham) return '';
  const govde = unluOncesiGovde(ham);
  const kaynastirma = sonHarfUnluMu(govde) ? 'y' : '';
  const ek = kalinMi(ham) ? 'a' : 'e';
  return `${govde}${ayirici(ham, kesme)}${kaynastirma}${ek}`;
}

/** Belirtme hali: -ı / -i / -u / -ü (unluden sonra -yı / -yi ...) */
function belirtme(kelime, { kesme = true } = {}) {
  const ham = String(kelime || '').trim();
  if (!ham) return '';
  const govde = unluOncesiGovde(ham);
  const kaynastirma = sonHarfUnluMu(govde) ? 'y' : '';
  return `${govde}${ayirici(ham, kesme)}${kaynastirma}${darUnlu(ham)}`;
}

/** Tamlayan hali: -ın / -in / -un / -ün (unluden sonra -nın / -nin ...) */
function tamlayan(kelime, { kesme = true } = {}) {
  const ham = String(kelime || '').trim();
  if (!ham) return '';
  const govde = unluOncesiGovde(ham);
  const kaynastirma = sonHarfUnluMu(govde) ? 'n' : '';
  return `${govde}${ayirici(ham, kesme)}${kaynastirma}${darUnlu(ham)}n`;
}

/** Vasita hali: -la / -le (unluden sonra -yla / -yle) */
function vasita(kelime, { kesme = true } = {}) {
  const k = String(kelime || '').trim();
  if (!k) return '';
  const kaynastirma = sonHarfUnluMu(k) ? 'y' : '';
  const ek = kalinMi(k) ? 'la' : 'le';
  return `${k}${ayirici(k, kesme)}${kaynastirma}${ek}`;
}

/** Cogul: -ler / -lar */
function cogul(kelime) {
  const k = String(kelime || '').trim();
  if (!k) return '';
  return `${k}${kalinMi(k) ? 'lar' : 'ler'}`;
}

/** "3 kayıt", "1 kayıt" — Turkce'de sayidan sonra cogul eki kullanilmaz. */
function sayili(adet, tekil) {
  return `${bicimliSayi(adet)} ${tekil}`;
}

/** Binlik ayiraci Turkce bicimde (1.234.567). */
function bicimliSayi(sayi) {
  const n = Number(sayi);
  if (!Number.isFinite(n)) return String(sayi);
  return n.toLocaleString('tr-TR');
}

const BIRLER = ['', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz'];
const ONLAR = ['', 'on', 'yirmi', 'otuz', 'kırk', 'elli', 'altmış', 'yetmiş', 'seksen', 'doksan'];

/** Sayiyi Turkce sozcuge cevirir (0-999.999). */
function sayiSozcuk(sayi) {
  let n = Math.floor(Math.abs(Number(sayi) || 0));
  if (n === 0) return 'sıfır';
  const parcalar = [];

  const binler = Math.floor(n / 1000);
  n %= 1000;
  if (binler > 0) {
    parcalar.push(binler === 1 ? 'bin' : `${ucBasamak(binler)} bin`);
  }
  if (n > 0) parcalar.push(ucBasamak(n));
  return parcalar.join(' ').trim();
}

function ucBasamak(n) {
  const yuz = Math.floor(n / 100);
  const on = Math.floor((n % 100) / 10);
  const bir = n % 10;
  const parcalar = [];
  if (yuz === 1) parcalar.push('yüz');
  else if (yuz > 1) parcalar.push(`${BIRLER[yuz]} yüz`);
  if (on > 0) parcalar.push(ONLAR[on]);
  if (bir > 0) parcalar.push(BIRLER[bir]);
  return parcalar.join(' ');
}

const AY_ADLARI = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const GUN_ADLARI = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];

/** "15 Mart 2024, Cuma" */
function tarihSozcuk(tarih, { gunAdi = true, saat = false } = {}) {
  const d = tarih instanceof Date ? tarih : new Date(tarih);
  if (Number.isNaN(d.getTime())) return '—';
  let s = `${d.getDate()} ${AY_ADLARI[d.getMonth()]} ${d.getFullYear()}`;
  if (gunAdi) s += `, ${GUN_ADLARI[d.getDay()]}`;
  if (saat) s += ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return s;
}

/** "3 gün önce", "2 ay sonra", "az önce" */
function gorece(tarih, simdi = new Date()) {
  const d = tarih instanceof Date ? tarih : new Date(tarih);
  if (Number.isNaN(d.getTime())) return '—';
  const fark = simdi.getTime() - d.getTime();
  const gecmis = fark >= 0;
  const mutlak = Math.abs(fark);

  const saniye = Math.floor(mutlak / 1000);
  const dakika = Math.floor(saniye / 60);
  const saat = Math.floor(dakika / 60);
  const gun = Math.floor(saat / 24);
  const ay = Math.floor(gun / 30);
  const yil = Math.floor(gun / 365);

  const ek = gecmis ? 'önce' : 'sonra';
  if (saniye < 45) return gecmis ? 'az önce' : 'birazdan';
  if (dakika < 60) return `${dakika} dakika ${ek}`;
  if (saat < 24) return `${saat} saat ${ek}`;
  if (gun < 31) return `${gun} gün ${ek}`;
  if (ay < 12) return `${ay} ay ${ek}`;
  return `${yil} yıl ${ek}`;
}

/** "A, B ve C" */
function listele(ogeler, baglac = 've') {
  const liste = (ogeler || []).map((o) => String(o)).filter(Boolean);
  if (liste.length === 0) return '';
  if (liste.length === 1) return liste[0];
  return `${liste.slice(0, -1).join(', ')} ${baglac} ${liste[liste.length - 1]}`;
}

/** Ilk harfi buyut (Turkce i/İ kuralina uyarak). */
function basBuyut(metin) {
  const s = String(metin || '');
  if (!s) return s;
  return s[0].toLocaleUpperCase('tr-TR') + s.slice(1);
}

/** Bayt boyutunu okunabilir hale getirir. */
function boyut(bayt) {
  const n = Number(bayt) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Sureyi okunabilir hale getirir. */
function sure(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${n} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)} sn`;
  return `${Math.floor(n / 60_000)} dk ${Math.round((n % 60_000) / 1000)} sn`;
}

// ------------------------------------------------- ARSIV TERIMLERI SOZLUGU

const TASNIF_ADI = {
  acik: 'AÇIK', hizmete_ozel: 'HİZMETE ÖZEL', gizli: 'GİZLİ', cok_gizli: 'ÇOK GİZLİ',
};

const GUVENILIRLIK_ADI = {
  A: 'tamamen güvenilir', B: 'genellikle güvenilir', C: 'oldukça güvenilir',
  D: 'genellikle güvenilmez', E: 'güvenilmez', F: 'değerlendirilemiyor',
};

const DOGRULUK_ADI = {
  1: 'başka kaynaklarca doğrulanmış', 2: 'büyük olasılıkla doğru',
  3: 'muhtemelen doğru', 4: 'doğruluğu kuşkulu',
  5: 'ihtimal dışı', 6: 'doğruluğu belirlenemiyor',
};

const VARLIK_TUR_ADI = {
  kisi: 'kişi', kurum: 'kurum', konum: 'konum', arac: 'araç', telefon: 'telefon',
  eposta: 'e-posta', hesap: 'hesap', web: 'web adresi', cihaz: 'cihaz',
  maddi: 'maddi varlık', kod_adi: 'kod adı', grup: 'grup', etkinlik: 'etkinlik',
  diger: 'diğer',
};

const ILISKI_TUR_ADI = {
  akrabalik: 'akrabalık', is: 'iş ilişkisi', ortaklik: 'ortaklık', uyelik: 'üyelik',
  sahiplik: 'sahiplik', iletisim: 'iletişim', finansal: 'finansal ilişki',
  husumet: 'husumet', lojistik: 'lojistik', konum: 'konum bağı',
  ayni_kisi: 'aynı kişi', diger: 'diğer',
};

const KAYIT_TUR_ADI = {
  ihbar: 'ihbar', gozlem: 'gözlem', rapor: 'rapor', analiz: 'analiz',
  sinyal: 'sinyal', acik_kaynak: 'açık kaynak', tutanak: 'tutanak',
  gorusme: 'görüşme', teknik: 'teknik rapor', ozet: 'özet',
};

const DURUM_ADI = {
  yeni: 'yeni', incelemede: 'incelemede', dogrulandi: 'doğrulandı',
  yalanlandi: 'yalanlandı', arsiv: 'arşiv',
  aktif: 'aktif', izlemede: 'izlemede', pasif: 'pasif', elendi: 'elendi',
  acik: 'açık', askida: 'askıda', kapali: 'kapalı',
};

module.exports = {
  bulunma, cikma, yonelme, belirtme, tamlayan, vasita, cogul, unluOncesiGovde,
  sayili, bicimliSayi, sayiSozcuk, tarihSozcuk, gorece, listele, basBuyut,
  boyut, sure, kalinMi, darUnlu, sonUnlu, ozelAdMi,
  TASNIF_ADI, GUVENILIRLIK_ADI, DOGRULUK_ADI, VARLIK_TUR_ADI,
  ILISKI_TUR_ADI, KAYIT_TUR_ADI, DURUM_ADI, AY_ADLARI, GUN_ADLARI,
};
