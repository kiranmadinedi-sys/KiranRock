/**
 * Core holdings (built 2026-10-17, the user's request): long-term positions that put
 * otherwise-idle cash to work, held for months, separate from the swing bot.
 *
 * Why: kmadined runs ~15-25% invested; the rest sits in cash. Since its live start
 * (2026-05-15) the swing bot realized +$38; SPY rose +3.8% over the same months — on
 * ~$6K of idle cash that's ~5x more, with no stock picking. 3-year history (2024→now):
 * SPY +67%, QQQ +79%, V +59%, AAPL +87%, while a 10-day swing trade in those same leaders
 * averaged only +0.1..0.6% — long climbs are captured by holding, not swing timing.
 *
 * Rules:
 *   - core_holdings lists each account's core symbols and target % of equity.
 *   - The swing bot never manages a core position: no stops, no exits, not counted in
 *     max_open_positions / sector caps / its investment budget, and never buys a core
 *     symbol as a swing trade (one holdings row per symbol must stay one strategy).
 *   - rebalanceCore() only BUYS toward target (once a trading day, ~10:00 ET) and keeps a
 *     cash reserve for the swing bot. It never sells — selling core is the user's call.
 *   - Buying is enabled per account via CORE_HOLDINGS_USER_IDS (paper first).
 *   - No stop-loss on core by design (index-level dips recover; stops sell the lows).
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const CACHE_MS = 60 * 1000;
const _cache = new Map(); // userId -> { at, rows }

let _tableReady = false;
async function ensureTable() {
    if (_tableReady) return;
    await query(`
        CREATE TABLE IF NOT EXISTS core_holdings (
            user_id    TEXT        NOT NULL,
            symbol     TEXT        NOT NULL,
            target_pct NUMERIC     NOT NULL CHECK (target_pct > 0 AND target_pct <= 80),
            active     BOOLEAN     NOT NULL DEFAULT true,
            note       TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, symbol)
        )`);
    _tableReady = true;
}

/** Active core rows for an account. On a DB error, serves the last good copy, else throws. */
async function getCoreRows(userId) {
    const key = String(userId);
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
    try {
        await ensureTable();
        const r = await query(
            `SELECT symbol, target_pct::float AS "targetPct", note FROM core_holdings WHERE user_id = $1 AND active`,
            [key]
        );
        const rows = r.rows.map(x => ({ ...x, symbol: x.symbol.toUpperCase() }));
        _cache.set(key, { at: Date.now(), rows });
        return rows;
    } catch (err) {
        // Never answer "no core" on a failed read — callers would then manage (stop, sell)
        // core positions as swing trades. Stale is safe; empty is not.
        if (hit) return hit.rows;
        throw err;
    }
}

async function getCoreSymbols(userId) {
    return new Set((await getCoreRows(userId)).map(r => r.symbol));
}

function _clearCache() { _cache.clear(); }

function isEnabledForBuying(userId) {
    return (process.env.CORE_HOLDINGS_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean).includes(String(userId));
}

const CASH_RESERVE_PCT = () => parseFloat(process.env.CORE_CASH_RESERVE_PCT || '25'); // kept free for swing trades
const MIN_BUY_USD = 50;

/**
 * Buy core positions up toward their target weights. Whole shares only (buyMarket
 * records filled qty as an integer). Returns a list of what it bought/skipped.
 */
async function rebalanceCore(userId) {
    const rows = await getCoreRows(userId);
    if (!rows.length) return [];
    const brokerService = require('./brokerService');
    const dataProvider = require('./dataProvider');
    const account = await brokerService.getAccountInfo(userId);
    const equity = account.portfolioValue;
    let cash = Math.max(0, account.cashBalance ?? 0);
    const reserve = equity * CASH_RESERVE_PCT() / 100;
    // Respect the same per-order caps brokerService.safetyCheck enforces (MAX_BOT_INVESTMENT_USD
    // and the account's maxOrderNotional): a large target is built up over several days
    // instead of being rejected outright.
    const { getUserTradingControls } = require('./tradingControlService');
    const controls = await getUserTradingControls(userId).catch(() => ({}));
    const orderCaps = [parseFloat(process.env.MAX_BOT_INVESTMENT_USD || '5000'), controls.maxOrderNotional].filter(v => v > 0);
    const maxOrderUsd = Math.min(...orderCaps) * 0.98;
    const positions = await brokerService.getPositions(userId);
    const held = Object.fromEntries(positions.map(p => [String(p.symbol).toUpperCase(), parseFloat(p.marketValue || 0)]));
    const actions = [];

    for (const row of rows) {
        const target = equity * row.targetPct / 100;
        const current = held[row.symbol] || 0;
        const gap = target - current;
        if (gap < Math.max(MIN_BUY_USD, target * 0.10)) { actions.push({ symbol: row.symbol, action: 'at_target', current, target }); continue; }
        // A buy from earlier today may still be resting (day limit order) — its shares aren't
        // in positions yet, so buying again would double up. Wait for it instead.
        const open = await brokerService.getOpenOrders(userId, row.symbol);
        if (open.some(o => o.side === 'buy')) { actions.push({ symbol: row.symbol, action: 'pending_order', current, target }); continue; }
        const spendable = Math.min(gap, cash - reserve, maxOrderUsd);
        const quote = await dataProvider.getQuote(row.symbol);
        const price = quote?.price;
        const qty = price > 0 ? Math.floor(spendable / (price * 1.005)) : 0;
        if (qty < 1) { actions.push({ symbol: row.symbol, action: 'no_cash', current, target, cash, reserve }); continue; }
        try {
            const res = await brokerService.buyMarket(userId, row.symbol, qty, { executedBy: 'CORE', reason: 'Core holding rebalance' });
            const spent = (res.filledQty || 0) * (res.filledAvgPrice || price);
            cash -= spent;
            actions.push({ symbol: row.symbol, action: 'bought', qty: res.filledQty, price: res.filledAvgPrice, status: res.status, target });
            logger.info('[Core] Bought toward target', { userId, symbol: row.symbol, qty: res.filledQty, price: res.filledAvgPrice, targetUsd: Math.round(target), status: res.status });
        } catch (err) {
            actions.push({ symbol: row.symbol, action: 'failed', error: err.message });
            logger.warn('[Core] Buy failed', { userId, symbol: row.symbol, error: err.message });
        }
    }
    return actions;
}

/** Scheduler tick (every 5 min): once per trading day after 10:00 ET for enabled accounts. */
const _ranOn = new Set();
async function runDailyRebalance(now = new Date()) {
    const ids = (process.env.CORE_HOLDINGS_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return;
    const { isMarketOpen } = require('../utils/marketCalendar');
    if (!isMarketOpen(now)) return;
    const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
    const etMin = parseInt(et.find(p => p.type === 'hour').value, 10) * 60 + parseInt(et.find(p => p.type === 'minute').value, 10);
    if (etMin < 10 * 60) return; // let the open settle
    const etDate = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    for (const userId of ids) {
        const key = `${userId}:${etDate}`;
        if (_ranOn.has(key)) continue;
        _ranOn.add(key); // once a day even if it fails — a retry loop on a broker error is worse
        try {
            const actions = await rebalanceCore(userId);
            const bought = actions.filter(a => a.action === 'bought');
            if (bought.length) {
                const alertService = require('./telegramAlertService');
                alertService.sendMessage(userId, `🏛️ *Core holdings* — bought ${bought.map(b => `${b.qty} ${b.symbol} @ $${Number(b.price).toFixed(2)}`).join(', ')}`).catch(() => {});
            }
        } catch (err) {
            logger.warn('[Core] Daily rebalance failed', { userId, error: err.message });
        }
    }
}

/** Core vs swing split for reports: core market value, cost, unrealized P&L. */
async function coreSummary(userId) {
    const rows = await getCoreRows(userId);
    if (!rows.length) return null;
    const syms = rows.map(r => r.symbol);
    const r = await query(
        `SELECT symbol, quantity::float AS qty, average_price::float AS avg, current_price::float AS px, market_value::float AS mv, gain_loss::float AS pl
         FROM holdings WHERE user_id = $1 AND symbol = ANY($2) AND quantity > 0`,
        [userId, syms]
    );
    const value = r.rows.reduce((s, x) => s + (x.mv || 0), 0);
    const pl = r.rows.reduce((s, x) => s + (x.pl || 0), 0);
    return { positions: r.rows, value, unrealizedPl: pl, cost: value - pl };
}

module.exports = { ensureTable, getCoreRows, getCoreSymbols, isEnabledForBuying, rebalanceCore, runDailyRebalance, coreSummary, _clearCache };
