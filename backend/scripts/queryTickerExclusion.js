/**
 * Operator query tool — "Why was [symbol] excluded on [date]?"
 *
 * Usage:
 *   node scripts/queryTickerExclusion.js AMD
 *   node scripts/queryTickerExclusion.js AMD 2026-05-27
 *   node scripts/queryTickerExclusion.js --summary          (today's exclusion breakdown)
 *   node scripts/queryTickerExclusion.js --drift            (7-day prescreen drift report)
 *   node scripts/queryTickerExclusion.js --new              (new tickers in today's scan)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const svc = require('../src/services/precomputedUniverseService');

async function main() {
    const args = process.argv.slice(2);

    if (args[0] === '--summary') {
        const rows = await svc.getExclusionSummary();
        if (!rows.length) { console.log('No exclusion data for today.'); return; }
        console.log('\n── Exclusion Reason Summary (today) ──');
        rows.forEach(r => console.log(`  ${r.category.padEnd(20)} ${r.count}`));
        return;
    }

    if (args[0] === '--drift') {
        const drift = await svc.checkPrescreenDrift(7);
        if (!drift) { console.log('No drift data available.'); return; }
        console.log('\n── 7-Day Prescreen Drift Report ──');
        console.log(`  Prescreened (7d ago):  ${drift.prescreenCount}`);
        console.log(`  Actually traded:       ${drift.tradedCount}`);
        console.log(`  Conversion rate:       ${drift.conversionRate}%`);
        console.log(`  Win rate (traded):     ${drift.winRate}%`);
        console.log(`  Avg P&L (traded):      $${drift.avgPnl}`);
        if (drift.conversionRate < 5 && drift.prescreenCount > 20) {
            console.log('\n  ⚠️  Low conversion — threshold may be too strict or regime blocking entries');
        }
        if (drift.winRate < 40 && drift.tradedCount >= 5) {
            console.log('\n  ⚠️  Low win rate — consider raising overnight ai_score floor');
        }
        return;
    }

    if (args[0] === '--new') {
        const tickers = await svc.getNewTickers();
        if (!tickers.length) { console.log('No new tickers detected today.'); return; }
        console.log(`\n── New Tickers Today (${tickers.length}) ──`);
        console.log(' ', tickers.join(', '));
        return;
    }

    const symbol = (args[0] || '').toUpperCase().trim();
    if (!symbol) {
        console.log('Usage: node queryTickerExclusion.js <SYMBOL> [YYYY-MM-DD]');
        console.log('       node queryTickerExclusion.js --summary');
        console.log('       node queryTickerExclusion.js --drift');
        console.log('       node queryTickerExclusion.js --new');
        process.exit(1);
    }

    const date = args[1] || undefined;
    const record = await svc.getSymbolScanRecord(symbol, date);

    if (!record) {
        console.log(`\n${symbol} was NOT found in the nightly scan for ${date || 'today'}.`);
        console.log('Possible reasons: ticker not in universe, scan not yet run, or data provider returned nothing.');
        return;
    }

    console.log(`\n── ${symbol} — Nightly Scan Record (${record.analysis_date}) ──`);
    console.log(`  Passed prescreen:  ${record.passed_prescreen ? '✅ YES' : '❌ NO'}`);
    console.log(`  AI Score:          ${record.ai_score ?? 'n/a'}`);
    console.log(`  Recommendation:    ${record.recommendation ?? 'n/a'}`);
    console.log(`  Setup Family:      ${record.setup_family ?? 'n/a'}`);
    console.log(`  Sector:            ${record.sector ?? 'n/a'}`);
    if (!record.passed_prescreen && record.exclusion_reason) {
        console.log(`  Exclusion Reason:  ${record.exclusion_reason}`);
    }
    console.log(`  Scanned at:        ${record.updated_at}`);
}

main().then(() => process.exit(0)).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
