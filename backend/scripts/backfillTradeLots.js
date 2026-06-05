const { query } = require('../src/config/database');

const userId = process.argv[2];

if (!userId) {
  console.error('Usage: node backfillTradeLots.js <userId>');
  process.exit(1);
}

(async () => {
  try {
    // Find BUY trades for user that are not yet represented in trade_lots
    const tradesRes = await query(
      `SELECT id, symbol, quantity, price, commission FROM trades WHERE user_id = $1 AND action = 'BUY' ORDER BY trade_date ASC`,
      [userId]
    );

    let inserted = 0;

    for (const t of tradesRes.rows) {
      const exists = await query('SELECT 1 FROM trade_lots WHERE trade_id = $1 LIMIT 1', [t.id]);
      if (exists.rowCount > 0) continue;

      await query(
        `INSERT INTO trade_lots (trade_id, user_id, symbol, quantity, remaining_quantity, price, commission, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [t.id, userId, t.symbol, t.quantity, t.quantity, t.price, t.commission || 0]
      );
      inserted++;
    }

    console.log('BACKFILL COMPLETE for', userId, '- inserted lots:', inserted);
  } catch (err) {
    console.error('ERROR in backfill:', err.message || err);
  } finally {
    process.exit();
  }
})();
