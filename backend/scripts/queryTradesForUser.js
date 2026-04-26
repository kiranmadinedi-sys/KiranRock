const { query } = require('../src/config/database');

const userId = '5f75d123-c22c-44d6-9af3-2f8ec27309e2';

(async () => {
  try {
    const res = await query(`SELECT id, action, symbol, quantity, price, total, commission, trade_date, notes FROM trades WHERE user_id = $1 ORDER BY trade_date DESC LIMIT 100`, [userId]);
    console.log('TRADES COUNT:', res.rowCount);
    console.log(res.rows);
  } catch (err) {
    console.error('ERROR QUERYING TRADES:', err.message);
  } finally {
    process.exit();
  }
})();
