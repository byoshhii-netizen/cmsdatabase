'use strict';
/**
 * src/zeka/varlikCikarim.js
 * VARLIK CIKARIMI (NER) — kural + sozluk + DOGRULAMA tabanli, bagimliliksiz.
 *
 * Bu modul bir sinir aginin istatistiksel tahmini yerine, dogrulanabilir
 * yapilari arar. Boylece "yanlis pozitif" orani cok dusuktur: bir TCKN
 * yalnizca kontrol basamagi dogruysa, bir IBAN yalnizca mod-97 testini
 * geciyorsa, bir kart numarasi yalnizca Luhn'u saglıyorsa raporlanir.
 *
 * Cikarilan turler:
 *   kisi, kurum, konum, telefon, eposta, web, ip, tckn, vkn, iban, kart,
 *   plaka, imei, para, tarih, saat, koordinat, ozet(hash), cuzdan, sosyal,
 *   ucus, dosya_yolu
 *
 * Her bulgu: { tur, deger, normal, baglam, konum, guven }
 */

const dil = require('./dil');

// ---------------------------------------------------------------- SOZLUKLER

const ILLER = [
  'Adana', 'Adıyaman', 'Afyonkarahisar', 'Ağrı', 'Amasya', 'Ankara', 'Antalya', 'Artvin',
  'Aydın', 'Balıkesir', 'Bilecik', 'Bingöl', 'Bitlis', 'Bolu', 'Burdur', 'Bursa',
  'Çanakkale', 'Çankırı', 'Çorum', 'Denizli', 'Diyarbakır', 'Edirne', 'Elazığ', 'Erzincan',
  'Erzurum', 'Eskişehir', 'Gaziantep', 'Giresun', 'Gümüşhane', 'Hakkari', 'Hatay', 'Isparta',
  'Mersin', 'İstanbul', 'İzmir', 'Kars', 'Kastamonu', 'Kayseri', 'Kırklareli', 'Kırşehir',
  'Kocaeli', 'Konya', 'Kütahya', 'Malatya', 'Manisa', 'Kahramanmaraş', 'Mardin', 'Muğla',
  'Muş', 'Nevşehir', 'Niğde', 'Ordu', 'Rize', 'Sakarya', 'Samsun', 'Siirt', 'Sinop',
  'Sivas', 'Tekirdağ', 'Tokat', 'Trabzon', 'Tunceli', 'Şanlıurfa', 'Uşak', 'Van', 'Yozgat',
  'Zonguldak', 'Aksaray', 'Bayburt', 'Karaman', 'Kırıkkale', 'Batman', 'Şırnak', 'Bartın',
  'Ardahan', 'Iğdır', 'Yalova', 'Karabük', 'Kilis', 'Osmaniye', 'Düzce',
];

const ILCELER = [
  'Kadıköy', 'Beşiktaş', 'Şişli', 'Beyoğlu', 'Fatih', 'Üsküdar', 'Maltepe', 'Ataşehir',
  'Bakırköy', 'Bahçelievler', 'Pendik', 'Kartal', 'Sarıyer', 'Zeytinburnu', 'Esenyurt',
  'Başakşehir', 'Çankaya', 'Keçiören', 'Yenimahalle', 'Mamak', 'Etimesgut', 'Altındağ',
  'Sincan', 'Bornova', 'Karşıyaka', 'Konak', 'Buca', 'Çiğli', 'Nilüfer', 'Osmangazi',
  'Selçuklu', 'Meram', 'Melikgazi', 'Kocasinan', 'Seyhan', 'Çukurova', 'Şahinbey',
  'Muratpaşa', 'Kepez', 'Konyaaltı', 'Alanya', 'Manavgat', 'Bodrum', 'Marmaris',
  'Kuşadası', 'Çeşme', 'Didim', 'Gebze', 'İzmit', 'Darıca', 'Çerkezköy',
];

const ULKELER = [
  'Türkiye', 'Almanya', 'Fransa', 'İngiltere', 'Birleşik Krallık', 'ABD', 'Amerika',
  'Rusya', 'Ukrayna', 'Çin', 'Japonya', 'İran', 'Irak', 'Suriye', 'Lübnan', 'İsrail',
  'Mısır', 'Libya', 'Tunus', 'Cezayir', 'Fas', 'Suudi Arabistan', 'Katar', 'BAE',
  'Kuveyt', 'Umman', 'Bahreyn', 'Yemen', 'Azerbaycan', 'Gürcistan', 'Ermenistan',
  'Kazakistan', 'Özbekistan', 'Türkmenistan', 'Kırgızistan', 'Tacikistan', 'Afganistan',
  'Pakistan', 'Hindistan', 'Bangladeş', 'Yunanistan', 'Bulgaristan', 'Romanya', 'Sırbistan',
  'Bosna', 'Hırvatistan', 'Slovenya', 'Makedonya', 'Arnavutluk', 'Kosova', 'Karadağ',
  'İtalya', 'İspanya', 'Portekiz', 'Hollanda', 'Belçika', 'İsviçre', 'Avusturya',
  'Polonya', 'Çekya', 'Slovakya', 'Macaristan', 'İsveç', 'Norveç', 'Danimarka',
  'Finlandiya', 'İrlanda', 'Kanada', 'Meksika', 'Brezilya', 'Arjantin', 'Avustralya',
  'Yeni Zelanda', 'Güney Afrika', 'Nijerya', 'Kenya', 'Etiyopya', 'Somali', 'Sudan',
  'Kıbrıs', 'KKTC', 'Malta', 'Singapur', 'Malezya', 'Endonezya', 'Tayland', 'Vietnam',
  'Kore', 'Güney Kore', 'Kuzey Kore', 'Tayvan', 'Hong Kong',
];

const SANLAR = [
  'Dr', 'Doç', 'Prof', 'Av', 'Müh', 'Ecz', 'Op', 'Uzm', 'Sn', 'Bay', 'Bayan',
  'Komiser', 'Başkomiser', 'Müdür', 'Başmüdür', 'Amir', 'Memur', 'Çavuş', 'Onbaşı',
  'Teğmen', 'Üsteğmen', 'Yüzbaşı', 'Binbaşı', 'Yarbay', 'Albay', 'General', 'Tuğgeneral',
  'Tümgeneral', 'Korgeneral', 'Orgeneral', 'Amiral', 'Vali', 'Kaymakam', 'Belediye Başkanı',
  'Savcı', 'Hakim', 'Yargıç', 'Müfettiş', 'Ajan', 'Operatör', 'Şüpheli', 'Tanık', 'Maktul',
];

const KURUM_IMLERI = [
  'A.Ş', 'AŞ', 'Ltd', 'Şti', 'LTD', 'ŞTİ', 'Holding', 'Grubu', 'Group', 'Vakfı', 'Vakıf',
  'Derneği', 'Dernek', 'Bakanlığı', 'Bakanlık', 'Müdürlüğü', 'Başkanlığı', 'Genel Müdürlüğü',
  'Üniversitesi', 'Fakültesi', 'Enstitüsü', 'Hastanesi', 'Bankası', 'Bank', 'Sigorta',
  'Partisi', 'Örgütü', 'Örgüt', 'Şirketi', 'Ticaret', 'Sanayi', 'İnşaat', 'Lojistik',
  'Danışmanlık', 'Teknoloji', 'Yazılım', 'Medya', 'Ajansı', 'Kooperatifi', 'Birliği',
  'Odası', 'Borsası', 'Konsolosluğu', 'Büyükelçiliği', 'Komutanlığı', 'Karakolu',
  'GmbH', 'Inc', 'LLC', 'Corp', 'Co', 'Plc', 'S.A', 'B.V', 'Limited', 'Foundation',
];

const AD_SOZLUGU = new Set([
  'ahmet', 'mehmet', 'mustafa', 'ali', 'hasan', 'huseyin', 'ibrahim', 'ismail', 'osman',
  'omer', 'yusuf', 'murat', 'kemal', 'orhan', 'serkan', 'burak', 'emre', 'cem', 'can',
  'deniz', 'baris', 'kaan', 'onur', 'tolga', 'volkan', 'yasin', 'salih', 'halil', 'ramazan',
  'suleyman', 'abdullah', 'bekir', 'cengiz', 'erdal', 'ferhat', 'gokhan', 'hakan', 'ilker',
  'kadir', 'levent', 'metin', 'necati', 'oguz', 'recep', 'sinan', 'tarik', 'ugur', 'veli',
  'yavuz', 'zeki', 'adem', 'bilal', 'davut', 'enes', 'fatih', 'furkan', 'hamza', 'harun',
  'kerem', 'mert', 'okan', 'ozan', 'selim', 'taner', 'umut', 'yunus', 'arda', 'berk',
  'ayse', 'fatma', 'emine', 'hatice', 'zeynep', 'elif', 'meryem', 'sultan', 'hava',
  'zehra', 'sevim', 'yasemin', 'ozlem', 'merve', 'esra', 'buse', 'gamze', 'pinar',
  'seda', 'tugba', 'ebru', 'derya', 'melek', 'nurcan', 'serap', 'sibel', 'nalan',
  'gul', 'gulsum', 'rabia', 'aysel', 'canan', 'dilek', 'funda', 'hulya', 'leyla',
  'nazli', 'nilufer', 'selin', 'sema', 'tulay', 'yeliz', 'asli', 'basak', 'cigdem',
  'ceren', 'didem', 'ece', 'eda', 'ipek', 'irem', 'kubra', 'melis', 'nehir', 'sila',
  'john', 'james', 'robert', 'michael', 'david', 'maria', 'anna', 'sarah', 'peter',
  'thomas', 'ivan', 'sergey', 'dimitri', 'mohammed', 'ahmad', 'omar', 'khalid', 'hassan',
]);

const SOYAD_SOZLUGU = new Set([
  'yilmaz', 'kaya', 'demir', 'sahin', 'celik', 'yildiz', 'yildirim', 'ozturk', 'aydin',
  'ozdemir', 'arslan', 'dogan', 'kilic', 'aslan', 'cetin', 'kara', 'koc', 'kurt',
  'ozkan', 'simsek', 'polat', 'korkmaz', 'ozcan', 'erdogan', 'turan', 'avci', 'tas',
  'aksoy', 'bulut', 'akbas', 'cakir', 'gunes', 'keskin', 'ates', 'bozkurt', 'duman',
  'erdem', 'gul', 'guler', 'kaplan', 'karaca', 'kose', 'ozer', 'sari', 'sen', 'sonmez',
  'tekin', 'ucar', 'uzun', 'yalcin', 'yavuz', 'yuksel', 'altin', 'basar', 'bayram',
  'cinar', 'demirci', 'eroglu', 'gumus', 'ilhan', 'kahraman', 'karadeniz', 'kaygusuz',
  'mutlu', 'nalbant', 'ozgur', 'pehlivan', 'saglam', 'tuna', 'unal', 'varol', 'zorlu',
  'smith', 'johnson', 'brown', 'wilson', 'miller', 'davis', 'ivanov', 'petrov', 'mueller',
]);

// Tamami buyuk harfle yazilan ama kod adi OLMAYAN yaygin sozcukler.
const KOD_ADI_YASAK = new Set([
  'gizli', 'cokgizli', 'acil', 'onemli', 'rapor', 'ozet', 'not', 'ek', 'dikkat',
  'uyari', 'bilgi', 'tasnif', 'konu', 'tarih', 'saat', 'kaynak', 'hedef', 'durum',
  'adres', 'telefon', 'eposta', 'imza', 'liste', 'sayfa', 'slayt', 'belge', 'dosya',
  'kimden', 'kime', 'ilgi', 'istihbarat', 'operasyon', 'arsiv', 'genel', 'resmi',
  'pdf', 'docx', 'xlsx', 'html', 'json', 'http', 'https', 'www', 'tckn', 'iban',
  'ocak', 'subat', 'mart', 'nisan', 'mayis', 'haziran', 'temmuz', 'agustos',
  'eylul', 'ekim', 'kasim', 'aralik', 'pazartesi', 'sali', 'carsamba', 'persembe',
  'cuma', 'cumartesi', 'pazar',
]);

const AYLAR = {
  ocak: 1, şubat: 2, subat: 2, mart: 3, nisan: 4, mayıs: 5, mayis: 5, haziran: 6,
  temmuz: 7, ağustos: 8, agustos: 8, eylül: 9, eylul: 9, ekim: 10, kasım: 11, kasim: 11,
  aralık: 12, aralik: 12,
};

// Tematik anahtar kumeler (kayit siniflandirmasina ipucu verir)
const TEMA_SOZLUKLERI = {
  silah: ['silah', 'tabanca', 'tufek', 'mermi', 'fisek', 'patlayici', 'bomba', 'el bombasi', 'muhimmat', 'kalasnikof', 'av tufegi'],
  uyusturucu: ['uyusturucu', 'eroin', 'kokain', 'esrar', 'metamfetamin', 'sentetik', 'bonzai', 'captagon', 'hap', 'madde'],
  finans: ['transfer', 'havale', 'nakit', 'aklama', 'offshore', 'paravan', 'fatura', 'kripto', 'bitcoin', 'kara para', 'rusvet'],
  kacakcilik: ['kacakcilik', 'kacak', 'gumruk', 'konteyner', 'sinir', 'gecis', 'tir', 'yuk', 'antrepo'],
  siber: ['sunucu', 'zararli', 'yazilim', 'sifre', 'veri sizintisi', 'oltalama', 'phishing', 'botnet', 'sizma', 'fidye'],
  insan: ['insan kacakciligi', 'gocmen', 'multeci', 'sahte kimlik', 'pasaport', 'vize', 'organizator'],
  terör: ['orgut', 'hucre', 'eylem', 'sabotaj', 'saldiri', 'suikast', 'militan', 'kamp', 'finansman'],
  istihbarat: ['kaynak', 'ajan', 'muhbir', 'dinleme', 'takip', 'gozetleme', 'operasyon', 'tespit', 'sizma', 'deşifre'],
};

// ---------------------------------------------------------- DOGRULAYICILAR

/** T.C. Kimlik Numarasi dogrulamasi (resmi algoritma). */
function tcknGecerliMi(numara) {
  const s = String(numara).replace(/\D/g, '');
  if (s.length !== 11) return false;
  if (s[0] === '0') return false;
  if (/^(\d)\1{10}$/.test(s)) return false;

  const b = s.split('').map(Number);
  const tekToplam = b[0] + b[2] + b[4] + b[6] + b[8];
  const ciftToplam = b[1] + b[3] + b[5] + b[7];
  const onuncu = ((tekToplam * 7) - ciftToplam) % 10;
  if (((onuncu + 10) % 10) !== b[9]) return false;

  const ilkOnToplam = b.slice(0, 10).reduce((a, c) => a + c, 0);
  return (ilkOnToplam % 10) === b[10];
}

/** Vergi Kimlik Numarasi (10 hane) dogrulamasi. */
function vknGecerliMi(numara) {
  const s = String(numara).replace(/\D/g, '');
  if (s.length !== 10) return false;
  let toplam = 0;
  for (let i = 0; i < 9; i++) {
    const basamak = Number(s[i]);
    let gecici = (basamak + (10 - (i + 1))) % 10;
    if (gecici === 0) { toplam += 0; continue; }
    let carpim = gecici * (2 ** (10 - (i + 1)));
    carpim %= 9;
    if (carpim === 0) carpim = 9;
    toplam += carpim;
  }
  const kontrol = (10 - (toplam % 10)) % 10;
  return kontrol === Number(s[9]);
}

/** IBAN mod-97 dogrulamasi. */
function ibanGecerliMi(iban) {
  const s = String(iban).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length < 15 || s.length > 34) return false;
  if (!/^[A-Z]{2}\d{2}/.test(s)) return false;

  const tasinmis = s.slice(4) + s.slice(0, 4);
  let kalan = 0;
  for (const k of tasinmis) {
    const deger = /\d/.test(k) ? k : String(k.charCodeAt(0) - 55);
    for (const d of deger) kalan = (kalan * 10 + Number(d)) % 97;
  }
  return kalan === 1;
}

/** Luhn algoritmasi (kredi karti, IMEI). */
function luhnGecerliMi(numara) {
  const s = String(numara).replace(/\D/g, '');
  if (s.length < 12) return false;
  let toplam = 0;
  let cift = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = Number(s[i]);
    if (cift) { d *= 2; if (d > 9) d -= 9; }
    toplam += d;
    cift = !cift;
  }
  return toplam % 10 === 0;
}

/** Turk plakasindaki il kodu gecerli mi (01-81)? */
function plakaGecerliMi(plaka) {
  const m = String(plaka).match(/^(\d{2})\s*([A-Za-zÇĞİÖŞÜçğıöşü]{1,3})\s*(\d{2,5})$/);
  if (!m) return false;
  const il = Number(m[1]);
  return il >= 1 && il <= 81;
}

const IBAN_BANKA = {
  // TR IBAN'da banka kodu 5 hanedir (TR + 2 kontrol + 5 banka + 1 ayrilmis + 16 hesap).
  // Yalnizca kesin bilinen kurum kodlari listelenir; bilinmeyen kod icin ad gosterilmez.
  '00001': 'T.C. Merkez Bankası', '00004': 'Türkiye İş Bankası', '00010': 'Ziraat Bankası',
  '00012': 'Halkbank', '00015': 'VakıfBank', '00032': 'TEB', '00046': 'Akbank',
  '00059': 'Şekerbank', '00062': 'Garanti BBVA', '00067': 'Yapı Kredi',
  '00099': 'ING', '00103': 'Fibabanka', '00111': 'QNB Finansbank', '00123': 'HSBC',
  '00134': 'DenizBank', '00135': 'Anadolubank', '00146': 'Odeabank',
  '00203': 'Albaraka Türk', '00205': 'Kuveyt Türk', '00206': 'Türkiye Finans',
  '00209': 'Ziraat Katılım', '00210': 'Vakıf Katılım', '00211': 'Emlak Katılım',
};

// -------------------------------------------------------------- DESENLER

function baglamAl(metin, konum, uzunluk, pencere = 60) {
  const bas = Math.max(0, konum - pencere);
  const son = Math.min(metin.length, konum + uzunluk + pencere);
  return (bas > 0 ? '…' : '') + metin.slice(bas, son).replace(/\s+/g, ' ').trim() + (son < metin.length ? '…' : '');
}

/**
 * Yapisal (dogrulanabilir) bulgulari cikarir.
 */
function yapisalBulgular(metin) {
  const bulgular = [];
  const ekle = (tur, deger, konum, guven, normal) => {
    bulgular.push({
      tur,
      deger: String(deger).trim(),
      normal: normal !== undefined ? normal : String(deger).trim(),
      konum,
      guven,
      baglam: baglamAl(metin, konum, String(deger).length),
    });
  };

  // --- E-posta ---
  for (const m of metin.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    ekle('eposta', m[0], m.index, 0.99, m[0].toLowerCase());
  }

  // --- URL / alan adi ---
  for (const m of metin.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"'()]{3,200}/gi)) {
    ekle('web', m[0].replace(/[.,;:)]+$/, ''), m.index, 0.97);
  }
  for (const m of metin.matchAll(/\b(?:t\.me|telegram\.me|wa\.me|x\.com|twitter\.com|instagram\.com|facebook\.com|tiktok\.com|linkedin\.com)\/[A-Za-z0-9_.-]{2,60}/gi)) {
    ekle('sosyal', m[0], m.index, 0.95);
  }
  for (const m of metin.matchAll(/(?:^|\s)@([A-Za-z0-9_]{3,30})\b/g)) {
    ekle('sosyal', '@' + m[1], m.index + m[0].indexOf('@'), 0.6);
  }

  // --- IP / MAC ---
  for (const m of metin.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    const parcalar = m[0].split('.').map(Number);
    if (parcalar.every((p) => p >= 0 && p <= 255)) {
      const ozel = parcalar[0] === 10 || parcalar[0] === 127 ||
        (parcalar[0] === 192 && parcalar[1] === 168) ||
        (parcalar[0] === 172 && parcalar[1] >= 16 && parcalar[1] <= 31);
      ekle('ip', m[0], m.index, ozel ? 0.75 : 0.95);
    }
  }
  for (const m of metin.matchAll(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g)) {
    ekle('cihaz', m[0], m.index, 0.9, m[0].toUpperCase().replace(/-/g, ':'));
  }

  // --- IBAN ---
  for (const m of metin.matchAll(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,8}[ ]?[A-Z0-9]{0,4}\b/g)) {
    const temiz = m[0].replace(/\s/g, '');
    if (temiz.length >= 15 && ibanGecerliMi(temiz)) {
      const banka = temiz.startsWith('TR') ? IBAN_BANKA[temiz.slice(4, 9)] : null;
      bulgular.push({
        tur: 'iban', deger: m[0].trim(), normal: temiz, konum: m.index, guven: 1,
        baglam: baglamAl(metin, m.index, m[0].length),
        ek: temiz.startsWith('TR')
          ? { banka_kodu: temiz.slice(4, 9), ...(banka ? { banka } : {}) }
          : { ulke: temiz.slice(0, 2) },
      });
    }
  }

  // --- TCKN ---
  for (const m of metin.matchAll(/\b\d{11}\b/g)) {
    if (tcknGecerliMi(m[0])) ekle('tckn', m[0], m.index, 1);
  }

  // --- VKN ---
  for (const m of metin.matchAll(/\b\d{10}\b/g)) {
    if (vknGecerliMi(m[0])) ekle('vkn', m[0], m.index, 0.9);
  }

  // --- Kredi karti (Luhn) ---
  for (const m of metin.matchAll(/\b(?:\d{4}[ -]?){3}\d{4}\b/g)) {
    const temiz = m[0].replace(/[\s-]/g, '');
    if (luhnGecerliMi(temiz)) ekle('kart', m[0].trim(), m.index, 0.95, temiz);
  }

  // --- IMEI ---
  for (const m of metin.matchAll(/\b\d{15}\b/g)) {
    if (luhnGecerliMi(m[0])) ekle('imei', m[0], m.index, 0.85);
  }

  // --- Telefon ---
  const telefonDeseni = /(?:\+?90[ .-]?)?(?:\(?0?(5\d{2}|2\d{2}|3\d{2}|4\d{2})\)?[ .-]?)(\d{3})[ .-]?(\d{2})[ .-]?(\d{2})\b|\+\d{1,3}[ .-]?\d{2,4}[ .-]?\d{3}[ .-]?\d{2,4}\b/g;
  for (const m of metin.matchAll(telefonDeseni)) {
    const rakamlar = m[0].replace(/\D/g, '');
    if (rakamlar.length < 10 || rakamlar.length > 15) continue;
    let normal = rakamlar;
    if (normal.length === 10) normal = '90' + normal;
    else if (normal.startsWith('0')) normal = '90' + normal.slice(1);
    ekle('telefon', m[0].trim(), m.index, m[1] && m[1].startsWith('5') ? 0.95 : 0.85, '+' + normal);
  }

  // --- Plaka ---
  for (const m of metin.matchAll(/\b(\d{2})\s?([A-ZÇĞİÖŞÜ]{1,3})\s?(\d{2,5})\b/g)) {
    if (plakaGecerliMi(`${m[1]} ${m[2]} ${m[3]}`)) {
      ekle('plaka', `${m[1]} ${m[2]} ${m[3]}`, m.index, 0.88, `${m[1]}${m[2]}${m[3]}`);
    }
  }

  // --- Koordinat ---
  for (const m of metin.matchAll(/\b(-?\d{1,2}[.,]\d{3,8})\s*[,;]\s*(-?\d{1,3}[.,]\d{3,8})\b/g)) {
    const enlem = Number(String(m[1]).replace(',', '.'));
    const boylam = Number(String(m[2]).replace(',', '.'));
    if (Math.abs(enlem) <= 90 && Math.abs(boylam) <= 180) {
      bulgular.push({
        tur: 'koordinat', deger: m[0], normal: `${enlem},${boylam}`, konum: m.index,
        guven: 0.9, baglam: baglamAl(metin, m.index, m[0].length),
        ek: { enlem, boylam },
      });
    }
  }
  for (const m of metin.matchAll(/(\d{1,3})°\s*(\d{1,2})['′]\s*(\d{1,2}(?:[.,]\d+)?)["″]?\s*([NSEWKGDB])/gi)) {
    const derece = Number(m[1]) + Number(m[2]) / 60 + Number(String(m[3]).replace(',', '.')) / 3600;
    const yon = m[4].toUpperCase();
    const isaret = (yon === 'S' || yon === 'W' || yon === 'G' || yon === 'B') ? -1 : 1;
    bulgular.push({
      tur: 'koordinat', deger: m[0], normal: String(isaret * derece), konum: m.index,
      guven: 0.85, baglam: baglamAl(metin, m.index, m[0].length),
      ek: { derece: isaret * derece, eksen: (yon === 'N' || yon === 'S' || yon === 'K' || yon === 'G') ? 'enlem' : 'boylam' },
    });
  }

  // --- Para ---
  const paraDeseni = /(?:₺|\$|€|£)\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?\s?(?:TL|TRY|USD|EUR|GBP|dolar|euro|avro|sterlin|lira)\b|\b\d{1,4}(?:[.,]\d+)?\s?(?:bin|milyon|milyar)\s?(?:TL|TRY|USD|EUR|dolar|euro|avro|lira)\b/gi;
  for (const m of metin.matchAll(paraDeseni)) {
    ekle('para', m[0].trim(), m.index, 0.9);
  }

  // --- Tarih ---
  for (const m of metin.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})\b/g)) {
    const gun = Number(m[1]);
    const ay = Number(m[2]);
    let yil = Number(m[3]);
    if (yil < 100) yil += yil > 50 ? 1900 : 2000;
    if (gun >= 1 && gun <= 31 && ay >= 1 && ay <= 12) {
      bulgular.push({
        tur: 'tarih', deger: m[0], konum: m.index, guven: 0.95,
        normal: `${yil}-${String(ay).padStart(2, '0')}-${String(gun).padStart(2, '0')}`,
        baglam: baglamAl(metin, m.index, m[0].length),
      });
    }
  }
  for (const m of metin.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    bulgular.push({
      tur: 'tarih', deger: m[0], konum: m.index, guven: 0.95, normal: m[0],
      baglam: baglamAl(metin, m.index, m[0].length),
    });
  }
  const ayDeseni = new RegExp(`\\b(\\d{1,2})\\s+(${Object.keys(AYLAR).join('|')})\\s*(\\d{4})?`, 'gi');
  for (const m of metin.matchAll(ayDeseni)) {
    const ay = AYLAR[dil.kucuk(m[2])];
    const yil = m[3] ? Number(m[3]) : new Date().getFullYear();
    bulgular.push({
      tur: 'tarih', deger: m[0].trim(), konum: m.index, guven: m[3] ? 0.93 : 0.7,
      normal: `${yil}-${String(ay).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`,
      baglam: baglamAl(metin, m.index, m[0].length),
    });
  }

  // --- Saat ---
  for (const m of metin.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/g)) {
    ekle('saat', m[0], m.index, 0.8);
  }

  // --- Ozet (hash) ---
  for (const m of metin.matchAll(/\b[a-fA-F0-9]{32}\b|\b[a-fA-F0-9]{40}\b|\b[a-fA-F0-9]{64}\b/g)) {
    const uzunluk = m[0].length;
    const ad = uzunluk === 32 ? 'MD5' : uzunluk === 40 ? 'SHA-1' : 'SHA-256';
    bulgular.push({
      tur: 'ozet', deger: m[0], normal: m[0].toLowerCase(), konum: m.index, guven: 0.8,
      baglam: baglamAl(metin, m.index, m[0].length), ek: { algoritma: ad },
    });
  }

  // --- Kripto cuzdan ---
  for (const m of metin.matchAll(/\b(?:bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|0x[a-fA-F0-9]{40}|T[A-Za-z1-9]{33})\b/g)) {
    const ag = m[0].startsWith('0x') ? 'Ethereum' : m[0].startsWith('T') ? 'Tron' : 'Bitcoin';
    bulgular.push({
      tur: 'cuzdan', deger: m[0], normal: m[0], konum: m.index, guven: m[0].startsWith('0x') ? 0.9 : 0.7,
      baglam: baglamAl(metin, m.index, m[0].length), ek: { ag },
    });
  }

  // --- Ucus kodu ---
  for (const m of metin.matchAll(/\b(TK|PC|XQ|AJ|LH|BA|AF|QR|EK|SU|AZ|KL|SN|OS|LX|TP|IB|AY|W6)\s?(\d{2,4})\b/g)) {
    ekle('ucus', `${m[1]}${m[2]}`, m.index, 0.7);
  }

  // --- Dosya yolu ---
  for (const m of metin.matchAll(/\b[A-Za-z]:\\[^\s"'<>|]{3,180}|(?:^|\s)\/(?:home|var|etc|opt|usr|mnt|srv)\/[^\s"'<>|]{2,180}/g)) {
    ekle('dosya_yolu', m[0].trim(), m.index, 0.7);
  }

  return bulgular;
}

// ------------------------------------------------------ AD / KURUM / KONUM

// Konum eki/tesis sozcukleri — normalize edilmis halde karsilastirilir.
const KONUM_EKLERI = [
  'mahallesi', 'mah.', 'caddesi', 'cad.', 'sokak', 'sok.', 'bulvari', 'blv.',
  'apartmani', 'sitesi', 'plaza', 'ilcesi', 'koyu', 'beldesi', 'limani',
  'havalimani', 'meydani', 'kavsagi', 'mevkii', 'antrepo', 'deposu', 'terminali',
  'istasyonu', 'garaji', 'otogari', 'hastanesi', 'karakolu', 'sinir kapisi',
  'serbest bolge', 'sanayi bolgesi', 'organize sanayi',
].map((k) => dil.normalize(k));

const ILLER_NORM = new Map(ILLER.map((i) => [dil.normalize(i), i]));
const ILCELER_NORM = new Map(ILCELER.map((i) => [dil.normalize(i), i]));
const ULKELER_NORM = new Map(ULKELER.map((u) => [dil.normalize(u), u]));
const SANLAR_NORM = new Set(SANLAR.map((s) => dil.normalize(s)));
const KURUM_NORM = KURUM_IMLERI.map((k) => dil.normalize(k).replace(/\./g, ''));

/** Buyuk harfle baslayan ardisik kelime dizilerini bulur. */
function ozelAdDizileri(metin) {
  const diziler = [];
  const desen = /(?:[A-ZÇĞİÖŞÜ][\p{Ll}çğıöşü]{1,20}|[A-ZÇĞİÖŞÜ]{2,}\.?)(?:[ ](?:[A-ZÇĞİÖŞÜ][\p{Ll}çğıöşü]{1,20}|[A-ZÇĞİÖŞÜ]{2,}\.?|ve|of|the|bin|el|al|de|da)){0,5}/gu;

  for (const m of metin.matchAll(desen)) {
    const parca = m[0].replace(/[.,;:]+$/, '').trim();
    if (parca.length < 3) continue;
    diziler.push({ metin: parca, konum: m.index });
  }
  return diziler;
}

/** Ad, kurum ve konum adaylarini bulur. */
function adBulgulari(metin) {
  const bulgular = [];
  const cumleBaslari = new Set();

  // Cumle basi konumlarini isaretle (orada buyuk harf ipucu zayiftir)
  let gecici = 0;
  for (const c of dil.cumleler(metin)) {
    const d = metin.indexOf(c, gecici);
    if (d >= 0) { cumleBaslari.add(d); gecici = d + c.length; }
  }

  for (const dizi of ozelAdDizileri(metin)) {
    const kelimeler = dizi.metin.split(/\s+/).filter(Boolean);
    const normal = dil.normalize(dizi.metin);
    const baglam = baglamAl(metin, dizi.konum, dizi.metin.length);

    // --- Konum sozlugu ---
    if (ILLER_NORM.has(normal) || ILCELER_NORM.has(normal) || ULKELER_NORM.has(normal)) {
      bulgular.push({
        tur: 'konum', deger: ILLER_NORM.get(normal) || ILCELER_NORM.get(normal) || ULKELER_NORM.get(normal),
        normal, konum: dizi.konum, guven: 0.95, baglam,
        ek: { kapsam: ILLER_NORM.has(normal) ? 'il' : ILCELER_NORM.has(normal) ? 'ilce' : 'ulke' },
      });
      continue;
    }

    // --- Adres / tesis bileseni ---
    // Karsilastirma NORMALIZE metin uzerinde yapilir: "Limani" ile "Limanı",
    // "Ilcesi" ile "İlçesi" ayni sayilir. Aksi halde ASCII yazilmis
    // belgelerdeki konumlar kacar.
    const ekDizini = kelimeler.findIndex((k) => KONUM_EKLERI.includes(dil.normalize(k)));
    if (ekDizini >= 0) {
      // Adayin basindaki ilgisiz sozcugu kirp: "Arac Mersin Limani" -> "Mersin Limani".
      // Bilinen bir il/ilce varsa oradan baslat, yoksa ek sozcugunden bir onceki
      // sozcukten itibaren al.
      let bas = kelimeler.findIndex((k) => {
        const n = dil.normalize(k);
        return ILLER_NORM.has(n) || ILCELER_NORM.has(n) || ULKELER_NORM.has(n);
      });
      if (bas < 0 || bas > ekDizini) bas = Math.max(0, ekDizini - 1);

      const kirpik = kelimeler.slice(bas).join(' ');
      const kayma = kelimeler.slice(0, bas).reduce((a, k) => a + k.length + 1, 0);

      bulgular.push({
        tur: 'konum', deger: kirpik, normal: dil.normalize(kirpik),
        konum: dizi.konum + kayma, guven: 0.82,
        baglam: baglamAl(metin, dizi.konum + kayma, kirpik.length),
        ek: { kapsam: 'tesis' },
      });
      continue;
    }

    // --- Bilinen il/ilce ile baslayan bilesik konum: "Mersin Limani" ---
    if (kelimeler.length >= 2) {
      const ilkKelimeNorm = dil.normalize(kelimeler[0]);
      if (ILLER_NORM.has(ilkKelimeNorm) || ILCELER_NORM.has(ilkKelimeNorm)) {
        bulgular.push({
          tur: 'konum', deger: dizi.metin, normal, konum: dizi.konum, guven: 0.8, baglam,
          ek: { kapsam: 'bilesik', il: ILLER_NORM.get(ilkKelimeNorm) || ILCELER_NORM.get(ilkKelimeNorm) },
        });
        continue;
      }
    }

    // --- Kurum imleri ---
    const kurumMu = KURUM_NORM.some((im) => {
      const n = normal.replace(/\./g, '');
      return n.endsWith(' ' + im) || n.includes(' ' + im + ' ') || n === im;
    });
    if (kurumMu && kelimeler.length >= 2) {
      bulgular.push({ tur: 'kurum', deger: dizi.metin, normal, konum: dizi.konum, guven: 0.9, baglam });
      continue;
    }

    // --- San ile baslayan kisi ---
    const ilkNorm = dil.normalize(kelimeler[0].replace(/\./g, ''));
    if (SANLAR_NORM.has(ilkNorm) && kelimeler.length >= 2) {
      const ad = kelimeler.slice(1).join(' ');
      bulgular.push({
        tur: 'kisi', deger: ad, normal: dil.normalize(ad), konum: dizi.konum, guven: 0.9,
        baglam, ek: { san: kelimeler[0].replace(/\.$/, '') },
      });
      continue;
    }

    // --- Ad/soyad sozlugu ---
    // Cumle basindaki ilgisiz bir sozcuk ("Yaninda Zeynep Kaya") adaya
    // karismasin: sozlukte olmayan ve cekim eki tasiyan bas sozcukleri kirp.
    let kirpilmis = kelimeler;
    let kirpKayma = 0;
    while (kirpilmis.length > 2) {
      const bas = dil.normalize(kirpilmis[0]);
      const sozlukteVar = AD_SOZLUGU.has(bas) || SOYAD_SOZLUGU.has(bas) ||
        ILLER_NORM.has(bas) || SANLAR_NORM.has(bas.replace(/\./g, ''));
      const kalanSozlukte = kirpilmis.slice(1).some((k) => AD_SOZLUGU.has(dil.normalize(k)))
        && kirpilmis.slice(1).some((k) => SOYAD_SOZLUGU.has(dil.normalize(k)));
      if (sozlukteVar || !kalanSozlukte) break;
      kirpKayma += kirpilmis[0].length + 1;
      kirpilmis = kirpilmis.slice(1);
    }
    if (kirpilmis.length !== kelimeler.length) {
      const yeniMetin = kirpilmis.join(' ');
      bulgular.push({
        tur: 'kisi', deger: yeniMetin, normal: dil.normalize(yeniMetin),
        konum: dizi.konum + kirpKayma, guven: 0.92,
        baglam: baglamAl(metin, dizi.konum + kirpKayma, yeniMetin.length),
      });
      continue;
    }

    if (kelimeler.length >= 2 && kelimeler.length <= 4) {
      const adParcalari = kelimeler.map((k) => dil.normalize(k));
      const adVar = adParcalari.some((k) => AD_SOZLUGU.has(k));
      const soyadVar = adParcalari.some((k) => SOYAD_SOZLUGU.has(k));
      const hepsiBuyuk = kelimeler.every((k) => /^[A-ZÇĞİÖŞÜ][\p{Ll}çğıöşü]+$/u.test(k));

      if (adVar && soyadVar) {
        bulgular.push({ tur: 'kisi', deger: dizi.metin, normal, konum: dizi.konum, guven: 0.95, baglam });
        continue;
      }
      if (adVar && hepsiBuyuk) {
        bulgular.push({ tur: 'kisi', deger: dizi.metin, normal, konum: dizi.konum, guven: 0.85, baglam });
        continue;
      }
      if (soyadVar && hepsiBuyuk) {
        bulgular.push({ tur: 'kisi', deger: dizi.metin, normal, konum: dizi.konum, guven: 0.75, baglam });
        continue;
      }
      if (hepsiBuyuk && !cumleBaslari.has(dizi.konum)) {
        // Sozlukte yok ama kalip uygun: iki+ buyuk harfli kelime, cumle basi degil
        bulgular.push({ tur: 'kisi', deger: dizi.metin, normal, konum: dizi.konum, guven: 0.55, baglam });
        continue;
      }
    }

    // --- Tek kelime buyuk harf: kod adi olabilir (TAMAMI BUYUK) ---
    if (kelimeler.length === 1 && /^[A-ZÇĞİÖŞÜ0-9-]{4,}$/.test(kelimeler[0]) &&
        !cumleBaslari.has(dizi.konum) && !KOD_ADI_YASAK.has(normal.replace(/[^a-z0-9]/g, ''))) {
      bulgular.push({ tur: 'kod_adi', deger: kelimeler[0], normal, konum: dizi.konum, guven: 0.5, baglam });
    }
  }

  return bulgular;
}

// ----------------------------------------------------------------- TEMALAR

/** Metinde hangi tematik alanlarin gectigini puanlar. */
function temalar(metin) {
  const anahtar = new Set(dil.anahtarlar(metin));
  const ham = dil.normalize(metin);
  const sonuc = [];

  for (const [tema, sozcuk] of Object.entries(TEMA_SOZLUKLERI)) {
    let puan = 0;
    const gecenler = [];
    for (const s of sozcuk) {
      if (s.includes(' ')) {
        if (ham.includes(dil.normalize(s))) { puan += 2; gecenler.push(s); }
      } else {
        const a = dil.dizinAnahtari(s);
        if (anahtar.has(a)) { puan += 1; gecenler.push(s); }
      }
    }
    if (puan > 0) sonuc.push({ tema, puan, gecenler: gecenler.slice(0, 8) });
  }

  return sonuc.sort((a, b) => b.puan - a.puan);
}

// ------------------------------------------------------------------- ANA

const GIZLI_TURLER = new Set(['tckn', 'vkn', 'iban', 'kart', 'imei', 'cuzdan']);

/**
 * Metinden tum varliklari cikarir.
 *
 * @param {string} metin
 * @param {object} secenek
 * @param {number} secenek.minGuven  en az bu guvende bulgular (0-1)
 * @param {number} secenek.maxBulgu  tur basina en fazla bulgu
 * @returns {{bulgular:Array, gruplar:object, temalar:Array, ozet:object}}
 */
function cikar(metin, { minGuven = 0.5, maxBulgu = 80 } = {}) {
  const ham = String(metin || '').slice(0, 2_000_000);
  if (!ham.trim()) {
    return { bulgular: [], gruplar: {}, temalar: [], ozet: { toplam: 0, hassas: 0 } };
  }

  const tumu = [...yapisalBulgular(ham), ...adBulgulari(ham)]
    .filter((b) => b.guven >= minGuven);

  // Ayni deger + tur tekrarlarini birlestir, sayacini tut
  const harita = new Map();
  for (const b of tumu) {
    const anahtar = `${b.tur}|${b.normal || b.deger}`;
    const mevcut = harita.get(anahtar);
    if (mevcut) {
      mevcut.sayi++;
      if (b.guven > mevcut.guven) mevcut.guven = b.guven;
      if (mevcut.baglamlar.length < 3) mevcut.baglamlar.push(b.baglam);
    } else {
      harita.set(anahtar, { ...b, sayi: 1, baglamlar: [b.baglam] });
    }
  }

  // Alt kume adlari at: "Ahmet" varsa ve "Ahmet Yilmaz" da varsa kisayi dusur
  const kisiler = [...harita.values()].filter((b) => b.tur === 'kisi');
  for (const kisa of kisiler) {
    for (const uzun of kisiler) {
      if (kisa === uzun) continue;
      if (uzun.normal.length > kisa.normal.length &&
          (uzun.normal.startsWith(kisa.normal + ' ') || uzun.normal.endsWith(' ' + kisa.normal))) {
        harita.delete(`kisi|${kisa.normal}`);
        break;
      }
    }
  }

  const bulgular = [...harita.values()].sort((a, b) => (b.guven * b.sayi) - (a.guven * a.sayi));

  const gruplar = {};
  for (const b of bulgular) {
    if (!gruplar[b.tur]) gruplar[b.tur] = [];
    if (gruplar[b.tur].length < maxBulgu) gruplar[b.tur].push(b);
  }

  const hassas = bulgular.filter((b) => GIZLI_TURLER.has(b.tur));

  return {
    bulgular,
    gruplar,
    temalar: temalar(ham),
    ozet: {
      toplam: bulgular.length,
      hassas: hassas.length,
      turler: Object.fromEntries(Object.entries(gruplar).map(([t, l]) => [t, l.length])),
    },
  };
}

/**
 * Cikarilan bulgulardan arsive eklenmeye hazir varlik onerileri uretir.
 * @returns {Array<{tur:string, ad:string, ozet:string, ozellikler:object, guven:number}>}
 */
function varlikOnerileri(cikarim) {
  const TUR_ESLEME = {
    kisi: 'kisi', kurum: 'kurum', konum: 'konum', telefon: 'telefon',
    eposta: 'eposta', web: 'web', ip: 'cihaz', cihaz: 'cihaz',
    plaka: 'arac', iban: 'hesap', cuzdan: 'hesap', kod_adi: 'kod_adi',
    sosyal: 'hesap', imei: 'cihaz',
  };

  const oneriler = [];
  for (const b of cikarim.bulgular) {
    const tur = TUR_ESLEME[b.tur];
    if (!tur) continue;
    if (b.guven < 0.6) continue;

    const ozellikler = { kaynak_tur: b.tur, gecis_sayisi: b.sayi };
    if (b.ek) Object.assign(ozellikler, b.ek);
    if (b.normal !== b.deger) ozellikler.normal = b.normal;

    oneriler.push({
      tur,
      ad: b.deger.slice(0, 180),
      ozet: (b.baglamlar && b.baglamlar[0] ? b.baglamlar[0] : '').slice(0, 400),
      ozellikler,
      guven: Math.round(b.guven * 100) / 100,
    });
  }

  return oneriler.slice(0, 120);
}

module.exports = {
  cikar, varlikOnerileri, temalar,
  tcknGecerliMi, vknGecerliMi, ibanGecerliMi, luhnGecerliMi, plakaGecerliMi,
  ILLER, ILCELER, ULKELER, TEMA_SOZLUKLERI,
};
