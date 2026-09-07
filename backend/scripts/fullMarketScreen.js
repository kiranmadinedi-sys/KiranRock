/**
 * Full Market Technical Screen — one-off, 2026-09-07
 * ================================================
 * Prompted by: "since it's a holiday weekend, does the system have time to
 * analyze the entire ~13k-ticker universe available via Polygon?" Answer
 * worked out with the user: the FULL PANTHEON pipeline (PULSE + ORACLE, the
 * expensive steps) can't — that's LLM-bound, not data-bound, and would take
 * 6-8 days regardless of data vendor. But Polygon's grouped-daily endpoint
 * returns the ENTIRE US market (~12,500 symbols) in one sub-second call, so a
 * technical-only screen (no LLM calls at all) genuinely can cover everything.
 *
 * This is deliberately NOT part of the live pipeline: read-only, writes
 * nothing to daily_universe_analysis, touches no scoring/gating/sizing code,
 * creates no orders. Just a broad first-pass report a human can look at.
 *
 * Usage: node scripts/fullMarketScreen.js
 */

require('../src/bootstrapRuntime');
const { fetchGroupedDailyBars } = require('../src/services/eodIngestionService');
const { query } = require('../src/config/database');

const LOOKBACK_CALENDAR_DAYS = 10;  // enough to catch ~6-7 real trading days
const MIN_PRICE  = 5;               // filter penny/junk tickers
const MIN_VOLUME = 300_000;         // matches HERMES's own liquidity floor
const TOP_N      = 40;

function isoDate(d) { return d.toISOString().slice(0, 10); }

async function main() {
    console.log(`[FullMarketScreen] Fetching ${LOOKBACK_CALENDAR_DAYS} calendar days of grouped daily bars...`);

    const perSymbol = new Map(); // symbol -> array of {timestamp, close, volume, high, low}
    let daysWithData = 0;

    for (let i = 0; i < LOOKBACK_CALENDAR_DAYS; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = isoDate(d);
        try {
            const bars = await fetchGroupedDailyBars(dateStr);
            if (bars.length === 0) continue; // weekend/holiday, no results
            daysWithData++;
            console.log(`[FullMarketScreen] ${dateStr}: ${bars.length} symbols`);
            for (const b of bars) {
                if (!perSymbol.has(b.symbol)) perSymbol.set(b.symbol, []);
                perSymbol.get(b.symbol).push(b);
            }
        } catch (err) {
            console.log(`[FullMarketScreen] ${dateStr}: fetch failed (${err.message}) — skipping`);
        }
    }

    console.log(`[FullMarketScreen] Collected ${perSymbol.size} distinct symbols across ${daysWithData} trading days`);

    // Rank by: multi-day return x volume surge, after basic liquidity/quality filters.
    const candidates = [];
    for (const [symbol, bars] of perSymbol) {
        if (bars.length < 2) continue;
        bars.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        const first = bars[0];
        const last  = bars[bars.length - 1];
        if (last.close < MIN_PRICE) continue;

        const avgVolume = bars.reduce((s, b) => s + b.volume, 0) / bars.length;
        if (avgVolume < MIN_VOLUME) continue;

        const periodReturnPct = ((last.close - first.close) / first.close) * 100;
        const volumeSurge     = avgVolume > 0 ? last.volume / avgVolume : 1;

        candidates.push({
            symbol,
            days: bars.length,
            lastClose: last.close,
            avgVolume: Math.round(avgVolume),
            lastVolume: last.volume,
            volumeSurge: Number(volumeSurge.toFixed(2)),
            periodReturnPct: Number(periodReturnPct.toFixed(1)),
        });
    }

    console.log(`[FullMarketScreen] ${candidates.length} symbols passed price/volume filters (>=$${MIN_PRICE}, >=${MIN_VOLUME.toLocaleString()} avg vol)`);

    // Composite rank: reward real upside momentum AND above-average volume behind it —
    // a big move on dead volume is noise, volume with no move is nothing happening.
    candidates.sort((a, b) => (b.periodReturnPct * b.volumeSurge) - (a.periodReturnPct * a.volumeSurge));
    const top = candidates.slice(0, TOP_N);

    // Cross-check against what the real nightly scan already covers, so this
    // highlights what the curated ~500-symbol universe would otherwise miss.
    const trackedRes = await query(
        `SELECT DISTINCT symbol FROM daily_universe_analysis WHERE analysis_date >= CURRENT_DATE - INTERVAL '10 days'`
    );
    const tracked = new Set(trackedRes.rows.map(r => r.symbol));

    console.log('\n=== TOP CANDIDATES (not already scored by PANTHEON in the last 10 days) ===');
    const novel = top.filter(c => !tracked.has(c.symbol));
    for (const c of novel.slice(0, 25)) {
        console.log(`${c.symbol.padEnd(8)} return=${c.periodReturnPct >= 0 ? '+' : ''}${c.periodReturnPct}%  volSurge=${c.volumeSurge}x  price=$${c.lastClose}  avgVol=${c.avgVolume.toLocaleString()}`);
    }

    console.log(`\n[FullMarketScreen] ${top.length} total top candidates, ${novel.length} not already in PANTHEON's tracked universe, ${top.length - novel.length} already covered (cross-validation)`);

    process.exit(0);
}

main().catch(err => {
    console.error('[FullMarketScreen] Fatal error:', err.message);
    process.exit(1);
});
