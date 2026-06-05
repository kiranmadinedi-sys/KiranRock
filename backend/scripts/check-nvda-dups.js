require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { query, pool } = require('../src/config/database');
(async () => {
  // 1. How many rows for this exact article?
  const dups = await query(`
    SELECT id, symbol, title, created_at
    FROM news_alerts
    WHERE symbol = 'NVDA'
      AND title ILIKE '%historically performed after earnings%'
    ORDER BY created_at DESC
  `);
  console.log('NVDA rows for this article:', dups.rows.length);
  dups.rows.forEach(r => console.log(`  id=${r.id} created=${r.created_at}`));

  // 2. Delivery records in Telegram events table
  const deliveries = await query(`
    SELECT item_key, symbol, title, delivered_at,
           payload->>'contentFingerprint' AS fp
    FROM stock_signal_telegram_events
    WHERE symbol = 'NVDA' AND item_type = 'news'
    ORDER BY delivered_at DESC LIMIT 10
  `);
  console.log('\nRecent NVDA Telegram delivery records:', deliveries.rows.length);
  deliveries.rows.forEach(r =>
    console.log(`  key=${r.item_key} delivered=${r.delivered_at} fp=${r.fp}`)
  );

  // 3. Unique index present?
  const idx = await query(`
    SELECT indexname FROM pg_indexes
    WHERE tablename='news_alerts'
      AND indexname='idx_news_alerts_symbol_title_dedup'
  `);
  console.log('\nUnique dedup index active:', idx.rows.length > 0 ? 'YES' : 'NO - MISSING!');

  // 4. Any NVDA news_alerts created AFTER restart (after ~09:00 UTC = 04:59 ET)
  const fresh = await query(`
    SELECT id, title, created_at FROM news_alerts
    WHERE symbol='NVDA'
      AND created_at > NOW() - INTERVAL '2 hours'
    ORDER BY created_at DESC
  `);
  console.log('\nNVDA news rows inserted in last 2 hours:', fresh.rows.length);
  fresh.rows.forEach(r => console.log(`  id=${r.id} created=${r.created_at} title=${r.title.slice(0,60)}`));

  await pool.end();
})();
