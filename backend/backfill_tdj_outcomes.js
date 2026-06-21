/**
 * Backfill outcome field for CLOSED rows in trade_decision_journal
 * where outcome is NULL but pnl is known.
 *   pnl_percent > 0.5  → 'win'
 *   pnl_percent < -0.5 → 'loss'
 *   otherwise          → 'breakeven'
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { query } = require('./src/config/database');

async function main() {
    const check = await query(`
        SELECT id, symbol, pnl, pnl_percent, outcome, closed_at
        FROM trade_decision_journal
        WHERE decision_phase = 'CLOSED' AND outcome IS NULL AND pnl IS NOT NULL
        ORDER BY closed_at DESC
    `);

    if (!check.rows.length) {
        console.log('No CLOSED rows with null outcome found. Nothing to do.');
        process.exit(0);
    }

    console.log(`Found ${check.rows.length} rows to backfill:`);
    for (const r of check.rows) {
        const pctNum = parseFloat(r.pnl_percent) || 0;
        const outcome = pctNum > 0.5 ? 'win' : pctNum < -0.5 ? 'loss' : 'breakeven';
        console.log(`  id=${r.id} ${r.symbol} pnl=${r.pnl} pnl%=${r.pnl_percent} → outcome=${outcome}`);
        await query(`UPDATE trade_decision_journal SET outcome=$1 WHERE id=$2`, [outcome, r.id]);
    }

    console.log(`\nBackfilled ${check.rows.length} row(s). ✓`);
    process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
