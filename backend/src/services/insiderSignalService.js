/**
 * Insider-cluster signal (built 2026-10-17) — a logged test arm, not a trading rule.
 *
 * First event study on the research archive (782K Finnhub Form 4 rows, 2023→): when 3+
 * DISTINCT insiders made open-market purchases ('P', non-derivative) of the same stock
 * within 30 days, buying at the next open beat a random stock-day by ~+1.7pp over 20
 * trading days (n=925; +0.56% vs SPY when a random stock lagged SPY by −1.11%), and was
 * better than the baseline in each of 2023, 2024, 2025 and 2026. Any single insider buy
 * was ~+1.0pp; insider SALES were not bearish. News headlines (upgrades, beats, approvals)
 * had no edge.
 *
 * So: log the active clusters every trading day as arm 'insider' next to control /
 * oversold / steady, and judge it forward on real prices before it touches money.
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const CLUSTER_MIN_INSIDERS = 3;
const CLUSTER_WINDOW_DAYS = 30;
const FRESH_DAYS = 7;   // the cluster's latest purchase was filed within this many days
const MIN_PRICE = 5;

/**
 * Stocks with an active insider-buying cluster as of `asOf` (YYYY-MM-DD): 3+ distinct
 * insiders buying in the 30 days to asOf, the latest filing within FRESH_DAYS.
 * Ranked by insider count, then dollars bought.
 */
async function getActiveClusters(asOf) {
    const r = await query(`
        WITH buys AS (
            SELECT symbol, name, filing_date, ABS(change) * COALESCE(price, 0) AS usd
            FROM insider_transactions
            WHERE transaction_code = 'P' AND NOT COALESCE(is_derivative, false)
              AND filing_date > ($1::date - $2::int) AND filing_date <= $1::date
        ),
        agg AS (
            SELECT symbol, COUNT(DISTINCT name) AS insiders, SUM(usd) AS usd, MAX(filing_date) AS last_filing
            FROM buys GROUP BY symbol
        ),
        px AS (
            SELECT DISTINCT ON (symbol) symbol, c FROM history_bars
            WHERE symbol IN (SELECT symbol FROM agg) AND d <= $1::date
            ORDER BY symbol, d DESC
        )
        SELECT a.symbol, a.insiders::int, a.usd::float, a.last_filing::text, px.c::float AS price
        FROM agg a LEFT JOIN px ON px.symbol = a.symbol
        WHERE a.insiders >= $3 AND a.last_filing > ($1::date - $4::int)
          AND COALESCE(px.c, 0) >= $5
        ORDER BY a.insiders DESC, a.usd DESC`,
        [asOf, CLUSTER_WINDOW_DAYS, CLUSTER_MIN_INSIDERS, FRESH_DAYS, MIN_PRICE]);
    return r.rows;
}

/**
 * The 3-year check, re-run weekly: cluster events (first day a stock reaches 3+ insiders in
 * 30 days, at most one per 30 days) vs a random stock-day, entry next open, excess vs SPY.
 */
async function clusterHistoryStudy() {
    const ev = await query(`
        WITH b AS (
            SELECT symbol, name, filing_date FROM insider_transactions
            WHERE transaction_code = 'P' AND NOT COALESCE(is_derivative, false) AND filing_date >= '2023-02-01'
        ),
        days AS (SELECT DISTINCT symbol, filing_date AS d FROM b),
        counted AS (
            SELECT d.symbol, d.d,
                   (SELECT COUNT(DISTINCT b.name) FROM b WHERE b.symbol = d.symbol AND b.filing_date > d.d - 30 AND b.filing_date <= d.d) AS n
            FROM days d
        )
        SELECT symbol, d::text AS d FROM counted WHERE n >= 3 ORDER BY symbol, d`);
    // keep one event per stock per 30 days
    const events = [];
    let last = {};
    for (const e of ev.rows) {
        if (last[e.symbol] && (new Date(e.d) - new Date(last[e.symbol])) / 86400000 < 30) continue;
        events.push(e); last[e.symbol] = e.d;
    }
    if (!events.length) return null;
    const fwd = await query(`
        WITH ev AS (SELECT * FROM unnest($1::text[], $2::date[]) AS t(symbol, d)),
             b AS (SELECT symbol, d, o, c, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY d) rn
                   FROM history_bars WHERE symbol = ANY($1) OR symbol = 'SPY'),
             start AS (
                SELECT ev.symbol, ev.d AS ed, MIN(b.rn) AS rn FROM ev JOIN b ON b.symbol = ev.symbol AND b.d > ev.d GROUP BY 1, 2)
        SELECT EXTRACT(YEAR FROM s.ed)::int AS y,
               (e20.c / e1.o - 1) * 100 - (p20.c / p1.o - 1) * 100 AS x20
        FROM start s
        JOIN b e1 ON e1.symbol = s.symbol AND e1.rn = s.rn
        JOIN b e20 ON e20.symbol = s.symbol AND e20.rn = s.rn + 19
        JOIN b p1 ON p1.symbol = 'SPY' AND p1.d = e1.d
        JOIN b p20 ON p20.symbol = 'SPY' AND p20.d = e20.d
        WHERE e1.o >= 2`,
        [events.map(e => e.symbol), events.map(e => e.d)]);
    const clip = v => Math.max(-60, Math.min(60, +v));
    const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    const vals = fwd.rows.map(r => clip(r.x20));
    const byYear = {};
    for (const r of fwd.rows) (byYear[r.y] ||= []).push(clip(r.x20));
    return {
        events: vals.length,
        avg20dVsSpy: +avg(vals).toFixed(2),
        winPct: +(vals.filter(v => v > 0).length / vals.length * 100).toFixed(0),
        byYear: Object.fromEntries(Object.entries(byYear).map(([y, v]) => [y, +avg(v).toFixed(2)])),
    };
}

/** Weekday after-close sweep of recent insider filings (last 10 days). Never throws. */
async function dailyInsiderSweep(now = new Date()) {
    try {
        const symbols = await require('./historyBarsService').scanUniverse();
        const from = new Date(now.getTime() - 10 * 86400000).toISOString().slice(0, 10);
        const r = await require('./researchArchiveService').sweepInsiders(symbols, { from });
        logger.info('[InsiderSignal] Daily insider sweep done', r);
        return r;
    } catch (err) {
        logger.warn('[InsiderSignal] Daily insider sweep failed (non-blocking)', { error: err.message });
        return null;
    }
}

module.exports = { getActiveClusters, clusterHistoryStudy, dailyInsiderSweep, CLUSTER_MIN_INSIDERS };
