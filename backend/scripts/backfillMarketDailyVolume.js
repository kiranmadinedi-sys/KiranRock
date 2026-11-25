/**
 * One-time (re-runnable) backfill of market_daily_volume — the last N completed trading days
 * of whole-market Polygon grouped-daily bars. See docs/UNIVERSE_BUILD_POLYGON_PREFILTER.md.
 *   node scripts/backfillMarketDailyVolume.js [days=22]
 * Retries each day up to 3× on 429/5xx; an empty day counts as a failure (reported, not stored).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { fetchGroupedDailyBars } = require('../src/services/eodIngestionService');
const pf = require('../src/services/universePrefilterService');
const { previousTradingDay } = require('../src/utils/marketCalendar');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const n = parseInt(process.argv[2] || '22', 10);
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const days = [];
    let d = previousTradingDay(todayET);
    while (days.length < n) { days.push(d); d = previousTradingDay(d); }
    let ok = 0; const failed = [];
    for (const day of days) {
        let bars = null;
        for (let a = 1; a <= 3; a++) {
            try { bars = await fetchGroupedDailyBars(day); break; }
            catch (e) {
                const st = e.response?.status;
                if (a < 3 && (st === 429 || st >= 500 || !st)) { await sleep(15000 * a); continue; }
                console.log(`${day}: failed (${st || e.message})`);
            }
        }
        if (!bars || bars.length === 0) { failed.push(day); continue; }
        const rows = await pf.storeMarketDailyVolume(day, bars);
        console.log(`${day}: ${rows} tickers stored`);
        ok++;
    }
    console.log(`Done: ${ok}/${days.length} days stored${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
