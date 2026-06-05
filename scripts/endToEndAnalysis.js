// endToEndAnalysis.js
// Run: node scripts/endToEndAnalysis.js user
// Performs local DB analysis: finds user, fetches this week's trades, stats, performance, and attempts to read portfolio/positions.

const username = process.argv[2] || 'user';
const { query } = require('../backend/src/config/database');
const tradesDb = require('../backend/src/services/tradesDatabaseService');
const perfService = require('../backend/src/services/performanceMetricsService');

function getMonday(d) {
  d = new Date(d);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}
function toISODate(date) { return date.toISOString().slice(0,10); }

(async function main(){
  try{
    console.log('Looking up user', username);
    const userRow = await query(`SELECT id, username, email FROM users WHERE username = $1 OR email = $1 LIMIT 1`, [username]);
    if (!userRow || !userRow.rowCount){
      console.log('User not found for', username);
      return process.exit(0);
    }
    const user = userRow.rows[0];
    console.log('Found user:', user);

    const today = new Date();
    const monday = getMonday(today);
    const start = toISODate(monday);
    const end = toISODate(today);
    console.log(`Fetching trades for week ${start} -> ${end}`);

    const trades = await tradesDb.getTradesByDateRange(user.id, start, end);
    console.log('Trades count:', trades.length);

    // Basic trade analysis
    let wins=0, losses=0, totalPnL=0, totalTrades=trades.length;
    trades.forEach(t=>{
      const pnl = Number(t.total) || 0;
      if (pnl>0) wins++;
      else if (pnl<0) losses++;
      totalPnL += pnl;
    });

    console.log('\n=== Trade Summary ===');
    console.log('Total trades:', totalTrades);
    console.log('Wins:', wins, 'Losses:', losses, 'Net PnL:', totalPnL.toFixed(2));

    // Trade statistics from service
    try{
      const stats = await tradesDb.getTradeStatistics(user.id);
      console.log('\nTrade statistics:', stats);
    }catch(e){ console.log('Could not fetch trade statistics:', e.message); }

    // Weekly performance
    try{
      const weeklyPerf = await perfService.getWeeklyPerformance(user.id);
      console.log('\nWeekly performance summary:', weeklyPerf);
    }catch(e){ console.log('Could not fetch weekly performance:', e.message); }

    // Try to read common portfolio/positions tables
    const candidateTables = ['positions','holdings','portfolio_positions','ledger_trades','ledger','accounts','portfolios'];
    for (const tbl of candidateTables){
      try{
        const r = await query(`SELECT * FROM ${tbl} WHERE user_id = $1 LIMIT 50`, [user.id]);
        if (r && r.rowCount){
          console.log(`\nFound rows in table ${tbl} (showing up to 5):`);
          console.log(r.rows.slice(0,5));
        } else {
          // console.log(`table ${tbl} empty or not used`);
        }
      }catch(e){ /* table may not exist */ }
    }

    // Suggestions
    console.log('\n=== Suggestions ===');
    if (totalTrades === 0){
      console.log('- No trades this week: check bot scheduler, ensure there is non-zero cash balance and that the execution service is running.');
    } else {
      if (losses > wins) console.log('- More losses than wins this week: review stop-loss settings and execution logs for slippage or partial fills.');
      else console.log('- Winning ratio looks acceptable; monitor drawdowns and risk sizing.');
    }

    console.log('\nIf you want, paste the full `trades` array or run with a different username.');
  }catch(err){
    console.error('Error during analysis:', err.message);
    console.error(err);
  }
})();
