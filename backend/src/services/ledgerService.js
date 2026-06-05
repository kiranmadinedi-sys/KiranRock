const { query } = require('../config/database');
const { Parser } = require('json2csv');

async function getLedgerSummary(userId) {
    const result = await query(`
        SELECT
            SUM(CASE WHEN action = 'DEPOSIT' THEN total ELSE 0 END) as total_deposits,
            SUM(CASE WHEN action = 'WITHDRAWAL' THEN total ELSE 0 END) as total_withdrawals,
            SUM(CASE WHEN action = 'BUY' THEN total ELSE 0 END) as total_buys,
            SUM(CASE WHEN action = 'SELL' THEN total ELSE 0 END) as total_sells,
            COALESCE(SUM(commission), 0) as total_commission
        FROM trades
        WHERE user_id = $1
    `, [userId]);

    const row = result.rows[0];
    return {
        totalDeposits: parseFloat(row.total_deposits || 0),
        totalWithdrawals: parseFloat(row.total_withdrawals || 0),
        totalBuys: parseFloat(row.total_buys || 0),
        totalSells: parseFloat(row.total_sells || 0),
        totalCommission: parseFloat(row.total_commission || 0),
    };
}

async function getLedgerTrades(userId, limit = 1000) {
    const result = await query(`
        SELECT id, symbol, action, quantity, price, total, commission, trade_date, notes, executed_by
        FROM trades
        WHERE user_id = $1
        ORDER BY trade_date DESC
        LIMIT $2
    `, [userId, limit]);

    return result.rows.map(r => ({
        id: r.id,
        symbol: r.symbol,
        action: r.action,
        quantity: r.quantity,
        price: parseFloat(r.price || 0),
        total: parseFloat(r.total || 0),
        commission: parseFloat(r.commission || 0),
        trade_date: r.trade_date,
        notes: r.notes,
        executed_by: r.executed_by
    }));
}

async function getLedgerCSV(userId) {
    const trades = await getLedgerTrades(userId, 10000);
    const fields = ['trade_date', 'action', 'symbol', 'quantity', 'price', 'total', 'commission', 'executed_by', 'notes'];
    const parser = new Parser({ fields });
    const csv = parser.parse(trades.map(t => ({
        trade_date: t.trade_date,
        action: t.action,
        symbol: t.symbol,
        quantity: t.quantity,
        price: t.price,
        total: t.total,
        commission: t.commission,
        executed_by: t.executed_by,
        notes: t.notes
    })));
    return csv;
}

module.exports = { getLedgerSummary, getLedgerTrades, getLedgerCSV };
