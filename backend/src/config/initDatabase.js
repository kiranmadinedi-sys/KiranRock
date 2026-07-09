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
                ai_trading_settings JSONB DEFAULT '{}'::jsonb,
                telegram_chat_id VARCHAR(100)
            )
        `);
        console.log('✓ Created users table');

        await query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS ai_trading_settings JSONB DEFAULT '{}'::jsonb
        `);

        // Per-user Alpaca broker credentials (optional — falls back to .env when not set)
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS alpaca_key_id TEXT`);
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS alpaca_secret_key TEXT`);
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS alpaca_paper BOOLEAN DEFAULT true`);

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

        await query(`
            CREATE TABLE IF NOT EXISTS portfolio_snapshots (
                id BIGSERIAL PRIMARY KEY,
                user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
                total_portfolio_value DECIMAL(15, 2) NOT NULL,
                total_holdings_value DECIMAL(15, 2) NOT NULL DEFAULT 0,
                cash_balance DECIMAL(15, 2) NOT NULL DEFAULT 0,
                total_cost_basis DECIMAL(15, 2) NOT NULL DEFAULT 0,
                total_unrealized_pl DECIMAL(15, 2) NOT NULL DEFAULT 0,
                total_realized_pl DECIMAL(15, 2) NOT NULL DEFAULT 0,
                overall_pl DECIMAL(15, 2) NOT NULL DEFAULT 0,
                captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                metadata JSONB DEFAULT '{}'::jsonb
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_user_time
            ON portfolio_snapshots(user_id, captured_at DESC)
        `);
        console.log('✓ Created portfolio_snapshots table');

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

        await query(`
            CREATE TABLE IF NOT EXISTS ai_decisions (
                id VARCHAR(100) PRIMARY KEY,
                user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                decision JSONB NOT NULL
            )
        `);
        console.log('✓ Created ai_decisions table');

        await query(`
            CREATE TABLE IF NOT EXISTS trade_decision_journal (
                id BIGSERIAL PRIMARY KEY,
                user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                bot_type VARCHAR(20) NOT NULL,
                symbol VARCHAR(20) NOT NULL,
                setup_family VARCHAR(80),
                strategy_family VARCHAR(80),
                regime VARCHAR(20),
                decision_phase VARCHAR(20) NOT NULL,
                score DECIMAL(8, 2),
                score_adjustment DECIMAL(8, 2) DEFAULT 0,
                size_multiplier DECIMAL(8, 4) DEFAULT 1,
                expectancy DECIMAL(10, 4),
                confidence DECIMAL(8, 4),
                entry_price DECIMAL(12, 4),
                exit_price DECIMAL(12, 4),
                pnl DECIMAL(12, 2),
                pnl_percent DECIMAL(8, 2),
                trade_ref_type VARCHAR(30),
                trade_ref_id VARCHAR(100),
                metadata JSONB DEFAULT '{}'::jsonb,
                opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                closed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CHECK (bot_type IN ('stock', 'options')),
                CHECK (decision_phase IN ('CANDIDATE', 'EXECUTED', 'CLOSED'))
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_trade_decision_journal_user_created
            ON trade_decision_journal(user_id, created_at DESC)
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_trade_decision_journal_lookup
            ON trade_decision_journal(bot_type, strategy_family, setup_family, regime, decision_phase)
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_trade_decision_journal_ref
            ON trade_decision_journal(trade_ref_type, trade_ref_id)
        `);
        console.log('✓ Created trade_decision_journal table');

        await query(`
            CREATE INDEX IF NOT EXISTS idx_ai_decisions_user_id ON ai_decisions(user_id)
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_ai_decisions_timestamp ON ai_decisions(timestamp)
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
                stop_loss DECIMAL(5, 4) DEFAULT -0.07,
                trailing_stop_percent DECIMAL(4, 3) DEFAULT 0.05,
                take_profit_percent DECIMAL(4, 3) DEFAULT 0.25,
                partial_take_profit_percent DECIMAL(4, 3) DEFAULT 0.15,
                max_open_positions INTEGER DEFAULT 25,
                min_market_cap BIGINT DEFAULT 2000000000,
                max_daily_trades INTEGER DEFAULT 10,
                max_vix DECIMAL(5, 2) DEFAULT 30,
                reduce_positions_vix DECIMAL(5, 2) DEFAULT 25,
                max_sector_allocation DECIMAL(4, 3) DEFAULT 0.35,
                daily_loss_limit DECIMAL(12, 2) DEFAULT -1000,
                max_order_notional DECIMAL(12, 2) DEFAULT 5000,
                emergency_stop_enabled BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id)
            )
        `);
        console.log('✓ Created risk_configs table');

        await query(`
            CREATE TABLE IF NOT EXISTS system_controls (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                global_trading_enabled BOOLEAN NOT NULL DEFAULT true,
                kill_switch_reason TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await query(`
            INSERT INTO system_controls (id, global_trading_enabled)
            VALUES (1, true)
            ON CONFLICT (id) DO NOTHING
        `);
        // DB-backed HALT_ALL fallback columns (added after initial table creation)
        await query(`ALTER TABLE system_controls ADD COLUMN IF NOT EXISTS halt_all_reason TEXT`);
        await query(`ALTER TABLE system_controls ADD COLUMN IF NOT EXISTS halt_all_set_at  TIMESTAMPTZ`);
        console.log('✓ Created system_controls table');

        // holdings.created_at — required by positionReconciliationService SHADOW fix
        await query(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);

        // holdings.atr — ATR at time of entry; used by getDynamicTrailingStop to set ATR-aware trail width
        // Without this, trailing stops use only gain-percentage tiers and ignore each stock's actual volatility.
        await query(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS atr DECIMAL(10, 4)`);

        // Quality score decay — periodic re-scoring of open positions (2026-07-06).
        // last_rescore_score/at: most recent AI re-score and when it ran (throttled to ~1x/day).
        // low_score_streak: consecutive re-scores below the decay-exit floor; exit fires at streak >= 2
        // to avoid reacting to one noisy recalculation.
        await query(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS last_rescore_score DECIMAL(5, 2)`);
        await query(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS last_rescore_at TIMESTAMPTZ`);
        await query(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS low_score_streak INTEGER DEFAULT 0`);

        await query(`
            CREATE TABLE IF NOT EXISTS worker_runtime_status (
                worker_name VARCHAR(100) PRIMARY KEY,
                instance_id VARCHAR(150) NOT NULL,
                role VARCHAR(30) NOT NULL DEFAULT 'leader',
                status VARCHAR(30) NOT NULL DEFAULT 'starting',
                started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                heartbeat_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                metadata JSONB DEFAULT '{}'::jsonb
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_worker_runtime_status_heartbeat
            ON worker_runtime_status(heartbeat_at)
        `);
        console.log('✓ Created worker_runtime_status table');

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
                impact VARCHAR(20),
                severity VARCHAR(20),
                sentiment_impact VARCHAR(30),
                sentiment_score DECIMAL(6, 4),
                keywords JSONB DEFAULT '[]'::jsonb,
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
        // Dedup: prevent near-duplicate rows from accumulating (same symbol + normalised title)
        await query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_news_alerts_symbol_title_dedup
            ON news_alerts(symbol, LOWER(REGEXP_REPLACE(TRIM(title), '\\s+', ' ', 'g')))
        `);
        await query(`
            CREATE TABLE IF NOT EXISTS news_monitor_runs (
                id SERIAL PRIMARY KEY,
                started_at TIMESTAMP,
                finished_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                monitored_symbols INTEGER DEFAULT 0,
                raw_articles INTEGER DEFAULT 0,
                recent_articles INTEGER DEFAULT 0,
                matched_articles INTEGER DEFAULT 0,
                saved_alerts INTEGER DEFAULT 0,
                duplicate_skips INTEGER DEFAULT 0,
                quality_skips INTEGER DEFAULT 0,
                no_ticker_match_skips INTEGER DEFAULT 0,
                stale_skips INTEGER DEFAULT 0,
                error TEXT,
                sources JSONB DEFAULT '{}'::jsonb
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_news_monitor_runs_finished_at
            ON news_monitor_runs(finished_at DESC)
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS stock_feed_popup_preferences (
                user_id VARCHAR(50) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                popup_mode VARCHAR(20) NOT NULL DEFAULT 'both',
                popup_min_priority INTEGER NOT NULL DEFAULT 72,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CHECK (popup_mode IN ('off', 'news', 'swing', 'both')),
                CHECK (popup_min_priority BETWEEN 0 AND 100)
            )
        `);
        await query(`
            CREATE TABLE IF NOT EXISTS stock_feed_dismissals (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                item_type VARCHAR(20) NOT NULL,
                item_key VARCHAR(200) NOT NULL,
                symbol VARCHAR(10),
                dismissed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP,
                UNIQUE(user_id, item_type, item_key),
                CHECK (item_type IN ('news', 'swing'))
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_stock_feed_dismissals_active
            ON stock_feed_dismissals(user_id, item_type, expires_at DESC)
        `);
        await query(`
            CREATE TABLE IF NOT EXISTS stock_signal_telegram_events (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                channel VARCHAR(30) NOT NULL DEFAULT 'telegram',
                item_type VARCHAR(20) NOT NULL,
                item_key VARCHAR(200) NOT NULL,
                symbol VARCHAR(10),
                title TEXT,
                priority_score INTEGER,
                delivered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP,
                payload JSONB DEFAULT '{}'::jsonb,
                UNIQUE(user_id, channel, item_type, item_key)
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_stock_signal_telegram_events_active
            ON stock_signal_telegram_events(user_id, channel, expires_at DESC)
        `);
        await query(`
            CREATE TABLE IF NOT EXISTS stock_signal_snapshots (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                item_type VARCHAR(20) NOT NULL DEFAULT 'swing',
                item_key VARCHAR(200) NOT NULL,
                symbol VARCHAR(10) NOT NULL,
                title TEXT NOT NULL,
                summary TEXT,
                signal VARCHAR(30),
                recommendation VARCHAR(20),
                source_label VARCHAR(100),
                priority_score INTEGER,
                popup_eligible BOOLEAN DEFAULT false,
                sentiment_score DECIMAL(6, 2),
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                analyzed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP,
                payload JSONB DEFAULT '{}'::jsonb,
                UNIQUE(user_id, item_type, item_key),
                CHECK (item_type IN ('swing'))
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_stock_signal_snapshots_user_recent
            ON stock_signal_snapshots(user_id, item_type, analyzed_at DESC)
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_stock_signal_snapshots_active
            ON stock_signal_snapshots(user_id, item_type, expires_at DESC)
        `);
        console.log('✓ Created stock feed popup preference tables');

        await query(`
            CREATE TABLE IF NOT EXISTS options_alerts (
                id VARCHAR(100) PRIMARY KEY,
                symbol VARCHAR(10) NOT NULL,
                market_cap VARCHAR(30),
                scan_time VARCHAR(30),
                severity VARCHAR(20),
                option_type VARCHAR(20),
                strike DECIMAL(12, 4),
                expiration VARCHAR(30),
                delta DECIMAL(10, 6),
                gamma DECIMAL(10, 6),
                theta DECIMAL(10, 6),
                vega DECIMAL(10, 6),
                last_price DECIMAL(12, 4),
                volume INTEGER,
                open_interest INTEGER,
                title TEXT,
                message TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                read BOOLEAN DEFAULT false
            )
        `);
        console.log('✓ Created options_alerts table');

        await query(`
            CREATE INDEX IF NOT EXISTS idx_options_alerts_created_at ON options_alerts(created_at)
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_options_alerts_symbol ON options_alerts(symbol)
        `);

        // Options chain DB cache — pre-populated before market open, serves as fallback during 429s
        await query(`
            CREATE TABLE IF NOT EXISTS options_chain_cache (
                symbol      VARCHAR(20) PRIMARY KEY,
                fetched_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                stock_price NUMERIC(12, 4),
                options_count INTEGER DEFAULT 0,
                source      VARCHAR(50) DEFAULT 'yahoo',
                payload     JSONB NOT NULL DEFAULT '[]'::jsonb
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_options_chain_cache_fetched_at
            ON options_chain_cache(fetched_at)
        `);
        console.log('✓ Created options_chain_cache table');

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
        const tablesWithUpdatedAt = ['users', 'trading_accounts', 'holdings', 'risk_configs', 'system_controls'];
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

        // ARROW order audit log — append-only, no UPDATE/DELETE per PANTHEON spec
        await query(`
            CREATE TABLE IF NOT EXISTS order_audit_log (
                id              BIGSERIAL PRIMARY KEY,
                idempotency_key TEXT        NOT NULL,
                user_id         TEXT        NOT NULL,
                symbol          TEXT        NOT NULL,
                state           TEXT        NOT NULL,
                previous_state  TEXT,
                broker          TEXT,
                broker_order_id TEXT,
                quantity        NUMERIC(14, 8),
                price           NUMERIC(12, 4),
                metadata        JSONB       DEFAULT '{}'::jsonb,
                created_at      TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_order_audit_key   ON order_audit_log(idempotency_key)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_order_audit_user   ON order_audit_log(user_id)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_order_audit_symbol ON order_audit_log(symbol, created_at DESC)`);
        console.log('✓ Created order_audit_log table');

        // EVOLVE / HISTORICAL DATA — 2-year OHLCV bar cache
        await query(`
            CREATE TABLE IF NOT EXISTS ohlcv_cache (
                id         BIGSERIAL PRIMARY KEY,
                symbol     VARCHAR(10)   NOT NULL,
                date       DATE          NOT NULL,
                open       NUMERIC(14,4),
                high       NUMERIC(14,4),
                low        NUMERIC(14,4),
                close      NUMERIC(14,4) NOT NULL,
                volume     BIGINT,
                created_at TIMESTAMPTZ   DEFAULT NOW(),
                UNIQUE (symbol, date)
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_ohlcv_symbol_date ON ohlcv_cache(symbol, date DESC)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_ohlcv_date ON ohlcv_cache(date DESC)`);
        console.log('✓ Created ohlcv_cache table');

        // EVOLVE / DAILY BARS — used by dailyBarsService + ollamaBacktestService
        await query(`
            CREATE TABLE IF NOT EXISTS daily_bars (
                id          BIGSERIAL PRIMARY KEY,
                symbol      VARCHAR(10)   NOT NULL,
                timestamp   TIMESTAMPTZ   NOT NULL,
                open        NUMERIC(14,4),
                high        NUMERIC(14,4),
                low         NUMERIC(14,4),
                close       NUMERIC(14,4) NOT NULL,
                volume      BIGINT,
                vwap        NUMERIC(14,4),
                trade_count INTEGER,
                UNIQUE (symbol, timestamp)
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_daily_bars_symbol_ts ON daily_bars(symbol, timestamp DESC)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_daily_bars_ts ON daily_bars(timestamp DESC)`);
        console.log('✓ Created daily_bars table');

        // ── ASSET UNIVERSE — production-grade symbol management ────────────────
        // Master table: all active Alpaca US equity assets (~11k symbols)
        await query(`
            CREATE TABLE IF NOT EXISTS asset_universe (
                id               SERIAL PRIMARY KEY,
                symbol           VARCHAR(20)  NOT NULL UNIQUE,
                name             TEXT,
                exchange         VARCHAR(20),
                asset_class      VARCHAR(30)  DEFAULT 'us_equity',
                tradable         BOOLEAN      DEFAULT false,
                shortable        BOOLEAN      DEFAULT false,
                marginable       BOOLEAN      DEFAULT false,
                easy_to_borrow   BOOLEAN      DEFAULT false,
                fractionable     BOOLEAN      DEFAULT false,
                status           VARCHAR(20)  DEFAULT 'active',
                last_refreshed_at TIMESTAMPTZ DEFAULT NOW(),
                created_at       TIMESTAMPTZ  DEFAULT NOW()
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_asset_universe_tradable ON asset_universe(tradable, exchange) WHERE status='active'`);
        console.log('✓ Created asset_universe table');

        // Daily filtered analysis universe — rebuilt each market day
        await query(`
            CREATE TABLE IF NOT EXISTS asset_universe_daily (
                id                  SERIAL PRIMARY KEY,
                universe_date       DATE         NOT NULL,
                symbol              VARCHAR(20)  NOT NULL,
                price               NUMERIC(14,4),
                volume              BIGINT,
                market_cap          BIGINT,
                avg_volume          BIGINT,
                rs_score            NUMERIC(8,4),
                is_velocity         BOOLEAN      DEFAULT false,
                is_premarket_mover  BOOLEAN      DEFAULT false,
                source              VARCHAR(30)  DEFAULT 'master',
                created_at          TIMESTAMPTZ  DEFAULT NOW(),
                UNIQUE(universe_date, symbol)
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_asset_universe_daily_date ON asset_universe_daily(universe_date, rs_score DESC)`);
        console.log('✓ Created asset_universe_daily table');

        // Blacklist — symbols to never trade
        await query(`
            CREATE TABLE IF NOT EXISTS asset_blacklist (
                id         SERIAL PRIMARY KEY,
                symbol     VARCHAR(20)  NOT NULL UNIQUE,
                reason     TEXT,
                added_by   VARCHAR(50)  DEFAULT 'system',
                expires_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ  DEFAULT NOW()
            )
        `);
        console.log('✓ Created asset_blacklist table');

        // Intraday halt tracking
        await query(`
            CREATE TABLE IF NOT EXISTS asset_halts (
                id          SERIAL PRIMARY KEY,
                symbol      VARCHAR(20)  NOT NULL,
                halt_type   VARCHAR(30)  DEFAULT 'unknown',
                source      VARCHAR(30)  DEFAULT 'system',
                halted_at   TIMESTAMPTZ  DEFAULT NOW(),
                resumed_at  TIMESTAMPTZ,
                created_at  TIMESTAMPTZ  DEFAULT NOW()
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_asset_halts_active ON asset_halts(symbol) WHERE resumed_at IS NULL`);
        console.log('✓ Created asset_halts table');

        // Nightly full-universe AI analysis — pre-scored overnight for fast market-hours loading
        await query(`
            CREATE TABLE IF NOT EXISTS daily_universe_analysis (
                id               BIGSERIAL PRIMARY KEY,
                symbol           VARCHAR(20)  NOT NULL,
                analysis_date    DATE         NOT NULL,
                ai_score         DECIMAL(8,2),
                recommendation   VARCHAR(20),
                setup_family     VARCHAR(80),
                sector           VARCHAR(80),
                market_cap       DECIMAL(20,2),
                passed_prescreen BOOLEAN      DEFAULT false,
                exclusion_reason TEXT,
                metadata         JSONB        DEFAULT '{}'::jsonb,
                created_at       TIMESTAMPTZ  DEFAULT NOW(),
                updated_at       TIMESTAMPTZ  DEFAULT NOW(),
                UNIQUE(symbol, analysis_date)
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_dua_date_score
            ON daily_universe_analysis(analysis_date, ai_score DESC)
            WHERE passed_prescreen = true
        `);
        console.log('✓ Created daily_universe_analysis table');

        // Live PANTHEON score cache — written by the bot every 5-min cycle during market hours.
        // Signals page prefers these over nightly scores when fresher than 10 minutes.
        await query(`
            CREATE TABLE IF NOT EXISTS live_score_cache (
                symbol          TEXT    NOT NULL,
                scan_date       DATE    NOT NULL,
                ai_score        NUMERIC,
                recommendation  TEXT,
                live_scored_at  TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (symbol, scan_date)
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_lsc_date_score
            ON live_score_cache(scan_date, ai_score DESC)
        `);
        console.log('✓ Created live_score_cache table');

        // ATLAS global sentiment — single-row DB cache so worker restarts don't
        // trigger a 90-second Yahoo market-data fetch before the nightly scan.
        await query(`
            CREATE TABLE IF NOT EXISTS global_sentiment_cache (
                id              INTEGER      PRIMARY KEY DEFAULT 1,
                sentiment_label TEXT         NOT NULL,
                global_score    NUMERIC(6,4) NOT NULL,
                base_adj        SMALLINT     NOT NULL,
                breakdown       JSONB,
                raw_data        JSONB,
                updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
                CONSTRAINT global_sentiment_singleton CHECK (id = 1)
            )
        `);
        console.log('✓ Created global_sentiment_cache table');

        // Fundamentals cache — DB-backed, 7-day TTL, survives restarts
        await query(`
            CREATE TABLE IF NOT EXISTS fundamentals_cache (
                symbol           TEXT        PRIMARY KEY,
                fetched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                earnings_growth  NUMERIC,
                revenue_growth   NUMERIC,
                gross_margins    NUMERIC,
                pe_ratio         NUMERIC,
                forward_pe       NUMERIC,
                peg_ratio        NUMERIC,
                profit_margin    NUMERIC,
                return_on_equity NUMERIC,
                debt_to_equity   NUMERIC,
                market_cap       BIGINT,
                sector           TEXT,
                industry         TEXT,
                raw_json         JSONB
            )
        `);
        console.log('✓ Created fundamentals_cache table');

        // Idempotent: tighten stop-loss defaults for any rows still at the old values
        await query(`
            UPDATE risk_configs
            SET stop_loss             = -0.07,
                trailing_stop_percent =  0.05,
                updated_at            = NOW()
            WHERE stop_loss <= -0.12
               OR trailing_stop_percent >= 0.08
        `);

        // Expand universe: lower min_market_cap from $5B to $2B so mid-caps are included
        await query(`
            UPDATE risk_configs
            SET min_market_cap = 2000000000,
                updated_at     = NOW()
            WHERE min_market_cap >= 5000000000
        `);

        // Position reconciliation audit trail
        await query(`
            CREATE TABLE IF NOT EXISTS position_reconciliation_log (
                id            SERIAL PRIMARY KEY,
                user_id       TEXT        NOT NULL,
                reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                discrepancy   TEXT        NOT NULL,   -- PHANTOM | DRIFT | SHADOW
                symbol        TEXT        NOT NULL,
                db_qty        INTEGER,
                broker_qty    INTEGER,
                action        TEXT        NOT NULL,   -- DELETED | UPDATED | INSERTED | ERROR
                details       TEXT,
                trigger       TEXT        NOT NULL DEFAULT 'SCHEDULED'  -- SCHEDULED | STARTUP | MANUAL
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_recon_log_user_date
            ON position_reconciliation_log(user_id, reconciled_at DESC)
        `);
        // Add acknowledged column for SENTINEL reset without data deletion
        await query(`
            ALTER TABLE position_reconciliation_log
            ADD COLUMN IF NOT EXISTS acknowledged      BOOLEAN     DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS acknowledged_at   TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS acknowledged_reason TEXT
        `);
        console.log('✓ Created position_reconciliation_log table');

        // SENTINEL acknowledgements for order_audit_log (append-only — can't add columns)
        await query(`
            CREATE TABLE IF NOT EXISTS sentinel_order_acknowledgements (
                id                SERIAL PRIMARY KEY,
                idempotency_key   TEXT        NOT NULL UNIQUE,
                acknowledged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                acknowledged_by   TEXT,
                reason            TEXT
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_sentinel_ack_key
            ON sentinel_order_acknowledgements(idempotency_key)
        `);
        console.log('✓ Created sentinel_order_acknowledgements table');

        // Score calibration suggestions — persisted by scoreCalibratorService
        await query(`
            CREATE TABLE IF NOT EXISTS calibration_suggestions (
                id               BIGSERIAL    PRIMARY KEY,
                user_id          VARCHAR(50)  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                suggested_floor  INTEGER,
                current_floor    INTEGER,
                confidence       VARCHAR(10),
                total_trades     INTEGER,
                reason           TEXT,
                has_enough_data  BOOLEAN,
                report_json      JSONB        NOT NULL DEFAULT '{}'::jsonb,
                created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_calibration_suggestions_user_created
            ON calibration_suggestions(user_id, created_at DESC)
        `);
        console.log('✓ Created calibration_suggestions table');

        // Market Review — daily snapshot of the FULL scan universe (every ticker analyzed,
        // not just ones traded) with forward returns backfilled once time has passed.
        // Purpose: compare AI score/recommendation against what the market actually did,
        // independent of what the bot chose to trade — used to validate/recalibrate scoring
        // logic against real outcomes (2026-07-06).
        await query(`
            CREATE TABLE IF NOT EXISTS market_review_snapshots (
                id               BIGSERIAL     PRIMARY KEY,
                scan_date        DATE          NOT NULL,
                symbol           VARCHAR(20)   NOT NULL,
                ai_score         DECIMAL(5, 2),
                recommendation   VARCHAR(20),
                sector           VARCHAR(100),
                setup_family     VARCHAR(50),
                tier             INTEGER,
                regime           VARCHAR(30),
                price_at_scan    DECIMAL(12, 4),
                was_traded       BOOLEAN       DEFAULT FALSE,
                close_1d         DECIMAL(12, 4),
                return_1d_pct    DECIMAL(8, 4),
                close_3d         DECIMAL(12, 4),
                return_3d_pct    DECIMAL(8, 4),
                close_5d         DECIMAL(12, 4),
                return_5d_pct    DECIMAL(8, 4),
                created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
                updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
                UNIQUE(scan_date, symbol)
            )
        `);
        // regime added after initial table creation — needed by existing installs
        await query(`ALTER TABLE market_review_snapshots ADD COLUMN IF NOT EXISTS regime VARCHAR(30)`);
        // blocked_reason added 2026-07-07 — see trade_rejection_log below
        await query(`ALTER TABLE market_review_snapshots ADD COLUMN IF NOT EXISTS blocked_reason VARCHAR(40)`);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_market_review_scan_date
            ON market_review_snapshots(scan_date)
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_market_review_symbol
            ON market_review_snapshots(symbol)
        `);
        console.log('✓ Created market_review_snapshots table');

        // Trade Rejection Log — "shadow portfolio" groundwork (2026-07-07).
        // Records the specific gate that blocked a candidate that had already cleared the
        // score threshold (i.e. was a real BUY/STRONG BUY opportunity, not just noise).
        // One row per (date, symbol) — last gate to reject it that day wins via upsert.
        // Market Review's daily capture LEFT JOINs this so "why wasn't this bought" can be
        // measured against the ticker's actual forward return, not guessed at.
        await query(`
            CREATE TABLE IF NOT EXISTS trade_rejection_log (
                id               BIGSERIAL     PRIMARY KEY,
                rejection_date   DATE          NOT NULL,
                symbol           VARCHAR(20)   NOT NULL,
                reason           VARCHAR(40)   NOT NULL,
                detail           TEXT,
                updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
                UNIQUE(rejection_date, symbol)
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_trade_rejection_log_date
            ON trade_rejection_log(rejection_date)
        `);
        console.log('✓ Created trade_rejection_log table');

        // Holding Re-score History — durable log of every Quality Score Decay re-score
        // (2026-07-07). holdings.last_rescore_score only keeps the latest value; this table
        // keeps the full trajectory so a future pass can distinguish "score steadily declining"
        // from "one noisy low reading" — separate from the existing 2-strike exit rule, which
        // is unchanged. Kept even after the position closes (unlike holdings, which is deleted
        // on exit) so decay-trend-vs-actual-outcome can be studied later.
        await query(`
            CREATE TABLE IF NOT EXISTS holding_rescore_history (
                id             BIGSERIAL     PRIMARY KEY,
                user_id        VARCHAR(50)   NOT NULL,
                symbol         VARCHAR(20)   NOT NULL,
                score          DECIMAL(5, 2) NOT NULL,
                scored_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_holding_rescore_history_user_symbol
            ON holding_rescore_history(user_id, symbol, scored_at DESC)
        `);
        console.log('✓ Created holding_rescore_history table');

        // Deposit Events Cache — durable backing for portfolioHistoryService's in-memory
        // deposit/withdrawal cache (2026-07-09). The in-memory Map is fast but empty after
        // every restart, forcing a slow Alpaca refetch for the first request; this table lets
        // a cold start load the last-known-good events instantly while a background refresh
        // (or the next cache-miss) brings it current. Deposits are rare, so a stale-by-a-few-
        // minutes row here is a non-issue.
        await query(`
            CREATE TABLE IF NOT EXISTS deposit_events_cache (
                user_id      VARCHAR(50)  PRIMARY KEY,
                events       JSONB        NOT NULL,
                computed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
            )
        `);
        console.log('✓ Created deposit_events_cache table');

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
