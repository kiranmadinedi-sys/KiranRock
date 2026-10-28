/**
 * Paper Tests — read-only status for the options-income and momentum-satellite paper tests
 * (2026-10-19). Each user only sees their own rows.
 */
const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);

router.get('/status', async (req, res) => {
    try {
        const uid = String(req.userId);
        const opts = await query(
            `SELECT contract, underlying, strike::float, expiry::text, status, entry_premium::float AS premium,
                    entry_delta::float AS delta, collateral::float, close_premium::float, close_reason, pnl::float, sector, reprice_count, next_earnings::text,
                    opened_at, closed_at
             FROM options_income_trades WHERE user_id = $1 ORDER BY opened_at DESC LIMIT 100`, [uid]).catch(() => ({ rows: [] }));
        const sat = await query(
            `SELECT h.symbol, h.quantity::float AS qty, h.average_price::float AS avg, h.current_price::float AS price,
                    h.market_value::float AS value, h.gain_loss::float AS pl
             FROM holdings h JOIN core_holdings c ON c.user_id = h.user_id AND c.symbol = h.symbol
             WHERE h.user_id = $1 AND c.sleeve = 'satellite' AND c.active AND h.quantity > 0
             ORDER BY h.symbol`, [uid]).catch(() => ({ rows: [] }));
        const perf = await require('../services/satelliteService').performance().catch(() => null);
        const closed = opts.rows.filter(o => ['closed', 'expired', 'assigned'].includes(o.status));
        // 2026-10-26: open puts marked at today's price (from the broker) + the T-bill benchmark on
        // the same collateral — the fair "was the risk worth it" comparison.
        let unrealized = null, markByContract = {};
        try {
            const cr = await require('../services/userDatabaseService').getUserAlpacaCredentials(uid);
            if (cr.isPaper !== false) {
                const pos = (await require('axios').get('https://paper-api.alpaca.markets/v2/positions', {
                    headers: { 'APCA-API-KEY-ID': cr.keyId, 'APCA-API-SECRET-KEY': cr.secretKey }, timeout: 15000 })).data;
                const byContract = Object.fromEntries(pos.filter(p => p.asset_class === 'us_option').map(p => [p.symbol, parseFloat(p.unrealized_pl)]));
                markByContract = Object.fromEntries(pos.filter(p => p.asset_class === 'us_option').map(p => [p.symbol, parseFloat(p.current_price)]));
                unrealized = 0;
                for (const o of opts.rows) if (['open', 'pending_close'].includes(o.status) && byContract[o.contract] != null) {
                    o.unrealized = byContract[o.contract]; unrealized += byContract[o.contract];
                }
            }
        } catch (_) { /* page still loads without live marks */ }
        // 2026-10-27: exit plan + risk flags per open put (stop/take-profit prices, close-by date,
        // earnings, assignment cost, cushion to the strike).
        const oi = require('../services/optionsIncomeService');
        const openRows = opts.rows.filter(o => ['open', 'pending_close'].includes(o.status));
        let stockPx = {};
        if (openRows.length) {
            try {
                const cr = await require('../services/userDatabaseService').getUserAlpacaCredentials(uid);
                const syms = [...new Set(openRows.map(o => o.underlying))].join(',');
                const snap = (await require('axios').get(`https://data.alpaca.markets/v2/stocks/snapshots?symbols=${syms}&feed=iex`, {
                    headers: { 'APCA-API-KEY-ID': cr.keyId, 'APCA-API-SECRET-KEY': cr.secretKey }, timeout: 15000 })).data;
                stockPx = Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, v.latestTrade?.p ?? v.dailyBar?.c ?? null]));
            } catch (_) { /* plan still shows without live prices */ }
        }
        for (const o of openRows) {
            o.plan = oi.exitPlan(o, { mark: markByContract[o.contract] ?? null, stockPrice: stockPx[o.underlying] ?? null });
        }
        const oiSum = await oi.summary().catch(() => null);
        res.json({
            options: {
                trades: opts.rows,
                summary: {
                    open: opts.rows.filter(o => ['open', 'pending_close'].includes(o.status)).length,
                    pending: opts.rows.filter(o => o.status === 'pending_open').length,
                    collateral: opts.rows.filter(o => ['open', 'pending_close'].includes(o.status)).reduce((s, o) => s + (o.collateral || 0), 0),
                    premiumCollected: opts.rows.filter(o => !['pending_open', 'not_filled'].includes(o.status)).reduce((s, o) => s + (o.premium || 0) * 100, 0),
                    closed: closed.length,
                    wins: closed.filter(o => o.pnl > 0).length,
                    pnl: closed.reduce((s, o) => s + (o.pnl || 0), 0),
                    unrealized,
                    tbillBenchmark: oiSum?.tbill_benchmark ?? null,
                    riskFreePct: oiSum?.riskFreePct ?? null,
                },
            },
            satellite: { positions: sat.rows, performance: perf },
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
