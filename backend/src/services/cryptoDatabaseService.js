/**
 * Crypto Trading — Database Layer
 *
 * Mirrors intradayDatabaseService.js (Blitz) exactly in shape and pattern —
 * same opt-in per-user config table, same separate positions/trades/logs
 * tables kept fully independent from the shared holdings/trades tables used
 * by swing trading (same reasoning as Blitz: holdings has UNIQUE(user_id,
 * symbol), and a symbol swing already owns could never get a second,
 * independent crypto lot if these were merged).
 *
 * Two deliberate differences from Blitz's schema:
 *   1. No force_flat_eod — crypto has no market close to flatten against.
 *      Positions live purely on stop-loss/take-profit, can span day
 *      boundaries.
 *   2. Wider DECIMAL precision on price/quantity columns — a $0.000012
 *      PEPE-style token and a $80,000 BTC both need to round-trip cleanly,
 *      which intraday_positions' DECIMAL(10,2) (built for equities) cannot
 *      hold. Quantity already needed DECIMAL(18,8) even for Blitz; crypto
 *      prices need the same headroom.
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

let _schemaEnsured = false;

async function ensureCryptoSchema() {
    if (_schemaEnsured) return;

    await query(`
        CREATE TABLE IF NOT EXISTS crypto_config (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            enabled BOOLEAN DEFAULT FALSE,
            allocation_amount DECIMAL(14,2) DEFAULT 500,
            max_position_notional DECIMAL(14,2) DEFAULT 250,
            max_open_positions INTEGER DEFAULT 3,
            max_daily_trades INTEGER DEFAULT 10,
            daily_loss_limit DECIMAL(14,2) DEFAULT -100,
            stop_loss_percent DECIMAL(5,2) DEFAULT 2.0,
            take_profit_percent DECIMAL(5,2) DEFAULT 4.0,
            min_score INTEGER DEFAULT 70,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS crypto_positions (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            symbol VARCHAR(20) NOT NULL,
            quantity DECIMAL(20,8) NOT NULL CHECK (quantity >= 0),
            average_price DECIMAL(20,8) NOT NULL,
            current_price DECIMAL(20,8),
            market_value DECIMAL(16,2),
            gain_loss DECIMAL(16,2),
            gain_loss_percent DECIMAL(8,4),
            stop_loss_price DECIMAL(20,8),
            take_profit_price DECIMAL(20,8),
            broker_order_id VARCHAR(100),
            opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, symbol)
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS crypto_trades (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            symbol VARCHAR(20) NOT NULL,
            side VARCHAR(4) NOT NULL,
            quantity DECIMAL(20,8) NOT NULL,
            entry_price DECIMAL(20,8),
            exit_price DECIMAL(20,8),
            entry_time TIMESTAMP,
            exit_time TIMESTAMP,
            pnl DECIMAL(16,2),
            pnl_percent DECIMAL(8,4),
            exit_reason VARCHAR(100),
            score_at_entry INTEGER,
            metadata JSONB DEFAULT '{}',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS crypto_trading_logs (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            success BOOLEAN DEFAULT TRUE,
            trades_executed INTEGER DEFAULT 0,
            capital_deployed DECIMAL(14,2) DEFAULT 0,
            opportunities_found INTEGER DEFAULT 0,
            message TEXT,
            trades_detail JSONB DEFAULT '[]',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Price/volume history for the curated universe — mirrors ohlcv_cache's shape
    // (symbol + time key, not user-specific, since the market data is the same for
    // everyone) but at 5-min bar granularity to match the bot's own cadence instead
    // of ohlcv_cache's daily bars. Added 2026-09-01: until now every cycle fetched a
    // fresh 20-bar (~100min) window from Alpaca purely to compute scoreFromBars() and
    // then discarded it — no persisted record of what price/volume conditions existed
    // when a trade did or didn't fire, so there was no way to audit a past decision or
    // build a richer/longer-window signal later. ON CONFLICT DO UPDATE (not DO
    // NOTHING) because the most-recent bar in each fetch is often still in progress
    // and its close/high/low/volume can still change until the 5-min window closes.
    await query(`
        CREATE TABLE IF NOT EXISTS crypto_price_history (
            id BIGSERIAL PRIMARY KEY,
            symbol VARCHAR(20) NOT NULL,
            bar_time TIMESTAMPTZ NOT NULL,
            open DECIMAL(20,8),
            high DECIMAL(20,8),
            low DECIMAL(20,8),
            close DECIMAL(20,8),
            volume DECIMAL(24,8),
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(symbol, bar_time)
        )
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_crypto_positions_user ON crypto_positions(user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_crypto_trades_user ON crypto_trades(user_id, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_crypto_logs_user ON crypto_trading_logs(user_id, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_crypto_price_history_symbol_time ON crypto_price_history(symbol, bar_time DESC)`);

    _schemaEnsured = true;
    logger.info('[CryptoBot] Schema ensured (crypto_config, crypto_positions, crypto_trades, crypto_trading_logs, crypto_price_history)');
}

async function getConfig(userId) {
    await ensureCryptoSchema();
    const result = await query('SELECT * FROM crypto_config WHERE user_id = $1', [userId]);
    if (result.rows.length > 0) return result.rows[0];

    const inserted = await query(
        `INSERT INTO crypto_config (user_id) VALUES ($1) RETURNING *`,
        [userId]
    );
    return inserted.rows[0];
}

async function updateConfig(userId, fields) {
    await ensureCryptoSchema();
    await getConfig(userId); // ensures a row exists first

    const allowed = [
        'enabled', 'allocation_amount', 'max_position_notional', 'max_open_positions',
        'max_daily_trades', 'daily_loss_limit', 'stop_loss_percent', 'take_profit_percent',
        'min_score'
    ];
    const sets = [];
    const values = [userId];
    let i = 2;
    for (const key of allowed) {
        if (fields[key] !== undefined) {
            sets.push(`${key} = $${i++}`);
            values.push(fields[key]);
        }
    }
    if (sets.length === 0) return getConfig(userId);

    const result = await query(
        `UPDATE crypto_config SET ${sets.join(', ')}, updated_at = NOW() WHERE user_id = $1 RETURNING *`,
        values
    );
    return result.rows[0];
}

async function getActiveUsers() {
    await ensureCryptoSchema();
    // Same column-shadowing guard as Blitz's getActiveUsers (u.id AS id last) —
    // crypto_config has its own serial `id`, must not silently overwrite the
    // real user id in the joined row.
    const result = await query(`
        SELECT u.username, c.*, u.id AS id
        FROM users u
        INNER JOIN crypto_config c ON u.id = c.user_id
        WHERE c.enabled = true
    `);
    return result.rows;
}

async function getPositions(userId) {
    await ensureCryptoSchema();
    const result = await query('SELECT * FROM crypto_positions WHERE user_id = $1 ORDER BY opened_at DESC', [userId]);
    return result.rows;
}

async function getPosition(userId, symbol) {
    await ensureCryptoSchema();
    const result = await query('SELECT * FROM crypto_positions WHERE user_id = $1 AND symbol = $2', [userId, symbol.toUpperCase()]);
    return result.rows[0] || null;
}

async function getCommittedCapital(userId) {
    await ensureCryptoSchema();
    const result = await query(
        'SELECT COALESCE(SUM(market_value), 0) AS total FROM crypto_positions WHERE user_id = $1',
        [userId]
    );
    return parseFloat(result.rows[0].total) || 0;
}

async function openPosition(userId, symbol, { quantity, price, stopLossPrice, takeProfitPrice, brokerOrderId }) {
    await ensureCryptoSchema();
    const marketValue = quantity * price;
    const result = await query(
        `INSERT INTO crypto_positions
            (user_id, symbol, quantity, average_price, current_price, market_value, stop_loss_price, take_profit_price, broker_order_id)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, symbol) DO UPDATE SET
            quantity = EXCLUDED.quantity, average_price = EXCLUDED.average_price,
            current_price = EXCLUDED.current_price, market_value = EXCLUDED.market_value,
            stop_loss_price = EXCLUDED.stop_loss_price, take_profit_price = EXCLUDED.take_profit_price,
            broker_order_id = EXCLUDED.broker_order_id, updated_at = NOW()
         RETURNING *`,
        [userId, symbol.toUpperCase(), quantity, price, marketValue, stopLossPrice || null, takeProfitPrice || null, brokerOrderId || null]
    );
    return result.rows[0];
}

async function updatePositionPrice(userId, symbol, currentPrice) {
    await ensureCryptoSchema();
    await query(
        `UPDATE crypto_positions SET
            current_price = $3,
            market_value = quantity * $3,
            gain_loss = (quantity * $3) - (quantity * average_price),
            gain_loss_percent = CASE WHEN average_price > 0 THEN (($3 - average_price) / average_price) * 100 ELSE 0 END,
            updated_at = NOW()
         WHERE user_id = $1 AND symbol = $2`,
        [userId, symbol.toUpperCase(), currentPrice]
    );
}

async function closePosition(userId, symbol, { exitPrice, exitReason, scoreAtEntry }) {
    await ensureCryptoSchema();
    const pos = await getPosition(userId, symbol);
    if (!pos) return null;

    const pnl = (exitPrice - parseFloat(pos.average_price)) * parseFloat(pos.quantity);
    const pnlPercent = parseFloat(pos.average_price) > 0
        ? ((exitPrice - parseFloat(pos.average_price)) / parseFloat(pos.average_price)) * 100
        : 0;

    await query('DELETE FROM crypto_positions WHERE user_id = $1 AND symbol = $2', [userId, symbol.toUpperCase()]);

    const trade = await query(
        `INSERT INTO crypto_trades
            (user_id, symbol, side, quantity, entry_price, exit_price, entry_time, exit_time, pnl, pnl_percent, exit_reason, score_at_entry)
         VALUES ($1, $2, 'sell', $3, $4, $5, $6, NOW(), $7, $8, $9, $10)
         RETURNING *`,
        [userId, symbol.toUpperCase(), pos.quantity, pos.average_price, exitPrice, pos.opened_at, pnl, pnlPercent, exitReason || 'manual', scoreAtEntry || null]
    );
    return trade.rows[0];
}

async function getTradeHistory(userId, limit = 50) {
    await ensureCryptoSchema();
    const result = await query(
        'SELECT * FROM crypto_trades WHERE user_id = $1 ORDER BY exit_time DESC LIMIT $2',
        [userId, limit]
    );
    return result.rows;
}

async function getTodayTradeCount(userId) {
    await ensureCryptoSchema();
    // Fixed midnight-ET boundary, not tied to any market close — see file docstring.
    const result = await query(
        `SELECT COUNT(*) AS cnt FROM crypto_trades WHERE user_id = $1 AND exit_time::date = CURRENT_DATE`,
        [userId]
    );
    return parseInt(result.rows[0].cnt) || 0;
}

async function getTodayPnl(userId) {
    await ensureCryptoSchema();
    const result = await query(
        `SELECT COALESCE(SUM(pnl), 0) AS total FROM crypto_trades WHERE user_id = $1 AND exit_time::date = CURRENT_DATE`,
        [userId]
    );
    return parseFloat(result.rows[0].total) || 0;
}

async function getTodaySummaryStats(userId) {
    await ensureCryptoSchema();
    const result = await query(
        `SELECT
            COUNT(*) AS trades,
            COUNT(*) FILTER (WHERE pnl > 0) AS wins,
            COUNT(*) FILTER (WHERE pnl < 0) AS losses,
            COALESCE(SUM(pnl), 0) AS total_pnl,
            COALESCE(MAX(pnl), 0) AS best_trade,
            COALESCE(MIN(pnl), 0) AS worst_trade
         FROM crypto_trades
         WHERE user_id = $1 AND exit_time::date = CURRENT_DATE`,
        [userId]
    );
    const row = result.rows[0];
    const trades = parseInt(row.trades) || 0;
    return {
        trades,
        wins: parseInt(row.wins) || 0,
        losses: parseInt(row.losses) || 0,
        winRate: trades > 0 ? (parseInt(row.wins) / trades) * 100 : 0,
        totalPnl: parseFloat(row.total_pnl) || 0,
        bestTrade: parseFloat(row.best_trade) || 0,
        worstTrade: parseFloat(row.worst_trade) || 0
    };
}

async function logCycle(userId, { success, tradesExecuted, capitalDeployed, opportunitiesFound, message, tradesDetail }) {
    await ensureCryptoSchema();
    await query(
        `INSERT INTO crypto_trading_logs
            (user_id, success, trades_executed, capital_deployed, opportunities_found, message, trades_detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, success !== false, tradesExecuted || 0, capitalDeployed || 0, opportunitiesFound || 0, message || null, JSON.stringify(tradesDetail || [])]
    );
}

/**
 * Persist a batch of 5-min bars for one symbol — not user-specific, the market
 * data is the same for every account. Upserts rather than skips duplicates: the
 * most recent bar in any fetch is typically still in progress (the current 5-min
 * window hasn't closed yet), so its close/high/low/volume legitimately change on
 * the next cycle's fetch of the same bar_time.
 */
async function savePriceBars(symbol, bars) {
    if (!bars || bars.length === 0) return;
    await ensureCryptoSchema();
    for (const bar of bars) {
        const barTime = bar.Timestamp || bar.timestamp || bar.t;
        if (!barTime) continue;
        try {
            await query(
                `INSERT INTO crypto_price_history (symbol, bar_time, open, high, low, close, volume)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (symbol, bar_time) DO UPDATE SET
                    close = EXCLUDED.close, high = EXCLUDED.high, low = EXCLUDED.low, volume = EXCLUDED.volume`,
                [symbol, new Date(barTime), bar.Open ?? bar.open, bar.High ?? bar.high, bar.Low ?? bar.low, bar.Close ?? bar.close, bar.Volume ?? bar.volume]
            );
        } catch (err) {
            logger.debug('[CryptoBot] savePriceBars failed for one bar', { symbol, error: err.message });
        }
    }
}

/** Recent persisted price history for one symbol — for review/audit, not live scoring. */
async function getPriceHistory(symbol, limit = 200) {
    await ensureCryptoSchema();
    const result = await query(
        `SELECT bar_time, open, high, low, close, volume FROM crypto_price_history
         WHERE symbol = $1 ORDER BY bar_time DESC LIMIT $2`,
        [symbol, limit]
    );
    return result.rows;
}

module.exports = {
    ensureCryptoSchema,
    getConfig,
    updateConfig,
    getActiveUsers,
    getPositions,
    getPosition,
    getCommittedCapital,
    openPosition,
    updatePositionPrice,
    closePosition,
    getTradeHistory,
    getTodayTradeCount,
    getTodayPnl,
    getTodaySummaryStats,
    logCycle,
    savePriceBars,
    getPriceHistory
};
