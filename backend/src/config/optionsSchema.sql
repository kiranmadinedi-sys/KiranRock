-- OPTIONS TRADING DATABASE SCHEMA
-- Professional options trading tables for autonomous bot

-- ============================================
-- OPTIONS TRADES TABLE
-- ============================================
-- Stores all options positions (open and closed)
CREATE TABLE IF NOT EXISTS options_trades (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- Option details
    symbol VARCHAR(10) NOT NULL,
    strike DECIMAL(10, 2) NOT NULL,
    expiration DATE NOT NULL,
    option_type VARCHAR(4) NOT NULL CHECK (option_type IN ('CALL', 'PUT')),
    
    -- Trade details
    action VARCHAR(10) NOT NULL CHECK (action IN ('BUY', 'SELL')),
    contracts INTEGER NOT NULL CHECK (contracts > 0),
    entry_price DECIMAL(10, 2) NOT NULL,
    exit_price DECIMAL(10, 2),
    entry_date TIMESTAMP NOT NULL DEFAULT NOW(),
    exit_date TIMESTAMP,
    
    -- Strategy and status
    strategy VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'EXPIRED', 'ASSIGNED')),
    exit_reason VARCHAR(50),
    
    -- Spread information (for multi-leg trades)
    spread_type VARCHAR(30),
    long_strike DECIMAL(10, 2),
    
    -- Performance
    profit_loss DECIMAL(12, 2),
    profit_loss_percent DECIMAL(8, 2),
    
    -- Greeks at entry (stored as JSON)
    greeks_at_entry JSONB,
    
    -- Metadata
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_options_trades_user_id ON options_trades(user_id);
CREATE INDEX IF NOT EXISTS idx_options_trades_symbol ON options_trades(symbol);
CREATE INDEX IF NOT EXISTS idx_options_trades_status ON options_trades(status);
CREATE INDEX IF NOT EXISTS idx_options_trades_strategy ON options_trades(strategy);
CREATE INDEX IF NOT EXISTS idx_options_trades_expiration ON options_trades(expiration);
CREATE INDEX IF NOT EXISTS idx_options_trades_entry_date ON options_trades(entry_date DESC);

-- ============================================
-- OPTIONS PERFORMANCE METRICS TABLE
-- ============================================
-- Daily aggregated performance for options trading
CREATE TABLE IF NOT EXISTS options_performance (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    
    -- Trade counts
    total_trades INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    losing_trades INTEGER DEFAULT 0,
    
    -- Strategy breakdown
    scalp_trades INTEGER DEFAULT 0,
    swing_trades INTEGER DEFAULT 0,
    spread_trades INTEGER DEFAULT 0,
    hedge_trades INTEGER DEFAULT 0,
    
    -- Financial metrics
    total_profit_loss DECIMAL(12, 2) DEFAULT 0,
    total_premium_paid DECIMAL(12, 2) DEFAULT 0,
    total_premium_received DECIMAL(12, 2) DEFAULT 0,
    largest_win DECIMAL(12, 2) DEFAULT 0,
    largest_loss DECIMAL(12, 2) DEFAULT 0,
    
    -- Performance ratios
    win_rate DECIMAL(5, 2) DEFAULT 0,
    average_win DECIMAL(10, 2) DEFAULT 0,
    average_loss DECIMAL(10, 2) DEFAULT 0,
    profit_factor DECIMAL(8, 2) DEFAULT 0,
    
    -- Risk metrics
    max_simultaneous_positions INTEGER DEFAULT 0,
    total_contracts_traded INTEGER DEFAULT 0,
    average_days_held DECIMAL(5, 2) DEFAULT 0,
    
    -- Greeks exposure (average)
    avg_delta_exposure DECIMAL(8, 4) DEFAULT 0,
    avg_gamma_exposure DECIMAL(8, 4) DEFAULT 0,
    avg_theta_exposure DECIMAL(8, 4) DEFAULT 0,
    avg_vega_exposure DECIMAL(8, 4) DEFAULT 0,
    
    -- Market conditions
    avg_vix_level DECIMAL(6, 2),
    market_regime VARCHAR(20),
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(user_id, date)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_options_performance_user_id ON options_performance(user_id);
CREATE INDEX IF NOT EXISTS idx_options_performance_date ON options_performance(date DESC);

-- ============================================
-- OPTIONS WATCHLIST TABLE
-- ============================================
-- Stocks being monitored for options opportunities
CREATE TABLE IF NOT EXISTS options_watchlist (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol VARCHAR(10) NOT NULL,
    
    -- Monitoring preferences
    strategies TEXT[], -- Array of strategies to monitor for this symbol
    min_score INTEGER DEFAULT 70,
    
    -- Alert settings
    alert_enabled BOOLEAN DEFAULT TRUE,
    alert_threshold DECIMAL(5, 2) DEFAULT 75.0,
    
    -- Notes
    notes TEXT,
    
    added_date TIMESTAMP DEFAULT NOW(),
    last_scan TIMESTAMP,
    
    UNIQUE(user_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_options_watchlist_user_id ON options_watchlist(user_id);

-- ============================================
-- OPTIONS ALERTS TABLE
-- ============================================
-- Real-time options opportunities and alerts
CREATE TABLE IF NOT EXISTS options_alerts (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) REFERENCES users(id) ON DELETE CASCADE,
    
    -- Alert details
    symbol VARCHAR(10) NOT NULL,
    alert_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) DEFAULT 'INFO' CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
    
    -- Opportunity details
    strategy VARCHAR(50),
    score DECIMAL(5, 2),
    
    -- Option details
    strike DECIMAL(10, 2),
    expiration DATE,
    option_type VARCHAR(4),
    
    -- Message
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    
    -- Metadata
    data JSONB, -- Additional structured data
    
    -- Status
    read BOOLEAN DEFAULT FALSE,
    dismissed BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_options_alerts_user_id ON options_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_options_alerts_symbol ON options_alerts(symbol);
CREATE INDEX IF NOT EXISTS idx_options_alerts_read ON options_alerts(read);
CREATE INDEX IF NOT EXISTS idx_options_alerts_created_at ON options_alerts(created_at DESC);

-- ============================================
-- OPTIONS BOT CONFIG TABLE
-- ============================================
-- User-specific bot configuration
CREATE TABLE IF NOT EXISTS options_bot_config (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    
    -- Bot status
    enabled BOOLEAN DEFAULT TRUE,
    
    -- Strategy enablement
    scalping_enabled BOOLEAN DEFAULT TRUE,
    swing_enabled BOOLEAN DEFAULT TRUE,
    spreads_enabled BOOLEAN DEFAULT TRUE,
    hedging_enabled BOOLEAN DEFAULT FALSE,
    
    -- Risk limits
    max_position_risk DECIMAL(5, 4) DEFAULT 0.02,
    max_account_risk DECIMAL(5, 4) DEFAULT 0.10,
    max_open_positions INTEGER DEFAULT 5,
    max_daily_loss DECIMAL(10, 2) DEFAULT 1000,
    
    -- Position sizing
    position_size_method VARCHAR(20) DEFAULT 'greeks',
    fixed_contracts INTEGER DEFAULT 1,
    
    -- Exit rules
    take_profit_percent DECIMAL(5, 2) DEFAULT 50.0,
    stop_loss_percent DECIMAL(5, 2) DEFAULT 30.0,
    trailing_stop_percent DECIMAL(5, 2) DEFAULT 15.0,
    
    -- Trading hours
    trading_start_time TIME DEFAULT '09:45:00',
    trading_end_time TIME DEFAULT '15:45:00',
    
    -- Minimum requirements
    min_liquidity_score DECIMAL(5, 2) DEFAULT 50.0,
    min_opportunity_score DECIMAL(5, 2) DEFAULT 70.0,
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- VIEWS FOR REPORTING
-- ============================================

-- Current open positions with P/L
CREATE OR REPLACE VIEW options_open_positions AS
SELECT 
    ot.*,
    (ot.contracts * 100) as shares_equivalent,
    EXTRACT(DAY FROM (NOW() - ot.entry_date)) as days_held
FROM options_trades ot
WHERE ot.status = 'OPEN'
ORDER BY ot.entry_date DESC;

-- Performance summary by strategy
CREATE OR REPLACE VIEW options_strategy_performance AS
SELECT 
    user_id,
    strategy,
    COUNT(*) as total_trades,
    SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) as winning_trades,
    SUM(CASE WHEN profit_loss < 0 THEN 1 ELSE 0 END) as losing_trades,
    ROUND(AVG(CASE WHEN profit_loss > 0 THEN profit_loss ELSE NULL END), 2) as avg_win,
    ROUND(AVG(CASE WHEN profit_loss < 0 THEN profit_loss ELSE NULL END), 2) as avg_loss,
    ROUND(SUM(profit_loss), 2) as total_pnl,
    ROUND(SUM(CASE WHEN profit_loss > 0 THEN 1.0 ELSE 0 END) * 100.0 / COUNT(*), 2) as win_rate
FROM options_trades
WHERE status = 'CLOSED'
GROUP BY user_id, strategy
ORDER BY total_pnl DESC;

-- Monthly performance summary
CREATE OR REPLACE VIEW options_monthly_performance AS
SELECT 
    user_id,
    DATE_TRUNC('month', entry_date) as month,
    COUNT(*) as total_trades,
    SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) as winning_trades,
    ROUND(SUM(profit_loss), 2) as total_pnl,
    ROUND(AVG(profit_loss), 2) as avg_pnl,
    ROUND(MAX(profit_loss), 2) as best_trade,
    ROUND(MIN(profit_loss), 2) as worst_trade
FROM options_trades
WHERE status = 'CLOSED'
GROUP BY user_id, DATE_TRUNC('month', entry_date)
ORDER BY month DESC;

-- ============================================
-- TRIGGER FUNCTIONS
-- ============================================

-- Update timestamp on options_trades update
CREATE OR REPLACE FUNCTION update_options_trades_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER options_trades_update_timestamp
    BEFORE UPDATE ON options_trades
    FOR EACH ROW
    EXECUTE FUNCTION update_options_trades_timestamp();

-- Auto-calculate P/L when position closed
CREATE OR REPLACE FUNCTION calculate_options_pnl()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'CLOSED' AND NEW.exit_price IS NOT NULL THEN
        IF NEW.action = 'BUY' THEN
            -- Long option: P/L = (exit - entry) * contracts * 100
            NEW.profit_loss = (NEW.exit_price - NEW.entry_price) * NEW.contracts * 100;
        ELSE
            -- Short option (spread): P/L = (entry - exit) * contracts * 100
            NEW.profit_loss = (NEW.entry_price - NEW.exit_price) * NEW.contracts * 100;
        END IF;
        
        NEW.profit_loss_percent = ((NEW.exit_price - NEW.entry_price) / NEW.entry_price) * 100;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER calculate_pnl_on_close
    BEFORE UPDATE ON options_trades
    FOR EACH ROW
    WHEN (NEW.status = 'CLOSED' AND OLD.status = 'OPEN')
    EXECUTE FUNCTION calculate_options_pnl();
