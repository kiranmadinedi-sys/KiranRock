/**
 * Core watchlist (2026-10-26) — quality names the user MAY add to core, with a daily
 * "today's entry" status. Information only: nothing here places an order.
 *
 * Why the statuses are about avoiding bad timing rather than predicting bounces: the quality-dip
 * validation (qualityDipBacktestService, 2026-10-26) found buying these names after a 10-20% dip did
 * no better than buying them on a random day of the same year. So "Good entry" just means "on sale
 * and nothing wrong today"; the real value is the Wait/Review flags (earnings imminent, strongly
 * bearish news, 30%+ collapse, shrinking revenue). Every status is stored daily so its forward
 * returns can be measured (getOutcomes) before anyone trusts it.
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const DEFAULT_LIST = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'MA', 'NVDA', 'AVGO', 'COST', 'JPM', 'LLY'];
const STATUS_ORDER = ['Good entry', 'Fine to buy', 'Wait', 'Review first', 'Avoid today'];

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

/**
 * Pure: status + reasons from the facts gathered for one symbol.
 * f = { ddPct, above200, gemini, daysToEarnings, revenueGrowth }
 */
function classify(f) {
    const reasons = [];
    if (f.gemini != null && f.gemini <= -3) return { status: 'Avoid today', reasons: [`strongly bearish news (Gemini ${f.gemini})`] };
    if (f.daysToEarnings != null && f.daysToEarnings >= 0 && f.daysToEarnings <= 5) {
        return { status: 'Wait', reasons: [`earnings in ${f.daysToEarnings} day${f.daysToEarnings === 1 ? '' : 's'} — buy after the report`] };
    }
    if (f.ddPct >= 30) return { status: 'Review first', reasons: [`down ${f.ddPct.toFixed(0)}% from its 52-week high — check whether the business changed`] };
    if (f.ddPct >= 10 && f.revenueGrowth != null && f.revenueGrowth < 0) {
        return { status: 'Review first', reasons: [`down ${f.ddPct.toFixed(0)}% with shrinking revenue (${(f.revenueGrowth * 100).toFixed(1)}%)`] };
    }
    if (f.ddPct >= 10) {
        reasons.push(`${f.ddPct.toFixed(0)}% below its 52-week high`);
        if (f.above200 === false) reasons.push('below its 200-day average — consider buying in stages');
        return { status: 'Good entry', reasons };
    }
    reasons.push(f.ddPct >= 5 ? `${f.ddPct.toFixed(0)}% below its high` : 'near its 52-week high');
    return { status: 'Fine to buy', reasons };
}

async function _bars(symbol) {
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
    const bars = await _bars(symbol);
    if (bars.length < 200) throw new Error('not enough price history');
    const closes = bars.map(b => b.c);
    const price = closes[closes.length - 1];
    const hi52 = Math.max(...closes.slice(-252));
    const sma200 = closes.slice(-200).reduce((s, v) => s + v, 0) / 200;
    const scan = (await query(
        `SELECT ai_score::float AS score,
                (SELECT substring(l from '^Gemini: ([+-]?[0-9]+)')::int FROM jsonb_array_elements_text(metadata->'scoringLog') l WHERE l LIKE 'Gemini:%' LIMIT 1) AS gem
         FROM daily_universe_analysis WHERE symbol = $1 ORDER BY analysis_date DESC LIMIT 1`, [symbol])).rows[0] || {};
    const fund = (await query(`SELECT revenue_growth::float AS rg FROM fundamentals_cache WHERE symbol = $1`, [symbol]).catch(() => ({ rows: [] }))).rows[0] || {};
    let daysToEarnings = null, earningsDate = null, earningsKnown = false;
    try {
        earningsDate = await require('../utils/finnhubEarnings').nextEarningsDate(symbol, 120, now);
        earningsKnown = true; // null here = no report in the next 120 days, not "unknown"
        if (earningsDate) daysToEarnings = Math.max(0, Math.round((new Date(`${earningsDate}T12:00:00Z`) - new Date(`${todayET(now)}T12:00:00Z`)) / 86400000));
    } catch (_) { /* unknown earnings → shown as unknown, not treated as safe */ }
    return {
        price, hi52, ddPct: (1 - price / hi52) * 100, above200: price >= sma200, sma200,
        ret21Pct: closes.length > 21 ? (price / closes[closes.length - 22] - 1) * 100 : null,
        score: scan.score ?? null, gemini: scan.gem ?? null, revenueGrowth: fund.rg ?? null,
        daysToEarnings, earningsDate, earningsKnown, asOf: String(bars[bars.length - 1].d).slice(0, 10),
    };
}

async function evaluate(symbol, now = new Date()) {
    const f = await _facts(symbol, now);
    const { status, reasons } = classify(f);
    if (!f.earningsKnown) reasons.push('earnings date unknown — check before buying');
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
    if ((await _bars(s)).length < 200) throw new Error(`${s}: not enough price history in our data yet`);
    await query(`INSERT INTO core_watchlist (user_id, symbol) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [String(userId), s]);
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
async function runDaily(now = new Date()) {
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
            const good = mine.filter(r => r.status === 'Good entry');
            const wait = mine.filter(r => ['Wait', 'Review first', 'Avoid today'].includes(r.status));
            const text = [
                `🏛️ *Core watchlist — ${today}*`,
                good.length ? `On sale, no red flags: ${good.map(r => `${r.symbol} (−${r.ddPct.toFixed(0)}%)`).join(', ')}` : 'Nothing on sale today.',
                wait.length ? `Hold off: ${wait.map(r => `${r.symbol} (${r.reasons[0]})`).join('; ')}` : '',
                '_Suggestions only — you decide. Buying these any day has historically done as well as waiting for dips._',
            ].filter(Boolean).join('\n');
            await require('./reportArchiveService').save({ kind: 'core_watchlist', title: `Core watchlist — ${good.length} on sale`, body: text, userId: u });
            if (good.length) {
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

/** Forward returns by status, for the weekly review: did "Good entry" days actually beat the rest? */
async function getOutcomes(days = 63) {
    await ensureTables();
    const r = await query(
        `SELECT s.status, COUNT(*)::int AS n,
                AVG((SELECT close FROM daily_bars b WHERE b.symbol = s.symbol AND b.timestamp::date >= s.signal_date + $1::int ORDER BY b.timestamp LIMIT 1) / s.price - 1)::float * 100 AS avg_pct
         FROM core_watchlist_signals s
         WHERE s.signal_date <= CURRENT_DATE - $1::int AND s.price > 0
         GROUP BY s.status`, [Math.round(days * 365 / 252)]);
    return r.rows;
}

module.exports = { DEFAULT_LIST, classify, evaluate, getList, addSymbol, removeSymbol, getWatchlist, runDaily, getOutcomes, ensureTables };
