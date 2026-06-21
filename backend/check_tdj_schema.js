require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { query } = require('./src/config/database');
async function main() {
    const r = await query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position", ['trade_decision_journal']);
    console.log('trade_decision_journal columns:');
    r.rows.forEach(c => console.log('  ', c.column_name, ':', c.data_type));
    // Sample a row
    const s = await query("SELECT * FROM trade_decision_journal WHERE user_id='ca632c53-8798-46f4-be94-29be0fede7f2' ORDER BY created_at DESC LIMIT 1");
    if (s.rows.length > 0) {
        console.log('\nSample row keys:', Object.keys(s.rows[0]));
        console.log('metadata:', JSON.stringify(s.rows[0].metadata, null, 2));
    }
    process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
