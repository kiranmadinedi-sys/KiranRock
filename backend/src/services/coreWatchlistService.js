/**
 * Core watchlist (2026-10-26) — quality names the user MAY add to core, with a daily status.
 * Information only: nothing here places an order.
 *
 * Statuses deliberately never say "buy" (review feedback 2026-10-26): the quality-dip validation
 * (qualityDipBacktestService) found buying after a 10-20% dip did no better than a random day of the
 * same year, so a price drop alone is never presented as a good entry. A dip is labelled by what we
 * can actually check — valuation vs the company's own usual P/E, growth, news, earnings timing — and
 * the system fails closed ("Data unavailable") when prices are stale or earnings can't be verified.
 * Every status is stored daily so its forward returns can be measured (getOutcomes).
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const DEFAULT_LIST = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'MA', 'NVDA', 'AVGO', 'COST', 'JPM', 'LLY'];
const STATUS_ORDER = ['Dip — valuation OK', 'Dip — review fundamentals', 'Dip — but pricey', 'No dip',
                      'Reassess', 'Wait', 'Review first', 'Avoid today', 'Data unavailable'];
const PRICEY_PCT = 10;     // P/E more than 10% above its own 5-year median
const STALE_DAYS = 4;      // last close older than this (calendar days) → no recommendation
const SOURCES = 'Prices: Alpaca daily bars · Earnings & valuation: Finnhub · News: Gemini (nightly scan)';

let _ready = false;
async function ensureTables() {
    if (_ready) return;
    await query(`CREATE TABLE IF NOT EXISTS core_watchlist (
        user_id TEXT NOT NULL, symbol TEXT NOT NULL, added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_id, symbol))`);
    await query(`CREATE TABLE IF NOT EXISTS core_watchlist_seeded (user_id TEXT PRIMARY KEY, seeded_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await query(`CREATE TABLE IF NOT EXISTS core_watchlist_signals (
        signal_date DATE NOT NULL, symbol TEXT NOT NULL, status TEXT NOT NULL, price NUMERIC, dd_pct NUMERIC,
        details JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (signal_date, symbol))`);
    _ready = true;
}

const todayET = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const dayDiff = (a, b) => Math.round((new Date(`${a}T12:00:00Z`) - new Date(`${b}T12:00:00Z`)) / 86400000);

/**
 * Pure: status + reasons. f = { ddPct, above200, gemini, staleDays, earningsKnown, daysToEarnings,
 * daysSinceEarnings, lastEarningsDate, valuation: { peVsUsualPct, revenueGrowthPct, epsGrowthPct } | null }
 */
function classify(f) {
    const v = f.valuation || {};
    if (f.staleDays == null || f.staleDays > STALE_DAYS) return { status: 'Data unavailable', reasons: [`price data is ${f.staleDays ?? '?'} days old — no recommendation`] };
    if (!f.earningsKnown) return { status: 'Data unavailable', reasons: ['earnings date could not be verified — no recommendation'] };
    if (f.gemini != null && f.gemini <= -3) return { status: 'Avoid today', reasons: [`strongly bearish news (Gemini ${f.gemini})`] };
    if (f.daysToEarnings != null && f.daysToEarnings >= 0 && f.daysToEarnings <= 5) {
        return { status: 'Wait', reasons: [`earnings in ${f.daysToEarnings} day${f.daysToEarnings === 1 ? '' : 's'} — reassess results, guidance and valuation after the report`] };
    }
    if (f.daysSinceEarnings != null && f.daysSinceEarnings <= 3) {
        return { status: 'Reassess', reasons: [`just reported (${f.lastEarningsDate}) — check results and guidance before deciding`] };
    }
    if (f.ddPct >= 30) return { status: 'Review first', reasons: [`down ${f.ddPct.toFixed(0)}% from its 52-week high — check whether the business changed`] };
    if (f.ddPct >= 10 && v.revenueGrowthPct != null && v.revenueGrowthPct < 0) {
        return { status: 'Review first', reasons: [`down ${f.ddPct.toFixed(0)}% with shrinking revenue (${v.revenueGrowthPct.toFixed(1)}% YoY)`] };
    }
    if (f.ddPct >= 10 && v.epsGrowthPct != null && v.epsGrowthPct < -10) {
        return { status: 'Review first', reasons: [`down ${f.ddPct.toFixed(0)}% with falling earnings (EPS ${v.epsGrowthPct.toFixed(0)}% YoY)`] };
    }
    const valNote = v.peVsUsualPct == null ? 'no valuation data'
        : v.peVsUsualPct <= -10 ? `P/E ${Math.abs(v.peVsUsualPct).toFixed(0)}% below its usual`
        : v.peVsUsualPct > PRICEY_PCT ? `P/E ${v.peVsUsualPct.toFixed(0)}% above its usual`
        : 'P/E around its usual';
    if (f.ddPct >= 10) {
        const reasons = [`${f.ddPct.toFixed(0)}% below its 52-week high`, valNote];
        if (f.above200 === false) reasons.push('below its 200-day average — stages, not all at once');
        if (v.peVsUsualPct == null) return { status: 'Dip — review fundamentals', reasons };
        if (v.peVsUsualPct > PRICEY_PCT) return { status: 'Dip — but pricey', reasons };
        // A low trailing P/E is a false bargain if analysts expect earnings to fall (forward P/E well
        // above trailing) — review feedback 2026-10-26.
        if (v.forwardPe != null && v.pe != null && v.forwardPe > v.pe * 1.15) {
            reasons.push(`forward P/E ${v.forwardPe.toFixed(0)} vs trailing ${v.pe.toFixed(0)} — earnings expected to fall`);
            return { status: 'Dip — review fundamentals', reasons };
        }
        return { status: 'Dip — valuation OK', reasons };
    }
    return { status: 'No dip', reasons: [f.ddPct >= 5 ? `${f.ddPct.toFixed(0)}% below its high` : 'near its 52-week high', valNote] };
}

// On-the-fly fallback (2026-10-26): symbols outside the nightly-scan universe have no local
// history, so the watchlist fetched nothing ("not enough price history"). Alpaca's historical SIP
// bars (split/dividend-adjusted, end >15 min ago so the free plan allows it), cached per day.
const DATA_USER = '83f08677-e55a-48d1-bd31-f5b56fa79c23'; // market data only — any valid Alpaca key works
const _remoteBars = new Map();
async function _alpacaHeaders() {
    const cr = await require('./userDatabaseService').getUserAlpacaCredentials(DATA_USER);
    return { 'APCA-API-KEY-ID': cr.keyId, 'APCA-API-SECRET-KEY': cr.secretKey };
}
async function _alpacaBars(symbol) {
    const day = new Date().toISOString().slice(0, 10);
    const hit = _remoteBars.get(symbol);
    if (hit && hit.day === day) return hit.rows;
    const axios = require('axios');
    const start = new Date(Date.now() - 420 * 86400000).toISOString().slice(0, 10);
    const end = new Date(Date.now() - 20 * 60000).toISOString();
    const r = (await axios.get(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars`, {
        params: { timeframe: '1Day', start, end, adjustment: 'all', limit: 1000, feed: 'sip' },
        headers: await _alpacaHeaders(), timeout: 20000,
    })).data;
    const rows = (r.bars || []).map(b => ({ d: b.t.slice(0, 10), c: b.c })).slice(-260);
    _remoteBars.set(symbol, { day, rows });
    return rows;
}

/** Name/tradability of a symbol from Alpaca, or throws a user-readable error. */
async function lookupAsset(symbol) {
    const axios = require('axios');
    try {
        const a = (await axios.get(`https://paper-api.alpaca.markets/v2/assets/${encodeURIComponent(symbol)}`, {
            headers: await _alpacaHeaders(), timeout: 15000 })).data;
        if (a.class !== 'us_equity' || !a.tradable) throw Object.assign(new Error(`${symbol} (${a.name}) is not a tradable US stock or ETF.`), { status: 400 });
        return { name: a.name, exchange: a.exchange, fractionable: !!a.fractionable };
    } catch (err) {
        // Check the HTTP response first: axios errors carry their own `status` too.
        if (err.response?.status === 404) throw Object.assign(new Error(`${symbol}: no such US stock or ETF — check the ticker.`), { status: 400 });
        throw err;
    }
}

async function _bars(symbol) {
    const local = await _localBars(symbol);
    if (local.length >= 200) return local;
    const remote = await _alpacaBars(symbol).catch(() => []);
    return remote.length > local.length ? remote : local;
}

async function _localBars(symbol) {
    // One row per trading day: history_bars first (clean, split-adjusted), daily_bars only for newer
    // days. daily_bars timestamps are UTC midnight-ish bars — read the date in UTC, or a Chicago
    // session shifts every bar back a day.
    const r = await query(
        `SELECT d::text AS d, c FROM (
             SELECT DISTINCT ON (d) d, c FROM (
                 SELECT d, c::float AS c, 0 AS pri FROM history_bars WHERE symbol = $1
                 UNION ALL
                 SELECT (timestamp AT TIME ZONE 'UTC')::date AS d, close::float AS c, 1 AS pri FROM daily_bars WHERE symbol = $1) x
             ORDER BY d, pri) y
         ORDER BY d DESC LIMIT 260`, [symbol]);
    return r.rows.reverse();
}

async function _facts(symbol, now) {
    const fh = require('../utils/finnhubEarnings');
    const bars = await _bars(symbol);
    if (bars.length < 200) throw new Error('not enough price history');
    const closes = bars.map(b => b.c);
    const price = closes[closes.length - 1];
    const window = bars.slice(-252);
    const hiBar = window.reduce((m, b) => (b.c > m.c ? b : m), window[0]);
    const sma200 = closes.slice(-200).reduce((s, v) => s + v, 0) / 200;
    const asOf = String(bars[bars.length - 1].d).slice(0, 10);
    const today = todayET(now);
    const scan = (await query(
        `SELECT ai_score::float AS score, analysis_date::text AS d,
                (SELECT substring(l from '^Gemini: ([+-]?[0-9]+)')::int FROM jsonb_array_elements_text(metadata->'scoringLog') l WHERE l LIKE 'Gemini:%' LIMIT 1) AS gem
         FROM daily_universe_analysis WHERE symbol = $1 ORDER BY analysis_date DESC LIMIT 1`, [symbol])).rows[0] || {};
    let daysToEarnings = null, earningsDate = null, earningsKnown = false, lastEarningsDate = null, daysSinceEarnings = null;
    try {
        earningsDate = await fh.nextEarningsDate(symbol, 120, now);       // null = none in the next 120 days
        lastEarningsDate = await fh.lastEarningsDate(symbol, 5, now);
        earningsKnown = true;
        if (earningsDate) daysToEarnings = Math.max(0, dayDiff(earningsDate, today));
        if (lastEarningsDate) daysSinceEarnings = dayDiff(today, lastEarningsDate);
    } catch (_) { /* fail closed in classify() */ }
    let valuation = null;
    try { valuation = await fh.valuationSnapshot(symbol); } catch (_) { /* shown as "no valuation data" */ }
    return {
        price, hi52: hiBar.c, hi52Date: String(hiBar.d).slice(0, 10), ddPct: (1 - price / hiBar.c) * 100,
        above200: price >= sma200, sma200, asOf, staleDays: dayDiff(today, asOf),
        score: scan.score ?? null, gemini: scan.gem ?? null, newsAsOf: scan.d ?? null,
        daysToEarnings, earningsDate, lastEarningsDate, daysSinceEarnings, earningsKnown, valuation,
        sources: SOURCES, checkedAt: now.toISOString(),
    };
}

async function evaluate(symbol, now = new Date()) {
    const f = await _facts(symbol, now);
    const { status, reasons } = classify(f);
    return { symbol, status, reasons, ...f };
}

async function getList(userId) {
    await ensureTables();
    const uid = String(userId);
    const seeded = (await query(`SELECT 1 FROM core_watchlist_seeded WHERE user_id = $1`, [uid])).rows.length > 0;
    if (!seeded) {
        for (const s of DEFAULT_LIST) await query(`INSERT INTO core_watchlist (user_id, symbol) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [uid, s]);
        await query(`INSERT INTO core_watchlist_seeded (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [uid]);
    }
    return (await query(`SELECT symbol FROM core_watchlist WHERE user_id = $1 ORDER BY symbol`, [uid])).rows.map(r => r.symbol);
}

async function addSymbol(userId, symbol) {
    const s = String(symbol || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z.]{0,5}$/.test(s)) throw new Error('Invalid symbol');
    await getList(userId);
    const asset = await lookupAsset(s);
    const bars = await _bars(s);
    if (bars.length < 200) throw new Error(`${s} (${asset.name}): only ${bars.length} trading days of history — needs 200 for the 52-week and 200-day checks.`);
    await query(`INSERT INTO core_watchlist (user_id, symbol) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [String(userId), s]);
    // Evaluate right away so the new row shows a status instead of "Not checked yet".
    try {
        const e = await evaluate(s);
        const { symbol: _s, status, price, ddPct, ...details } = e;
        const today = todayET();
        await query(`INSERT INTO core_watchlist_signals (signal_date, symbol, status, price, dd_pct, details) VALUES ($1,$2,$3,$4,$5,$6)
                     ON CONFLICT (signal_date, symbol) DO UPDATE SET status = EXCLUDED.status, price = EXCLUDED.price, dd_pct = EXCLUDED.dd_pct, details = EXCLUDED.details`,
            [today, s, status, price, ddPct, JSON.stringify({ ...details, price, ddPct })]);
    } catch (err) {
        logger.warn('[CoreWatchlist] First evaluation failed', { symbol: s, error: err.message });
    }
    return { symbol: s, name: asset.name };
}

async function removeSymbol(userId, symbol) {
    await getList(userId);
    await query(`DELETE FROM core_watchlist WHERE user_id = $1 AND symbol = $2`, [String(userId), String(symbol).toUpperCase()]);
}

/** The user's list with today's (or the latest stored) status per symbol, best first. */
async function getWatchlist(userId) {
    const symbols = await getList(userId);
    const core = await require('./coreHoldingsService').getCoreSymbols(userId).catch(() => new Set());
    const rows = [];
    for (const s of symbols) {
        const sig = (await query(
            `SELECT signal_date::text AS date, status, details FROM core_watchlist_signals WHERE symbol = $1 ORDER BY signal_date DESC LIMIT 1`, [s])).rows[0];
        rows.push(sig ? { symbol: s, date: sig.date, status: sig.status, ...sig.details, inCore: core.has(s) }
                      : { symbol: s, status: 'Not checked yet', reasons: ['first check runs at 10:15 AM ET on the next trading day'], inCore: core.has(s) });
    }
    const rank = r => { const i = STATUS_ORDER.indexOf(r.status); return i < 0 ? 99 : i; };
    return rows.sort((a, b) => rank(a) - rank(b) || (b.ddPct || 0) - (a.ddPct || 0));
}

/** 10:15 AM ET on trading days: evaluate every watched symbol once, store, archive + notify each user. */
async function runDaily(now = new Date(), { notify = true } = {}) {
    try {
        const today = todayET(now);
        const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
        if (dow === 0 || dow === 6 || require('../utils/marketCalendar').isTradingHoliday(now)) return { skipped: 'not a trading day' };
        await ensureTables();
        const users = (await query(`SELECT DISTINCT user_id FROM core_watchlist`)).rows.map(r => r.user_id);
        const symbols = [...new Set((await query(`SELECT DISTINCT symbol FROM core_watchlist`)).rows.map(r => r.symbol))];
        const results = {};
        for (const s of symbols) {
            try {
                const e = await evaluate(s, now);
                const { symbol, status, price, ddPct, ...details } = e;
                await query(`INSERT INTO core_watchlist_signals (signal_date, symbol, status, price, dd_pct, details) VALUES ($1,$2,$3,$4,$5,$6)
                             ON CONFLICT (signal_date, symbol) DO UPDATE SET status = EXCLUDED.status, price = EXCLUDED.price, dd_pct = EXCLUDED.dd_pct, details = EXCLUDED.details`,
                    [today, symbol, status, price, ddPct, JSON.stringify({ ...details, price, ddPct })]);
                results[s] = e;
            } catch (err) {
                logger.warn('[CoreWatchlist] Evaluate failed', { symbol: s, error: err.message });
            }
        }
        const alert = require('./telegramAlertService');
        for (const u of users) {
            const mine = (await getList(u)).map(s => results[s]).filter(Boolean);
            const good = mine.filter(r => r.status === 'Dip — valuation OK');
            const wait = mine.filter(r => ['Wait', 'Reassess', 'Review first', 'Avoid today', 'Data unavailable'].includes(r.status));
            const text = [
                `🏛️ *Core watchlist — ${today}*`,
                good.length ? `Dip with reasonable valuation (review before buying): ${good.map(r => `${r.symbol} (−${r.ddPct.toFixed(0)}%, ${r.reasons[1]})`).join(', ')}` : 'No dip with reasonable valuation today.',
                wait.length ? `Hold off: ${wait.map(r => `${r.symbol} (${r.reasons[0]})`).join('; ')}` : '',
                '_Suggestions only — you decide. In our 2020–2026 test, buying on dips did no better than buying on any day; valuation is a rough check vs the company\'s own usual P/E._',
            ].filter(Boolean).join('\n');
            await require('./reportArchiveService').save({ kind: 'core_watchlist', title: `Core watchlist — ${good.length} on sale`, body: text, userId: u });
            if (notify && good.length) {
                const chatId = await alert.getUserTelegramChatId(u).catch(() => null);
                if (chatId) await alert.sendTelegramMessage(chatId, text).catch(() => {});
            }
        }
        logger.info('[CoreWatchlist] Daily check done', { symbols: symbols.length, evaluated: Object.keys(results).length });
        return { evaluated: Object.keys(results).length };
    } catch (err) {
        logger.warn('[CoreWatchlist] Daily check failed', { error: err.message });
        return { error: err.message };
    }
}

/**
 * Prospective outcomes (review feedback 2026-10-26): for every stored signal old enough, the stock's
 * return and SPY's return over the same 1/3/6/12-month window, by status. Rules are frozen while this
 * accumulates — judge the watchlist on this record, not on how many dips it finds. A symbol repeats
 * daily, so `symbols` (distinct stocks) is the honest sample size, not `n`.
 */
const OUTCOME_HORIZONS = { '1m': 30, '3m': 91, '6m': 182, '12m': 365 };
async function getOutcomes() {
    await ensureTables();
    const px = `(SELECT close FROM daily_bars b WHERE b.symbol = %SYM% AND (b.timestamp AT TIME ZONE 'UTC')::date >= %DATE% ORDER BY b.timestamp LIMIT 1)`;
    const at = (sym, date) => px.replace('%SYM%', sym).replace('%DATE%', date);
    const out = {};
    for (const [label, days] of Object.entries(OUTCOME_HORIZONS)) {
        const r = await query(
            `SELECT status, COUNT(*)::int AS n, COUNT(DISTINCT symbol)::int AS symbols,
                    AVG(ret)::float * 100 AS avg_pct, AVG(spy)::float * 100 AS spy_pct,
                    AVG(CASE WHEN ret > spy THEN 1 ELSE 0 END)::float * 100 AS beat_spy_pct
             FROM (
                 SELECT s.status, s.symbol,
                        ${at('s.symbol', `s.signal_date + ${days}`)} / s.price - 1 AS ret,
                        ${at("'SPY'", `s.signal_date + ${days}`)} / ${at("'SPY'", 's.signal_date')} - 1 AS spy
                 FROM core_watchlist_signals s
                 WHERE s.signal_date <= CURRENT_DATE - ${days} AND s.price > 0) x
             WHERE ret IS NOT NULL AND spy IS NOT NULL
             GROUP BY status ORDER BY status`);
        out[label] = r.rows;
    }
    return out;
}

module.exports = { DEFAULT_LIST, classify, evaluate, lookupAsset, getList, addSymbol, removeSymbol, getWatchlist, runDaily, getOutcomes, ensureTables };
