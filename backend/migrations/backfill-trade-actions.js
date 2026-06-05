const { Pool } = require('pg');

const pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'kiranrock_trading',
    user: 'postgres',
    password: 'admin'
});

(async () => {
    try {
        console.log('Starting backfill: normalize deposit/withdrawal trade actions');

        // Fix rows where symbol = 'DEPOSIT' but action is not 'DEPOSIT'
        const res1 = await pool.query(`UPDATE trades SET action = 'DEPOSIT' WHERE symbol = 'DEPOSIT' AND action != 'DEPOSIT' RETURNING id`);
        console.log('Updated DEPOSIT rows:', res1.rowCount);

        // Fix rows where symbol = 'WITHDRAWAL' but action is not 'WITHDRAWAL'
        const res2 = await pool.query(`UPDATE trades SET action = 'WITHDRAWAL' WHERE symbol = 'WITHDRAWAL' AND action != 'WITHDRAWAL' RETURNING id`);
        console.log('Updated WITHDRAWAL rows:', res2.rowCount);

        // Also normalize CASH-related system deposits/withdrawals
        const res3 = await pool.query(`UPDATE trades SET action = 'DEPOSIT' WHERE symbol = 'CASH' AND notes ILIKE '%deposit%' AND action != 'DEPOSIT' RETURNING id`);
        console.log('Updated CASH deposit rows:', res3.rowCount);

        const res4 = await pool.query(`UPDATE trades SET action = 'WITHDRAWAL' WHERE symbol = 'CASH' AND notes ILIKE '%withdraw%' AND action != 'WITHDRAWAL' RETURNING id`);
        console.log('Updated CASH withdrawal rows:', res4.rowCount);

        await pool.end();
        console.log('Backfill complete');
    } catch (err) {
        console.error('Backfill failed:', err.message);
        process.exit(1);
    }
})();
