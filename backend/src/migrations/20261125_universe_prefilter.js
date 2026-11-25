const { query } = require('../config/database');
const { logger } = require('../utils/logger');

/**
 * Universe build: Polygon first, Yahoo as backup (docs/UNIVERSE_BUILD_POLYGON_PREFILTER.md).
 *  - market_daily_volume: whole-market daily close/volume from the EOD job's Polygon call.
 *  - universe_prefilter_shadow: per-build shadow comparisons.
 *  - hermes_symbol_log: nullable quote fields so the Blitz build can reuse passed rows.
 * All additive (new table / nullable columns); existing readers are unaffected.
 */
async function up() {
    logger.info('Applying migration: universe_prefilter...');
    const stmts = [
        `CREATE TABLE IF NOT EXISTS market_daily_volume (
            symbol     VARCHAR(12) NOT NULL,
            trade_date DATE        NOT NULL,
            close      NUMERIC,
            volume     BIGINT,
            PRIMARY KEY (symbol, trade_date))`,
        `CREATE INDEX IF NOT EXISTS idx_market_daily_volume_date ON market_daily_volume (trade_date)`,
        `CREATE TABLE IF NOT EXISTS universe_prefilter_shadow (
            id         SERIAL PRIMARY KEY,
            run_date   DATE NOT NULL,
            kind       VARCHAR(20) NOT NULL,
            summary    JSONB,
            created_at TIMESTAMPTZ DEFAULT NOW())`,
        `ALTER TABLE hermes_symbol_log
            ADD COLUMN IF NOT EXISTS price       NUMERIC,
            ADD COLUMN IF NOT EXISTS rs_score    NUMERIC,
            ADD COLUMN IF NOT EXISTS week52_high NUMERIC,
            ADD COLUMN IF NOT EXISTS week52_low  NUMERIC,
            ADD COLUMN IF NOT EXISTS sma50       NUMERIC,
            ADD COLUMN IF NOT EXISTS sma200      NUMERIC,
            ADD COLUMN IF NOT EXISTS sector      VARCHAR(60),
            ADD COLUMN IF NOT EXISTS industry    VARCHAR(80)`,
    ];
    for (const s of stmts) await query(s);
    logger.info('Migration universe_prefilter completed.');
    return true;
}

async function down() {
    await query('DROP TABLE IF EXISTS universe_prefilter_shadow');
    await query('DROP TABLE IF EXISTS market_daily_volume');
    await query(`ALTER TABLE hermes_symbol_log
        DROP COLUMN IF EXISTS price, DROP COLUMN IF EXISTS rs_score, DROP COLUMN IF EXISTS week52_high,
        DROP COLUMN IF EXISTS week52_low, DROP COLUMN IF EXISTS sma50, DROP COLUMN IF EXISTS sma200,
        DROP COLUMN IF EXISTS sector, DROP COLUMN IF EXISTS industry`);
}

module.exports = { name: 'universe_prefilter', up, down };
