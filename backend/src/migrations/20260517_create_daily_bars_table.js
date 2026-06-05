const { query } = require('../config/database');
const { logger } = require('../utils/logger');

/**
 * This migration creates the 'daily_bars' table to store historical
 * OHLCV data for stocks. This serves as the foundation for our
 * local data warehouse, enabling faster analysis and reducing
 * reliance on external APIs.
 */
async function up() {
    logger.info('Applying migration: create_daily_bars_table...');
    
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS daily_bars (
            id SERIAL PRIMARY KEY,
            symbol VARCHAR(16) NOT NULL,
            timestamp TIMESTAMPTZ NOT NULL,
            open NUMERIC(12, 4) NOT NULL,
            high NUMERIC(12, 4) NOT NULL,
            low NUMERIC(12, 4) NOT NULL,
            close NUMERIC(12, 4) NOT NULL,
            volume BIGINT NOT NULL,
            vwap NUMERIC(12, 4),
            trade_count INTEGER,
            UNIQUE(symbol, timestamp)
        );
    `;

    const createIndexQuery = `
        CREATE INDEX IF NOT EXISTS idx_daily_bars_symbol_timestamp ON daily_bars (symbol, timestamp DESC);
    `;

    try {
        await query(createTableQuery);
        logger.info('Table "daily_bars" created or already exists.');
        
        await query(createIndexQuery);
        logger.info('Index "idx_daily_bars_symbol_timestamp" created or already exists.');
        
        logger.info('Migration create_daily_bars_table completed successfully.');
        return true;
    } catch (error) {
        logger.error('Error applying migration create_daily_bars_table', { error: error.message });
        throw error;
    }
}

/**
 * Reverts the migration by dropping the 'daily_bars' table.
 */
async function down() {
    logger.info('Reverting migration: create_daily_bars_table...');
    try {
        await query('DROP TABLE IF EXISTS daily_bars;');
        logger.info('Table "daily_bars" dropped.');
        logger.info('Migration create_daily_bars_table reverted successfully.');
        return true;
    } catch (error) {
        logger.error('Error reverting migration create_daily_bars_table', { error: error.message });
        throw error;
    }
}

module.exports = {
    up,
    down,
    name: 'create_daily_bars_table'
};
