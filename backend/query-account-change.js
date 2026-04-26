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

        const userRes = await pool.query(`SELECT id, username FROM users WHERE username = $1`, [username]);
        if (userRes.rows.length === 0) {
            console.error('User not found:', username);
            process.exit(1);
        }
        const userId = userRes.rows[0].id;

        const accountRes = await pool.query(`SELECT balance, initial_balance FROM trading_accounts WHERE user_id = $1`, [userId]);
        const account = accountRes.rows[0] || { balance: 0, initial_balance: 0 };

        const summaryRes = await pool.query(`
            SELECT
                SUM(CASE WHEN action = 'DEPOSIT' THEN total ELSE 0 END) as total_deposits,
                SUM(CASE WHEN action = 'WITHDRAWAL' THEN total ELSE 0 END) as total_withdrawals,
                SUM(CASE WHEN action = 'BUY' THEN total ELSE 0 END) as total_buys,
                SUM(CASE WHEN action = 'SELL' THEN total ELSE 0 END) as total_sells,
                SUM(commission) as total_commission
            FROM trades
            WHERE user_id = $1
        `, [userId]);

        const s = summaryRes.rows[0];
        const totalDeposits = parseFloat(s.total_deposits || 0);
        const totalWithdrawals = parseFloat(s.total_withdrawals || 0);
        const totalBuys = parseFloat(s.total_buys || 0);
        const totalSells = parseFloat(s.total_sells || 0);
        const totalCommission = parseFloat(s.total_commission || 0);

        console.log('Account summary for', username);
        console.log('  Initial balance:', parseFloat(account.initial_balance || 0).toFixed(2));
        console.log('  Current balance:', parseFloat(account.balance || 0).toFixed(2));
        console.log('  Total deposits:', totalDeposits.toFixed(2));
        console.log('  Total withdrawals:', totalWithdrawals.toFixed(2));
        console.log('  Total buys (cash spent):', totalBuys.toFixed(2));
        console.log('  Total sells (proceeds):', totalSells.toFixed(2));
        console.log('  Total commissions:', totalCommission.toFixed(2));

        const computedBalance = (parseFloat(account.initial_balance || 0) + totalDeposits - totalWithdrawals - totalBuys + totalSells - totalCommission);
        console.log('\nComputed balance from ledger:', computedBalance.toFixed(2));
        console.log('Difference (computed - reported):', (computedBalance - parseFloat(account.balance || 0)).toFixed(2));

        console.log('\nLast 50 trades:');
        const tradesRes = await pool.query(`SELECT action, symbol, quantity, price, total, commission, trade_date, notes, executed_by FROM trades WHERE user_id = $1 ORDER BY trade_date DESC LIMIT 50`, [userId]);
        tradesRes.rows.forEach(t => {
            console.log(`  [${t.trade_date}] ${t.action} ${t.quantity || ''} ${t.symbol || ''} @ ${t.price || ''} total=${t.total || ''} comm=${t.commission || 0} by=${t.executed_by || ''} ${t.notes || ''}`);
        });

        await pool.end();
    } catch (err) {
        console.error('Error running query:', err.message);
        process.exit(1);
    }
})();
