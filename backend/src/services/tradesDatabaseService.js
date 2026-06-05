const { query } = require('../config/database');

/**
 * Trades Database Service
 * Records all trading activity for audit trail
 */

// Record a trade
async function recordTrade(tradeData) {
    const {
        userId, symbol, action, quantity, price, total,
        commission = 0, executedBy = 'MANUAL', notes = null,
        aiScore = null, sector = null
    } = tradeData;
    
    const result = await query(`
        INSERT INTO trades (
            user_id, symbol, action, quantity, price, total,
            commission, executed_by, notes, ai_score, sector
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
    `, [
        userId, symbol, action, quantity, price, total,
        commission, executedBy, notes, aiScore, sector
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
    getRecentAITrades
    , getFirstBuyDates
};
