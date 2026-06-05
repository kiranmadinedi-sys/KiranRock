require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { query } = require('./src/config/database');
const uid = 'b3eec6b6-719d-4686-92da-35c96ab61289';

async function run() {
    const [phases, setups, counts, sample, tradesSample] = await Promise.all([
        query('SELECT decision_phase, COUNT(*) FROM trade_decision_journal WHERE user_id=$1 GROUP BY decision_phase', [uid]),
        query('SELECT setup_family, regime, COUNT(*) FROM trade_decision_journal WHERE user_id=$1 AND pnl IS NOT NULL GROUP BY setup_family, regime', [uid]),
        query('SELECT COUNT(*) as total, COUNT(pnl) as with_pnl, COUNT(setup_family) as with_setup FROM trade_decision_journal WHERE user_id=$1', [uid]),
        query('SELECT decision_phase, setup_family, regime, pnl, pnl_percent, score FROM trade_decision_journal WHERE user_id=$1 LIMIT 5', [uid]),
        query('SELECT symbol, action, ai_score, sector FROM trades WHERE user_id=$1 LIMIT 5', [uid]),
    ]);
    console.log('Decision phases:', JSON.stringify(phases.rows));
    console.log('Setups with P&L:', JSON.stringify(setups.rows));
    console.log('Counts:', JSON.stringify(counts.rows));
    console.log('Journal sample:', JSON.stringify(sample.rows));
    console.log('Trades sample:', JSON.stringify(tradesSample.rows));
    process.exit(0);
}
run().catch(e => { console.error(e.stack); process.exit(1); });
