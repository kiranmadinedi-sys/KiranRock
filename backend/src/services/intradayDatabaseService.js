/**
 * Blitz — Intraday Trading Module: Database Layer
 *
 * Deliberately four brand-new tables, never an extension of the existing
 * `holdings`/`trades` tables swing (ARROW) owns. `holdings` has
 * UNIQUE(user_id, symbol) — it structurally cannot hold a second,
 * independent lot of a symbol swing already owns, so any shared-table
 * approach would collide the moment both strategies touch the same name.
 * Keeping Blitz's data fully separate is what makes "can't break swing"
 * actually true rather than just intended.
 */

const { query } = require('../config/database');
const { logger } = require('../utils/logger');

let _schemaEnsured = false;

async function ensureIntradaySchema() {
    if (_schemaEnsured) return;

    await query(`
        CREATE TABLE IF NOT EXISTS intraday_config (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            enabled BOOLEAN DEFAULT FALSE,
            allocation_amount DECIMAL(12,2) DEFAULT 500,
            max_position_notional DECIMAL(12,2) DEFAULT 250,
            max_open_positions INTEGER DEFAULT 3,
            max_daily_trades INTEGER DEFAULT 10,
            daily_loss_limit DECIMAL(12,2) DEFAULT -100,
            stop_loss_percent DECIMAL(5,2) DEFAULT 1.0,
            take_profit_percent DECIMAL(5,2) DEFAULT 2.0,
            min_score INTEGER DEFAULT 70,
            force_flat_eod BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS intraday_positions (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            symbol VARCHAR(10) NOT NULL,
            quantity DECIMAL(18,8) NOT NULL CHECK (quantity >= 0),
            average_price DECIMAL(10,2) NOT NULL,
            current_price DECIMAL(10,2),
            market_value DECIMAL(15,2),
            gain_loss DECIMAL(15,2),
            gain_loss_percent DECIMAL(8,4),
            stop_loss_price DECIMAL(10,2),
            take_profit_price DECIMAL(10,2),
            broker_order_id VARCHAR(100),
            opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, symbol)
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS intraday_trades (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            symbol VARCHAR(10) NOT NULL,
            side VARCHAR(4) NOT NULL,
            quantity DECIMAL(18,8) NOT NULL,
            entry_price DECIMAL(10,2),
            exit_price DECIMAL(10,2),
            entry_time TIMESTAMP,
            exit_time TIMESTAMP,
            pnl DECIMAL(12,2),
            pnl_percent DECIMAL(8,4),
            exit_reason VARCHAR(100),
            score_at_entry INTEGER,
            metadata JSONB DEFAULT '{}',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS intraday_trading_logs (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            success BOOLEAN DEFAULT TRUE,
            trades_executed INTEGER DEFAULT 0,
            capital_deployed DECIMAL(12,2) DEFAULT 0,
            opportunities_found INTEGER DEFAULT 0,
            message TEXT,
            trades_detail JSONB DEFAULT '[]',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_intraday_positions_user ON intraday_positions(user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_intraday_trades_user ON intraday_trades(user_id, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_intraday_logs_user ON intraday_trading_logs(user_id, created_at DESC)`);

    _schemaEnsured = true;
    logger.info('[Blitz] Schema ensured (intraday_config, intraday_positions, intraday_trades, intraday_trading_logs)');
}

async function getConfig(userId) {
    await ensureIntradaySchema();
    const result = await query('SELECT * FROM intraday_config WHERE user_id = $1', [userId]);
    if (result.rows.length > 0) return result.rows[0];

    const inserted = await query(
        `INSERT INTO intraday_config (user_id) VALUES ($1) RETURNING *`,
        [userId]
    );
    return inserted.rows[0];
}

async function updateConfig(userId, fields) {
    await ensureIntradaySchema();
    await getConfig(userId); // ensures a row exists first

    const allowed = [
        'enabled', 'allocation_amount', 'max_position_notional', 'max_open_positions',
        'max_daily_trades', 'daily_loss_limit', 'stop_loss_percent', 'take_profit_percent',
        'min_score', 'force_flat_eod'
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
        `UPDATE intraday_config SET ${sets.join(', ')}, updated_at = NOW() WHERE user_id = $1 RETURNING *`,
        values
    );
    return result.rows[0];
}

async function getActiveUsers() {
    await ensureIntradaySchema();
    // NOTE: c.* must not precede/shadow u.id — intraday_config has its own
    // serial `id` column, and pg's row mapping lets a later duplicate column
    // name silently overwrite an earlier one in the resulting JS object. That
    // previously left every downstream call (scanForUser, brokerService, etc.)
    // using the config table's row number instead of the real user id.
    const result = await query(`
        SELECT u.username, c.*, u.id AS id
        FROM users u
        INNER JOIN intraday_config c ON u.id = c.user_id
        WHERE c.enabled = true
    `);
    return result.rows;
}

async function getPositions(userId) {
    await ensureIntradaySchema();
    const result = await query('SELECT * FROM intraday_positions WHERE user_id = $1 ORDER BY opened_at DESC', [userId]);
    return result.rows;
}

async function getPosition(userId, symbol) {
    await ensureIntradaySchema();
    const result = await query('SELECT * FROM intraday_positions WHERE user_id = $1 AND symbol = $2', [userId, symbol.toUpperCase()]);
    return result.rows[0] || null;
}

async function getCommittedCapital(userId) {
    await ensureIntradaySchema();
    const result = await query(
        'SELECT COALESCE(SUM(market_value), 0) AS total FROM intraday_positions WHERE user_id = $1',
        [userId]
    );
    return parseFloat(result.rows[0].total) || 0;
}

async function openPosition(userId, symbol, { quantity, price, stopLossPrice, takeProfitPrice, brokerOrderId }) {
    await ensureIntradaySchema();
    const marketValue = quantity * price;
    const result = await query(
        `INSERT INTO intraday_positions
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
    await ensureIntradaySchema();
    await query(
        `UPDATE intraday_positions SET
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
    await ensureIntradaySchema();
    const pos = await getPosition(userId, symbol);
    if (!pos) return null;

    const pnl = (exitPrice - parseFloat(pos.average_price)) * parseFloat(pos.quantity);
    const pnlPercent = parseFloat(pos.average_price) > 0
        ? ((exitPrice - parseFloat(pos.average_price)) / parseFloat(pos.average_price)) * 100
        : 0;

    await query('DELETE FROM intraday_positions WHERE user_id = $1 AND symbol = $2', [userId, symbol.toUpperCase()]);

    const trade = await query(
        `INSERT INTO intraday_trades
            (user_id, symbol, side, quantity, entry_price, exit_price, entry_time, exit_time, pnl, pnl_percent, exit_reason, score_at_entry)
         VALUES ($1, $2, 'sell', $3, $4, $5, $6, NOW(), $7, $8, $9, $10)
         RETURNING *`,
        [userId, symbol.toUpperCase(), pos.quantity, pos.average_price, exitPrice, pos.opened_at, pnl, pnlPercent, exitReason || 'manual', scoreAtEntry || null]
    );
    return trade.rows[0];
}

async function getTradeHistory(userId, limit = 50) {
    await ensureIntradaySchema();
    const result = await query(
        'SELECT * FROM intraday_trades WHERE user_id = $1 ORDER BY exit_time DESC LIMIT $2',
        [userId, limit]
    );
    return result.rows;
}

async function getTodayTradeCount(userId) {
    await ensureIntradaySchema();
    const result = await query(
        `SELECT COUNT(*) AS cnt FROM intraday_trades WHERE user_id = $1 AND exit_time::date = CURRENT_DATE`,
        [userId]
    );
    return parseInt(result.rows[0].cnt) || 0;
}

async function getTodayPnl(userId) {
    await ensureIntradaySchema();
    const result = await query(
        `SELECT COALESCE(SUM(pnl), 0) AS total FROM intraday_trades WHERE user_id = $1 AND exit_time::date = CURRENT_DATE`,
        [userId]
    );
    return parseFloat(result.rows[0].total) || 0;
}

async function getTodaySummaryStats(userId) {
    await ensureIntradaySchema();
    const result = await query(
        `SELECT
            COUNT(*) AS trades,
            COUNT(*) FILTER (WHERE pnl > 0) AS wins,
            COUNT(*) FILTER (WHERE pnl < 0) AS losses,
            COALESCE(SUM(pnl), 0) AS total_pnl,
            COALESCE(MAX(pnl), 0) AS best_trade,
            COALESCE(MIN(pnl), 0) AS worst_trade
         FROM intraday_trades
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
    await ensureIntradaySchema();
    await query(
        `INSERT INTO intraday_trading_logs
            (user_id, success, trades_executed, capital_deployed, opportunities_found, message, trades_detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, success !== false, tradesExecuted || 0, capitalDeployed || 0, opportunitiesFound || 0, message || null, JSON.stringify(tradesDetail || [])]
    );
}

module.exports = {
    ensureIntradaySchema,
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
    logCycle
};
