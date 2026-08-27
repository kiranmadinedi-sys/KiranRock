const { query } = require('../config/database');
const { logger } = require('../utils/logger');

/**
 * Creates 'hermes_symbol_log' — a per-symbol, per-night record of exactly what
 * market cap / avg volume HERMES read for every candidate in the universe build,
 * and whether it passed.
 *
 * Why this exists: daily_universe_analysis only ever gets a row for symbols that
 * CLEAR the HERMES prescreen — a symbol excluded by cap/volume leaves zero trace
 * anywhere. Found 2026-08-27 answering "why didn't the app catch [a screenshot of
 * real gainers]?" — could confirm those symbols WERE in the raw candidate pool
 * (asset_universe_daily) and got excluded before AI analysis, but couldn't say
 * *why* with certainty because the actual cap/volume values HERMES read that
 * night were never persisted anywhere, only the aggregate exclusion counts
 * (added earlier the same night). Re-querying live hours later hit the same
 * Yahoo rate-limiting the app itself fights, and even when it succeeds, that's
 * the CURRENT read, not what HERMES actually saw at scan time.
 *
 * This table makes that question answerable definitively and instantly, any time
 * in the future, by just looking up (symbol, universe_date) instead of guessing
 * or fighting a live rate limit after the fact.
 */
async function up() {
    logger.info('Applying migration: create_hermes_symbol_log_table...');

    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS hermes_symbol_log (
            id SERIAL PRIMARY KEY,
            universe_date DATE NOT NULL,
            symbol VARCHAR(10) NOT NULL,
            market_cap NUMERIC,
            avg_volume BIGINT,
            cap_floor NUMERIC,
            volume_floor BIGINT,
            passed BOOLEAN NOT NULL,
            fail_reason VARCHAR(20),
            is_velocity BOOLEAN DEFAULT FALSE,
            tier INTEGER,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(universe_date, symbol)
        );
    `;

    const createIndexes = [
        `CREATE INDEX IF NOT EXISTS idx_hermes_symbol_log_symbol ON hermes_symbol_log (symbol);`,
        `CREATE INDEX IF NOT EXISTS idx_hermes_symbol_log_date   ON hermes_symbol_log (universe_date);`
    ];

    try {
        await query(createTableQuery);
        logger.info('Table "hermes_symbol_log" created or already exists.');

        for (const idx of createIndexes) {
            await query(idx);
        }
        logger.info('Indexes on "hermes_symbol_log" created or already exist.');

        logger.info('Migration create_hermes_symbol_log_table completed successfully.');
        return true;
    } catch (error) {
        logger.error('Error applying migration create_hermes_symbol_log_table', { error: error.message });
        throw error;
    }
}

async function down() {
    logger.info('Reverting migration: create_hermes_symbol_log_table...');
    try {
        await query('DROP TABLE IF EXISTS hermes_symbol_log;');
        logger.info('Table "hermes_symbol_log" dropped.');
        return true;
    } catch (error) {
        logger.error('Error reverting migration create_hermes_symbol_log_table', { error: error.message });
        throw error;
    }
}

module.exports = {
    up,
    down,
    name: 'create_hermes_symbol_log_table'
};
