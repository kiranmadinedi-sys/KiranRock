// Script: fetchThisWeeksTrades.js
// Description: Fetches and analyzes this week's trades for the given user from the local DB.

const { getTradesByDateRange } = require('../backend/src/services/tradesDatabaseService');

const userId = 'user'; // Replace with your actual user id if needed

// Helper to get Monday of this week
function getMonday(d) {
  d = new Date(d);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is Sunday
  return new Date(d.setDate(diff));
}

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

async function main() {
  try {
    const today = new Date();
    const monday = getMonday(today);
    const trades = await getTradesByDateRange(
      userId,
      toISODate(monday),
      toISODate(today)
    );
    if (!trades.length) {
      console.log('No trades found for this week.');
      return;
    }
    // Basic analysis
    let wins = 0, losses = 0, totalPnL = 0;
    trades.forEach(trade => {
      if (trade.total > 0) wins++;
      else if (trade.total < 0) losses++;
      totalPnL += trade.total;
    });
    console.log(`\n=== This Week's Trades Analysis ===`);
    console.log(`Total Trades: ${trades.length}`);
    console.log(`Wins: ${wins}`);
    console.log(`Losses: ${losses}`);
    console.log(`Net P&L: $${totalPnL.toFixed(2)}`);
    // Suggestions
    if (losses > wins) {
      console.log('Suggestion: Review losing trades for common patterns or mistakes.');
    } else if (wins > losses) {
      console.log('Good job! Keep monitoring your risk management.');
    } else {
      console.log('Mixed results. Consider reviewing both win and loss trades for improvement.');
    }
    // Print trade details
    console.table(trades.map(t => ({
      Date: t.trade_date,
      Symbol: t.symbol,
      Action: t.action,
      Qty: t.quantity,
      Price: t.price,
      Total: t.total,
      Notes: t.notes || ''
    })));
  } catch (err) {
    console.error('Error fetching trades:', err.message);
  }
}

main();
