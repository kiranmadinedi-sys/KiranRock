require('dotenv').config();
const { query } = require('./src/config/database');

(async () => {
    // Get trading_accounts columns
    const cols = await query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='trading_accounts' ORDER BY ordinal_position"
    );
    console.log('trading_accounts columns:', cols.rows.map(r => r.column_name));

    // Get trades columns
    const tcols = await query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='trades' ORDER BY ordinal_position"
    );
    console.log('trades columns:', tcols.rows.map(r => r.column_name));

    // Get all trades for kmadined
    const userId = 'ca632c53-8798-46f4-be94-29be0fede7f2';
    const trades = await query(
        "SELECT * FROM trades WHERE user_id=$1 ORDER BY trade_date DESC LIMIT 30",
        [userId]
    );
    console.log('\nkmadined trades count:', trades.rows.length);
    if (trades.rows.length > 0) {
        console.log('Sample trade:', JSON.stringify(trades.rows[0], null, 2));
        console.log('All trades:', JSON.stringify(trades.rows, null, 2));
    }

    // Also check trading_accounts for kmadined
    const accts = await query(
        "SELECT * FROM trading_accounts WHERE user_id=$1",
        [userId]
    );
    console.log('\nkmadined trading_account:', JSON.stringify(accts.rows, null, 2));

    // All users trade counts
    const counts = await query(
        "SELECT user_id, action, COUNT(*) FROM trades GROUP BY user_id, action ORDER BY user_id"
    );
    console.log('\nAll trade counts by user+action:', JSON.stringify(counts.rows, null, 2));

    process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
