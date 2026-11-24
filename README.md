# CMS VERİ MERKEZİ

Matrix + gizli istihbarat estetiğine sahip, mobil uyumlu, tam yığın (full-stack)
veri yönetim terminali. Node.js + Express + PostgreSQL. Railway üzerinde barınmak
üzere yapılandırılmıştır.

> **Bu aşamada ne var:** sunucu çatısı, PostgreSQL şeması (tüm modülleri
> destekler), güvenlik ara yazılımları, giriş/şifre değiştirme sistemi, tema
> (CSS/Web Audio/geçiş animasyonları) ve diğer sayfaların çalışan iskeletleri.

---

## 1. Hızlı başlangıç (yerel)

```bash
cd CMSVeriMerkezi
npm install

# Sırları üret ve .env dosyasını hazırla
cp .env.example .env
npm run guvenlik:anahtar     # çıkan iki satırı .env içine yapıştır

# .env içinde DATABASE_URL değerini kendi PostgreSQL adresinize göre düzenleyin
# İlk yönetici için VARSAYILAN_SIFRE değerine güçlü ve benzersiz bir parola yazın
npm run db:migrate           # şemayı kurar + varsayılan yöneticiyi oluşturur
npm run db:seed              # (isteğe bağlı) örnek klasör/pano verisi
npm run dev
```

Tarayıcı: <http://localhost:3000/giris>

| | |
|---|---|
| Kullanıcı | `cms` (`.env` → `VARSAYILAN_KULLANICI`) |
| Şifre | `.env` → `VARSAYILAN_SIFRE` (kurulumda sizin belirlediğiniz değer) |

Şifre veritabanında **argon2id** ile hash'lenir; düz metin hiçbir yerde saklanmaz.
İlk girişten sonra `/ayarlar` ekranından değiştirin — değiştirildiği anda diğer
tüm cihazlardaki oturumlar düşer.

---

## 2. Railway'e dağıtım

1. **Proje oluştur** → GitHub deposunu bağla (veya `railway up`).
2. **PostgreSQL eklentisi ekle.** `DATABASE_URL` otomatik enjekte edilir.
3. **Değişkenleri gir** (Variables sekmesi):

   | Değişken | Değer |
   |---|---|
   | `NODE_ENV` | `production` |
   | `SESSION_SECRET` | `npm run guvenlik:anahtar` çıktısı (≥32 karakter) |
   | `ENCRYPTION_KEY` | `npm run guvenlik:anahtar` çıktısı (64 HEX karakter) |
   | `PUBLIC_URL` | `https://<alan-adiniz>.up.railway.app` |
   | `TRUST_PROXY` | `1` |
   | `VARSAYILAN_SIFRE` | ilk kurulum için güçlü ve benzersiz parola |
   | `DB_SSL` | dış bağlantı kullanıyorsanız `zorunlu`, dahili ağda `otomatik` |

4. Dağıt. `railway.json` içindeki başlatma komutu migrasyonu otomatik çalıştırır:
   `npm run db:migrate && npm start`
5. Sağlık kontrolü: `GET /saglik`

> `SESSION_SECRET` veya `ENCRYPTION_KEY` üretimde eksikse uygulama **bilerek
> başlamaz** ve hangi değişkenin eksik olduğunu yazar. Bu, zayıf sırla canlıya
> çıkmayı imkânsız kılar.

**Önemli:** `ENCRYPTION_KEY` değişirse veritabanındaki kayıtlı API anahtarları
çözülemez. Anahtarı güvenli bir yerde yedekleyin.

---

## 3. Klasör yapısı

```
CMSVeriMerkezi/
├── server.js                      # giriş noktası, zarif kapanış
├── package.json
├── railway.json                   # Railway derleme/dağıtım + healthcheck
├── .env.example                   # tüm ortam değişkenleri (açıklamalı)
├── .gitignore / .dockerignore
├── depo_veri/                     # şifreli dosya blob'ları (git dışı)
│
├── src/
│   ├── app.js                     # Express kurulumu, ara yazılım sırası
│   │
│   ├── config/
│   │   ├── env.js                 # ortam doğrulama, güvenli varsayılanlar
│   │   └── db.js                  # PostgreSQL havuzu, parametreli sorgu, işlem
│   │
│   ├── db/
│   │   ├── schema.sql             # 15 tablo + indeksler + tetikleyiciler
│   │   ├── migrate.js             # şema uygulama + varsayılan yönetici
│   │   └── seed.js                # örnek veri (geliştirme)
│   │
│   ├── middleware/
│   │   ├── security.js            # Helmet, sıkı CSP, önbellek, kaynak doğrulama
│   │   ├── session.js             # PostgreSQL oturum deposu, HttpOnly çerez
│   │   ├── csrf.js                # senkronizasyon token'ı (zaman sabitli)
│   │   ├── rateLimit.js           # 5 ayrı hız sınırlayıcı
│   │   ├── auth.js                # oturum koruma, zaman aşımı, sürüm kontrolü
│   │   ├── logger.js              # istek/yanıt izleme
│   │   └── errorHandler.js        # 404 + merkezi hata yakalayıcı
│   │
│   ├── services/
│   │   ├── authService.js         # giriş, şifre değiştirme (argon2id)
│   │   ├── kilitService.js        # kademeli brute-force kilidi
│   │   ├── ayarService.js         # sistem ayarları + API anahtar kasası
│   │   └── logService.js          # kayıt yazma/listeleme/özet/budama
│   │
│   ├── utils/
│   │   ├── crypto.js              # argon2id, AES-256-GCM, token, sabit zaman
│   │   └── validate.js            # girdi doğrulama, open-redirect koruması
│   │
│   ├── routes/
│   │   ├── index.js               # rota haritası
│   │   ├── giris.js  merkez.js  depo.js  pano.js
│   │   ├── cambaz.js loglar.js  ayarlar.js  paylas.js
│   │   └── api/
│   │       ├── kimlik.js          # oturum durumu, CSRF tazeleme
│   │       └── sistem.js          # panel verileri (JSON)
│   │
│   └── views/                     # EJS şablonları
│       ├── partials/              # bas, son, kabuk-ust, kabuk-alt
│       ├── giris.ejs  merkez.ejs  depo.ejs  pano.ejs
│       ├── cambaz.ejs loglar.ejs  ayarlar.ejs  paylas.ejs
│       └── hata/genel.ejs
│
└── public/
    ├── css/terminal.css           # tema (tek dosya, satır içi stil yok)
    ├── js/ses.js                  # Web Audio API ses sentezi
    ├── js/matrix.js               # Matrix karakter yağmuru (canvas)
    ├── js/gecis.js                # sayfa geçiş animasyonu
    ├── js/cekirdek.js             # çekirdek: saat, ses, CSRF'li fetch
    ├── js/giris.js  js/ayarlar.js
    └── ikon/amblem.svg
```

---

## 4. Rota haritası

| Metot | Rota | Erişim | Açıklama |
|---|---|---|---|
| GET | `/` | açık | oturuma göre `/merkez` ya da `/giris` |
| GET | `/giris` | misafir | şifreli terminal giriş ekranı |
| POST | `/giris` | misafir | kimlik doğrulama (hız sınırlı + kilitli) |
| POST | `/cikis` | açık | oturum kapatma |
| GET | `/merkez` | **kimlik** | ana kontrol paneli |
| GET | `/depo` | **kimlik** | şifreli dosya ve klasör kasası |
| GET | `/pano` | **kimlik** | çizim ve strateji panosu |
| GET | `/cambaz` | **kimlik** | yapay zekâ ajanı |
| GET | `/loglar` | **kimlik** | erişim ve izleme kayıtları |
| GET | `/ayarlar` | **kimlik** | şifre ve API anahtarı yönetimi |
| POST | `/ayarlar/sifre` | **kimlik** | ana şifre değiştirme |
| POST | `/ayarlar/api-anahtari` | **kimlik** | anahtar kaydet (AES-256-GCM) |
| POST | `/ayarlar/api-anahtari/:id/sil` | **kimlik** | anahtar sil |
| POST | `/ayarlar/arayuz` | **kimlik** | ses/matrix/geçiş ayarları |
| GET | `/paylas/:token` | açık* | dışa açık kontrollü görünüm |
| POST | `/paylas/:token/sifre` | açık* | link şifresi doğrulama |
| GET | `/saglik` | açık | Railway healthcheck |
| GET | `/api/kimlik/durum` | açık | oturum nabız kontrolü |
| GET | `/api/kimlik/belirtec` | **kimlik** | CSRF token tazeleme |
| GET | `/api/sistem/ozet` | **kimlik** | panel göstergeleri |
| GET | `/api/sistem/loglar` | **kimlik** | log akışı (JSON) |

\* `noindex`, hız sınırlı, süre/kota/şifre kontrollü, her erişim kaydedilir.

---

## 5. Güvenlik katmanı

**Kimlik ve şifre**
- argon2id (19 MiB bellek, t=2, p=1 — OWASP önerisi); düz metin asla saklanmaz
- Kullanıcı bulunamadığında da sahte doğrulama yapılır → zamanlama saldırısı ve
  kullanıcı envanteri çıkarımı engellenir
- Hata mesajları geneldir: "kullanıcı yok" / "şifre yanlış" ayrımı sızdırılmaz
- Şifre politikası: ≥10 karakter, harf + rakam, yaygın/varsayılan şifre reddi
- Şifre değişince `oturum_surumu` artar → **diğer tüm oturumlar anında düşer**

**Brute-force**
- IP başına hız sınırı: giriş 10/10dk, şifre değiştirme 12/saat, genel 900/15dk
- Veritabanı destekli kademeli kilit: 5 hata → 5 dk, 10 hata → 60 dk
- Başarılı giriş sayacı sıfırlar; tüm denemeler `giris_denemeleri` tablosuna yazılır

**Oturum**
- PostgreSQL oturum deposu (`oturumlar`), süresi geçenler otomatik budanır
- Çerez: `HttpOnly` + `Secure` (üretim) + `SameSite=Lax` + imzalı + özel ad
- Girişte `session.regenerate()` → **oturum sabitleme (fixation) koruması**
- Boşta zaman aşımı (60 dk) + mutlak zaman aşımı (720 dk)
- Kimlikli sayfalarda `Cache-Control: no-store` → geri tuşuyla içerik görünmez

**CSRF**
- Oturum bağlı senkronizasyon token'ı, zaman sabitli karşılaştırma
- `X-CSRF-Token` başlığı veya `_csrf` form alanı ile doğrulama
- İkinci hat: `Origin`/`Referer` kaynak doğrulaması
- Girişte token yenilenir

**XSS**
- EJS varsayılan kaçışı (`<%= %>`) + ikinci hat girdi temizleme
- **Sıkı CSP:** `script-src 'self'`, `script-src-attr 'none'`, `style-src 'self'`,
  `object-src 'none'`, `frame-ancestors 'none'` — `unsafe-inline` **yok**
- Projede tek bir satır içi `<script>`, `style=""` veya `onclick=""` bulunmaz
  (bu nedenle sunucu→tarayıcı veri aktarımı `<body data-*>` ile yapılır)
- `HttpOnly` çerez → XSS olsa bile oturum token'ı çalınamaz

**Diğer**
- Helmet: HSTS (1 yıl), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`,
  `Permissions-Policy` (kamera/mikrofon/konum kapalı), `X-Powered-By` kaldırıldı
- Üretimde HTTP→HTTPS 308 yönlendirme
- Gövde boyut sınırları (64 KB form / 256 KB JSON), parametre sayısı sınırı
- **Tüm** SQL sorguları parametreli (`$1, $2 …`) → SQL injection kapalı
- Open-redirect koruması: `?hedef=` yalnızca dahili yollar kabul eder
- Path traversal koruması: dosya adları ve depolama adları temizlenir
- API anahtarları AES-256-GCM ile şifreli; ekranda yalnızca maske görünür
- Üretimde yığın izi (stack trace) istemciye **asla** gönderilmez
- Tüm güvenlik olayları `loglar` tablosuna yazılır

---

## 6. Veritabanı şeması (15 tablo)

| Tablo | Amaç |
|---|---|
| `yoneticiler` | kimlik, argon2id hash, oturum sürümü |
| `ayarlar` | anahtar/değer sistem ayarları |
| `oturumlar` | PostgreSQL oturum deposu |
| `giris_denemeleri` | adli iz / brute-force analizi |
| `ip_kilitleri` | kademeli kilit durumu |
| `loglar` | tüm olaylar (seviye, kategori, IP, meta JSONB) |
| `klasorler` | hiyerarşik kasa (self-FK, klasör şifresi) |
| `dosyalar` | şifreli dosya kayıtları (IV, auth tag, SHA-256) |
| `paylasim_linkleri` | dışa açık token'lar (süre, kota, şifre) |
| `paylasim_erisimleri` | paylaşım erişim izi |
| `panolar` | strateji panosu tuval durumu (JSONB) |
| `pano_ogeleri` | çizim nesneleri, notlar, bağlantılar |
| `cambaz_oturumlari` | yapay zekâ görüşmeleri |
| `cambaz_mesajlari` | mesaj geçmişi, token sayacı |
| `api_anahtarlari` | AES-256-GCM şifreli anahtar kasası |

Şema **idempotent**'tir: `npm run db:migrate` tekrar tekrar güvenle çalıştırılabilir.
Sıfırdan kurmak için: `npm run db:reset` (**tüm veriyi siler**).

---

## 7. Tema ve etkileşim

- **Renkler:** koyu siyah `#04070a`, zümrüt `#00ff9c`, camgöbeği `#22d3ee`
- **Matrix yağmuru:** canvas, katakana + proje karakterleri; mobilde düşük
  yoğunluk, sekme gizliyken durur, `prefers-reduced-motion` ile kapanır
- **Web Audio API sesleri** (dosya indirilmez, osilatörle sentezlenir):
  `tik` `gezin` `yazma` `erisim` `ret` `uyari` `onay` `gecis` `tarama` `acilis` `alarm`
  Tarayıcı politikası gereği ilk kullanıcı hareketinde açılır; tercih
  `localStorage`'da saklanır, üst bardaki düğmeyle kapatılabilir
- **Geçiş animasyonları:** bağlantı tıklamasında tarama perdesi + ses, sonra
  gerçek yönlendirme. JS kapalıysa bağlantılar normal çalışır (zarif bozulma)
- **Mobil:** 900 px altında yan menü alt bara dönüşür, `safe-area-inset` desteği,
  dokunma hedefleri ≥42 px, tablolar yatay kaydırmalı

---

## 8. Sonraki aşamalar

1. **`/depo`** — parçalı dosya yükleme + AES-256-GCM blob şifreleme, indirme akışı,
   klasör şifresi doğrulaması, paylaşım linki üretme arayüzü
2. **`/pano`** — canvas tuval motoru (kalem, şekil, ok, yapışkan not, bağlantı),
   otomatik kaydetme, sürüm geçmişi
3. **`/cambaz`** — akışlı (streaming) sohbet motoru, araç çağrıları, depo/pano
   bağlamını okuma
4. **`/loglar`** — CSV dışa aktarma, IP kilidi elle kaldırma, canlı akış (SSE)
5. **`/paylas/:token`** — şifreli dosya indirme akışı, alt klasör gezinme

---

## 9. Komutlar

| Komut | Açıklama |
|---|---|
| `npm start` | üretim sunucusu |
| `npm run dev` | geliştirme (dosya değişiminde yeniden başlar) |
| `npm run db:migrate` | şemayı uygula + varsayılan yönetici |
| `npm run db:reset` | **tüm tabloları düşürüp** yeniden kur |
| `npm run db:seed` | örnek veri yükle |
| `npm run guvenlik:anahtar` | `SESSION_SECRET` ve `ENCRYPTION_KEY` üret |
