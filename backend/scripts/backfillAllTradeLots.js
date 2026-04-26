const { query } = require('../src/config/database');

(async () => {
  try {
    console.log('Searching for BUY trades missing trade_lots...');

    const res = await query(`
      SELECT t.id, t.user_id, t.symbol, t.quantity, t.price, t.commission
      FROM trades t
      WHERE t.action = 'BUY'
        AND NOT EXISTS (SELECT 1 FROM trade_lots l WHERE l.trade_id = t.id)
      ORDER BY t.trade_date ASC
    `);

    console.log('Found', res.rowCount, 'trades to backfill');

    let inserted = 0;
    for (const t of res.rows) {
      await query(`
        INSERT INTO trade_lots (trade_id, user_id, symbol, quantity, remaining_quantity, price, commission, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      `, [t.id, t.user_id, t.symbol, t.quantity, t.quantity, t.price, t.commission || 0]);
      inserted++;
    }

    console.log('Backfill complete. Inserted lots:', inserted);
  } catch (err) {
    console.error('ERROR during backfillAllTradeLots:', err.message || err);
  } finally {
    process.exit();
  }
})();
