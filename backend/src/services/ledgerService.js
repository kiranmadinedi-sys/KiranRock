const { query } = require('../config/database');
const { Parser } = require('json2csv');
const axios = require('axios');
const userDb = require('./userDatabaseService');

async function getAlpacaClient(userId) {
    // Was reading alpaca_key_id/secret straight off the users row, which is NULL for
    // accounts that rely on the shared .env credentials (no per-user keys saved) — that
    // sent a null API key to Alpaca, got a 401, and silently fell back to summing the
    // KiranRock DB's own (stale, divergent) trades table instead of the real deposit
    // history. userDatabaseService.getUserAlpacaCredentials() already implements the
    // correct env fallback and is what brokerService uses for the same account (found
    // 2026-07-09: this mismatch made a $100k paper seed show as only $60k deposited).
    const creds = await userDb.getUserAlpacaCredentials(userId);
    if (!creds.keyId || !creds.secretKey) throw new Error('Alpaca keys not configured');
    const base = creds.isPaper === false
        ? 'https://api.alpaca.markets'
        : 'https://paper-api.alpaca.markets';
    return {
        base,
        headers: {
            'APCA-API-KEY-ID': creds.keyId,
            'APCA-API-SECRET-KEY': creds.secretKey,
        },
    };
}

// Fetch all pages of Alpaca account activities for given types
async function fetchAlpacaActivities(base, headers, activityTypes) {
    const results = [];
    let pageToken = null;
    const types = activityTypes.join(',');
    do {
        const params = { activity_types: types, page_size: 100 };
        if (pageToken) params.page_token = pageToken;
        const res = await axios.get(`${base}/v2/account/activities`, { headers, params });
        const batch = res.data || [];
        results.push(...batch);
        pageToken = batch.length === 100 ? batch[batch.length - 1].id : null;
    } while (pageToken);
    return results;
}

async function getLedgerSummary(userId) {
    // ── 1. Pull from Alpaca activities (source of truth for deposits/withdrawals) ──
    try {
        const { base, headers } = await getAlpacaClient(userId);

        // CSD = cash deposit, CSW = cash withdrawal (live accounts)
        // JNLC/JNLS = journal credit/debit — the deposit/withdrawal types paper accounts
        // actually use for seed funding and top-ups. Omitting these meant every paper
        // account's real deposit history was invisible here (found 2026-07-09).
        // FILL = order fill, PTC = pass-through charge
        const activities = await fetchAlpacaActivities(base, headers, ['CSD', 'CSW', 'JNLC', 'JNLS', 'FILL', 'PTC', 'DIV']);

        let totalDeposits    = 0;
        let totalWithdrawals = 0;
        let totalBuys        = 0;
        let totalSells       = 0;
        let totalCommission  = 0;
        let totalDividends   = 0;

        for (const a of activities) {
            const amt = Math.abs(parseFloat(a.net_amount || a.price * a.qty || 0));
            switch (a.activity_type) {
                case 'CSD': case 'JNLC': totalDeposits    += amt; break;
                case 'CSW': case 'JNLS': totalWithdrawals += amt; break;
                case 'DIV': totalDividends   += amt; break;
                case 'PTC': totalCommission  += amt; break;
                case 'FILL':
                    if (a.side === 'buy') {
                        totalBuys += parseFloat(a.price || 0) * Math.abs(parseFloat(a.qty || 0));
                    } else {
                        totalSells += parseFloat(a.price || 0) * Math.abs(parseFloat(a.qty || 0));
                    }
                    // Commission is embedded in fills as the difference between price and filled_avg_price
                    if (a.commission) totalCommission += parseFloat(a.commission);
                    break;
            }
        }

        return {
            totalDeposits,
            totalWithdrawals,
            totalBuys,
            totalSells,
            totalCommission,
            totalDividends,
            source: 'alpaca',
        };
    } catch (alpacaErr) {
        // ── 2. Fallback to DB if Alpaca is unreachable ──────────────────────
        const result = await query(`
            SELECT
                SUM(CASE WHEN action = 'DEPOSIT'    THEN total ELSE 0 END) as total_deposits,
                SUM(CASE WHEN action = 'WITHDRAWAL' THEN total ELSE 0 END) as total_withdrawals,
                SUM(CASE WHEN action = 'BUY'        THEN total ELSE 0 END) as total_buys,
                SUM(CASE WHEN action = 'SELL'       THEN total ELSE 0 END) as total_sells,
                COALESCE(SUM(commission), 0) as total_commission
            FROM trades
            WHERE user_id = $1
        `, [userId]);

        const row = result.rows[0];
        return {
            totalDeposits:    parseFloat(row.total_deposits    || 0),
            totalWithdrawals: parseFloat(row.total_withdrawals || 0),
            totalBuys:        parseFloat(row.total_buys        || 0),
            totalSells:       parseFloat(row.total_sells       || 0),
            totalCommission:  parseFloat(row.total_commission  || 0),
            totalDividends:   0,
            source: 'db_fallback',
        };
    }
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
    return parser.parse(trades.map(t => ({
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
}

module.exports = { getLedgerSummary, getLedgerTrades, getLedgerCSV };
