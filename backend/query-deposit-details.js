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

        console.log('Trades with notes or symbol indicating deposit:');
        const res = await pool.query(`SELECT id, action, symbol, quantity, price, total, commission, trade_date, notes FROM trades WHERE user_id = $1 AND (symbol ILIKE '%DEPOSIT%' OR notes ILIKE '%deposit%') ORDER BY trade_date DESC`, [userId]);
        res.rows.forEach(r => {
            console.log(r);
        });

        console.log('\nSum of commissions by action:');
        const commRes = await pool.query(`SELECT action, SUM(commission) as sum_comm FROM trades WHERE user_id = $1 GROUP BY action`, [userId]);
        console.log(commRes.rows);

        await pool.end();
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
})();
