'use strict';
/**
 * src/db/seed.js
 * Gelistirme icin ornek veri: kok klasorler, bir pano, bir log kaydi.
 * Uretimde cagrilmasi gerekmez.
 */

const db = require('../config/db');

async function calistir() {
  const yonetici = await db.tekSatir('SELECT id FROM yoneticiler ORDER BY id LIMIT 1');
  const sahipId = yonetici ? yonetici.id : null;

  const kokKlasorler = [
    ['ISTIHBARAT', 'Ham veri ve saha raporlari', '#00ff9c'],
    ['OPERASYON', 'Aktif operasyon dosyalari', '#22d3ee'],
    ['ARSIV', 'Kapatilmis kayitlar', '#64748b'],
  ];

  for (const [ad, aciklama, renk] of kokKlasorler) {
    await db.sorgu(
      `INSERT INTO klasorler (ad, yol, aciklama, renk, olusturan_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [ad, '/' + ad, aciklama, renk, sahipId],
    );
  }

  const pano = await db.tekSatir(
    `INSERT INTO panolar (ad, aciklama, olusturan_id)
     VALUES ('ANA STRATEJI', 'Varsayilan strateji panosu', $1)
     RETURNING id`,
    [sahipId],
  );

  if (pano) {
    await db.sorgu(
      `INSERT INTO pano_ogeleri (pano_id, tur, veri, x, y, genislik, yukseklik)
       VALUES ($1, 'not', $2, 120, 120, 240, 140)`,
      [pano.id, JSON.stringify({ metin: 'Baslangic notu: hedefleri tanimla.' })],
    );
  }

  await db.sorgu(
    `INSERT INTO loglar (seviye, kategori, olay, mesaj)
     VALUES ('bilgi', 'sistem', 'tohum_veri', 'Ornek veriler yuklendi.')`,
  );

  console.log('[TOHUM] Ornek veriler yuklendi.');
  await db.kapat();
}

calistir().catch(async (hata) => {
  console.error('[TOHUM] Hata:', hata.message);
  try { await db.kapat(); } catch { /* yoksay */ }
  process.exit(1);
});
