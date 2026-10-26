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

module.exports = { nextEarningsDate, lastEarningsDate, valuationSnapshot };
