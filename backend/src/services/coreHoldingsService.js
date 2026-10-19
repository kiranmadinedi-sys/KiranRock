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
 *   - Each account opts in from Settings -> Core Holdings (core_settings.enabled), like the
 *     crypto feature. Turning it off stops BUYING only; held core positions stay protected
 *     from the swing bot. A target of 0% means "keep holding, stop buying".
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
            target_pct NUMERIC     NOT NULL CHECK (target_pct >= 0 AND target_pct <= 80),
            active     BOOLEAN     NOT NULL DEFAULT true,
            note       TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, symbol)
        )`);
    // 0% = keep holding, stop buying (2026-10-17, Settings screen) — widen the original > 0.
    await query(`
        ALTER TABLE core_holdings DROP CONSTRAINT IF EXISTS core_holdings_target_pct_check;
        ALTER TABLE core_holdings ADD CONSTRAINT core_holdings_target_pct_check CHECK (target_pct >= 0 AND target_pct <= 80)`);
    await query(`
        CREATE TABLE IF NOT EXISTS core_settings (
            user_id          TEXT        PRIMARY KEY,
            enabled          BOOLEAN     NOT NULL DEFAULT false,
            cash_reserve_pct NUMERIC     NOT NULL DEFAULT 25 CHECK (cash_reserve_pct >= 10 AND cash_reserve_pct <= 80),
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    // 'satellite' sleeve (2026-10-18): momentum positions managed by satelliteService. They are
    // protected from the swing bot exactly like core, but kept out of the core list/settings.
    await query(`ALTER TABLE core_holdings ADD COLUMN IF NOT EXISTS sleeve TEXT NOT NULL DEFAULT 'core'`);
    _tableReady = true;
}

/** Active rows of every sleeve. On a DB error, serves the last good copy, else throws. */
async function _getAllRows(userId) {
    const key = String(userId);
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
    try {
        await ensureTable();
        const r = await query(
            `SELECT symbol, target_pct::float AS "targetPct", note, sleeve FROM core_holdings WHERE user_id = $1 AND active`,
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

/** The core sleeve only (core list, settings, rebalance, reports). */
async function getCoreRows(userId) {
    return (await _getAllRows(userId)).filter(r => (r.sleeve || 'core') === 'core');
}

/**
 * Every symbol the swing bot must leave alone: core AND satellite. Throws (or serves a stale
 * copy) on a failed read — never answers "none".
 */
async function getCoreSymbols(userId) {
    return new Set((await _getAllRows(userId)).map(r => r.symbol));
}

/** Satellite sleeve: replace the account's active satellite symbols (satelliteService). */
async function setSatelliteSymbols(userId, symbols) {
    await ensureTable();
    const uid = String(userId);
    const list = [...new Set(symbols.map(x => String(x).toUpperCase()))];
    for (const sym of list) {
        await query(
            `INSERT INTO core_holdings (user_id, symbol, target_pct, active, note, sleeve) VALUES ($1, $2, 0, true, 'momentum satellite', 'satellite')
             ON CONFLICT (user_id, symbol) DO UPDATE SET active = true, sleeve = 'satellite', target_pct = 0, note = 'momentum satellite'
             WHERE core_holdings.sleeve = 'satellite' OR NOT core_holdings.active`,
            [uid, sym]
        );
    }
    await query(`UPDATE core_holdings SET active = false WHERE user_id = $1 AND sleeve = 'satellite' AND NOT (symbol = ANY($2))`, [uid, list]);
    _cache.delete(uid);
}

function _clearCache() { _cache.clear(); }

async function getSettings(userId) {
    await ensureTable();
    const r = await query(`SELECT enabled, cash_reserve_pct::float AS "cashReservePct" FROM core_settings WHERE user_id = $1`, [String(userId)]);
    return r.rows[0] || { enabled: false, cashReservePct: 25 };
}

async function setEnabled(userId, enabled) {
    await ensureTable();
    await query(
        `INSERT INTO core_settings (user_id, enabled) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
        [String(userId), !!enabled]
    );
    return getSettings(userId);
}

const MAX_SYMBOLS = 10, MAX_TOTAL_PCT = 80, MAX_SINGLE_PCT = 50;

/**
 * Replace the account's core list (Settings -> Save). Guards:
 *   - total <= 80% of equity, any one symbol <= 50%, at most 10 symbols, valid tickers;
 *   - a symbol the SWING bot currently holds can't become core (its swing stop is still
 *     resting at the broker and would sell the "core" position);
 *   - removing a symbol that is still held needs explicit release — removal hands the
 *     position to the swing bot, which may stop it out or sell it. Use 0% to keep holding.
 */
async function saveConfig(userId, { cashReservePct, holdings = [], releaseSymbols = [] } = {}) {
    await ensureTable();
    const uid = String(userId);
    const list = holdings.map(h => ({ symbol: String(h.symbol || '').trim().toUpperCase(), targetPct: Number(h.targetPct) }));
    const errors = [];
    if (list.length > MAX_SYMBOLS) errors.push(`At most ${MAX_SYMBOLS} core symbols.`);
    for (const h of list) {
        if (!/^[A-Z][A-Z.]{0,5}$/.test(h.symbol)) errors.push(`"${h.symbol}" is not a valid stock symbol.`);
        if (!(h.targetPct >= 0 && h.targetPct <= MAX_SINGLE_PCT)) errors.push(`${h.symbol}: target must be 0-${MAX_SINGLE_PCT}%.`);
    }
    if (new Set(list.map(h => h.symbol)).size !== list.length) errors.push('Each symbol can appear only once.');
    const total = list.reduce((sum, h) => sum + (h.targetPct || 0), 0);
    if (total > MAX_TOTAL_PCT) errors.push(`Total target is ${total}% — keep it at ${MAX_TOTAL_PCT}% or less so the swing bot has room.`);
    if (cashReservePct != null && !(cashReservePct >= 10 && cashReservePct <= 80)) errors.push('Cash reserve must be 10-80%.');

    const current = await query(`SELECT symbol FROM core_holdings WHERE user_id = $1 AND active AND sleeve = 'core'`, [uid]);
    const currentSet = new Set(current.rows.map(r => r.symbol.toUpperCase()));
    const held = await query(`SELECT UPPER(symbol) AS symbol FROM holdings WHERE user_id = $1 AND quantity > 0`, [uid]);
    const heldSet = new Set(held.rows.map(r => r.symbol));
    for (const h of list) {
        if (!currentSet.has(h.symbol) && heldSet.has(h.symbol)) {
            errors.push(`${h.symbol} is an open swing-bot position right now — add it to core after that swing trade closes.`);
        }
    }
    const newSet = new Set(list.map(h => h.symbol));
    const release = new Set(releaseSymbols.map(x => String(x).toUpperCase()));
    for (const sym of currentSet) {
        if (!newSet.has(sym) && heldSet.has(sym) && !release.has(sym)) {
            errors.push(`${sym} is still held. Set it to 0% to keep holding without buying more, or confirm release to hand it to the swing bot (which may set a stop or sell it).`);
        }
    }
    if (errors.length) { const e = new Error(errors.join(' ')); e.status = 400; e.errors = errors; throw e; }

    for (const h of list) {
        await query(
            `INSERT INTO core_holdings (user_id, symbol, target_pct, active) VALUES ($1, $2, $3, true)
             ON CONFLICT (user_id, symbol) DO UPDATE SET target_pct = EXCLUDED.target_pct, active = true, sleeve = 'core'`,
            [uid, h.symbol, h.targetPct]
        );
    }
    const removed = [...currentSet].filter(x => !newSet.has(x));
    if (removed.length) await query(`UPDATE core_holdings SET active = false WHERE user_id = $1 AND sleeve = 'core' AND symbol = ANY($2)`, [uid, removed]);
    if (cashReservePct != null) {
        await query(
            `INSERT INTO core_settings (user_id, cash_reserve_pct) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET cash_reserve_pct = EXCLUDED.cash_reserve_pct, updated_at = NOW()`,
            [uid, cashReservePct]
        );
    }
    _cache.delete(uid);
    logger.info('[Core] Settings saved', { userId: uid, holdings: list, removed, cashReservePct });
    return { holdings: await getCoreRows(uid), settings: await getSettings(uid), released: removed };
}

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
    const { cashReservePct } = await getSettings(userId);
    const reserve = equity * cashReservePct / 100; // kept free for swing trades
    // Per-order cap: the platform-wide MAX_BOT_INVESTMENT_USD only. The account's
    // maxOrderNotional is a SWING-trade size limit (paper $500, kmadined $900) — applied to
    // core it made SPY (~$770/share) unbuyable forever (found 2026-10-19, first live run).
    // Core is already bounded by its target %, the cash reserve and this cap; large targets
    // still build over several days.
    const maxOrderUsd = parseFloat(process.env.MAX_BOT_INVESTMENT_USD || '5000') * 0.98;
    const positions = await brokerService.getPositions(userId);
    const held = Object.fromEntries(positions.map(p => [String(p.symbol).toUpperCase(), parseFloat(p.marketValue || 0)]));
    const actions = [];

    for (const row of rows) {
        if (!(row.targetPct > 0)) { actions.push({ symbol: row.symbol, action: 'hold_only' }); continue; }
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
            const res = await brokerService.buyMarket(userId, row.symbol, qty, {
                executedBy: 'CORE', reason: 'Core holding rebalance',
                safetyOptions: { enforceNotionalLimit: false }, // swing per-order limit doesn't apply to core (see maxOrderUsd)
            });
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
    await ensureTable();
    const ids = (await query(`SELECT user_id FROM core_settings WHERE enabled`)).rows.map(r => r.user_id);
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

/** Everything the Settings screen shows. */
async function getStatus(userId) {
    const [settings, rows] = await Promise.all([getSettings(userId), getCoreRows(userId)]);
    const summary = await coreSummary(userId).catch(() => null);
    let equity = null, cash = null;
    try {
        const acct = await require('./brokerService').getAccountInfo(userId);
        equity = acct.portfolioValue; cash = acct.cashBalance;
    } catch (_) { /* the screen still loads without live account numbers */ }
    const bySym = Object.fromEntries((summary?.positions || []).map(p => [p.symbol.toUpperCase(), p]));
    return {
        settings,
        equity, cash,
        totalTargetPct: rows.reduce((sum, r) => sum + r.targetPct, 0),
        holdings: rows.map(r => {
            const p = bySym[r.symbol];
            return {
                symbol: r.symbol, targetPct: r.targetPct, note: r.note || null,
                targetUsd: equity != null ? +(equity * r.targetPct / 100).toFixed(2) : null,
                qty: p?.qty ?? 0, avgPrice: p?.avg ?? null, price: p?.px ?? null,
                value: p?.mv ?? 0, unrealizedPl: p?.pl ?? 0,
                currentPct: equity ? +((p?.mv ?? 0) / equity * 100).toFixed(1) : null,
            };
        }),
        totals: summary ? { value: summary.value, unrealizedPl: summary.unrealizedPl, cost: summary.cost } : { value: 0, unrealizedPl: 0, cost: 0 },
        limits: { maxSymbols: MAX_SYMBOLS, maxTotalPct: MAX_TOTAL_PCT, maxSinglePct: MAX_SINGLE_PCT },
    };
}

module.exports = {
    ensureTable, getCoreRows, getCoreSymbols, setSatelliteSymbols, getSettings, setEnabled, saveConfig, getStatus,
    rebalanceCore, runDailyRebalance, coreSummary, _clearCache,
};
