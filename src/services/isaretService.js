'use strict';
/**
 * src/services/isaretService.js
 * Harita (Muktebes / Kure) operator isaretleri.
 * Operator, kure uzerinde bir noktayi isaretler; baslik, not, tasnif ve renk
 * ile birlikte kalici olarak saklanir. Tablo ilk kullanimda idempotent olarak
 * olusturulur, boylece ayri bir migrasyon adimi gerektirmez.
 */

const db = require('../config/db');

const TASNIFLER = new Set(['acik', 'hizmete_ozel', 'gizli', 'cok_gizli']);

let tabloHazir = false;

async function tabloHazirla() {
  if (tabloHazir) return;
  await db.sorgu(`
    CREATE TABLE IF NOT EXISTS harita_isaretleri (
      id             BIGSERIAL    PRIMARY KEY,
      baslik         TEXT        NOT NULL,
      notlar         TEXT,
      tasnif         TEXT        NOT NULL DEFAULT 'hizmete_ozel',
      enlem          DOUBLE PRECISION NOT NULL,
      boylam         DOUBLE PRECISION NOT NULL,
      renk           TEXT,
      varlik_id      BIGINT,
      olusturan_id   BIGINT,
      olusturuldu_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      guncellendi_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  tabloHazir = true;
}

function disariCevir(s) {
  return {
    id: s.id,
    baslik: s.baslik,
    not: s.notlar || '',
    tasnif: s.tasnif,
    enlem: Number(s.enlem),
    boylam: Number(s.boylam),
    renk: s.renk || null,
    varlik_id: s.varlik_id || null,
    olusturuldu_at: s.olusturuldu_at,
  };
}

/** Tum isaretleri listeler. Tablo yoksa bos dizi doner (sayfa calismaya devam eder). */
async function listele() {
  try {
    await tabloHazirla();
    const satirlar = await db.satirlar(
      'SELECT * FROM harita_isaretleri ORDER BY olusturuldu_at DESC LIMIT 2000',
    );
    return satirlar.map(disariCevir);
  } catch (hata) {
    console.error('[ISARET] listele basarisiz:', hata.message);
    return [];
  }
}

/** Yeni isaret olusturur. */
async function olustur({ baslik, not, tasnif, enlem, boylam, renk, varlikId, yoneticiId }) {
  await tabloHazirla();

  const temizBaslik = String(baslik || '').trim().slice(0, 120);
  if (!temizBaslik) return { tamam: false, hata: 'Isaret adi gerekli.' };

  const en = Number(enlem);
  const bo = Number(boylam);
  if (!Number.isFinite(en) || en < -90 || en > 90) return { tamam: false, hata: 'Gecersiz enlem.' };
  if (!Number.isFinite(bo) || bo < -180 || bo > 180) return { tamam: false, hata: 'Gecersiz boylam.' };

  const temizTasnif = TASNIFLER.has(tasnif) ? tasnif : 'hizmete_ozel';
  const temizNot = String(not || '').slice(0, 4000);
  const temizRenk = /^#[0-9a-fA-F]{3,8}$/.test(String(renk || '')) ? renk : null;
  const vid = Number.isInteger(Number(varlikId)) && Number(varlikId) > 0 ? Number(varlikId) : null;

  const satir = await db.tekSatir(
    `INSERT INTO harita_isaretleri (baslik, notlar, tasnif, enlem, boylam, renk, varlik_id, olusturan_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [temizBaslik, temizNot, temizTasnif, en, bo, temizRenk, vid, yoneticiId || null],
  );
  return { tamam: true, isaret: disariCevir(satir) };
}

/** Isareti siler. */
async function sil(id) {
  await tabloHazirla();
  const kimlik = Number(id);
  if (!Number.isInteger(kimlik) || kimlik <= 0) return false;
  const sonuc = await db.sorgu('DELETE FROM harita_isaretleri WHERE id = $1', [kimlik]);
  return sonuc.rowCount > 0;
}

module.exports = { listele, olustur, sil };
