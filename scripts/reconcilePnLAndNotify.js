// reconcilePnLAndNotify.js
// Usage: node scripts/reconcilePnLAndNotify.js [username]
// Computes trade-level P&L for this week, compares to ai_performance_metrics, sends a Telegram summary.

// Load backend .env (fallback)
try { require('dotenv').config({ path: 'backend/.env' }); } catch (e) {
  const fs = require('fs');
  const envPath = require('path').join(__dirname, '..', 'backend', '.env');
  try {
    const envRaw = fs.readFileSync(envPath, 'utf8');
    envRaw.split(/\r?\n/).forEach(line => {
      line = line.trim(); if (!line || line.startsWith('#')) return;
      const idx = line.indexOf('='); if (idx === -1) return;
      const key = line.slice(0, idx).trim(); let val = line.slice(idx+1).trim();
      if (val.includes('#')) val = val.split('#')[0].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1,-1);
      if (key && val && !process.env[key]) process.env[key] = val;
    });
  } catch (err) { /* ignore */ }
}

const https = require('https');
const { query } = require('../backend/src/config/database');
const tradesDb = require('../backend/src/services/tradesDatabaseService');

function sendTelegramMessage(token, chatId, text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ chat_id: chatId, text });
    const options = { hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { const j = JSON.parse(body); if (j.ok) resolve(j); else reject(new Error('Telegram error: ' + JSON.stringify(j))); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getMondayISO(d) { d = new Date(d); const day = d.getDay(); const diff = d.getDate() - day + (day === 0 ? -6 : 1); return new Date(d.setDate(diff)).toISOString().slice(0,10); }

const username = process.argv[2] || 'user';

(async function(){
  try{
    // Find user
    const ures = await query(`SELECT id, username, email FROM users WHERE username = $1 OR email = $1 LIMIT 1`, [username]);
    if (!ures.rowCount) return console.error('User not found:', username);
    const user = ures.rows[0];

    const today = new Date();
    const monday = getMondayISO(today);
    const todayISO = today.toISOString().slice(0,10);

    // Trades this week
    const trades = await tradesDb.getTradesByDateRange(user.id, monday, todayISO);
    const tradePnL = trades.reduce((s,t)=>s + (Number(t.total)||0), 0);

    // Aggregated metrics table
    const perfRes = await query(`SELECT COALESCE(SUM(total_profit_loss),0) as total_profit_loss FROM ai_performance_metrics WHERE user_id = $1 AND date >= date_trunc('week', CURRENT_DATE)`, [user.id]);
    const aggPnL = Number(perfRes.rows[0].total_profit_loss) || 0;

    // Build explanation
    let md = `*PnL Reconciliation — ${todayISO}*\n\n`;
    md += `*User:* ${user.username} (${user.email || 'N/A'})\n`;
    md += `*This week (${monday} → ${todayISO})*\n`;
    md += `• Trade-level net P&L: *$${tradePnL.toFixed(2)}*\n`;
    md += `• Aggregated metrics table P&L: *$${aggPnL.toFixed(2)}*\n`;
    const diff = tradePnL - aggPnL;
    md += `• Difference (trade - agg): *$${diff.toFixed(2)}*\n\n`;

    if (Math.abs(diff) > 1) {
      md += `*Possible causes for discrepancy:*\n`;
      md += `- Aggregated table may record realized P&L differently (e.g., only realized vs. trade.row total includes fees/commission).\n`;
      md += `- Rounding/aggregation windows or timezone differences.\n`;
      md += `- Some trades may be pending/partial fills not reflected in metrics.\n\n`;
    } else {
      md += `Numbers match closely — no major discrepancy.\n\n`;
    }

    md += `*Per-trade breakdown (this week):*\n`;
    if (trades.length === 0) md += `No trades found.\n`;
    for (const t of trades) {
      const pnl = Number(t.total)||0;
      md += `• ${t.trade_date.toISOString().slice(0,19).replace('T',' ')} — ${t.action} ${t.symbol} x${t.quantity} @ ${t.price} => $${pnl.toFixed(2)} (${t.executed_by || 'manual'}${t.ai_score ? `, score ${t.ai_score}` : ''})\n`;
      if (t.notes) md += `  _notes:_ ${t.notes}\n`;
    }

    md += `\n*Quick recommendations:*\n`;
    md += `• Reconcile commission handling between ` + '`trades.total`' + ` and ` + '`ai_performance_metrics.total_profit_loss`' + `.\n`;
    md += `• Verify holdings update job for accurate unrealized values.\n`;
    md += `• If discrepancies persist, run per-day aggregation SQL and compare.\n`;

    // Send via Telegram
    const token = process.env.TELEGRAM_BOT_TOKEN; const chat = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chat) return console.error('Telegram not configured in backend/.env');
    // split into 3500 chars
    const max = 3500; for (let i=0;i<md.length;i+=max){ const part = md.slice(i,i+max); const prefix = (md.length>max)? `[${Math.floor(i/max)+1}/${Math.ceil(md.length/max)}] ` : ''; await sendTelegramMessage(token, chat, prefix + part); }
    console.log('Reconciliation summary sent to Telegram');
  } catch (err) { console.error('Error:', err.message); }
})();
