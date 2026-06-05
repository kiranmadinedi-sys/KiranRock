// Script: export-trades-to-csv.js
// Description: Exports all trades (buy/sell) for all users to a CSV file

const fs = require('fs');
// Use the shared database config
const { pool } = require('./src/config/database');

async function exportTradesToCSV() {
  const query = `SELECT user_id, symbol, action, quantity, price, trade_date, notes FROM trades ORDER BY user_id, symbol, trade_date`;
  try {
    const res = await pool.query(query);
    const rows = res.rows;
    if (!rows.length) {
      console.log('No trades found.');
      return;
    }
    const header = 'user_id,symbol,action,quantity,price,trade_date,notes\n';
    const csv =
      header +
      rows
        .map(r => [
          r.user_id,
          r.symbol,
          r.action,
          r.quantity,
          r.price,
          r.trade_date.toISOString(),
          (r.notes || '').replace(/\n/g, ' ').replace(/,/g, ';')
        ].join(','))
        .join('\n');
    fs.writeFileSync('all_trades.csv', csv);
    console.log('Exported to all_trades.csv');
  } catch (err) {
    console.error('Error exporting trades:', err.message);
  } finally {
    await pool.end();
  }
}

exportTradesToCSV();
