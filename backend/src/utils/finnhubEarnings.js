/**
 * Next earnings date for one symbol from Finnhub's per-symbol earnings calendar (2026-10-24).
 * Yahoo calendarEvents has been 429-blocked, so getDaysToEarnings returned null for every
 * symbol and the swing bot's earnings guards never fired. Per-symbol on purpose — the range
 * calendar silently truncates at 1500 rows in earnings season.
 * Returns 'YYYY-MM-DD', null (none in the window), or throws on a failed lookup.
 */
const axios = require('axios');

async function nextEarningsDate(symbol, horizonDays = 60, now = new Date()) {
    const from = now.toISOString().slice(0, 10);
    const to = new Date(now.getTime() + horizonDays * 86400000).toISOString().slice(0, 10);
    const resp = await axios.get('https://finnhub.io/api/v1/calendar/earnings', {
        params: { from, to, symbol, token: process.env.FINNHUB_KEY }, timeout: 15000 });
    const rows = resp.data?.earningsCalendar;
    if (!Array.isArray(rows)) throw new Error('bad Finnhub earnings response');
    return rows.map(e => e.date).filter(Boolean).sort()[0] || null;
}

/** Most recent report within the last `lookbackDays` (or null). Throws on a failed lookup. */
async function lastEarningsDate(symbol, lookbackDays = 5, now = new Date()) {
    const to = now.toISOString().slice(0, 10);
    const from = new Date(now.getTime() - lookbackDays * 86400000).toISOString().slice(0, 10);
    const resp = await axios.get('https://finnhub.io/api/v1/calendar/earnings', {
        params: { from, to, symbol, token: process.env.FINNHUB_KEY }, timeout: 15000 });
    const rows = resp.data?.earningsCalendar;
    if (!Array.isArray(rows)) throw new Error('bad Finnhub earnings response');
    return rows.map(e => e.date).filter(d => d && d <= to).sort().pop() || null;
}

/**
 * Valuation snapshot from Finnhub /stock/metric (free tier). peVsUsualPct compares today's
 * trailing P/E with the median of the company's own last 5 fiscal-year P/Es — a rough
 * "cheap or pricey for this company" gauge, not a fair-value estimate. Throws on a failed lookup.
 */
async function valuationSnapshot(symbol) {
    const resp = await axios.get('https://finnhub.io/api/v1/stock/metric', {
        params: { symbol, metric: 'all', token: process.env.FINNHUB_KEY }, timeout: 15000 });
    const m = resp.data?.metric;
    if (!m) throw new Error('bad Finnhub metric response');
    const thisYear = new Date().getUTCFullYear();
    const hist = (resp.data?.series?.annual?.pe || [])
        .filter(x => x && x.v > 0 && Number(String(x.period).slice(0, 4)) < thisYear).slice(0, 5).map(x => x.v).sort((a, b) => a - b);
    const usualPe = hist.length >= 3 ? hist[Math.floor(hist.length / 2)] : null;
    const pe = m.peTTM > 0 ? m.peTTM : null;
    return {
        pe, forwardPe: m.forwardPE > 0 ? m.forwardPE : null, peg: m.pegTTM ?? null, usualPe,
        peVsUsualPct: pe && usualPe ? (pe / usualPe - 1) * 100 : null,
        revenueGrowthPct: m.revenueGrowthTTMYoy ?? null, epsGrowthPct: m.epsGrowthTTMYoy ?? null,
    };
}

// Free tier allows 60 calls/min across the whole key; fundamentals lookups are spaced so
// a nightly-scan burst leaves room for the earnings and news calls.
const FUNDAMENTALS_SPACING_MS = 1200;
let _nextFundamentalsAt = 0;

/**
 * CANSLIM growth inputs from Finnhub /stock/metric (2026-11-03). Replaces Polygon's
 * /vX/reference/financials, which started returning 404 around 2026-10-09 — CANSLIM scored 0
 * for every stock from 10-16 once the 7-day cache ran out. Quarterly year-over-year first (what
 * Yahoo's financialData gave), trailing-12-month if the quarter is missing. Decimal fractions
 * (0.2377 = 23.77%). All-null for symbols without fundamentals (ETFs). Throws on a failed lookup.
 */
async function fundamentalsSnapshot(symbol) {
    const now = Date.now();
    const waitMs = Math.max(0, _nextFundamentalsAt - now);
    _nextFundamentalsAt = Math.max(now, _nextFundamentalsAt) + FUNDAMENTALS_SPACING_MS;
    if (waitMs) await new Promise(r => setTimeout(r, waitMs));
    const resp = await axios.get('https://finnhub.io/api/v1/stock/metric', {
        params: { symbol, metric: 'all', token: process.env.FINNHUB_KEY }, timeout: 15000 });
    const m = resp.data?.metric;
    if (!m) throw new Error('bad Finnhub metric response');
    const pct = (...vals) => { const v = vals.find(x => typeof x === 'number' && Number.isFinite(x)); return v != null ? v / 100 : null; };
    return {
        earningsGrowth: pct(m.epsGrowthQuarterlyYoy, m.epsGrowthTTMYoy),
        revenueGrowth:  pct(m.revenueGrowthQuarterlyYoy, m.revenueGrowthTTMYoy),
        grossMargins:   pct(m.grossMarginTTM),
        // Finnhub reports millions of USD. Alpaca quotes carry no market cap, so this is the
        // only live source since Yahoo was blocked (every stock read 0 from at least Aug 2026).
        marketCap:      m.marketCapitalization > 0 ? Math.round(m.marketCapitalization * 1e6) : null,
    };
}

module.exports = { nextEarningsDate, lastEarningsDate, valuationSnapshot, fundamentalsSnapshot };
