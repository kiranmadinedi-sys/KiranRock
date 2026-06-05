/**
 * backfill-sharpe.js
 *
 * One-shot script: recomputes Sharpe ratio for every date in ai_performance_metrics
 * where sharpe_ratio is NULL or 0, using the same rolling-30-day daily-returns
 * formula as performanceMetricsService.calculateSharpeRatio().
 *
 * Usage:
 *   node backend/scripts/backfill-sharpe.js
 *   node backend/scripts/backfill-sharpe.js --dry-run   # print what would be updated
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { query, pool } = require('../src/config/database');
const { logger } = require('../src/utils/logger');

const DRY_RUN = process.argv.includes('--dry-run');

async function computeSharpe(userId, asOfDate) {
    // Daily P&L for the 30 days ending on asOfDate
    const res = await query(`
        SELECT total_profit_loss AS pnl
        FROM ai_performance_metrics
        WHERE user_id = $1
          AND date <= $2::date
          AND date >  ($2::date - INTERVAL '30 days')
        ORDER BY date ASC
    `, [userId, asOfDate]);

    const returns = res.rows.map(r => parseFloat(r.pnl) || 0);
    if (returns.length < 5) return 0; // not enough data for a meaningful estimate

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
    const std = Math.sqrt(variance);
    if (std === 0) return 0;

    // Annualised Sharpe (252 trading days)
    return (mean / std) * Math.sqrt(252);
}

async function run() {
    console.log(`[backfill-sharpe] Starting${DRY_RUN ? ' (DRY RUN)' : ''}...`);

    // Fetch all rows that need a Sharpe value
    const rows = await query(`
        SELECT id, user_id, date
        FROM ai_performance_metrics
        WHERE sharpe_ratio IS NULL OR sharpe_ratio = 0
        ORDER BY user_id, date ASC
    `);

    console.log(`[backfill-sharpe] Found ${rows.rows.length} rows to update`);
    if (rows.rows.length === 0) {
        console.log('[backfill-sharpe] Nothing to do. Exiting.');
        await pool.end();
        return;
    }

    let updated = 0;
    let skipped = 0;

    for (const row of rows.rows) {
        const sharpe = await computeSharpe(row.user_id, row.date);
        if (sharpe === 0) { skipped++; continue; }

        if (!DRY_RUN) {
            await query(`
                UPDATE ai_performance_metrics
                SET sharpe_ratio = $1, updated_at = NOW()
                WHERE id = $2
            `, [sharpe, row.id]);
        }

        console.log(`  ${DRY_RUN ? '[DRY]' : '[UPD]'} user=${row.user_id} date=${row.date} sharpe=${sharpe.toFixed(4)}`);
        updated++;
    }

    console.log(`\n[backfill-sharpe] Done. Updated: ${updated}, Skipped (insufficient data): ${skipped}`);
    await pool.end();
}

run().catch(e => {
    console.error('[backfill-sharpe] Fatal:', e.message);
    pool.end().finally(() => process.exit(1));
});
