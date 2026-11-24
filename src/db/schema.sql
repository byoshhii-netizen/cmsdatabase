-- ============================================================================
--  CMS VERI MERKEZI  |  PostgreSQL Sema Tanimi
--  Tum modulleri destekler: kimlik, loglar, depo, pano, cambaz, paylasim
--  Idempotent: tekrar tekrar guvenle calistirilabilir.
-- ============================================================================

SET client_min_messages TO WARNING;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN insufficient_privilege OR feature_not_supported THEN
  RAISE WARNING 'pgcrypto eklentisi kurulamadi, uygulama Node tarafinda kriptografi kullanacak.';
END $$;

-- ---------------------------------------------------------------------------
--  0. YARDIMCI: updated_at otomatik guncelleme tetikleyicisi
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_guncellendi()
RETURNS TRIGGER AS $$
BEGIN
  NEW.guncellendi_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
--  1. YONETICILER  (kimlik dogrulama)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS yoneticiler (
  id                BIGSERIAL    PRIMARY KEY,
  kullanici_adi     TEXT        NOT NULL UNIQUE,
  gorunen_ad        TEXT        NOT NULL DEFAULT 'Operator',
  sifre_hash        TEXT        NOT NULL,
  sifre_algo        TEXT        NOT NULL DEFAULT 'argon2id',
  -- Oturum surumu: sifre degisince +1 yapilir, eski tum oturumlar gecersizlesir
  oturum_surumu     INTEGER     NOT NULL DEFAULT 1,
  aktif             BOOLEAN     NOT NULL DEFAULT TRUE,
  son_giris_at      TIMESTAMPTZ,
  son_giris_ip      INET,
  sifre_degisti_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  olusturuldu_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS yoneticiler_guncellendi ON yoneticiler;
CREATE TRIGGER yoneticiler_guncellendi
  BEFORE UPDATE ON yoneticiler
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

-- ---------------------------------------------------------------------------
--  2. AYARLAR  (anahtar/deger sistem ayarlari)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ayarlar (
  anahtar         TEXT        PRIMARY KEY,
  deger           TEXT,
  tur             TEXT        NOT NULL DEFAULT 'metin'
                               CHECK (tur IN ('metin','sayi','mantik','json','gizli')),
  aciklama        TEXT,
  guncellendi_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS ayarlar_guncellendi ON ayarlar;
CREATE TRIGGER ayarlar_guncellendi
  BEFORE UPDATE ON ayarlar
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

-- ---------------------------------------------------------------------------
--  3. OTURUMLAR  (connect-pg-simple deposu)
--     Sutun adlari kutuphane tarafindan sabittir, Turkcelestirilemez.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oturumlar (
  sid    VARCHAR      NOT NULL COLLATE "default",
  sess   JSON         NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'oturumlar_pkey'
  ) THEN
    ALTER TABLE oturumlar
      ADD CONSTRAINT oturumlar_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_oturumlar_expire ON oturumlar (expire);

-- ---------------------------------------------------------------------------
--  4. GIRIS DENEMELERI  (brute-force analizi / adli iz)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS giris_denemeleri (
  id             BIGSERIAL    PRIMARY KEY,
  kullanici_adi  TEXT,
  ip             INET        NOT NULL,
  basarili       BOOLEAN     NOT NULL DEFAULT FALSE,
  sebep          TEXT,
  user_agent     TEXT,
  olusturuldu_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_giris_den_ip_zaman
  ON giris_denemeleri (ip, olusturuldu_at DESC);
CREATE INDEX IF NOT EXISTS idx_giris_den_zaman
  ON giris_denemeleri (olusturuldu_at DESC);

-- ---------------------------------------------------------------------------
--  5. IP KILITLERI  (kademeli brute-force kilidi)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ip_kilitleri (
  ip              INET        PRIMARY KEY,
  basarisiz_sayi  INTEGER     NOT NULL DEFAULT 0,
  toplam_sayi     INTEGER     NOT NULL DEFAULT 0,
  kilit_bitis_at  TIMESTAMPTZ,
  son_deneme_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS ip_kilitleri_guncellendi ON ip_kilitleri;
CREATE TRIGGER ip_kilitleri_guncellendi
  BEFORE UPDATE ON ip_kilitleri
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

CREATE INDEX IF NOT EXISTS idx_ip_kilit_bitis ON ip_kilitleri (kilit_bitis_at);

-- ---------------------------------------------------------------------------
--  6. LOGLAR  (/loglar modulu: erisim ve izleme kayitlari)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loglar (
  id              BIGSERIAL    PRIMARY KEY,
  seviye          TEXT        NOT NULL DEFAULT 'bilgi'
                               CHECK (seviye IN ('izleme','bilgi','uyari','hata','kritik')),
  kategori        TEXT        NOT NULL DEFAULT 'sistem'
                               CHECK (kategori IN ('sistem','kimlik','depo','pano','cambaz','paylasim','ayarlar','guvenlik')),
  olay            TEXT        NOT NULL,
  mesaj           TEXT,
  yonetici_id     BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  rota            TEXT,
  metot           TEXT,
  durum_kodu      INTEGER,
  ip              INET,
  user_agent      TEXT,
  sure_ms         INTEGER,
  meta            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loglar_zaman     ON loglar (olusturuldu_at DESC);
CREATE INDEX IF NOT EXISTS idx_loglar_kategori  ON loglar (kategori, olusturuldu_at DESC);
CREATE INDEX IF NOT EXISTS idx_loglar_seviye    ON loglar (seviye, olusturuldu_at DESC);
CREATE INDEX IF NOT EXISTS idx_loglar_ip        ON loglar (ip);
CREATE INDEX IF NOT EXISTS idx_loglar_meta      ON loglar USING GIN (meta);

-- ---------------------------------------------------------------------------
--  7. KLASORLER  (/depo modulu: hiyerarsik kasa)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS klasorler (
  id              BIGSERIAL    PRIMARY KEY,
  ebeveyn_id      BIGINT      REFERENCES klasorler(id) ON DELETE CASCADE,
  ad              TEXT        NOT NULL,
  yol             TEXT        NOT NULL DEFAULT '/',
  aciklama        TEXT,
  renk            TEXT        NOT NULL DEFAULT '#00ff9c',
  ikon            TEXT        NOT NULL DEFAULT 'klasor',
  -- Klasor bazli ek sifre (opsiyonel, argon2id)
  kilitli         BOOLEAN     NOT NULL DEFAULT FALSE,
  sifre_hash      TEXT,
  siralama        INTEGER     NOT NULL DEFAULT 0,
  olusturan_id    BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  silindi         BOOLEAN     NOT NULL DEFAULT FALSE,
  silindi_at      TIMESTAMPTZ,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT klasor_kendine_ebeveyn CHECK (ebeveyn_id IS NULL OR ebeveyn_id <> id)
);

DROP TRIGGER IF EXISTS klasorler_guncellendi ON klasorler;
CREATE TRIGGER klasorler_guncellendi
  BEFORE UPDATE ON klasorler
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

CREATE INDEX IF NOT EXISTS idx_klasor_ebeveyn ON klasorler (ebeveyn_id) WHERE silindi = FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_klasor_ad_ebeveyn
  ON klasorler ((COALESCE(ebeveyn_id, 0)), (lower(ad))) WHERE silindi = FALSE;

-- ---------------------------------------------------------------------------
--  8. DOSYALAR  (/depo modulu: sifreli dosya kayitlari)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dosyalar (
  id              BIGSERIAL    PRIMARY KEY,
  klasor_id       BIGINT      REFERENCES klasorler(id) ON DELETE CASCADE,
  ad              TEXT        NOT NULL,
  orijinal_ad     TEXT        NOT NULL,
  mime_turu       TEXT        NOT NULL DEFAULT 'application/octet-stream',
  boyut_bayt      BIGINT      NOT NULL DEFAULT 0,
  -- Diskteki sifreli blob'un adi (rastgele, kullanici adindan bagimsiz)
  depolama_adi    TEXT        NOT NULL UNIQUE,
  sha256          TEXT,
  -- AES-256-GCM parametreleri (sifreli saklama)
  sifreli         BOOLEAN     NOT NULL DEFAULT TRUE,
  sifre_iv        TEXT,
  sifre_etiketi   TEXT,
  aciklama        TEXT,
  etiketler       TEXT[]      NOT NULL DEFAULT '{}',
  indirme_sayisi  INTEGER     NOT NULL DEFAULT 0,
  yukleyen_id     BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  silindi         BOOLEAN     NOT NULL DEFAULT FALSE,
  silindi_at      TIMESTAMPTZ,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS dosyalar_guncellendi ON dosyalar;
CREATE TRIGGER dosyalar_guncellendi
  BEFORE UPDATE ON dosyalar
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

CREATE INDEX IF NOT EXISTS idx_dosya_klasor ON dosyalar (klasor_id) WHERE silindi = FALSE;
CREATE INDEX IF NOT EXISTS idx_dosya_zaman  ON dosyalar (olusturuldu_at DESC);
CREATE INDEX IF NOT EXISTS idx_dosya_etiket ON dosyalar USING GIN (etiketler);

-- ---------------------------------------------------------------------------
--  9. PAYLASIM LINKLERI  (/paylas/:token modulu)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paylasim_linkleri (
  id                BIGSERIAL    PRIMARY KEY,
  token             TEXT        NOT NULL UNIQUE,
  tur               TEXT        NOT NULL DEFAULT 'klasor'
                                 CHECK (tur IN ('klasor','dosya','pano')),
  klasor_id         BIGINT      REFERENCES klasorler(id) ON DELETE CASCADE,
  dosya_id          BIGINT      REFERENCES dosyalar(id)  ON DELETE CASCADE,
  pano_id           BIGINT,
  baslik            TEXT,
  -- Opsiyonel link sifresi (argon2id)
  sifre_hash        TEXT,
  indirmeye_izin    BOOLEAN     NOT NULL DEFAULT TRUE,
  son_kullanma_at   TIMESTAMPTZ,
  max_goruntuleme   INTEGER,
  goruntuleme_sayisi INTEGER    NOT NULL DEFAULT 0,
  aktif             BOOLEAN     NOT NULL DEFAULT TRUE,
  olusturan_id      BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  olusturuldu_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT paylasim_hedef_var CHECK (
    (tur = 'klasor' AND klasor_id IS NOT NULL) OR
    (tur = 'dosya'  AND dosya_id  IS NOT NULL) OR
    (tur = 'pano'   AND pano_id   IS NOT NULL)
  )
);

DROP TRIGGER IF EXISTS paylasim_guncellendi ON paylasim_linkleri;
CREATE TRIGGER paylasim_guncellendi
  BEFORE UPDATE ON paylasim_linkleri
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

CREATE INDEX IF NOT EXISTS idx_paylasim_aktif ON paylasim_linkleri (aktif, son_kullanma_at);

-- ---------------------------------------------------------------------------
-- 10. PAYLASIM ERISIMLERI  (disa acilan linklerin izlenmesi)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paylasim_erisimleri (
  id              BIGSERIAL    PRIMARY KEY,
  link_id         BIGINT      NOT NULL REFERENCES paylasim_linkleri(id) ON DELETE CASCADE,
  ip              INET,
  user_agent      TEXT,
  referans        TEXT,
  eylem           TEXT        NOT NULL DEFAULT 'goruntuleme'
                               CHECK (eylem IN ('goruntuleme','indirme','sifre_hatasi','reddedildi')),
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paylasim_eris_link ON paylasim_erisimleri (link_id, olusturuldu_at DESC);

-- ---------------------------------------------------------------------------
-- 11. PANOLAR  (/pano modulu: cizim ve strateji panosu)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS panolar (
  id              BIGSERIAL    PRIMARY KEY,
  ad              TEXT        NOT NULL,
  aciklama        TEXT,
  -- Tuval durumu (katmanlar, kamera, izgara ayarlari)
  tuval           JSONB       NOT NULL DEFAULT '{"kamera":{"x":0,"y":0,"olcek":1},"izgara":true}'::jsonb,
  onizleme        TEXT,
  surum           INTEGER     NOT NULL DEFAULT 1,
  olusturan_id    BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  silindi         BOOLEAN     NOT NULL DEFAULT FALSE,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS panolar_guncellendi ON panolar;
CREATE TRIGGER panolar_guncellendi
  BEFORE UPDATE ON panolar
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

CREATE INDEX IF NOT EXISTS idx_pano_zaman ON panolar (guncellendi_at DESC) WHERE silindi = FALSE;

-- paylasim_linkleri.pano_id -> panolar.id bagi (panolar sonradan olustugu icin burada)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_paylasim_pano'
  ) THEN
    ALTER TABLE paylasim_linkleri
      ADD CONSTRAINT fk_paylasim_pano
      FOREIGN KEY (pano_id) REFERENCES panolar(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 12. PANO OGELERI  (cizim nesneleri, notlar, baglantilar)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pano_ogeleri (
  id              BIGSERIAL    PRIMARY KEY,
  pano_id         BIGINT      NOT NULL REFERENCES panolar(id) ON DELETE CASCADE,
  tur             TEXT        NOT NULL DEFAULT 'not'
                               CHECK (tur IN ('not','kalem','dikdortgen','elips','cizgi','ok','metin','resim','dugum','baglanti')),
  veri            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  x               DOUBLE PRECISION NOT NULL DEFAULT 0,
  y               DOUBLE PRECISION NOT NULL DEFAULT 0,
  genislik        DOUBLE PRECISION,
  yukseklik       DOUBLE PRECISION,
  renk            TEXT        NOT NULL DEFAULT '#00ff9c',
  z_sira          INTEGER     NOT NULL DEFAULT 0,
  kilitli         BOOLEAN     NOT NULL DEFAULT FALSE,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS pano_ogeleri_guncellendi ON pano_ogeleri;
CREATE TRIGGER pano_ogeleri_guncellendi
  BEFORE UPDATE ON pano_ogeleri
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

CREATE INDEX IF NOT EXISTS idx_pano_oge_pano ON pano_ogeleri (pano_id, z_sira);

-- ---------------------------------------------------------------------------
-- 13. CAMBAZ OTURUMLARI  (/cambaz modulu: yapay zeka ajani)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cambaz_oturumlari (
  id              BIGSERIAL    PRIMARY KEY,
  baslik          TEXT        NOT NULL DEFAULT 'Yeni Gorusme',
  saglayici       TEXT        NOT NULL DEFAULT 'anthropic',
  model           TEXT,
  sistem_talimati TEXT,
  yonetici_id     BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  arsivlendi      BOOLEAN     NOT NULL DEFAULT FALSE,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS cambaz_oturum_guncellendi ON cambaz_oturumlari;
CREATE TRIGGER cambaz_oturum_guncellendi
  BEFORE UPDATE ON cambaz_oturumlari
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

CREATE INDEX IF NOT EXISTS idx_cambaz_oturum_zaman
  ON cambaz_oturumlari (guncellendi_at DESC) WHERE arsivlendi = FALSE;

-- ---------------------------------------------------------------------------
-- 14. CAMBAZ MESAJLARI
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cambaz_mesajlari (
  id              BIGSERIAL    PRIMARY KEY,
  oturum_id       BIGINT      NOT NULL REFERENCES cambaz_oturumlari(id) ON DELETE CASCADE,
  rol             TEXT        NOT NULL CHECK (rol IN ('kullanici','ajan','sistem','arac')),
  icerik          TEXT        NOT NULL,
  model           TEXT,
  girdi_token     INTEGER,
  cikti_token     INTEGER,
  gecikme_ms      INTEGER,
  hata            TEXT,
  meta            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cambaz_mesaj_oturum
  ON cambaz_mesajlari (oturum_id, olusturuldu_at);

-- ---------------------------------------------------------------------------
-- 15. API ANAHTARLARI  (/ayarlar modulu: AES-256-GCM ile sifreli saklanir)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_anahtarlari (
  id              BIGSERIAL    PRIMARY KEY,
  saglayici       TEXT        NOT NULL,
  etiket          TEXT        NOT NULL DEFAULT 'varsayilan',
  -- Sifreli govde: base64(ciphertext) + iv + auth tag ayri sutunlarda
  sifreli_deger   TEXT        NOT NULL,
  sifre_iv        TEXT        NOT NULL,
  sifre_etiketi   TEXT        NOT NULL,
  -- Kullaniciya gosterilecek maskeli onek (or. "sk-ant-...4f2a")
  maske           TEXT,
  aktif           BOOLEAN     NOT NULL DEFAULT TRUE,
  son_kullanim_at TIMESTAMPTZ,
  olusturan_id    BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_api_saglayici_etiket UNIQUE (saglayici, etiket)
);

DROP TRIGGER IF EXISTS api_anahtar_guncellendi ON api_anahtarlari;
CREATE TRIGGER api_anahtar_guncellendi
  BEFORE UPDATE ON api_anahtarlari
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

-- ---------------------------------------------------------------------------
-- 16. BELGELER  (/depo modulu: dahili metin belgesi editoru)
--     Baslik + icerik + "dijital imza" (operator imzasi, PKI degildir) +
--     sunucu tarafinda hesaplanan butunluk parmak izi (SHA-256).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS belgeler (
  id              BIGSERIAL    PRIMARY KEY,
  klasor_id       BIGINT      REFERENCES klasorler(id) ON DELETE CASCADE,
  baslik          TEXT        NOT NULL,
  icerik          TEXT        NOT NULL DEFAULT '',
  imza            TEXT,
  butunluk_hash   TEXT,
  surum           INTEGER     NOT NULL DEFAULT 1,
  olusturan_id    BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  silindi         BOOLEAN     NOT NULL DEFAULT FALSE,
  silindi_at      TIMESTAMPTZ,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS belgeler_guncellendi ON belgeler;
CREATE TRIGGER belgeler_guncellendi
  BEFORE UPDATE ON belgeler
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

CREATE INDEX IF NOT EXISTS idx_belge_klasor ON belgeler (klasor_id) WHERE silindi = FALSE;
CREATE INDEX IF NOT EXISTS idx_belge_zaman  ON belgeler (olusturuldu_at DESC);

-- ---------------------------------------------------------------------------
-- 17. SONRADAN EKLENEN SUTUNLAR  (eski kurulumlar icin idempotent ALTER)
-- ---------------------------------------------------------------------------

-- dosyalar.goruntuleme_sayisi: indirmeden bagimsiz, dahili oynaticida/
-- paylasim gorunumunde her acilista artan sayac.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'dosyalar' AND column_name = 'goruntuleme_sayisi'
  ) THEN
    ALTER TABLE dosyalar ADD COLUMN goruntuleme_sayisi INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- paylasim_erisimleri: tekil dosya/belge izi + ayristirilmis cihaz bilgisi.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'paylasim_erisimleri' AND column_name = 'dosya_id'
  ) THEN
    ALTER TABLE paylasim_erisimleri
      ADD COLUMN dosya_id BIGINT REFERENCES dosyalar(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'paylasim_erisimleri' AND column_name = 'belge_id'
  ) THEN
    ALTER TABLE paylasim_erisimleri
      ADD COLUMN belge_id BIGINT REFERENCES belgeler(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'paylasim_erisimleri' AND column_name = 'tarayici'
  ) THEN
    ALTER TABLE paylasim_erisimleri ADD COLUMN tarayici TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'paylasim_erisimleri' AND column_name = 'isletim_sistemi'
  ) THEN
    ALTER TABLE paylasim_erisimleri ADD COLUMN isletim_sistemi TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'paylasim_erisimleri' AND column_name = 'cihaz_tipi'
  ) THEN
    ALTER TABLE paylasim_erisimleri ADD COLUMN cihaz_tipi TEXT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_paylasim_eris_dosya ON paylasim_erisimleri (dosya_id) WHERE dosya_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_paylasim_eris_belge ON paylasim_erisimleri (belge_id) WHERE belge_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_paylasim_eris_zaman ON paylasim_erisimleri (olusturuldu_at DESC);

-- paylasim_linkleri.ozet_baslik: "Dışarıya Aç" formundaki ozel baslik zaten
-- 'baslik' sutununda tutuluyor; ek olarak klasor adini da saklayalim ki
-- klasor silinse bile paylasim gecmisinde hangi klasor oldugu bilinsin.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'paylasim_linkleri' AND column_name = 'hedef_adi'
  ) THEN
    ALTER TABLE paylasim_linkleri ADD COLUMN hedef_adi TEXT;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 19. PANO GENISLETME  (/pano: tum-pano kilidi)
-- ---------------------------------------------------------------------------
-- Oge bazli kilit zaten pano_ogeleri.kilitli ile var; burada eklenen
-- panolar.kilitli ise TUM panoyu salt-okunur yapan ust duzey anahtardir.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'panolar' AND column_name = 'kilitli'
  ) THEN
    ALTER TABLE panolar ADD COLUMN kilitli BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 20. CAMBAZ HAFIZASI  (/cambaz: kalici, duzenlenebilir "ogrenilen bilgi")
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cambaz_hafiza (
  id               BIGSERIAL    PRIMARY KEY,
  baslik           TEXT        NOT NULL DEFAULT 'Not',
  icerik           TEXT        NOT NULL,
  kaynak           TEXT        NOT NULL DEFAULT 'manuel' CHECK (kaynak IN ('manuel','otomatik')),
  kaynak_oturum_id BIGINT      REFERENCES cambaz_oturumlari(id) ON DELETE SET NULL,
  olusturan_id     BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  olusturuldu_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS cambaz_hafiza_guncellendi ON cambaz_hafiza;
CREATE TRIGGER cambaz_hafiza_guncellendi
  BEFORE UPDATE ON cambaz_hafiza
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

CREATE INDEX IF NOT EXISTS idx_cambaz_hafiza_zaman ON cambaz_hafiza (guncellendi_at DESC);

-- ---------------------------------------------------------------------------
-- 21. CAMBAZ SES PROFILI  (/cambaz: ozel ses ornegi, AES-256-GCM ile sakli)
-- ---------------------------------------------------------------------------
-- Tek satirli (id sabit 1) sistem geneli ozel ses ornegi. ElevenLabs gibi
-- klonlama destekleyen bir saglayici API anahtari eklenirse, bu ornek o
-- saglayiciya gonderilip donen ses kimligi elevenlabs_ses_id'de saklanir.
CREATE TABLE IF NOT EXISTS cambaz_ses_profili (
  id                SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  dosya_adi         TEXT,
  mime              TEXT,
  sifreli_veri      TEXT,
  sifre_iv          TEXT,
  sifre_etiketi     TEXT,
  bayt_boyutu       INTEGER,
  elevenlabs_ses_id TEXT,
  guncellendi_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 22. CAMBAZ MESAJLARI GENISLETME  (sesli girdi isareti)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'cambaz_mesajlari' AND column_name = 'sesli'
  ) THEN
    ALTER TABLE cambaz_mesajlari ADD COLUMN sesli BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 18. VARSAYILAN AYAR KAYITLARI
-- ---------------------------------------------------------------------------
INSERT INTO ayarlar (anahtar, deger, tur, aciklama) VALUES
  ('sistem_adi',        'CMS VERI MERKEZI', 'metin',  'Arayuzde gorunen sistem adi'),
  ('sistem_kodu',       'KARTRIDEX',        'metin',  'Operasyon kod adi'),
  ('ses_aktif',         'true',             'mantik', 'Web Audio ses efektleri'),
  ('matrix_aktif',      'true',             'mantik', 'Matrix yagmuru arka plani'),
  ('gecis_animasyonu',  'true',             'mantik', 'Sayfa gecis animasyonlari'),
  ('log_saklama_gun',   '90',               'sayi',   'Loglarin saklanma suresi (gun)'),
  ('paylasim_aktif',    'true',             'mantik', 'Disa acik paylasim linkleri etkin mi'),
  ('cambaz_saglayici',  'anthropic',        'metin',  'Aktif yapay zeka saglayicisi'),
  ('cambaz_model',      'claude-sonnet-4-5','metin',  'Aktif model kimligi'),
  ('cambaz_arama_saglayici', 'tavily',      'metin',  'Aktif web arama saglayicisi'),
  ('cambaz_ses_turu',   'tarayici',         'metin',  'Cambaz TTS motoru: tarayici|openai|elevenlabs'),
  ('cambaz_ses_ad',     '',                 'metin',  'Secili sistem/saglayici ses adi'),
  ('cambaz_ses_hiz',    '1',                'metin',  'Konusma hizi (0.5 - 2.0)'),
  ('cambaz_ses_perde',  '1',                'metin',  'Konusma perdesi (0.5 - 2.0, yalnizca tarayici motoru)'),
  ('bakim_modu',        'false',            'mantik', 'Bakim modu (giris haric tum rotalar kapali)')
ON CONFLICT (anahtar) DO NOTHING;
