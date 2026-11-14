/**
 * Options lab (2026-11-14) — research only. Cash-secured put (CSP) backtests on REAL historical
 * option trades, plus a replay of our own put trades. Never places orders.
 *
 * Data honesty (from the 2026-11-14 data audit):
 *   - Alpaca has daily option bars (real trades: OHLCV) from about Feb 2024 and lists expired
 *     contracts. It has NO historical bid/ask and NO historical Greeks/IV. Nothing is invented:
 *       · prices are real daily closes; a sale fills at close × (1 − HAIRCUT), a buy-back at
 *         close × (1 + HAIRCUT) — a stand-in for the bid/ask spread we can't see;
 *       · IV and delta are worked out from that real close (Black-Scholes), never assumed;
 *       · a contract with no trade on a day can't be checked that day (no made-up marks).
 *   - Assignment: an in-the-money put at expiry takes the shares at the strike; they are sold at
 *     the next open, so the full lifecycle loss counts, not just the option.
 *
 * Validation: weekly entries (Feb 2024 →); per-week average return on collateral minus T-bills
 * for the days held; train before HOLDOUT_START, holdout after; Newey-West t (entries overlap);
 * Benjamini-Hochberg q across every variant tested. Pass rules follow the options-lab spec.
 *
 * Safety: the only network calls are GETs to two read-only market-data paths (labGet guard),
 * with the server's paper-account data keys. No order, position or config code is reachable.
 */
const axios = require('axios');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');
const { nwTStat, normCdf, bhQ } = require('./researchLabService');

const DATA = 'https://data.alpaca.markets';
const TRADING = (process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets/v2').replace(/\/v2\/?$/, '');
const HOLDOUT_START = '2025-07-01';
const HAIRCUT = 0.05;          // 5% of the option price each way, stand-in for the unseen spread
const FEE_PER_SHARE = 0.0005;  // ~$0.05 regulatory fees per contract per side
const RF = 0.04;               // T-bill rate for the cash the collateral could have earned
const ENTRY_DTE = [25, 45];    // monthly expiry inside this window
const PASS = { trades: 100, dates: 40, pf: 1.15, sharpe: 1.0, fdrQ: 0.10, holdT: 1.0 };

// ── safety guard ─────────────────────────────────────────────────────────────
const ALLOWED = [`${DATA}/v1beta1/options/bars`, `${TRADING}/v2/options/contracts`];
let _lastCall = 0;
async function labGet(url, params) {
    if (!ALLOWED.includes(url)) throw new Error(`optionsLab: blocked request to ${url}`);
    const wait = 320 - (Date.now() - _lastCall); // ≤ ~190 requests/min, under Alpaca's 200
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastCall = Date.now();
    const headers = { 'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY };
    for (let attempt = 0; ; attempt++) {
        try { return (await axios.get(url, { headers, params, timeout: 30000 })).data; }
        catch (e) {
            if (attempt < 3 && (e.response?.status === 429 || !e.response)) { await new Promise(r => setTimeout(r, 5000 * (attempt + 1))); continue; }
            throw e;
        }
    }
}

// ── Black-Scholes (puts) ─────────────────────────────────────────────────────
function d1d2(S, K, T, r, v) {
    const d1 = (Math.log(S / K) + (r + v * v / 2) * T) / (v * Math.sqrt(T));
    return [d1, d1 - v * Math.sqrt(T)];
}
function putPrice(S, K, T, r, v) {
    if (T <= 0) return Math.max(0, K - S);
    const [d1, d2] = d1d2(S, K, T, r, v);
    return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}
function putDelta(S, K, T, r, v) { return normCdf(d1d2(S, K, T, r, v)[0]) - 1; }
/** IV from a put price by bisection; null when the price is below intrinsic or out of range. */
function impliedVol(price, S, K, T, r = RF) {
    if (!(price > 0 && S > 0 && K > 0 && T > 0)) return null;
    if (price < Math.max(0, K * Math.exp(-r * T) - S) - 1e-6) return null;
    let lo = 0.01, hi = 5;
    if (putPrice(S, K, T, r, hi) < price) return null;
    for (let k = 0; k < 80; k++) {
        const mid = (lo + hi) / 2;
        if (putPrice(S, K, T, r, mid) > price) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
}

// ── dates ────────────────────────────────────────────────────────────────────
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.round((new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 86400000);
/** Third Friday of a month (standard monthly expiry). */
function thirdFriday(y, m) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const day = 1 + ((5 - first + 7) % 7) + 14;
    return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
const occ = (u, exp, k) => `${u}${exp.slice(2).replace(/-/g, '')}P${String(Math.round(k * 1000)).padStart(8, '0')}`;

// ── storage ──────────────────────────────────────────────────────────────────
let _ready = false;
async function ensureTables() {
    if (_ready) return;
    await query(`CREATE TABLE IF NOT EXISTS options_hist_contracts (
        underlying TEXT NOT NULL, expiry DATE NOT NULL, strike NUMERIC NOT NULL, contract TEXT NOT NULL,
        PRIMARY KEY (underlying, expiry, strike))`);
    await query(`CREATE TABLE IF NOT EXISTS options_hist_listed (underlying TEXT NOT NULL, expiry DATE NOT NULL, n INT, fetched_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (underlying, expiry))`);
    await query(`CREATE TABLE IF NOT EXISTS options_hist_bars (
        contract TEXT NOT NULL, d DATE NOT NULL, o NUMERIC, h NUMERIC, l NUMERIC, c NUMERIC, v INT, n INT,
        PRIMARY KEY (contract, d))`);
    await query(`CREATE TABLE IF NOT EXISTS options_hist_fetched (contract TEXT PRIMARY KEY, bars INT, fetched_at TIMESTAMPTZ DEFAULT NOW())`);
    await query(`CREATE TABLE IF NOT EXISTS options_lab_runs (
        id SERIAL PRIMARY KEY, kind TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), result JSONB NOT NULL)`);
    _ready = true;
}

/** Put strikes listed for one underlying/expiry (cached). */
async function listStrikes(underlying, expiry) {
    await ensureTables();
    const seen = await query(`SELECT 1 FROM options_hist_listed WHERE underlying = $1 AND expiry = $2`, [underlying, expiry]);
    if (!seen.rows.length) {
        const today = new Date().toISOString().slice(0, 10);
        const out = [];
        let token = null;
        do {
            const d = await labGet(`${TRADING}/v2/options/contracts`, {
                underlying_symbols: underlying, expiration_date: expiry, type: 'put',
                status: expiry < today ? 'inactive' : 'active', limit: 10000, ...(token ? { page_token: token } : {}) });
            out.push(...(d.option_contracts || []));
            token = d.next_page_token || null;
        } while (token);
        for (const c of out) {
            await query(`INSERT INTO options_hist_contracts (underlying, expiry, strike, contract) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
                [underlying, expiry, Number(c.strike_price), c.symbol]);
        }
        await query(`INSERT INTO options_hist_listed (underlying, expiry, n) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [underlying, expiry, out.length]);
    }
    // Adjusted contracts after corporate actions (e.g. "1AAPL…") have non-standard deliverables
    // and the bars endpoint rejects their symbols: standard contracts only.
    return (await query(`SELECT strike::float AS k, contract FROM options_hist_contracts WHERE underlying = $1 AND expiry = $2 ORDER BY strike`, [underlying, expiry]))
        .rows.filter(r => /^[A-Z]{1,5}\d{6,7}[CP]\d{8}$/.test(r.contract));
}

/** Daily bars for contracts (cached; fetched once per contract over its whole life). */
async function ensureBars(contracts, start) {
    await ensureTables();
    if (!contracts.length) return;
    const have = new Set((await query(`SELECT contract FROM options_hist_fetched WHERE contract = ANY($1)`, [contracts])).rows.map(r => r.contract));
    const need = contracts.filter(c => !have.has(c));
    for (let i = 0; i < need.length; i += 100) {
        const chunk = need.slice(i, i + 100);
        const got = new Map(chunk.map(c => [c, 0]));
        let token = null;
        do {
            const d = await labGet(`${DATA}/v1beta1/options/bars`, { symbols: chunk.join(','), timeframe: '1Day', start, limit: 10000, ...(token ? { page_token: token } : {}) });
            for (const [sym, bars] of Object.entries(d.bars || {})) {
                for (const b of bars) {
                    await query(`INSERT INTO options_hist_bars (contract, d, o, h, l, c, v, n) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
                        [sym, b.t.slice(0, 10), b.o, b.h, b.l, b.c, b.v, b.n]);
                }
                got.set(sym, (got.get(sym) || 0) + bars.length);
            }
            token = d.next_page_token || null;
        } while (token);
        for (const [c, n] of got) await query(`INSERT INTO options_hist_fetched (contract, bars) VALUES ($1,$2) ON CONFLICT (contract) DO UPDATE SET bars = EXCLUDED.bars, fetched_at = NOW()`, [c, n]);
    }
}

async function barsFor(contracts) {
    const r = await query(`SELECT contract, d::text AS d, c::float AS c, v FROM options_hist_bars WHERE contract = ANY($1) ORDER BY contract, d`, [contracts]);
    const m = new Map();
    for (const row of r.rows) { if (!m.has(row.contract)) m.set(row.contract, new Map()); m.get(row.contract).set(row.d, row); }
    return m;
}

async function stockBars(symbols, from) {
    const r = await query(`SELECT symbol, d::text AS d, o::float AS o, c::float AS c FROM history_bars WHERE symbol = ANY($1) AND d >= $2 ORDER BY symbol, d`, [symbols, from]);
    const m = new Map();
    for (const row of r.rows) { if (!m.has(row.symbol)) m.set(row.symbol, []); m.get(row.symbol).push(row); }
    return m;
}

// ── one trade's life ─────────────────────────────────────────────────────────
/**
 * Simulate one short put from the entry day to exit. exit: { tp (fraction of premium, e.g. 0.5
 * = buy back at 50% of it) | null, stop (multiple, e.g. 3) | null, closeDte | null }.
 * stock: [{d, o, c}] for the underlying; opt: Map d → {c}. Returns null when the entry can't fill.
 */
function simulate({ entryDay, expiry, strike, premium, stock, opt, exit }) {
    const sIdx = new Map(stock.map((b, i) => [b.d, i]));
    const i0 = sIdx.get(entryDay);
    if (i0 == null || !(premium > 0)) return null;
    let worstMark = premium, minPrice = stock[i0].c, noTradeDays = 0, checked = 0;
    for (let i = i0 + 1; i < stock.length && stock[i].d <= expiry; i++) {
        const d = stock[i].d, dte = dayDiff(expiry, d);
        minPrice = Math.min(minPrice, stock[i].c);
        const bar = opt.get(d);
        if (d === expiry) break;
        if (!bar) { noTradeDays++; continue; }
        checked++;
        const mark = bar.c * (1 + HAIRCUT) + FEE_PER_SHARE;
        worstMark = Math.max(worstMark, mark);
        const out = reason => ({ exitDay: d, reason, cost: mark, days: dayDiff(d, entryDay) });
        if (exit.stop && mark >= exit.stop * premium) return { ...out('stop'), worstMark, minPrice, noTradeDays, checked };
        if (exit.tp != null && mark <= exit.tp * premium) return { ...out('take profit'), worstMark, minPrice, noTradeDays, checked };
        if (exit.closeDte != null && dte <= exit.closeDte) return { ...out(`close at ${exit.closeDte} days left`), worstMark, minPrice, noTradeDays, checked };
    }
    // expiry: settle on the underlying's close; assignment sells the shares at the next open
    const ie = sIdx.get(expiry) ?? [...sIdx.keys()].filter(d => d <= expiry).map(d => sIdx.get(d)).pop();
    if (ie == null || stock[ie].d < addDays(expiry, -4)) return null; // no settlement data yet
    const sExp = stock[ie].c;
    if (sExp >= strike) return { exitDay: stock[ie].d, reason: 'expired worthless', cost: 0, days: dayDiff(stock[ie].d, entryDay), worstMark, minPrice, noTradeDays, checked };
    const next = stock[ie + 1];
    if (!next) return null; // assignment not settled yet
    // short put assigned: pay K for shares worth `next.o` at the next open → cost = K − next.o
    return { exitDay: next.d, reason: 'assigned', cost: Math.max(0, strike - next.o), days: dayDiff(next.d, entryDay), worstMark, minPrice, noTradeDays, checked, assigned: true };
}

function tradeResult(sim, premium, strike) {
    const pnlPerShare = premium - sim.cost;
    const days = Math.max(1, sim.days);
    const rocPct = pnlPerShare / strike * 100;
    return { ...sim, pnl: +(pnlPerShare * 100).toFixed(2), rocPct: +rocPct.toFixed(3), exRocPct: +(rocPct - RF * days / 365 * 100).toFixed(3) };
}

// ── own-trade replay (first acceptance test) ────────────────────────────────
const POLICIES = {
    'our rules (50% profit · 3× stop · close at 7 days)': { tp: 0.5, stop: 3, closeDte: 7 },
    '50% profit, otherwise hold to expiry': { tp: 0.5, stop: null, closeDte: null },
    'hold to expiry (no exits)': { tp: null, stop: null, closeDte: null },
    '3× stop only, otherwise hold': { tp: null, stop: 3, closeDte: null },
    '50% profit · 2× stop': { tp: 0.5, stop: 2, closeDte: null },
};

async function replayOwnTrades() {
    await ensureTables();
    const trades = (await query(`SELECT id, contract, underlying, strike::float AS strike, expiry::text AS expiry, entry_premium::float AS premium,
            entry_delta::float AS delta, status, close_reason, pnl::float AS pnl,
            (opened_at AT TIME ZONE 'America/New_York')::date::text AS opened
        FROM options_income_trades WHERE status IN ('open','closed','expired','assigned') AND entry_premium > 0 ORDER BY id`)).rows;
    if (!trades.length) return { trades: [] };
    await ensureBars(trades.map(t => t.contract), addDays(trades[0].opened, -5));
    const ob = await barsFor(trades.map(t => t.contract));
    const sb = await stockBars([...new Set(trades.map(t => t.underlying))], addDays(trades[0].opened, -40));
    const out = [];
    for (const t of trades) {
        const stock = sb.get(t.underlying) || [];
        const opt = ob.get(t.contract) || new Map();
        const ent = stock.find(b => b.d >= t.opened);
        if (!ent) continue;
        const T = Math.max(1, dayDiff(t.expiry, ent.d)) / 365;
        const iv = impliedVol(t.premium, ent.c, t.strike, T);
        // realised volatility over the 20 days before entry, for "was the premium rich?"
        const k = stock.indexOf(ent), win = stock.slice(Math.max(0, k - 20), k + 1);
        const rets = win.slice(1).map((b, i) => Math.log(b.c / win[i].c));
        const rv = rets.length > 5 ? Math.sqrt(rets.reduce((s, x) => s + x * x, 0) / rets.length * 252) : null;
        const policies = {};
        for (const [name, exit] of Object.entries(POLICIES)) {
            const sim = simulate({ entryDay: ent.d, expiry: t.expiry, strike: t.strike, premium: t.premium, stock, opt, exit });
            policies[name] = sim ? tradeResult(sim, t.premium, t.strike) : { open: true };
        }
        const after = stock.filter(b => b.d > ent.d && b.d <= t.expiry);
        out.push({
            id: t.id, contract: t.contract, underlying: t.underlying, strike: t.strike, expiry: t.expiry, opened: ent.d,
            premium: t.premium, collateral: t.strike * 100, stockAtOpen: ent.c, entryDelta: t.delta,
            ivAtOpen: iv != null ? +(iv * 100).toFixed(1) : null, rv20AtOpen: rv != null ? +(rv * 100).toFixed(1) : null,
            maxDropPct: after.length ? +((Math.min(...after.map(b => b.c)) / ent.c - 1) * 100).toFixed(1) : null,
            optionTradeDays: [...opt.keys()].filter(d => d > ent.d).length,
            actual: { status: t.status, reason: t.close_reason, pnl: t.pnl },
            policies,
        });
    }
    const totals = {};
    for (const name of Object.keys(POLICIES)) {
        const done = out.map(o => o.policies[name]).filter(p => !p.open);
        totals[name] = { settled: done.length, pnl: +done.reduce((s, p) => s + p.pnl, 0).toFixed(2), wins: done.filter(p => p.pnl > 0).length };
    }
    const actualClosed = out.filter(o => o.actual.pnl != null);
    totals.actual = { settled: actualClosed.length, pnl: +actualClosed.reduce((s, o) => s + o.actual.pnl, 0).toFixed(2), wins: actualClosed.filter(o => o.actual.pnl > 0).length };
    const result = { trades: out, totals, haircutPct: HAIRCUT * 100, note: 'Daily closing prices of real option trades; buy-backs at close + 5% for the unseen spread.' };
    await query(`INSERT INTO options_lab_runs (kind, result) VALUES ('own_trades', $1)`, [JSON.stringify(result)]);
    return result;
}

// ── watchlist CSP backtest ──────────────────────────────────────────────────
const DELTAS = [0.15, 0.20, 0.25, 0.30];
const EXITS = {
    current: { tp: 0.5, stop: 3, closeDte: 7 },
    tp50_hold: { tp: 0.5, stop: null, closeDte: null },
    hold: { tp: null, stop: null, closeDte: null },
    tp50_stop2: { tp: 0.5, stop: 2, closeDte: null },
    tp50_close14: { tp: 0.5, stop: null, closeDte: 14 },
};
const FILTERS = {
    none: () => true,
    uptrend: e => e.sma200 != null && e.stock > e.sma200,
    no_earnings: e => !e.earningsInside,
    iv_rich: e => e.rv20 != null && e.iv >= 1.2 * e.rv20,
    // Our own 2026 puts traded 1-4 times a day; paper fills on such contracts used swinging
    // indicative quotes (BMY stop filled at ~2× the real trade price). Liquid = 20+ contracts that day.
    liquid: e => e.vol >= 20,
};

/** Entry candidates: first trading day of each week, the monthly expiry 25-45 days out. */
function entryPlan(calendar, from, to) {
    const plan = [];
    let lastWeek = null;
    for (const d of calendar) {
        if (d < from || d > to) continue;
        const wk = (() => { const x = new Date(d + 'T12:00:00Z'); const day = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - day); return x.toISOString().slice(0, 10); })();
        if (wk === lastWeek) continue;
        lastWeek = wk;
        const [y, m] = d.split('-').map(Number);
        for (const [yy, mm] of [[y, m], [m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1], [m >= 11 ? y + 1 : y, ((m + 1) % 12) + 1]]) {
            const exp = thirdFriday(yy, mm), dte = dayDiff(exp, d);
            if (dte >= ENTRY_DTE[0] && dte <= ENTRY_DTE[1]) { plan.push({ d, expiry: exp, dte }); break; }
        }
    }
    return plan;
}

async function _earningsDays(symbols) {
    const r = await query(`SELECT symbol, (created_at AT TIME ZONE 'America/New_York')::date::text AS d FROM news_events
        WHERE symbol = ANY($1) AND event_type IN ('earnings_beat','earnings_miss','earnings_mixed') GROUP BY 1, 2`, [symbols]);
    const m = new Map();
    for (const x of r.rows) { if (!m.has(x.symbol)) m.set(x.symbol, []); m.get(x.symbol).push(x.d); }
    return m;
}

/**
 * Collect entries for the universe: for each symbol × week, the strikes whose delta (from the
 * real close) is nearest each target delta. Fetches/caches the data it needs.
 */
async function collectEntries({ symbols, from = '2024-02-20', to = null, onProgress = null } = {}) {
    await ensureTables();
    to = to || addDays(new Date().toISOString().slice(0, 10), -50);
    const calendar = (await query(`SELECT d::text AS d FROM history_bars WHERE symbol = 'SPY' AND d >= $1 ORDER BY d`, [from])).rows.map(r => r.d);
    const plan = entryPlan(calendar, from, to);
    const sb = await stockBars(symbols, addDays(from, -320));
    const earn = await _earningsDays(symbols);
    const entries = [];
    let done = 0;
    for (const sym of symbols) {
        const stock = sb.get(sym) || [];
        const idx = new Map(stock.map((b, i) => [b.d, i]));
        const byExp = new Map();
        for (const p of plan) { if (!byExp.has(p.expiry)) byExp.set(p.expiry, []); byExp.get(p.expiry).push(p); }
        for (const [expiry, ps] of byExp) {
            const strikes = await listStrikes(sym, expiry);
            if (!strikes.length) continue;
            // candidate strikes: 0.70-1.00 × the price on any entry day for this expiry
            const prices = ps.map(p => stock[idx.get(p.d)]?.c).filter(Boolean);
            if (!prices.length) continue;
            const lo = Math.min(...prices) * 0.70, hi = Math.max(...prices);
            let cands = strikes.filter(s => s.k >= lo && s.k <= hi);
            if (cands.length > 40) { const step = cands.length / 40; cands = Array.from({ length: 40 }, (_, i) => cands[Math.floor(i * step)]); }
            await ensureBars(cands.map(c => c.contract), addDays(ps[0].d, -3));
            const ob = await barsFor(cands.map(c => c.contract));
            for (const p of ps) {
                const i = idx.get(p.d);
                if (i == null || i < 200) continue;
                const S = stock[i].c, T = p.dte / 365;
                const sma200 = stock.slice(i - 199, i + 1).reduce((s, b) => s + b.c, 0) / 200;
                const rets = stock.slice(i - 20, i + 1).map((b, k, a) => (k ? Math.log(b.c / a[k - 1].c) : null)).filter(x => x != null);
                const rv20 = Math.sqrt(rets.reduce((s, x) => s + x * x, 0) / rets.length * 252);
                const earningsInside = (earn.get(sym) || []).some(d => d > p.d && d <= expiry);
                const priced = [];
                for (const c of cands) {
                    const bar = ob.get(c.contract)?.get(p.d);
                    if (!bar || !(bar.c > 0.05)) continue; // must have traded that day; skip penny quotes
                    const iv = impliedVol(bar.c, S, c.k, T);
                    if (iv == null) continue;
                    priced.push({ ...c, close: bar.c, vol: bar.v, iv, delta: putDelta(S, c.k, T, RF, iv) });
                }
                for (const target of DELTAS) {
                    const best = priced.filter(x => Math.abs(-x.delta - target) <= 0.05).sort((a, b) => Math.abs(-a.delta - target) - Math.abs(-b.delta - target))[0];
                    if (!best) continue;
                    entries.push({ sym, d: p.d, expiry, dte: p.dte, target, strike: best.k, contract: best.contract,
                                   premium: best.close * (1 - HAIRCUT) - FEE_PER_SHARE, iv: best.iv, delta: best.delta, vol: best.vol,
                                   stock: S, sma200, rv20, earningsInside });
                }
            }
        }
        done++;
        if (onProgress) onProgress({ symbol: sym, done, of: symbols.length, entries: entries.length });
    }
    return { entries, plan: plan.length };
}

function sharpeOf(vals, perYear) {
    if (vals.length < 3) return null;
    const m = vals.reduce((s, x) => s + x, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((s, x) => s + (x - m) ** 2, 0) / (vals.length - 1));
    return sd > 0 ? m / sd * Math.sqrt(perYear) : null;
}

/** Evaluate every delta × exit × filter variant on collected entries. */
async function evaluate(entries) {
    const symbols = [...new Set(entries.map(e => e.sym))];
    const sb = await stockBars(symbols, addDays(entries.reduce((m, e) => (e.d < m ? e.d : m), '9999'), -5));
    const ob = await barsFor([...new Set(entries.map(e => e.contract))]);
    const weeks = [...new Set(entries.map(e => e.d))].sort();
    const wIdx = new Map(weeks.map((d, i) => [d, i]));
    const variants = [];
    for (const target of DELTAS) for (const [exitName, exit] of Object.entries(EXITS)) for (const [filterName, f] of Object.entries(FILTERS)) {
        const trades = [];
        for (const e of entries) {
            if (e.target !== target || !f(e)) continue;
            const sim = simulate({ entryDay: e.d, expiry: e.expiry, strike: e.strike, premium: e.premium, stock: sb.get(e.sym) || [], opt: ob.get(e.contract) || new Map(), exit });
            if (sim) trades.push({ ...tradeResult(sim, e.premium, e.strike), d: e.d, sym: e.sym });
        }
        const byWeek = new Map();
        for (const t of trades) { const a = byWeek.get(t.d) || []; a.push(t.exRocPct); byWeek.set(t.d, a); }
        const pts = [...byWeek].map(([d, a]) => ({ d, i: wIdx.get(d), v: a.reduce((s, x) => s + x, 0) / a.length }));
        const part = arr => { const v = arr.map(p => p.v); return { dates: v.length, avgExRocPct: v.length ? +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(3) : null, t: v.length > 2 ? +(nwTStat(arr, 5) ?? 0).toFixed(2) : null }; };
        const gains = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0), losses = -trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
        const avgDays = trades.length ? trades.reduce((s, t) => s + t.days, 0) / trades.length : 0;
        const avgRoc = trades.length ? trades.reduce((s, t) => s + t.rocPct, 0) / trades.length : 0;
        let cum = 0, peak = 0, dd = 0;
        for (const p of pts.sort((a, b) => a.i - b.i)) { cum += p.v / 5; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); } // ~5 overlapping weekly batches
        variants.push({
            delta: target, exit: exitName, filter: filterName, trades: trades.length,
            winPct: trades.length ? +(trades.filter(t => t.pnl > 0).length / trades.length * 100).toFixed(1) : null,
            profitFactor: losses > 0 ? +(gains / losses).toFixed(2) : null,
            avgPnl: trades.length ? +(trades.reduce((s, t) => s + t.pnl, 0) / trades.length).toFixed(2) : null,
            avgRocPct: +avgRoc.toFixed(3), annualizedRocPct: avgDays ? +(avgRoc * 365 / avgDays).toFixed(1) : null, avgDays: +avgDays.toFixed(1),
            assignedPct: trades.length ? +(trades.filter(t => t.assigned).length / trades.length * 100).toFixed(1) : null,
            stoppedPct: trades.length ? +(trades.filter(t => t.reason === 'stop').length / trades.length * 100).toFixed(1) : null,
            worstTradePnl: trades.length ? Math.min(...trades.map(t => t.pnl)) : null,
            worstTradeRocPct: trades.length ? Math.min(...trades.map(t => t.rocPct)) : null,
            maxDrawdownPct: +dd.toFixed(2),
            sharpe: sharpeOf(pts.map(p => p.v), 52 / Math.max(1, avgDays / 7)) != null ? +sharpeOf(pts.map(p => p.v), 52 / Math.max(1, avgDays / 7)).toFixed(2) : null,
            train: part(pts.filter(p => p.d < HOLDOUT_START)), holdout: part(pts.filter(p => p.d >= HOLDOUT_START)),
        });
    }
    // false-discovery control across all variants on the train t
    const qs = bhQ(variants.map(v => (v.train.t != null ? 1 - normCdf(v.train.t) : 1)));
    variants.forEach((v, k) => {
        v.fdrQ = +qs[k].toFixed(3);
        const why = [];
        if (v.trades < PASS.trades) why.push(`only ${v.trades} trades`);
        if (v.train.dates + v.holdout.dates < PASS.dates) why.push(`only ${v.train.dates + v.holdout.dates} entry weeks`);
        if (!(v.train.avgExRocPct > 0)) why.push('no profit over T-bills in older data');
        if (!(v.holdout.avgExRocPct > 0)) why.push('no profit over T-bills in recent data');
        // 2026-11-14: "recent > 0" alone let a +0.07%/trade, t 0.35 holdout pass; the recent period must hold up on its own
        else if (!(v.holdout.t >= PASS.holdT)) why.push(`recent profit too thin to trust (t ${v.holdout.t}, needs ${PASS.holdT})`);
        if (!(v.profitFactor > PASS.pf)) why.push(`profit factor ${v.profitFactor} (needs >${PASS.pf})`);
        if (!(v.sharpe > PASS.sharpe)) why.push(`Sharpe ${v.sharpe} (needs >${PASS.sharpe})`);
        if (!(v.fdrQ <= PASS.fdrQ)) why.push(`could be luck (q ${v.fdrQ})`);
        const promising = why.length && v.train.avgExRocPct > 0 && v.holdout.avgExRocPct > 0 && v.profitFactor > 1;
        v.verdict = why.length ? (promising ? 'promising' : 'fail') : 'pass';
        v.why = why.join('; ') || 'cleared every check';
    });
    return variants;
}

async function runCspBacktest({ symbols = null, onProgress = null } = {}) {
    await ensureTables();
    symbols = symbols || (await query(`SELECT DISTINCT symbol FROM options_iv_history ORDER BY 1`)).rows.map(r => r.symbol);
    const t0 = Date.now();
    const { entries, plan } = await collectEntries({ symbols, onProgress });
    const variants = await evaluate(entries);
    const result = {
        symbols: symbols.length, entryWeeks: plan, entries: entries.length, from: entries.reduce((m, e) => (e.d < m ? e.d : m), '9999'),
        to: entries.reduce((m, e) => (e.d > m ? e.d : m), ''), holdoutStart: HOLDOUT_START, haircutPct: HAIRCUT * 100, rfPct: RF * 100,
        variants: variants.sort((a, b) => (b.holdout.avgExRocPct ?? -99) - (a.holdout.avgExRocPct ?? -99)),
        passed: variants.filter(v => v.verdict === 'pass').length, promising: variants.filter(v => v.verdict === 'promising').length,
        minutes: Math.round((Date.now() - t0) / 60000),
    };
    await query(`INSERT INTO options_lab_runs (kind, result) VALUES ('csp_backtest', $1)`, [JSON.stringify(result)]);
    logger.info('[OptionsLab] CSP backtest stored', { entries: result.entries, variants: variants.length, passed: result.passed, promising: result.promising });
    return result;
}

module.exports = {
    ensureTables, replayOwnTrades, runCspBacktest, collectEntries, evaluate, simulate, tradeResult,
    putPrice, putDelta, impliedVol, thirdFriday, entryPlan, labGet, occ, POLICIES, EXITS, DELTAS, FILTERS, HAIRCUT, PASS,
};
