const { query } = require('../config/database');

/**
 * Trades Database Service
 * Records all trading activity for audit trail
 */

// broker_order_id — added 2026-09-17 alongside the fill-history reconciliation
// (positionReconciliationService.reconcileFillHistory). Lets a real Alpaca
// order be matched against its trades row by exact ID instead of only by
// fuzzy symbol/qty/price/time comparison — every caller that has an order id
// on hand should pass it. Ensured lazily (like cryptoDatabaseService's
// ensureCryptoSchema) rather than depending on initDatabase.js's startup
// path, which not every process here calls.
let _brokerOrderIdColumnEnsured = false;
async function _ensureBrokerOrderIdColumn() {
    if (_brokerOrderIdColumnEnsured) return;
    await query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS broker_order_id VARCHAR(100)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_trades_broker_order_id ON trades(broker_order_id) WHERE broker_order_id IS NOT NULL`);
    _brokerOrderIdColumnEnsured = true;
}

// Record a trade
async function recordTrade(tradeData) {
    await _ensureBrokerOrderIdColumn();
    const {
        userId, symbol, action, quantity, price, total,
        commission = 0, executedBy = 'MANUAL', notes = null,
        aiScore = null, sector = null,
        brokerOrderId = null,
        // Optional real historical timestamp — added 2026-09-14 for reconciler
        // backfills, where the trade actually happened at a real broker fill
        // time in the past, not "now" (when the reconciler happened to catch
        // up). Every other caller omits this and keeps getting the column's
        // own NOW() default, so this is purely additive.
        //
        // trade_date is `timestamp without time zone` — a raw UTC ISO string
        // (e.g. Alpaca's transaction_time) passed straight through gets its
        // clock digits stored AS naive, silently discarding the "this was
        // UTC" fact; reading it back later then reinterprets those same naive
        // digits as this server's LOCAL time and shifts by the zone offset
        // (5-6h, DST-dependent) AGAIN. Net effect: a value that round-trips
        // wrong by a full UTC-offset every time. Cast to timestamptz (so
        // Postgres parses the real UTC instant) then `AT TIME ZONE
        // 'America/Chicago'` (this server's zone) converts it to the correct
        // naive-local value for storage — DST-aware via Postgres's own tzdata,
        // confirmed via a real insert-then-read round trip.
        tradeDate = null,
        // pnl/pnlPercent — added 2026-09-15. This function silently had no way
        // to record a P&L at all (NULL always, unconditionally) — a backfill
        // caller passing pnl in tradeData had it quietly dropped with no error,
        // found only by noticing 3 freshly-backfilled VEEA rows all read back
        // pnl: null despite being passed explicitly. status defaults to
        // 'CLOSED' when a pnl is actually given (a SELL with a known P&L is by
        // definition a closed round-trip); every other caller keeps getting
        // NULL/the table's own default, unchanged from before this fix.
        pnl = null, pnlPercent = null
    } = tradeData;

    // 'OPEN' matches the column's own default — every pre-existing caller (no
    // pnl passed) must keep getting exactly that, not NULL, now that status
    // is explicitly in the column list below instead of omitted.
    const status = pnl !== null ? 'CLOSED' : 'OPEN';

    const result = await query(`
        INSERT INTO trades (
            user_id, symbol, action, quantity, price, total,
            commission, executed_by, notes, ai_score, sector, trade_date,
            pnl, pnl_percent, status, broker_order_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
            COALESCE($12::timestamptz AT TIME ZONE 'America/Chicago', NOW()),
            $13, $14, $15, $16)
        RETURNING *
    `, [
        userId, symbol, action, quantity, price, total,
        commission, executedBy, notes, aiScore, sector, tradeDate,
        pnl, pnlPercent, status, brokerOrderId
    ]);

    return result.rows[0];
}

// Get user's trade history
async function getUserTrades(userId, limit = 100, offset = 0) {
    const result = await query(`
        SELECT * FROM trades
        WHERE user_id = $1
        ORDER BY trade_date DESC
        LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);
    
    return result.rows;
}

// Get trades for specific symbol
async function getSymbolTrades(userId, symbol, limit = 50) {
    const result = await query(`
        SELECT * FROM trades
        WHERE user_id = $1 AND symbol = $2
        ORDER BY trade_date DESC
        LIMIT $3
    `, [userId, symbol, limit]);
    
    return result.rows;
}

// Get trades by date range
async function getTradesByDateRange(userId, startDate, endDate) {
    const result = await query(`
        SELECT * FROM trades
        WHERE user_id = $1
        AND trade_date >= $2
        AND trade_date <= $3
        ORDER BY trade_date DESC
    `, [userId, startDate, endDate]);
    
    return result.rows;
}

// Get trade statistics
async function getTradeStatistics(userId) {
    const result = await query(`
        SELECT
            COUNT(*) as total_trades,
            COUNT(CASE WHEN action = 'BUY' THEN 1 END) as buys,
            COUNT(CASE WHEN action = 'SELL' THEN 1 END) as sells,
            SUM(CASE WHEN action = 'BUY' THEN total ELSE 0 END) as total_bought,
            SUM(CASE WHEN action = 'SELL' THEN total ELSE 0 END) as total_sold,
            COUNT(DISTINCT symbol) as symbols_traded,
            AVG(price) as avg_price,
            SUM(commission) as total_commission
        FROM trades
        WHERE user_id = $1
    `, [userId]);
    
    return result.rows[0];
}

// Get recent AI bot trades
async function getRecentAITrades(userId, limit = 20) {
    const result = await query(`
        SELECT * FROM trades
        WHERE user_id = $1 AND executed_by LIKE '%AI%'
        ORDER BY trade_date DESC
        LIMIT $2
    `, [userId, limit]);
    
    return result.rows;
}

// Get first buy date per symbol for a user (aggregated)
async function getFirstBuyDates(userId) {
    const result = await query(`
        SELECT symbol, MIN(trade_date) as first_bought
        FROM trades
        WHERE user_id = $1 AND UPPER(action) = 'BUY'
        GROUP BY symbol
    `, [userId]);

    return result.rows; // [{ symbol, first_bought }, ...]
}

module.exports = {
    recordTrade,
    getUserTrades,
    getSymbolTrades,
    getTradesByDateRange,
    getTradeStatistics,
    getRecentAITrades,
    getFirstBuyDates,
    ensureBrokerOrderIdColumn: _ensureBrokerOrderIdColumn // exported so callers reading
    // trades.broker_order_id directly (e.g. reconcileFillHistory) can ensure it exists
    // first too, not only recordTrade's own INSERT path.
};
