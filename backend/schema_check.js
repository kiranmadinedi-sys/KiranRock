require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { query } = require('./src/config/database');
async function main() {
    const r = await query(
        "SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position",
        ['trades']
    );
    console.log('trades columns:', r.rows.map(c => c.column_name).join(', '));
    const r2 = await query(
        "SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position",
        ['holdings']
    );
    console.log('holdings columns:', r2.rows.map(c => c.column_name).join(', '));
    process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
