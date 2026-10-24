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

module.exports = { nextEarningsDate };
