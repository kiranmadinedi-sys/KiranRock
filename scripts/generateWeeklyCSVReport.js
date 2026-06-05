// generateWeeklyCSVReport.js
// Usage: node scripts/generateWeeklyCSVReport.js user
// Outputs: scripts/weekly-trades-<date>.csv and scripts/weekly-holdings-<date>.csv

const fs = require('fs');
const path = require('path');
const username = process.argv[2] || 'user';
const { query } = require('../backend/src/config/database');
const tradesDb = require('../backend/src/services/tradesDatabaseService');

function getMonday(d) {
  d = new Date(d);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}
function toISODate(date) { return date.toISOString().slice(0,10); }

function csvEscape(v){
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('\n') || s.includes('"')) return '"' + s.replace(/"/g,'""') + '"';
  return s;
}

(async function main(){
  try{
    console.log('Looking up user', username);
    const userRow = await query(`SELECT id, username, email FROM users WHERE username = $1 OR email = $1 LIMIT 1`, [username]);
    if (!userRow || !userRow.rowCount){
      console.error('User not found for', username);
      process.exit(1);
    }
    const user = userRow.rows[0];
    console.log('Found user id:', user.id);

    const today = new Date();
    const monday = getMonday(today);
    const start = toISODate(monday);
    const end = toISODate(today);

    const trades = await tradesDb.getTradesByDateRange(user.id, start, end);

    const dateTag = toISODate(today).replace(/-/g,'');
    const tradesFile = path.join(__dirname, `weekly-trades-${dateTag}.csv`);
    const holdingsFile = path.join(__dirname, `weekly-holdings-${dateTag}.csv`);

    // Write trades CSV
    const tradeHeaders = ['id','trade_date','symbol','action','quantity','price','total','commission','executed_by','notes'];
    let csv = tradeHeaders.join(',') + '\n';
    let cumPnL = 0;
    trades.forEach(t => {
      const row = [t.id, t.trade_date, t.symbol, t.action, t.quantity, t.price, t.total, t.commission, t.executed_by, t.notes];
      cumPnL += Number(t.total) || 0;
      csv += row.map(csvEscape).join(',') + '\n';
    });
    fs.writeFileSync(tradesFile, csv);
    console.log('Wrote', tradesFile, 'rows=', trades.length);

    // Write holdings CSV from holdings table
    let holdingsRows = [];
    try{
      const h = await query(`SELECT id, user_id, symbol, quantity, average_price, current_price, market_value, gain_loss, gain_loss_percent, purchase_date FROM holdings WHERE user_id = $1`, [user.id]);
      holdingsRows = h.rows || [];
    }catch(e){
      console.log('Holdings table query failed:', e.message);
    }
    if (holdingsRows.length){
      const headers = Object.keys(holdingsRows[0]);
      let hcsv = headers.join(',') + '\n';
      holdingsRows.forEach(r => {
        hcsv += headers.map(h=>csvEscape(r[h])).join(',') + '\n';
      });
      fs.writeFileSync(holdingsFile, hcsv);
      console.log('Wrote', holdingsFile, 'rows=', holdingsRows.length);
    } else {
      console.log('No holdings rows found for user, skipping holdings CSV');
    }

    // Summary print
    console.log('\nSummary:');
    console.log('Trades count:', trades.length);
    console.log('Cumulative P&L (this week):', cumPnL.toFixed(2));
    if (holdingsRows.length) console.log('Holdings count:', holdingsRows.length);

    console.log('\nFiles created in scripts/ — paste or attach them if you want a full report.');
  }catch(err){
    console.error('Error generating report:', err.message);
    console.error(err);
  }
})();
