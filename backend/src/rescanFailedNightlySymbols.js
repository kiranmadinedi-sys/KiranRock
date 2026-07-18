require('./bootstrapRuntime');

const { query, pool } = require('./config/database');
const nightlyScanSvc  = require('./services/nightlyUniverseScanService');

async function main() {
    const date = process.argv[2] || '2026-07-17';

    const failedRes = await query(
        `SELECT symbol FROM daily_universe_analysis
         WHERE analysis_date = $1::date AND ai_score IS NULL
         ORDER BY symbol`,
        [date]
    );
    const symbols = failedRes.rows.map(r => r.symbol);

    console.log(`[Rescan] ${symbols.length} failed symbols for ${date} — starting`);

    const result = await nightlyScanSvc.rescanFailedSymbols(date, symbols);

    console.log(JSON.stringify({
        date: result.date,
        attempted: result.attempted,
        analyzed: result.analyzed,
        passed: result.passed,
        filtered: result.filtered,
        stillFailed: result.stillFailed
    }, null, 2));

    console.log('\nStill-failed symbols:', result.results.filter(r => !r.ok).map(r => r.symbol).join(', ') || 'none');
    console.log('\nNewly passed:', result.results.filter(r => r.ok && (r.recommendation === 'STRONG BUY' || r.recommendation === 'BUY') && r.score >= 70).map(r => `${r.symbol}(${r.score})`).join(', ') || 'none');
}

main()
    .then(async () => { await pool.end(); process.exit(0); })
    .catch(async (error) => {
        console.error('[Rescan] Failed:', error);
        try { await pool.end(); } catch (_) {}
        process.exit(1);
    });
