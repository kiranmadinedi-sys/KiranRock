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
        const username = 'user';
        const userRes = await pool.query(`SELECT id FROM users WHERE username = $1`, [username]);
        const userId = userRes.rows[0].id;

        const res = await pool.query(`SELECT symbol, quantity, average_price, current_price FROM holdings WHERE user_id = $1`, [userId]);
        let totalCurrent = 0;
        let totalCost = 0;
        res.rows.forEach(h => {
            const qty = parseFloat(h.quantity || 0);
            const avg = parseFloat(h.average_price || 0);
            const cur = parseFloat(h.current_price || avg);
            totalCurrent += qty * cur;
            totalCost += qty * avg;
        });

        console.log('Holdings totals:');
        console.log('  Total market value:', totalCurrent.toFixed(2));
        console.log('  Total cost basis:', totalCost.toFixed(2));
        console.log('  Unrealized P/L:', (totalCurrent - totalCost).toFixed(2));

        await pool.end();
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
})();
