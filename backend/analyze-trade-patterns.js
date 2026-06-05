require('dotenv').config({ path: '.env' });
const { query } = require('./src/config/database');
const axios = require('axios');

async function analyzeAndSend() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const since = thirtyDaysAgo.toISOString().split('T')[0];

  // --- 1. Symbol breakdown ---
  const symbolRes = await query(`
    WITH buy_avg AS (
      SELECT user_id, symbol, AVG(price) as avg_buy_price
      FROM trades WHERE action = 'BUY' AND trade_date >= $1
      GROUP BY user_id, symbol
    ),
    pnl_trades AS (
      SELECT s.symbol,
             (s.total - b.avg_buy_price * s.quantity) AS pnl
      FROM trades s
      JOIN buy_avg b ON s.user_id = b.user_id AND s.symbol = b.symbol
      WHERE s.action = 'SELL' AND s.trade_date >= $1
    )
    SELECT symbol,
           COUNT(*) as trades,
           SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
           ROUND(SUM(pnl)::numeric, 2) as total_pnl,
           ROUND(AVG(pnl)::numeric, 2) as avg_pnl
    FROM pnl_trades
    GROUP BY symbol ORDER BY total_pnl ASC
  `, [since]);

  // --- 2. Sector breakdown ---
  const sectorRes = await query(`
    WITH buy_avg AS (
      SELECT user_id, symbol, AVG(price) as avg_buy_price
      FROM trades WHERE action = 'BUY' AND trade_date >= $1
      GROUP BY user_id, symbol
    ),
    pnl_trades AS (
      SELECT COALESCE(s.sector, 'Unknown') as sector,
             (s.total - b.avg_buy_price * s.quantity) AS pnl
      FROM trades s
      JOIN buy_avg b ON s.user_id = b.user_id AND s.symbol = b.symbol
      WHERE s.action = 'SELL' AND s.trade_date >= $1
    )
    SELECT sector, COUNT(*) as trades,
           SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
           ROUND(SUM(pnl)::numeric, 2) as total_pnl
    FROM pnl_trades
    GROUP BY sector ORDER BY total_pnl ASC
  `, [since]);

  // --- 3. AI vs Manual ---
  const aiRes = await query(`
    WITH buy_avg AS (
      SELECT user_id, symbol, AVG(price) as avg_buy_price
      FROM trades WHERE action = 'BUY' AND trade_date >= $1
      GROUP BY user_id, symbol
    ),
    pnl_trades AS (
      SELECT COALESCE(s.executed_by, 'manual') as executed_by,
             s.ai_score,
             (s.total - b.avg_buy_price * s.quantity) AS pnl
      FROM trades s
      JOIN buy_avg b ON s.user_id = b.user_id AND s.symbol = b.symbol
      WHERE s.action = 'SELL' AND s.trade_date >= $1
    )
    SELECT executed_by,
           COUNT(*) as trades,
           SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
           ROUND(AVG(COALESCE(ai_score,0))::numeric, 2) as avg_ai_score,
           ROUND(SUM(pnl)::numeric, 2) as total_pnl
    FROM pnl_trades
    GROUP BY executed_by ORDER BY total_pnl ASC
  `, [since]);

  // --- 4. Top 10 biggest losing trades ---
  const losersRes = await query(`
    WITH buy_avg AS (
      SELECT user_id, symbol, AVG(price) as avg_buy_price
      FROM trades WHERE action = 'BUY' AND trade_date >= $1
      GROUP BY user_id, symbol
    )
    SELECT s.symbol, s.quantity,
           ROUND(s.price::numeric, 2) as sell_price,
           ROUND(b.avg_buy_price::numeric, 2) as avg_buy_price,
           ROUND((s.total - b.avg_buy_price * s.quantity)::numeric, 2) AS pnl,
           s.trade_date::date as trade_date,
           COALESCE(s.executed_by, 'manual') as executed_by,
           s.ai_score,
           COALESCE(s.sector, 'Unknown') as sector
    FROM trades s
    JOIN buy_avg b ON s.user_id = b.user_id AND s.symbol = b.symbol
    WHERE s.action = 'SELL' AND s.trade_date >= $1
      AND (s.total - b.avg_buy_price * s.quantity) < 0
    ORDER BY pnl ASC LIMIT 10
  `, [since]);

  // --- 5. AI score comparison ---
  const scoreRes = await query(`
    WITH buy_avg AS (
      SELECT user_id, symbol, AVG(price) as avg_buy_price
      FROM trades WHERE action = 'BUY' AND trade_date >= $1
      GROUP BY user_id, symbol
    ),
    pnl_trades AS (
      SELECT s.ai_score,
             (s.total - b.avg_buy_price * s.quantity) AS pnl
      FROM trades s
      JOIN buy_avg b ON s.user_id = b.user_id AND s.symbol = b.symbol
      WHERE s.action = 'SELL' AND s.trade_date >= $1 AND s.ai_score IS NOT NULL
    )
    SELECT
      ROUND(AVG(CASE WHEN pnl > 0 THEN ai_score END)::numeric, 2) as avg_score_winners,
      ROUND(AVG(CASE WHEN pnl <= 0 THEN ai_score END)::numeric, 2) as avg_score_losers,
      ROUND(MIN(CASE WHEN pnl > 0 THEN ai_score END)::numeric, 2) as min_score_winners,
      ROUND(MAX(CASE WHEN pnl <= 0 THEN ai_score END)::numeric, 2) as max_score_losers,
      COUNT(CASE WHEN pnl <= 0 AND ai_score IS NOT NULL THEN 1 END) as scored_losers,
      COUNT(CASE WHEN pnl > 0 AND ai_score IS NOT NULL THEN 1 END) as scored_winners
    FROM pnl_trades
  `, [since]);

  // --- 6. Day of week ---
  const dowRes = await query(`
    WITH buy_avg AS (
      SELECT user_id, symbol, AVG(price) as avg_buy_price
      FROM trades WHERE action = 'BUY' AND trade_date >= $1
      GROUP BY user_id, symbol
    ),
    pnl_trades AS (
      SELECT s.trade_date,
             (s.total - b.avg_buy_price * s.quantity) AS pnl
      FROM trades s
      JOIN buy_avg b ON s.user_id = b.user_id AND s.symbol = b.symbol
      WHERE s.action = 'SELL' AND s.trade_date >= $1
    )
    SELECT TRIM(TO_CHAR(trade_date, 'Day')) as day_of_week,
           EXTRACT(DOW FROM trade_date) as dow_num,
           COUNT(*) as trades,
           SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
           ROUND(SUM(pnl)::numeric, 2) as total_pnl
    FROM pnl_trades
    GROUP BY TRIM(TO_CHAR(trade_date, 'Day')), EXTRACT(DOW FROM trade_date)
    ORDER BY EXTRACT(DOW FROM trade_date)
  `, [since]);

  // ========== BUILD TELEGRAM MESSAGE ==========
  const symbols = symbolRes.rows;
  const sectors = sectorRes.rows;
  const aiVsManual = aiRes.rows;
  const topLosers = losersRes.rows;
  const scores = scoreRes.rows[0] || {};
  const dow = dowRes.rows;

  const totalWins = symbols.reduce((s, r) => s + parseInt(r.wins), 0);
  const totalLosses = symbols.reduce((s, r) => s + parseInt(r.losses), 0);
  const totalTrades = totalWins + totalLosses;
  const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : 0;
  const totalPnl = symbols.reduce((s, r) => s + parseFloat(r.total_pnl || 0), 0);

  // Identify worst symbols (where losses > wins)
  const bleedingSymbols = symbols.filter(r => parseInt(r.losses) > parseInt(r.wins));
  const bestSymbols = [...symbols].sort((a,b) => parseFloat(b.total_pnl) - parseFloat(a.total_pnl)).filter(r => parseFloat(r.total_pnl) > 0).slice(0, 3);

  // Identify root cause patterns
  const rootCauses = [];

  // Check AI score pattern
  if (scores.avg_score_losers !== null && scores.avg_score_winners !== null) {
    const loserScore = parseFloat(scores.avg_score_losers || 0);
    const winnerScore = parseFloat(scores.avg_score_winners || 0);
    if (loserScore > 0) {
      rootCauses.push(`AI scores of losing trades avg ${loserScore} vs winners avg ${winnerScore} — trades with low AI confidence are executing`);
    }
    if (scores.max_score_losers > 60) {
      rootCauses.push(`Some losers had high AI scores (max ${scores.max_score_losers}) — market moved against prediction despite high confidence`);
    }
  }

  // Check if manual trades losing more
  const manualRow = aiVsManual.find(r => r.executed_by === 'manual');
  const aiRow = aiVsManual.find(r => r.executed_by === 'ai' || r.executed_by === 'bot');
  if (manualRow && parseInt(manualRow.losses) > parseInt(manualRow.wins)) {
    rootCauses.push(`Manual trades bleeding: ${manualRow.losses} losses vs ${manualRow.wins} wins — emotional/unplanned entries detected`);
  }
  if (aiRow && parseInt(aiRow.losses) > parseInt(aiRow.wins)) {
    rootCauses.push(`AI bot trades also losing: ${aiRow.losses} losses vs ${aiRow.wins} wins — AI model needs retraining or stricter entry threshold`);
  }

  // Check worst day
  const worstDay = [...dow].sort((a,b) => parseFloat(a.total_pnl) - parseFloat(b.total_pnl))[0];
  if (worstDay && parseFloat(worstDay.total_pnl) < -100) {
    rootCauses.push(`Worst trading day: ${worstDay.day_of_week} with ₹${worstDay.total_pnl} P&L (${worstDay.losses} losses) — avoid or reduce size on this day`);
  }

  // Check worst sector
  const worstSector = sectors[0];
  if (worstSector && parseFloat(worstSector.total_pnl) < -100) {
    rootCauses.push(`Sector '${worstSector.sector}' is biggest drag: ₹${worstSector.total_pnl} total loss across ${worstSector.losses} trades`);
  }

  // Improvement recommendations
  const improvements = [
    scores.avg_score_losers < 55 ? `🔧 Raise AI entry threshold to 65+ (losers avg score: ${scores.avg_score_losers})` : null,
    bleedingSymbols.length > 3 ? `🚫 Pause trading on ${bleedingSymbols.slice(0,3).map(s=>s.symbol).join(', ')} — consistently losing` : null,
    manualRow && parseInt(manualRow.losses) > parseInt(manualRow.wins) ? `📵 Disable manual overrides — manual trades have ${manualRow.losses} losses vs ${manualRow.wins} wins` : null,
    worstDay ? `📅 Reduce position size on ${worstDay.day_of_week}s or skip entirely` : null,
    `📊 Add stop-loss at 1.5% per trade to cap downside on each position`,
    `⚖️ Apply Kelly Criterion sizing — reduce size on low-confidence trades`,
    bestSymbols.length > 0 ? `✅ Focus capital on best performers: ${bestSymbols.map(s=>s.symbol).join(', ')}` : null,
  ].filter(Boolean);

  // Build message parts (plain text)
  let msg = `📊 TRADE WIN/LOSS DEEP ANALYSIS - Last 30 Days\n`;
  msg += `========================\n`;
  msg += `Wins: ${totalWins} | Losses: ${totalLosses} | WinRate: ${winRate}%\n`;
  msg += `Net P&L: Rs.${totalPnl.toFixed(2)}\n\n`;

  msg += `-- BLEEDING SYMBOLS (more losses than wins) --\n`;
  if (bleedingSymbols.length === 0) {
    msg += `None — all symbols net positive\n`;
  } else {
    bleedingSymbols.forEach(r => {
      msg += `  ${r.symbol}: ${r.losses}L/${r.wins}W  P&L Rs.${r.total_pnl}\n`;
    });
  }
  msg += `\n`;

  msg += `\n-- SECTOR PERFORMANCE --\n`;
  sectors.forEach(r => {
    const icon = parseFloat(r.total_pnl) >= 0 ? '[+]' : '[-]';
    msg += `  ${icon} ${r.sector}: ${r.wins}W/${r.losses}L  Rs.${r.total_pnl}\n`;
  });
  msg += `\n`;

  msg += `\n-- AI BOT vs MANUAL --\n`;
  aiVsManual.forEach(r => {
    const wr = parseInt(r.trades) > 0 ? ((parseInt(r.wins)/parseInt(r.trades))*100).toFixed(0) : 0;
    msg += `  ${r.executed_by}: ${r.wins}W/${r.losses}L (${wr}% WR) AvgScore:${r.avg_ai_score}  Rs.${r.total_pnl}\n`;
  });
  msg += `\n`;

  if (scores.avg_score_winners !== null) {
    msg += `\n-- AI SCORE INSIGHT --\n`;
    msg += `  Winners avg score: ${scores.avg_score_winners}\n`;
    msg += `  Losers avg score:  ${scores.avg_score_losers}\n`;
    msg += `  Scored losers: ${scores.scored_losers} | Scored winners: ${scores.scored_winners}\n\n`;
  }

  msg += `\n-- DAY OF WEEK PATTERN --\n`;
  dow.forEach(r => {
    const icon = parseFloat(r.total_pnl) >= 0 ? '[+]' : '[-]';
    msg += `  ${icon} ${r.day_of_week}: ${r.wins}W/${r.losses}L  Rs.${r.total_pnl}\n`;
  });
  msg += `\n`;

  msg += `\n-- TOP 10 WORST LOSING TRADES --\n`;
  topLosers.forEach((r, i) => {
    msg += `  ${i+1}. ${r.symbol} | Qty:${r.quantity} | Sell:${r.sell_price} Buy:${r.avg_buy_price} | P&L:Rs.${r.pnl} | By:${r.executed_by} | Score:${r.ai_score || 'N/A'} | ${r.trade_date}\n`;
  });
  msg += `\n`;

  msg += `\n-- ROOT CAUSES IDENTIFIED --\n`;
  if (rootCauses.length === 0) {
    msg += `  Data insufficient for pattern detection\n`;
  } else {
    rootCauses.forEach((c, i) => msg += `  ${i+1}. ${c}\n`);
  }
  msg += `\n`;

  msg += `\n-- RECOMMENDATIONS TO IMPROVE WIN RATE --\n`;
  improvements.forEach((r, i) => msg += `  ${i+1}. ${r}\n`);
  msg += `\n`;

  msg += `\n-- GOAL: Target 55%+ win rate --\n`;
  msg += `  - Higher AI entry bar (score >= 65)\n`;
  msg += `  - Hard stop-loss 1.5% per trade\n`;
  msg += `  - Reduce manual overrides\n`;
  msg += `  - Focus on top 3 performing symbols\n`;
  msg += `  - Backtest before adding new symbols\n`;

  // Send to Telegram
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');

  // Split into chunks if > 4096 chars
  const maxLen = 4000;
  const chunks = [];
  let current = '';
  for (const line of msg.split('\n')) {
    if ((current + line + '\n').length > maxLen) {
      chunks.push(current);
      current = line + '\n';
    } else {
      current += line + '\n';
    }
  }
  if (current) chunks.push(current);

  for (let i = 0; i < chunks.length; i++) {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = {
      chat_id: chatId,
      text: (chunks.length > 1 ? `[${i+1}/${chunks.length}] ` : '') + chunks[i],
    };
    const resp = await axios.post(url, payload);
    if (!resp.data.ok) throw new Error('Telegram error: ' + JSON.stringify(resp.data));
    console.log(`Chunk ${i+1}/${chunks.length} sent`);
  }

  console.log('SUCCESS - Trade analysis report sent to Telegram');
  process.exit(0);
}

analyzeAndSend().catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
