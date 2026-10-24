/**
 * Momentum satellite — PAPER ONLY test (built 2026-10-18, the user asked for it).
 *
 * Rule (the one tested): each month, among the 300 most-traded non-fund stocks ($20+, with a
 * full year of history), hold the 10 with the strongest 12-month return skipping the latest
 * month ("12-1 momentum"), equal weight, SATELLITE_PCT (10%) of the account.
 *
 * Evidence and the reason it is only a test: Feb 2024 → Sep 2026 it returned +395% vs SPY
 * +61%, BUT without each month's single best stock it was +63% (≈ SPY) — the edge came from a
 * few rockets (MSTR, APP, BE...), single names moved −44%..+119% in a month, worst drop −28%
 * (SPY −7%), in an unusually strong momentum era, on survivor-only data. So: paper, small,
 * judged against SPY month by month.
 *
 * Satellite positions are registered as the 'satellite' sleeve in core_holdings, so the swing
 * bot never stops or sells them, and it never buys a symbol the swing bot or core already holds.
 * HARD GUARD: refuses non-paper accounts. Enabled per account via SATELLITE_USER_IDS.
 */
const axios = require('axios');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const N_PICKS = 10, UNIVERSE = 300, MIN_PRICE = 20;
const pct = () => parseFloat(process.env.SATELLITE_PCT || '10');
const userIds = () => (process.env.SATELLITE_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const etToday = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

let _ready = false;
async function ensureTables() {
    if (_ready) return;
    await query(`CREATE TABLE IF NOT EXISTS fund_symbols (symbol TEXT PRIMARY KEY, type TEXT, refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await query(`
        CREATE TABLE IF NOT EXISTS satellite_rebalances (
            id          SERIAL      PRIMARY KEY,
            user_id     TEXT        NOT NULL,
            month       TEXT        NOT NULL,
            as_of       DATE        NOT NULL,
            picks       JSONB       NOT NULL,
            actions     JSONB       NOT NULL DEFAULT '[]',
            equity      NUMERIC,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (user_id, month)
        )`);
    _ready = true;
}

/** Official ETF/ETN/ETV list from Polygon, refreshed when older than 30 days. Never throws. */
async function refreshFundList() {
    try {
        await ensureTables();
        const age = await query(`SELECT MAX(refreshed_at) AS t, COUNT(*)::int AS n FROM fund_symbols`);
        if (age.rows[0].n > 1000 && Date.now() - new Date(age.rows[0].t).getTime() < 30 * 86400000) return;
        const key = process.env.POLYGON_API_KEY;
        if (!key) return;
        for (const type of ['ETF', 'ETN', 'ETV']) {
            let url = 'https://api.polygon.io/v3/reference/tickers';
            let params = { type, market: 'stocks', active: true, limit: 1000, apiKey: key };
            while (url) {
                const r = await axios.get(url, { params, timeout: 30000 });
                const rows = (r.data.results || []).map(t => t.ticker);
                for (let i = 0; i < rows.length; i += 500) {
                    const chunk = rows.slice(i, i + 500);
                    await query(`INSERT INTO fund_symbols (symbol, type) SELECT unnest($1::text[]), $2
                                 ON CONFLICT (symbol) DO UPDATE SET type = EXCLUDED.type, refreshed_at = NOW()`, [chunk, type]);
                }
                url = r.data.next_url || null;
                params = { apiKey: key };
                if (url) await new Promise(res => setTimeout(res, 13000)); // free tier: 5 calls/min
            }
        }
    } catch (err) {
        logger.warn('[Satellite] Fund list refresh failed (using the stored list)', { error: err.message });
    }
}

/** The 10 picks from history_bars as of its latest bar. */
async function computePicks({ exclude = new Set() } = {}) {
    const r = await query(`
        WITH b AS (
            SELECT symbol, c, v, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY d DESC) AS rn
            FROM history_bars WHERE d >= CURRENT_DATE - 420
        )
        SELECT b.symbol,
               MAX(c) FILTER (WHERE rn = 1)::float   AS c0,
               MAX(c) FILTER (WHERE rn = 22)::float  AS c21,
               MAX(c) FILTER (WHERE rn = 253)::float AS c252,
               AVG(c * v) FILTER (WHERE rn <= 60)::float AS dv
        FROM b
        WHERE NOT EXISTS (SELECT 1 FROM fund_symbols f WHERE f.symbol = b.symbol)
        GROUP BY b.symbol`);
    const uni = r.rows.filter(x => x.c0 >= MIN_PRICE && x.c21 > 0 && x.c252 > 0 && x.dv > 0 && x.symbol !== 'SPY')
        .sort((a, b) => b.dv - a.dv).slice(0, UNIVERSE);
    return uni.map(x => ({ symbol: x.symbol, price: x.c0, mom: x.c21 / x.c252 - 1 }))
        .filter(x => !exclude.has(x.symbol))
        .sort((a, b) => b.mom - a.mom).slice(0, N_PICKS);
}

async function _paperOnly(userId) {
    const c = await require('./userDatabaseService').getUserAlpacaCredentials(userId);
    if (c.isPaper === false) throw new Error('momentum satellite is PAPER ONLY — refusing a live account');
}

/** Monthly rebalance for one account. Returns the actions taken. */
async function rebalance(userId, now = new Date()) {
    await ensureTables();
    await _paperOnly(userId);
    const month = etToday(now).slice(0, 7);
    const done = await query(`SELECT 1 FROM satellite_rebalances WHERE user_id = $1 AND month = $2`, [String(userId), month]);
    if (done.rows.length) return null;

    const core = require('./coreHoldingsService');
    const broker = require('./brokerService');
    await refreshFundList();
    await require('./historyBarsService').appendRecent({ now }); // fresh prices for the ranking

    const allRows = await query(`SELECT symbol, sleeve FROM core_holdings WHERE user_id = $1 AND active`, [String(userId)]);
    const coreSyms = new Set(allRows.rows.filter(x => x.sleeve !== 'satellite').map(x => x.symbol.toUpperCase()));
    const currentSat = new Set(allRows.rows.filter(x => x.sleeve === 'satellite').map(x => x.symbol.toUpperCase()));
    const positions = await broker.getPositions(userId);
    const posBySym = Object.fromEntries(positions.map(p => [String(p.symbol).toUpperCase(), p]));
    // anything held that isn't core/satellite belongs to the swing bot — never mix
    const swingHeld = new Set(Object.keys(posBySym).filter(s => !coreSyms.has(s) && !currentSat.has(s)));

    const picks = await computePicks({ exclude: new Set([...coreSyms, ...swingHeld]) });
    if (picks.length < N_PICKS) throw new Error(`only ${picks.length} picks available`);
    const pickSet = new Set(picks.map(p => p.symbol));

    // protect everything we hold or are about to hold before touching orders
    await core.setSatelliteSymbols(userId, [...pickSet, ...currentSat]);

    const account = await broker.getAccountInfo(userId);
    const perName = account.portfolioValue * pct() / 100 / N_PICKS;
    const actions = [];
    for (const sym of currentSat) {
        if (pickSet.has(sym)) continue;
        const p = posBySym[sym];
        if (!p || !(parseFloat(p.qty) > 0)) continue;
        try {
            const res = await broker.sellMarket(userId, sym, parseFloat(p.qty), { executedBy: 'SATELLITE', reason: 'Satellite rebalance' });
            actions.push({ sym, action: 'sell', qty: res.filledQty ?? p.qty, status: res.status });
        } catch (err) {
            actions.push({ sym, action: 'sell_failed', error: err.message });
        }
    }
    for (const pick of picks) {
        if (posBySym[pick.symbol]) { actions.push({ sym: pick.symbol, action: 'keep' }); continue; }
        const qty = Math.floor(perName / (pick.price * 1.01));
        if (qty < 1) { actions.push({ sym: pick.symbol, action: 'skip_price', price: pick.price }); continue; }
        try {
            // The account's swing per-order limit (paper: $500) doesn't apply: each satellite name
            // is SATELLITE_PCT/10 of the account (~$1,070 on paper). MAX_BOT_INVESTMENT_USD still does.
            const res = await broker.buyMarket(userId, pick.symbol, qty, {
                executedBy: 'SATELLITE', reason: 'Satellite rebalance', safetyOptions: { enforceNotionalLimit: false },
            });
            actions.push({ sym: pick.symbol, action: 'buy', qty: res.filledQty, price: res.filledAvgPrice, status: res.status });
        } catch (err) {
            actions.push({ sym: pick.symbol, action: 'buy_failed', error: err.message });
        }
    }
    // keep protecting picks + anything whose sell didn't go through
    const stillHeld = actions.filter(a => a.action === 'sell_failed').map(a => a.sym);
    await core.setSatelliteSymbols(userId, [...pickSet, ...stillHeld]);

    await query(`INSERT INTO satellite_rebalances (user_id, month, as_of, picks, actions, equity) VALUES ($1, $2, $3::date, $4, $5, $6)
                 ON CONFLICT (user_id, month) DO NOTHING`,
        [String(userId), month, etToday(now), JSON.stringify(picks), JSON.stringify(actions), account.portfolioValue]);
    logger.info('[Satellite] Monthly rebalance done', { userId, month, picks: picks.map(p => p.symbol), actions });
    return { picks, actions };
}

/** Scheduler tick: first chance each month (trading hours, after 10:30 ET). */
const _triedOn = new Set();
async function runTick(now = new Date()) {
    const ids = userIds();
    if (!ids.length) return;
    const { isMarketOpen } = require('../utils/marketCalendar');
    if (!isMarketOpen(now)) return;
    const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
    const etMin = parseInt(et.find(p => p.type === 'hour').value, 10) * 60 + parseInt(et.find(p => p.type === 'minute').value, 10);
    if (etMin < 10 * 60 + 30 || etMin > 15 * 60) return;
    for (const id of ids) {
        const key = `${id}:${etToday(now)}`;
        if (_triedOn.has(key)) continue; // at most one attempt per account per day
        _triedOn.add(key);
        try { await rebalance(id, now); } catch (err) { logger.warn('[Satellite] Rebalance failed (will retry tomorrow)', { userId: id, error: err.message }); }
    }
}

/**
 * Basket vs SPY since the first rebalance, from logged picks and history_bars: each month's
 * equal-weight return of that month's picks (from the rebalance day's close to the next
 * rebalance or the latest bar), compounded.
 */
async function performance() {
    await ensureTables();
    const r = await query(`SELECT as_of::text AS d, picks FROM satellite_rebalances ORDER BY as_of`);
    if (!r.rows.length) return null;
    // daily_bars first (refreshed daily); history_bars only grows on Saturdays, which made this
    // read +0% vs +0% all week (2026-10-24).
    const close = async (sym, d) => (await query(
        `SELECT c FROM (SELECT close::float AS c, timestamp::date AS d FROM daily_bars WHERE symbol = $1 AND timestamp::date <= $2::date
                        UNION ALL SELECT c::float, d FROM history_bars WHERE symbol = $1 AND d <= $2::date) x
         ORDER BY d DESC LIMIT 1`, [sym, d])).rows[0]?.c;
    const latest = (await query(
        `SELECT GREATEST((SELECT MAX(timestamp)::date FROM daily_bars WHERE symbol = 'SPY'), (SELECT MAX(d) FROM history_bars WHERE symbol = 'SPY'))::text AS d`)).rows[0].d;
    let basket = 1, spy = 1;
    for (let i = 0; i < r.rows.length; i++) {
        const from = r.rows[i].d, to = r.rows[i + 1]?.d || latest;
        if (to <= from) continue;
        const rets = [];
        for (const p of r.rows[i].picks) {
            const a = await close(p.symbol, from), b = await close(p.symbol, to);
            if (a > 0 && b > 0) rets.push(b / a - 1);
        }
        if (rets.length) basket *= 1 + rets.reduce((s, v) => s + v, 0) / rets.length;
        const s0 = await close('SPY', from), s1 = await close('SPY', to);
        if (s0 > 0 && s1 > 0) spy *= s1 / s0;
    }
    return { since: r.rows[0].d, months: r.rows.length, basketPct: (basket - 1) * 100, spyPct: (spy - 1) * 100,
             currentPicks: r.rows[r.rows.length - 1].picks.map(p => p.symbol) };
}

module.exports = { computePicks, rebalance, runTick, performance, refreshFundList, ensureTables, N_PICKS };
