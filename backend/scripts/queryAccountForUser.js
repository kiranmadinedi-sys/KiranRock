const { query } = require('../src/config/database');

const userId = '5f75d123-c22c-44d6-9af3-2f8ec27309e2';

(async () => {
  try {
    const acc = await query('SELECT id, user_id, balance, created_at FROM trading_accounts WHERE user_id = $1', [userId]);
    console.log('ACCOUNT ROWS:', acc.rowCount);
    console.log(acc.rows);

    const tx = await query("SELECT id, symbol, action, total, trade_date FROM trades WHERE user_id = $1 ORDER BY trade_date DESC LIMIT 50", [userId]);
    console.log('TRADE TX:', tx.rowCount);
    console.log(tx.rows);
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    process.exit();
  }
})();
