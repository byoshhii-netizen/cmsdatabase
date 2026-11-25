-- ============================================================================
--  CMS VERI MERKEZI  |  ISTIHBARAT ARSIVI SEMASI  (schema_arsiv.sql)
--  schema.sql uygulandiktan SONRA calistirilir. Idempotent'tir.
--
--  Tasnif seviyeleri    : acik | hizmete_ozel | gizli | cok_gizli
--  Kaynak guvenilirligi : A..F  (Admiralty / NATO derecelendirmesi)
--  Bilgi dogrulugu      : 1..6  (Admiralty / NATO derecelendirmesi)
-- ============================================================================

SET client_min_messages TO WARNING;

-- ---------------------------------------------------------------------------
--  0. YARDIMCI FONKSIYONLAR
-- ---------------------------------------------------------------------------

-- Turkce metni arama icin normalize eder: once Turkce'ye ozgu harfleri ASCII
-- karsiligina cevirir (locale bagimsiz olsun diye), sonra kucuk harfe indirir.
-- Boylece "Isik", "ışık", "ISIK" ayni anahtara duser.
CREATE OR REPLACE FUNCTION arsiv_normalize(m TEXT)
RETURNS TEXT AS $$
  SELECT lower(translate(COALESCE(m, ''),
    'ÇĞİIÖŞÜçğıiöşüÂÎÛâîûÀÁÄÈÉËÌÍÒÓÔÙÚàáäèéëìíòóôùú',
    'cgiiosucgiiosuaiuaiuaaaeeeiiooouuaaaeeeiiooouu'))
$$ LANGUAGE sql IMMUTABLE;

-- Arama vektoru kuran genel tetikleyici. Her tabloda hangi sutunlarin
-- birlesecegi TG_ARGV ile verilir: CREATE TRIGGER ... EXECUTE FUNCTION
-- trg_arama_vektoru('baslik', 'govde', 'etiketler')
CREATE OR REPLACE FUNCTION trg_arama_vektoru()
RETURNS TRIGGER AS $$
DECLARE
  parca   TEXT := '';
  i       INT;
  deger   TEXT;
  satir   JSONB := to_jsonb(NEW);
BEGIN
  FOR i IN 0 .. (TG_NARGS - 1) LOOP
    deger := NULLIF(satir ->> TG_ARGV[i], '');
    IF deger IS NOT NULL THEN
      -- Dizi sutunlari JSON dizisi olarak gelir: koseli parantezleri at.
      deger := regexp_replace(deger, '[\[\]"{}]', ' ', 'g');
      parca := parca || ' ' || deger;
    END IF;
  END LOOP;
  NEW.arama := to_tsvector('simple', arsiv_normalize(parca));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Kod uretici: VRL-000123 bicimli, tablo basina artan okunabilir kod.
CREATE SEQUENCE IF NOT EXISTS seq_varlik_kodu  START 1;
CREATE SEQUENCE IF NOT EXISTS seq_kayit_kodu   START 1;
CREATE SEQUENCE IF NOT EXISTS seq_vaka_kodu    START 1;
CREATE SEQUENCE IF NOT EXISTS seq_kaynak_kodu  START 1;
CREATE SEQUENCE IF NOT EXISTS seq_olay_kodu    START 1;

-- ---------------------------------------------------------------------------
--  1. KAYNAKLAR  (bilgi kaynaklari + guvenilirlik derecesi)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kaynaklar (
  id              BIGSERIAL   PRIMARY KEY,
  kod             TEXT        NOT NULL UNIQUE
                               DEFAULT 'KYN-' || lpad(nextval('seq_kaynak_kodu')::text, 5, '0'),
  ad              TEXT        NOT NULL,
  tur             TEXT        NOT NULL DEFAULT 'acik_kaynak'
                               CHECK (tur IN ('insan','acik_kaynak','sinyal','teknik','belge','kurum','anonim','dahili')),
  guvenilirlik    CHAR(1)     NOT NULL DEFAULT 'C'
                               CHECK (guvenilirlik IN ('A','B','C','D','E','F')),
  irtibat         TEXT,
  aciklama        TEXT,
  etiketler       TEXT[]      NOT NULL DEFAULT '{}',
  aktif           BOOLEAN     NOT NULL DEFAULT TRUE,
  kayit_sayisi    INTEGER     NOT NULL DEFAULT 0,
  olusturan_id    BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  silindi         BOOLEAN     NOT NULL DEFAULT FALSE,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS kaynaklar_guncellendi ON kaynaklar;
CREATE TRIGGER kaynaklar_guncellendi BEFORE UPDATE ON kaynaklar
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

CREATE INDEX IF NOT EXISTS idx_kaynak_tur ON kaynaklar (tur) WHERE silindi = FALSE;

-- ---------------------------------------------------------------------------
--  2. VARLIKLAR  (kisi, kurum, konum, arac, hesap ... = arsivin cekirdegi)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS varliklar (
  id              BIGSERIAL   PRIMARY KEY,
  kod             TEXT        NOT NULL UNIQUE
                               DEFAULT 'VRL-' || lpad(nextval('seq_varlik_kodu')::text, 5, '0'),
  tur             TEXT        NOT NULL DEFAULT 'kisi'
                               CHECK (tur IN ('kisi','kurum','konum','arac','telefon','eposta','hesap',
                                              'web','cihaz','maddi','kod_adi','grup','etkinlik','diger')),
  ad              TEXT        NOT NULL,
  takma_adlar     TEXT[]      NOT NULL DEFAULT '{}',
  ozet            TEXT,
  detay           TEXT,
  tasnif          TEXT        NOT NULL DEFAULT 'hizmete_ozel'
                               CHECK (tasnif IN ('acik','hizmete_ozel','gizli','cok_gizli')),
  guvenilirlik    CHAR(1)     NOT NULL DEFAULT 'C'
                               CHECK (guvenilirlik IN ('A','B','C','D','E','F')),
  dogruluk        SMALLINT    NOT NULL DEFAULT 3 CHECK (dogruluk BETWEEN 1 AND 6),
  durum           TEXT        NOT NULL DEFAULT 'aktif'
                               CHECK (durum IN ('aktif','izlemede','pasif','arsiv','elendi')),
  onem            SMALLINT    NOT NULL DEFAULT 50 CHECK (onem BETWEEN 0 AND 100),
  ulke            TEXT,
  adres           TEXT,
  enlem           DOUBLE PRECISION,
  boylam          DOUBLE PRECISION,
  baslangic_tarihi DATE,
  bitis_tarihi    DATE,
  ozellikler      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  etiketler       TEXT[]      NOT NULL DEFAULT '{}',
  renk            TEXT        NOT NULL DEFAULT '#00ff9c',
  arama           TSVECTOR,
  olusturan_id    BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  silindi         BOOLEAN     NOT NULL DEFAULT FALSE,
  silindi_at      TIMESTAMPTZ,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS varliklar_guncellendi ON varliklar;
CREATE TRIGGER varliklar_guncellendi BEFORE UPDATE ON varliklar
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

DROP TRIGGER IF EXISTS varliklar_arama ON varliklar;
CREATE TRIGGER varliklar_arama BEFORE INSERT OR UPDATE ON varliklar
  FOR EACH ROW EXECUTE FUNCTION trg_arama_vektoru('ad', 'takma_adlar', 'ozet', 'detay', 'etiketler', 'kod', 'adres');

CREATE INDEX IF NOT EXISTS idx_varlik_tur     ON varliklar (tur)   WHERE silindi = FALSE;
CREATE INDEX IF NOT EXISTS idx_varlik_durum   ON varliklar (durum) WHERE silindi = FALSE;
CREATE INDEX IF NOT EXISTS idx_varlik_onem    ON varliklar (onem DESC) WHERE silindi = FALSE;
CREATE INDEX IF NOT EXISTS idx_varlik_arama   ON varliklar USING GIN (arama);
CREATE INDEX IF NOT EXISTS idx_varlik_etiket  ON varliklar USING GIN (etiketler);
CREATE INDEX IF NOT EXISTS idx_varlik_ozellik ON varliklar USING GIN (ozellikler);
CREATE INDEX IF NOT EXISTS idx_varlik_ad_norm ON varliklar (arsiv_normalize(ad)) WHERE silindi = FALSE;

-- ---------------------------------------------------------------------------
--  3. VARLIK ILISKILERI  (baglanti analizinin kenarlari)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS varlik_iliskileri (
  id               BIGSERIAL   PRIMARY KEY,
  kaynak_varlik_id BIGINT      NOT NULL REFERENCES varliklar(id) ON DELETE CASCADE,
  hedef_varlik_id  BIGINT      NOT NULL REFERENCES varliklar(id) ON DELETE CASCADE,
  tur              TEXT        NOT NULL DEFAULT 'iletisim'
                                CHECK (tur IN ('akrabalik','is','ortaklik','uyelik','sahiplik','iletisim',
                                               'finansal','husumet','lojistik','konum','ayni_kisi','diger')),
  etiket           TEXT,
  yon              TEXT        NOT NULL DEFAULT 'cift' CHECK (yon IN ('tek','cift')),
  guc              SMALLINT    NOT NULL DEFAULT 50 CHECK (guc BETWEEN 0 AND 100),
  guvenilirlik     CHAR(1)     NOT NULL DEFAULT 'C'
                                CHECK (guvenilirlik IN ('A','B','C','D','E','F')),
  baslangic        DATE,
  bitis            DATE,
  aciklama         TEXT,
  kanit_kayit_id   BIGINT,
  otomatik         BOOLEAN     NOT NULL DEFAULT FALSE,
  olusturan_id     BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  olusturuldu_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT iliski_kendine CHECK (kaynak_varlik_id <> hedef_varlik_id)
);

DROP TRIGGER IF EXISTS iliskiler_guncellendi ON varlik_iliskileri;
CREATE TRIGGER iliskiler_guncellendi BEFORE UPDATE ON varlik_iliskileri
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

CREATE INDEX IF NOT EXISTS idx_iliski_kaynak ON varlik_iliskileri (kaynak_varlik_id);
CREATE INDEX IF NOT EXISTS idx_iliski_hedef  ON varlik_iliskileri (hedef_varlik_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_iliski_tekil
  ON varlik_iliskileri (kaynak_varlik_id, hedef_varlik_id, tur, COALESCE(lower(etiket), ''));

-- ---------------------------------------------------------------------------
--  4. VAKALAR  (operasyon / dosya kapsami)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vakalar (
  id              BIGSERIAL   PRIMARY KEY,
  kod             TEXT        NOT NULL UNIQUE
                               DEFAULT 'VAK-' || lpad(nextval('seq_vaka_kodu')::text, 4, '0'),
  ad              TEXT        NOT NULL,
  kod_adi         TEXT,
  aciklama        TEXT,
  durum           TEXT        NOT NULL DEFAULT 'acik'
                               CHECK (durum IN ('acik','askida','kapali','arsiv')),
  oncelik         TEXT        NOT NULL DEFAULT 'orta'
                               CHECK (oncelik IN ('dusuk','orta','yuksek','kritik')),
  tasnif          TEXT        NOT NULL DEFAULT 'gizli'
                               CHECK (tasnif IN ('acik','hizmete_ozel','gizli','cok_gizli')),
  sorumlu         TEXT,
  hedef_tarih     DATE,
  etiketler       TEXT[]      NOT NULL DEFAULT '{}',
  arama           TSVECTOR,
  olusturan_id    BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  silindi         BOOLEAN     NOT NULL DEFAULT FALSE,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS vakalar_guncellendi ON vakalar;
CREATE TRIGGER vakalar_guncellendi BEFORE UPDATE ON vakalar
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

DROP TRIGGER IF EXISTS vakalar_arama ON vakalar;
CREATE TRIGGER vakalar_arama BEFORE INSERT OR UPDATE ON vakalar
  FOR EACH ROW EXECUTE FUNCTION trg_arama_vektoru('ad', 'kod_adi', 'aciklama', 'etiketler', 'kod');

CREATE INDEX IF NOT EXISTS idx_vaka_durum ON vakalar (durum) WHERE silindi = FALSE;
CREATE INDEX IF NOT EXISTS idx_vaka_arama ON vakalar USING GIN (arama);

-- ---------------------------------------------------------------------------
--  5. KAYITLAR  (istihbarat kayitlari: ihbar, gozlem, rapor, analiz ...)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kayitlar (
  id               BIGSERIAL   PRIMARY KEY,
  kod              TEXT        NOT NULL UNIQUE
                                DEFAULT 'KYT-' || lpad(nextval('seq_kayit_kodu')::text, 6, '0'),
  baslik           TEXT        NOT NULL,
  govde            TEXT        NOT NULL DEFAULT '',
  tur              TEXT        NOT NULL DEFAULT 'rapor'
                                CHECK (tur IN ('ihbar','gozlem','rapor','analiz','sinyal','acik_kaynak',
                                               'tutanak','gorusme','teknik','ozet')),
  kaynak_id        BIGINT      REFERENCES kaynaklar(id) ON DELETE SET NULL,
  vaka_id          BIGINT      REFERENCES vakalar(id)   ON DELETE SET NULL,
  tasnif           TEXT        NOT NULL DEFAULT 'hizmete_ozel'
                                CHECK (tasnif IN ('acik','hizmete_ozel','gizli','cok_gizli')),
  guvenilirlik     CHAR(1)     NOT NULL DEFAULT 'C'
                                CHECK (guvenilirlik IN ('A','B','C','D','E','F')),
  dogruluk         SMALLINT    NOT NULL DEFAULT 3 CHECK (dogruluk BETWEEN 1 AND 6),
  durum            TEXT        NOT NULL DEFAULT 'yeni'
                                CHECK (durum IN ('yeni','incelemede','dogrulandi','yalanlandi','arsiv')),
  olay_zamani      TIMESTAMPTZ,
  konum            TEXT,
  enlem            DOUBLE PRECISION,
  boylam           DOUBLE PRECISION,
  etiketler        TEXT[]      NOT NULL DEFAULT '{}',
  ozet             TEXT,
  anahtar_kelimeler TEXT[]     NOT NULL DEFAULT '{}',
  butunluk_hash    TEXT,
  surum            INTEGER     NOT NULL DEFAULT 1,
  arama            TSVECTOR,
  olusturan_id     BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  silindi          BOOLEAN     NOT NULL DEFAULT FALSE,
  silindi_at       TIMESTAMPTZ,
  olusturuldu_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS kayitlar_guncellendi ON kayitlar;
CREATE TRIGGER kayitlar_guncellendi BEFORE UPDATE ON kayitlar
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

DROP TRIGGER IF EXISTS kayitlar_arama ON kayitlar;
CREATE TRIGGER kayitlar_arama BEFORE INSERT OR UPDATE ON kayitlar
  FOR EACH ROW EXECUTE FUNCTION trg_arama_vektoru('baslik', 'govde', 'etiketler', 'anahtar_kelimeler', 'konum', 'kod');

CREATE INDEX IF NOT EXISTS idx_kayit_zaman  ON kayitlar (COALESCE(olay_zamani, olusturuldu_at) DESC) WHERE silindi = FALSE;
CREATE INDEX IF NOT EXISTS idx_kayit_tur    ON kayitlar (tur)    WHERE silindi = FALSE;
CREATE INDEX IF NOT EXISTS idx_kayit_durum  ON kayitlar (durum)  WHERE silindi = FALSE;
CREATE INDEX IF NOT EXISTS idx_kayit_vaka   ON kayitlar (vaka_id) WHERE silindi = FALSE;
CREATE INDEX IF NOT EXISTS idx_kayit_arama  ON kayitlar USING GIN (arama);
CREATE INDEX IF NOT EXISTS idx_kayit_etiket ON kayitlar USING GIN (etiketler);

-- varlik_iliskileri.kanit_kayit_id -> kayitlar.id (kayitlar sonradan olustu)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_iliski_kanit') THEN
    ALTER TABLE varlik_iliskileri
      ADD CONSTRAINT fk_iliski_kanit
      FOREIGN KEY (kanit_kayit_id) REFERENCES kayitlar(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
--  6. KAYIT SURUMLERI  (degisiklik gecmisi / adli iz)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kayit_surumleri (
  id              BIGSERIAL   PRIMARY KEY,
  kayit_id        BIGINT      NOT NULL REFERENCES kayitlar(id) ON DELETE CASCADE,
  surum           INTEGER     NOT NULL,
  baslik          TEXT,
  govde           TEXT,
  butunluk_hash   TEXT,
  yonetici_id     BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_kayit_surum UNIQUE (kayit_id, surum)
);

CREATE INDEX IF NOT EXISTS idx_kayit_surum ON kayit_surumleri (kayit_id, surum DESC);

-- ---------------------------------------------------------------------------
--  7. KAYIT <-> VARLIK  baglantilari
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kayit_varliklari (
  id              BIGSERIAL   PRIMARY KEY,
  kayit_id        BIGINT      NOT NULL REFERENCES kayitlar(id)  ON DELETE CASCADE,
  varlik_id       BIGINT      NOT NULL REFERENCES varliklar(id) ON DELETE CASCADE,
  rol             TEXT        NOT NULL DEFAULT 'ilgili'
                               CHECK (rol IN ('ozne','hedef','tanik','araci','konum','ilgili')),
  otomatik        BOOLEAN     NOT NULL DEFAULT FALSE,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_kayit_varlik UNIQUE (kayit_id, varlik_id, rol)
);

CREATE INDEX IF NOT EXISTS idx_kv_varlik ON kayit_varliklari (varlik_id);
CREATE INDEX IF NOT EXISTS idx_kv_kayit  ON kayit_varliklari (kayit_id);

-- ---------------------------------------------------------------------------
--  8. OLAYLAR  (zaman cizgisi)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS olaylar (
  id              BIGSERIAL   PRIMARY KEY,
  kod             TEXT        NOT NULL UNIQUE
                               DEFAULT 'OLY-' || lpad(nextval('seq_olay_kodu')::text, 6, '0'),
  baslik          TEXT        NOT NULL,
  aciklama        TEXT,
  tur             TEXT        NOT NULL DEFAULT 'olay'
                               CHECK (tur IN ('toplanti','seyahat','iletisim','islem','olay','tespit','operasyon','diger')),
  zaman           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  bitis_zamani    TIMESTAMPTZ,
  belirsizlik     TEXT        NOT NULL DEFAULT 'kesin'
                               CHECK (belirsizlik IN ('kesin','yaklasik','tahmini')),
  konum           TEXT,
  enlem           DOUBLE PRECISION,
  boylam          DOUBLE PRECISION,
  tasnif          TEXT        NOT NULL DEFAULT 'hizmete_ozel'
                               CHECK (tasnif IN ('acik','hizmete_ozel','gizli','cok_gizli')),
  guvenilirlik    CHAR(1)     NOT NULL DEFAULT 'C'
                               CHECK (guvenilirlik IN ('A','B','C','D','E','F')),
  dogruluk        SMALLINT    NOT NULL DEFAULT 3 CHECK (dogruluk BETWEEN 1 AND 6),
  onem            SMALLINT    NOT NULL DEFAULT 50 CHECK (onem BETWEEN 0 AND 100),
  vaka_id         BIGINT      REFERENCES vakalar(id)  ON DELETE SET NULL,
  kayit_id        BIGINT      REFERENCES kayitlar(id) ON DELETE SET NULL,
  etiketler       TEXT[]      NOT NULL DEFAULT '{}',
  arama           TSVECTOR,
  olusturan_id    BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  silindi         BOOLEAN     NOT NULL DEFAULT FALSE,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS olaylar_guncellendi ON olaylar;
CREATE TRIGGER olaylar_guncellendi BEFORE UPDATE ON olaylar
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

DROP TRIGGER IF EXISTS olaylar_arama ON olaylar;
CREATE TRIGGER olaylar_arama BEFORE INSERT OR UPDATE ON olaylar
  FOR EACH ROW EXECUTE FUNCTION trg_arama_vektoru('baslik', 'aciklama', 'konum', 'etiketler', 'kod');

CREATE INDEX IF NOT EXISTS idx_olay_zaman ON olaylar (zaman DESC) WHERE silindi = FALSE;
CREATE INDEX IF NOT EXISTS idx_olay_vaka  ON olaylar (vaka_id)    WHERE silindi = FALSE;
CREATE INDEX IF NOT EXISTS idx_olay_arama ON olaylar USING GIN (arama);

CREATE TABLE IF NOT EXISTS olay_varliklari (
  id              BIGSERIAL   PRIMARY KEY,
  olay_id         BIGINT      NOT NULL REFERENCES olaylar(id)   ON DELETE CASCADE,
  varlik_id       BIGINT      NOT NULL REFERENCES varliklar(id) ON DELETE CASCADE,
  rol             TEXT        NOT NULL DEFAULT 'katilimci'
                               CHECK (rol IN ('katilimci','hedef','tanik','araci','konum','ilgili')),
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_olay_varlik UNIQUE (olay_id, varlik_id, rol)
);

CREATE INDEX IF NOT EXISTS idx_ov_varlik ON olay_varliklari (varlik_id);

-- ---------------------------------------------------------------------------
--  9. VAKA OGELERI  (vakaya baglanan her tur arsiv ogesi)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vaka_ogeleri (
  id              BIGSERIAL   PRIMARY KEY,
  vaka_id         BIGINT      NOT NULL REFERENCES vakalar(id) ON DELETE CASCADE,
  oge_tur         TEXT        NOT NULL CHECK (oge_tur IN ('varlik','kayit','olay','dosya','belge','pano')),
  oge_id          BIGINT      NOT NULL,
  not_metni       TEXT,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_vaka_oge UNIQUE (vaka_id, oge_tur, oge_id)
);

CREATE INDEX IF NOT EXISTS idx_vaka_oge ON vaka_ogeleri (oge_tur, oge_id);

-- ---------------------------------------------------------------------------
-- 10. VARLIK EKLERI  (varlik <-> dosya/belge/pano)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS varlik_ekleri (
  id              BIGSERIAL   PRIMARY KEY,
  varlik_id       BIGINT      NOT NULL REFERENCES varliklar(id) ON DELETE CASCADE,
  oge_tur         TEXT        NOT NULL CHECK (oge_tur IN ('dosya','belge','pano')),
  oge_id          BIGINT      NOT NULL,
  not_metni       TEXT,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_varlik_ek UNIQUE (varlik_id, oge_tur, oge_id)
);

CREATE INDEX IF NOT EXISTS idx_varlik_ek ON varlik_ekleri (oge_tur, oge_id);

-- ---------------------------------------------------------------------------
-- 11. BELGE COZUMLEME  (yuklenen dosyanin makine okumasi)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS belge_cozumleme (
  id               BIGSERIAL   PRIMARY KEY,
  dosya_id         BIGINT      REFERENCES dosyalar(id) ON DELETE CASCADE,
  belge_id         BIGINT      REFERENCES belgeler(id) ON DELETE CASCADE,
  bicim            TEXT,
  sihirli_tur      TEXT,
  uyusmazlik       BOOLEAN     NOT NULL DEFAULT FALSE,
  sayfa_sayisi     INTEGER,
  kelime_sayisi    INTEGER     NOT NULL DEFAULT 0,
  karakter_sayisi  INTEGER     NOT NULL DEFAULT 0,
  dil              TEXT,
  metin            TEXT        NOT NULL DEFAULT '',
  ozet             TEXT,
  anahtar_kelimeler TEXT[]     NOT NULL DEFAULT '{}',
  bulgular         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ustveri          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  risk_isaretleri  TEXT[]      NOT NULL DEFAULT '{}',
  entropi          NUMERIC(5,3),
  durum            TEXT        NOT NULL DEFAULT 'bekliyor'
                                CHECK (durum IN ('bekliyor','tamam','kismi','desteklenmiyor','hata')),
  hata             TEXT,
  sure_ms          INTEGER,
  arama            TSVECTOR,
  olusturuldu_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cozumleme_hedef CHECK (dosya_id IS NOT NULL OR belge_id IS NOT NULL)
);

DROP TRIGGER IF EXISTS cozumleme_guncellendi ON belge_cozumleme;
CREATE TRIGGER cozumleme_guncellendi BEFORE UPDATE ON belge_cozumleme
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

DROP TRIGGER IF EXISTS cozumleme_arama ON belge_cozumleme;
CREATE TRIGGER cozumleme_arama BEFORE INSERT OR UPDATE ON belge_cozumleme
  FOR EACH ROW EXECUTE FUNCTION trg_arama_vektoru('metin', 'ozet', 'anahtar_kelimeler');

CREATE UNIQUE INDEX IF NOT EXISTS uq_cozumleme_dosya ON belge_cozumleme (dosya_id) WHERE dosya_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cozumleme_belge ON belge_cozumleme (belge_id) WHERE belge_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cozumleme_arama ON belge_cozumleme USING GIN (arama);
CREATE INDEX IF NOT EXISTS idx_cozumleme_durum ON belge_cozumleme (durum);

-- ---------------------------------------------------------------------------
-- 12. YEREL ZEKA DIZINI  (API'siz motorun BM25 ters dizini)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zeka_belgeleri (
  id              BIGSERIAL   PRIMARY KEY,
  kaynak_tur      TEXT        NOT NULL CHECK (kaynak_tur IN ('kayit','belge','dosya','varlik','olay','hafiza','vaka')),
  kaynak_id       BIGINT      NOT NULL,
  baslik          TEXT        NOT NULL DEFAULT '',
  parca_no        SMALLINT    NOT NULL DEFAULT 0,
  metin           TEXT        NOT NULL DEFAULT '',
  uzunluk         INTEGER     NOT NULL DEFAULT 0,
  tasnif          TEXT        NOT NULL DEFAULT 'hizmete_ozel',
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_zeka_belge UNIQUE (kaynak_tur, kaynak_id, parca_no)
);

CREATE INDEX IF NOT EXISTS idx_zeka_belge_kaynak ON zeka_belgeleri (kaynak_tur, kaynak_id);

CREATE TABLE IF NOT EXISTS zeka_terimleri (
  belge_id        BIGINT      NOT NULL REFERENCES zeka_belgeleri(id) ON DELETE CASCADE,
  terim           TEXT        NOT NULL,
  sayi            INTEGER     NOT NULL DEFAULT 1,
  PRIMARY KEY (belge_id, terim)
);

CREATE INDEX IF NOT EXISTS idx_zeka_terim ON zeka_terimleri (terim);

-- Ogrenilen modeller (Naive Bayes agirliklari, IDF onbellegi, kume merkezleri)
CREATE TABLE IF NOT EXISTS zeka_modelleri (
  ad              TEXT        PRIMARY KEY,
  tur             TEXT        NOT NULL DEFAULT 'bayes',
  veri            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ornek_sayisi    INTEGER     NOT NULL DEFAULT 0,
  basari          NUMERIC(5,2),
  guncellendi_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Motorun sorgu gecmisi: ogrenme ve "sik sorulan" analizi icin
CREATE TABLE IF NOT EXISTS zeka_sorgulari (
  id              BIGSERIAL   PRIMARY KEY,
  soru            TEXT        NOT NULL,
  niyet           TEXT,
  bulgu_sayisi    INTEGER     NOT NULL DEFAULT 0,
  sure_ms         INTEGER,
  yararli         BOOLEAN,
  yonetici_id     BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zeka_sorgu_zaman ON zeka_sorgulari (olusturuldu_at DESC);

-- ---------------------------------------------------------------------------
-- 13. IZLEME KURALLARI + UYARILAR  (watchlist / otomatik tetikleme)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS izleme_kurallari (
  id              BIGSERIAL   PRIMARY KEY,
  ad              TEXT        NOT NULL,
  tur             TEXT        NOT NULL DEFAULT 'anahtar'
                               CHECK (tur IN ('anahtar','varlik','desen')),
  desen           TEXT        NOT NULL DEFAULT '',
  varlik_id       BIGINT      REFERENCES varliklar(id) ON DELETE CASCADE,
  kapsam          TEXT[]      NOT NULL DEFAULT '{kayit,belge,olay}',
  seviye          TEXT        NOT NULL DEFAULT 'uyari'
                               CHECK (seviye IN ('bilgi','uyari','kritik')),
  aktif           BOOLEAN     NOT NULL DEFAULT TRUE,
  tetik_sayisi    INTEGER     NOT NULL DEFAULT 0,
  son_tetik_at    TIMESTAMPTZ,
  olusturan_id    BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  guncellendi_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS izleme_guncellendi ON izleme_kurallari;
CREATE TRIGGER izleme_guncellendi BEFORE UPDATE ON izleme_kurallari
  FOR EACH ROW EXECUTE FUNCTION trg_guncellendi();

CREATE TABLE IF NOT EXISTS uyarilar (
  id              BIGSERIAL   PRIMARY KEY,
  kural_id        BIGINT      REFERENCES izleme_kurallari(id) ON DELETE CASCADE,
  seviye          TEXT        NOT NULL DEFAULT 'uyari'
                               CHECK (seviye IN ('bilgi','uyari','kritik')),
  baslik          TEXT        NOT NULL,
  mesaj           TEXT,
  oge_tur         TEXT,
  oge_id          BIGINT,
  okundu          BOOLEAN     NOT NULL DEFAULT FALSE,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uyari_okundu ON uyarilar (okundu, olusturuldu_at DESC);

-- ---------------------------------------------------------------------------
-- 14. DENETIM IZI  (chain of custody: arsiv ogelerine kim ne yapti)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS denetim_izi (
  id              BIGSERIAL   PRIMARY KEY,
  oge_tur         TEXT        NOT NULL,
  oge_id          BIGINT,
  eylem           TEXT        NOT NULL
                               CHECK (eylem IN ('olusturma','guncelleme','silme','goruntuleme','indirme',
                                                'disa_aktarma','tasnif_degisimi','baglanti','cozumleme')),
  yonetici_id     BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  onceki          JSONB,
  sonraki         JSONB,
  aciklama        TEXT,
  ip              INET,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_denetim_oge   ON denetim_izi (oge_tur, oge_id, olusturuldu_at DESC);
CREATE INDEX IF NOT EXISTS idx_denetim_zaman ON denetim_izi (olusturuldu_at DESC);

-- ---------------------------------------------------------------------------
-- 15. KAYITLI SORGULAR  (operatorun kendi kaydettigi arama kaliplari)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS arsiv_sorgulari (
  id              BIGSERIAL   PRIMARY KEY,
  ad              TEXT        NOT NULL,
  sorgu           TEXT        NOT NULL DEFAULT '',
  filtreler       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  olusturan_id    BIGINT      REFERENCES yoneticiler(id) ON DELETE SET NULL,
  olusturuldu_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 16. VARSAYILAN ARSIV / ZEKA AYARLARI
-- ---------------------------------------------------------------------------
INSERT INTO ayarlar (anahtar, deger, tur, aciklama) VALUES
  ('arsiv_tasnif_bandi',   'true',  'mantik', 'Ust tasnif bandini goster'),
  ('arsiv_varsayilan_tasnif','hizmete_ozel','metin','Yeni kayitlarin varsayilan tasnifi'),
  ('zeka_otomatik_cozumleme','true','mantik', 'Yuklenen dosyalar otomatik cozumlensin'),
  ('zeka_otomatik_varlik', 'true',  'mantik', 'Cozumlemede bulunan varliklar otomatik onerilsin'),
  ('zeka_dizin_parca_kelime','220', 'sayi',   'Dizin parcasi basina kelime sayisi'),
  ('zeka_motor',           'dahili','metin',  'Cambaz cekirdegi: dahili | saglayici | karma'),
  ('risk_esigi',           '70',    'sayi',   'Varlik onem puani uyari esigi'),
  ('arayuz_temasi',        'zumrut','metin',  'Arayuz tema varyanti: zumrut | kehribar | camgobegi | mor')
ON CONFLICT (anahtar) DO NOTHING;
