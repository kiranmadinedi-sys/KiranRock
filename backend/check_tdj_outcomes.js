require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { query } = require('./src/config/database');
async function main() {
    const USER = 'ca632c53-8798-46f4-be94-29be0fede7f2';

    // Check what outcome values exist
    const r = await query(`
        SELECT outcome, decision_phase, COUNT(*) as cnt
        FROM trade_decision_journal WHERE user_id=$1
        GROUP BY outcome, decision_phase ORDER BY cnt DESC
    `, [USER]);
    console.log('Outcome values in TDJ:');
    r.rows.forEach(r => console.log('  phase=' + r.decision_phase + ' outcome=' + (r.outcome||'null') + ' cnt=' + r.cnt));

    // Check what metadata fields exist across rows
    const m = await query(`
        SELECT DISTINCT jsonb_object_keys(metadata) AS key
        FROM trade_decision_journal WHERE user_id=$1
        ORDER BY key
    `, [USER]);
    console.log('\nAll metadata keys:', m.rows.map(r => r.key).join(', '));

    // How many closed rows have daysToEarnings?
    const e = await query(`
        SELECT
            COUNT(*) FILTER (WHERE metadata->>'daysToEarnings' IS NOT NULL AND metadata->>'daysToEarnings' != 'null') AS with_dte,
            COUNT(*) FILTER (WHERE metadata->>'atrPct' IS NOT NULL) AS with_atr,
            COUNT(*) AS total
        FROM trade_decision_journal WHERE user_id=$1 AND decision_phase='CLOSED'
    `, [USER]);
    const row = e.rows[0];
    console.log('\nClosed rows:', row.total, '| with daysToEarnings:', row.with_dte, '| with atrPct:', row.with_atr);

    // Sample closed rows
    const c = await query(`
        SELECT symbol, score, confidence, regime, setup_family, pnl, pnl_percent, outcome,
               metadata->>'daysToEarnings' as dte,
               metadata->>'exitReason' as exit_reason,
               metadata->>'sector' as sector,
               metadata->>'atrPct' as atr_pct,
               closed_at
        FROM trade_decision_journal WHERE user_id=$1 AND decision_phase='CLOSED'
        ORDER BY closed_at DESC LIMIT 10
    `, [USER]);
    console.log('\nRecent CLOSED rows:');
    c.rows.forEach(r => {
        console.log('  ' + r.symbol
            + ' score=' + r.score
            + ' pnl=' + r.pnl
            + ' outcome=' + (r.outcome||'?')
            + ' exitReason=' + (r.exit_reason||'?')
            + ' dte=' + (r.dte||'null')
            + ' atrPct=' + (r.atr_pct||'null')
            + ' sector=' + (r.sector||'?')
        );
    });

    process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
