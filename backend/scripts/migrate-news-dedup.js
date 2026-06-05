/**
 * One-time migration: deduplicate news_alerts and add unique index.
 * Safe to run multiple times (idempotent).
 *
 *   node scripts/migrate-news-dedup.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { query, pool } = require('../src/config/database');

(async () => {
    try {
        // 1. Remove duplicate rows — keep the newest per (symbol, normalised title)
        const del = await query(`
            DELETE FROM news_alerts
            WHERE id NOT IN (
                SELECT MAX(id)
                FROM news_alerts
                GROUP BY symbol, LOWER(REGEXP_REPLACE(TRIM(title), '\\s+', ' ', 'g'))
            )
        `);
        console.log(`[dedup] Removed ${del.rowCount} duplicate news_alerts rows`);

        // 2. Create unique index (idempotent — IF NOT EXISTS)
        await query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_news_alerts_symbol_title_dedup
            ON news_alerts(symbol, LOWER(REGEXP_REPLACE(TRIM(title), '\\s+', ' ', 'g')))
        `);
        console.log('[dedup] Unique index on news_alerts(symbol, normalised_title) OK');

        console.log('[dedup] Migration complete — duplicate Telegram messages should stop now');
    } catch (err) {
        console.error('[dedup] Migration failed:', err.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
})();
