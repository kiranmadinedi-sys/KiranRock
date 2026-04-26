const { query } = require('../config/database');

/**
 * Initialize PostgreSQL database schema
 * Creates all necessary tables for the trading application
 */

async function initializeDatabase() {
    console.log('\n=== Initializing PostgreSQL Database ===\n');

    try {
        // 1. Create Users table
        await query(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(50) PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                email VARCHAR(255),
                full_name VARCHAR(255),
                phone VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP,
                is_active BOOLEAN DEFAULT true,
                ai_trading_enabled BOOLEAN DEFAULT false,
                telegram_chat_id VARCHAR(100)
            )
        `);
        console.log('✓ Created users table');

        // 2. Create Trading Accounts table
        await query(`
            CREATE TABLE IF NOT EXISTS trading_accounts (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
                balance DECIMAL(15, 2) DEFAULT 0,
                initial_balance DECIMAL(15, 2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id)
            )
        `);
        console.log('✓ Created trading_accounts table');

        // 3. Create Holdings table
        await query(`
            CREATE TABLE IF NOT EXISTS holdings (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
                symbol VARCHAR(10) NOT NULL,
                quantity INTEGER NOT NULL CHECK (quantity >= 0),
                average_price DECIMAL(10, 2) NOT NULL,
                current_price DECIMAL(10, 2),
                market_value DECIMAL(15, 2),
                gain_loss DECIMAL(15, 2),
                gain_loss_percent DECIMAL(8, 4),
                peak_price DECIMAL(10, 2),
                partial_profit_taken BOOLEAN DEFAULT false,
                sector VARCHAR(100),
                purchase_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, symbol)
            )
        `);
        console.log('✓ Created holdings table');

        // Create index for faster queries
        await query(`
            CREATE INDEX IF NOT EXISTS idx_holdings_user_id ON holdings(user_id)
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_holdings_symbol ON holdings(symbol)
        `);

        // 4. Create Trades table (audit trail)
        await query(`
            CREATE TABLE IF NOT EXISTS trades (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
                symbol VARCHAR(10) NOT NULL,
                action VARCHAR(10) NOT NULL CHECK (action IN ('BUY', 'SELL')),
                quantity INTEGER NOT NULL,
                price DECIMAL(10, 2) NOT NULL,
                total DECIMAL(15, 2) NOT NULL,
                commission DECIMAL(10, 2) DEFAULT 0,
                trade_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                executed_by VARCHAR(50) DEFAULT 'MANUAL',
                notes TEXT,
                ai_score INTEGER,
                sector VARCHAR(100)
            )
        `);
        console.log('✓ Created trades table');

        // Create indexes
        await query(`
            CREATE INDEX IF NOT EXISTS idx_trades_user_id ON trades(user_id)
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol)
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(trade_date)
        `);

        // 5. Create AI Trading Logs table
        await query(`
            CREATE TABLE IF NOT EXISTS ai_trading_logs (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                success BOOLEAN NOT NULL,
                trades_executed INTEGER DEFAULT 0,
                capital_deployed DECIMAL(15, 2) DEFAULT 0,
                opportunities_found INTEGER DEFAULT 0,
                message TEXT,
                trades_detail JSONB
            )
        `);
        console.log('✓ Created ai_trading_logs table');

        await query(`
            CREATE INDEX IF NOT EXISTS idx_ai_logs_user_id ON ai_trading_logs(user_id)
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_ai_logs_timestamp ON ai_trading_logs(timestamp)
        `);

        // 6. Create Risk Configuration table
        await query(`
            CREATE TABLE IF NOT EXISTS risk_configs (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
                max_position_size DECIMAL(4, 3) DEFAULT 0.15,
                min_position_size DECIMAL(4, 3) DEFAULT 0.02,
                max_portfolio_risk DECIMAL(4, 3) DEFAULT 0.60,
                min_buy_score INTEGER DEFAULT 65,
                stop_loss DECIMAL(5, 4) DEFAULT -0.12,
                trailing_stop_percent DECIMAL(4, 3) DEFAULT 0.08,
                take_profit_percent DECIMAL(4, 3) DEFAULT 0.25,
                partial_take_profit_percent DECIMAL(4, 3) DEFAULT 0.15,
                max_open_positions INTEGER DEFAULT 25,
                min_market_cap BIGINT DEFAULT 5000000000,
                max_daily_trades INTEGER DEFAULT 10,
                max_vix DECIMAL(5, 2) DEFAULT 30,
                reduce_positions_vix DECIMAL(5, 2) DEFAULT 25,
                max_sector_allocation DECIMAL(4, 3) DEFAULT 0.35,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id)
            )
        `);
        console.log('✓ Created risk_configs table');

        // 7. Create Sessions table
        await query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
                token VARCHAR(255) UNIQUE NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                ip_address VARCHAR(45),
                user_agent TEXT
            )
        `);
        console.log('✓ Created sessions table');

        await query(`
            CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)
        `);

        // 8. Create Watchlist table
        await query(`
            CREATE TABLE IF NOT EXISTS watchlist (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
                symbol VARCHAR(10) NOT NULL,
                added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                notes TEXT,
                UNIQUE(user_id, symbol)
            )
        `);
        console.log('✓ Created watchlist table');

        // 9. Create Alerts table
        await query(`
            CREATE TABLE IF NOT EXISTS alerts (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
                symbol VARCHAR(10) NOT NULL,
                alert_type VARCHAR(50) NOT NULL,
                condition VARCHAR(50) NOT NULL,
                target_price DECIMAL(10, 2),
                current_price DECIMAL(10, 2),
                triggered BOOLEAN DEFAULT false,
                triggered_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP
            )
        `);
        console.log('✓ Created alerts table');

        await query(`
            CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts(user_id)
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_alerts_triggered ON alerts(triggered)
        `);

        // 10. Create News Alerts table
        await query(`
            CREATE TABLE IF NOT EXISTS news_alerts (
                id SERIAL PRIMARY KEY,
                symbol VARCHAR(10) NOT NULL,
                title TEXT NOT NULL,
                summary TEXT,
                url TEXT,
                source VARCHAR(100),
                sentiment VARCHAR(20),
                published_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                viewed BOOLEAN DEFAULT false
            )
        `);
        console.log('✓ Created news_alerts table');

        await query(`
            CREATE INDEX IF NOT EXISTS idx_news_alerts_symbol ON news_alerts(symbol)
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_news_alerts_published ON news_alerts(published_at)
        `);

        // Create update timestamp trigger function
        await query(`
            CREATE OR REPLACE FUNCTION update_updated_at_column()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ language 'plpgsql';
        `);
        console.log('✓ Created update timestamp trigger function');

        // Apply triggers to tables with updated_at column
        const tablesWithUpdatedAt = ['users', 'trading_accounts', 'holdings', 'risk_configs'];
        for (const table of tablesWithUpdatedAt) {
            await query(`
                DROP TRIGGER IF EXISTS update_${table}_updated_at ON ${table};
                CREATE TRIGGER update_${table}_updated_at
                    BEFORE UPDATE ON ${table}
                    FOR EACH ROW
                    EXECUTE FUNCTION update_updated_at_column();
            `);
        }
        console.log('✓ Applied update timestamp triggers');

        console.log('\n✓ Database initialization completed successfully!\n');
        return true;

    } catch (error) {
        console.error('\n✗ Database initialization failed:', error);
        throw error;
    }
}

// Run initialization if called directly
if (require.main === module) {
    initializeDatabase()
        .then(() => {
            console.log('Database ready!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('Failed to initialize database:', error);
            process.exit(1);
        });
}

module.exports = { initializeDatabase };
