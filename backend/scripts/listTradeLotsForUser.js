const { query } = require('../src/config/database');
const userId = process.argv[2];
if (!userId) { console.error('Usage: node listTradeLotsForUser.js <userId>'); process.exit(1); }

(async () => {
  try {
    const res = await query('SELECT id, trade_id, symbol, quantity, remaining_quantity, price, commission, created_at FROM trade_lots WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    console.log('TRADE_LOTS COUNT:', res.rowCount);
    console.log(res.rows.slice(0,50));
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally { process.exit(); }
})();
