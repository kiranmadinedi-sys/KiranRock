#!/usr/bin/env node

/**
 * Fix Database Schema
 * Adds missing columns and tables required for the trading system
 */

const { query } = require('./src/config/database');

async function fixDatabaseSchema() {
    console.log('\n=== Fixing Database Schema ===\n');

    try {
        // 1. Add missing columns to daily_universe_analysis
        console.log('Adding missing columns to daily_universe_analysis...');

        await query(`
            ALTER TABLE daily_universe_analysis
            ADD COLUMN IF NOT EXISTS regime VARCHAR(20),
            ADD COLUMN IF NOT EXISTS tier INTEGER DEFAULT 3
        `);
        console.log('✓ Added regime and tier columns to daily_universe_analysis');

        // 2. Add outcome column to trade_decision_journal
        console.log('Adding outcome column to trade_decision_journal...');

        await query(`
            ALTER TABLE trade_decision_journal
            ADD COLUMN IF NOT EXISTS outcome VARCHAR(10)
        `);
        console.log('✓ Added outcome column to trade_decision_journal');

        // 3. Create missing bot_config table
        console.log('Creating bot_config table...');

        await query(`
            CREATE TABLE IF NOT EXISTS bot_config (
                id SERIAL PRIMARY KEY,
                key VARCHAR(100) UNIQUE NOT NULL,
                value TEXT NOT NULL,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✓ Created bot_config table');

        // 4. Insert default bot configuration
        console.log('Inserting default bot configuration...');

        await query(`
            INSERT INTO bot_config (key, value, description) VALUES
            ('minBuyScore', '75', 'Minimum AI score required for buy signals'),
            ('maxPositions', '8', 'Maximum number of open positions'),
            ('positionSizePct', '0.125', 'Position size as percentage of portfolio (12.5%)'),
            ('edgeGateMinScore', '80', 'Minimum score for edge gate activation'),
            ('AI_TRADING_ENABLED', 'true', 'Global AI trading enabled flag')
            ON CONFLICT (key) DO NOTHING
        `);
        console.log('✓ Inserted default bot configuration');

        // 5. Create options_positions table
        console.log('Creating options_positions table...');

        await query(`
            CREATE TABLE IF NOT EXISTS options_positions (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
                symbol VARCHAR(20) NOT NULL,
                option_type VARCHAR(4) NOT NULL CHECK (option_type IN ('CALL', 'PUT')),
                strike_price DECIMAL(10, 2) NOT NULL,
                expiration_date DATE NOT NULL,
                contracts INTEGER NOT NULL,
                entry_price DECIMAL(10, 4) NOT NULL,
                current_price DECIMAL(10, 4),
                status VARCHAR(20) DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
                pnl DECIMAL(12, 2),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                closed_at TIMESTAMP
            )
        `);
        console.log('✓ Created options_positions table');

        // 6. Create options_signals table
        console.log('Creating options_signals table...');

        await query(`
            CREATE TABLE IF NOT EXISTS options_signals (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
                symbol VARCHAR(20) NOT NULL,
                signal_type VARCHAR(10) NOT NULL CHECK (signal_type IN ('BUY', 'SELL')),
                option_type VARCHAR(4) NOT NULL CHECK (option_type IN ('CALL', 'PUT')),
                strike_price DECIMAL(10, 2),
                expiration_date DATE,
                confidence DECIMAL(5, 2),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✓ Created options_signals table');

        // 7. Create ai_trading_configs table
        console.log('Creating ai_trading_configs table...');

        await query(`
            CREATE TABLE IF NOT EXISTS ai_trading_configs (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                enabled BOOLEAN DEFAULT true,
                max_positions INTEGER DEFAULT 8,
                position_size_pct DECIMAL(5, 4) DEFAULT 0.125,
                min_score INTEGER DEFAULT 75,
                risk_level VARCHAR(20) DEFAULT 'MEDIUM',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✓ Created ai_trading_configs table');

        // 8. Create global_trading_control table
        console.log('Creating global_trading_control table...');

        await query(`
            CREATE TABLE IF NOT EXISTS global_trading_control (
                id SERIAL PRIMARY KEY,
                trading_enabled BOOLEAN DEFAULT true,
                emergency_stop BOOLEAN DEFAULT false,
                max_daily_trades INTEGER DEFAULT 100,
                market_hours_only BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✓ Created global_trading_control table');

        // 9. Insert default global trading control record
        await query(`
            INSERT INTO global_trading_control (trading_enabled, emergency_stop, max_daily_trades, market_hours_only)
            SELECT true, false, 100, true
            WHERE NOT EXISTS (SELECT 1 FROM global_trading_control)
        `);
        console.log('✓ Inserted default global trading control');

        // 10. Add portfolio_value column to trading_accounts if missing
        console.log('Adding portfolio_value column to trading_accounts...');

        await query(`
            ALTER TABLE trading_accounts
            ADD COLUMN IF NOT EXISTS portfolio_value DECIMAL(15, 2) DEFAULT 0
        `);
        console.log('✓ Added portfolio_value column to trading_accounts');

        // 11. Create default AI trading config for existing user
        console.log('Creating default AI trading config for user kmadined...');

        await query(`
            INSERT INTO ai_trading_configs (user_id, enabled, max_positions, position_size_pct, min_score)
            SELECT id, true, 8, 0.125, 75
            FROM users
            WHERE username = 'kmadined'
            ON CONFLICT (user_id) DO NOTHING
        `);
        console.log('✓ Created AI trading config for kmadined');

        console.log('\n=== Database Schema Fix Complete ===\n');

    } catch (error) {
        console.error('❌ Database schema fix failed:', error.message);
        throw error;
    }
}

if (require.main === module) {
    fixDatabaseSchema()
        .then(() => {
            console.log('✅ Database schema fixed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Failed to fix database schema:', error);
            process.exit(1);
        });
}

module.exports = { fixDatabaseSchema };