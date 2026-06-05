require('dotenv').config({ path: '.env' });
const axios = require('axios');

async function sendUpgradeReport() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Missing Telegram credentials');

  const msg = [
    '=== SYSTEM UPGRADE: WIN RATE IMPROVEMENTS DEPLOYED ===',
    'Date: ' + new Date().toLocaleString(),
    '',
    '-- CHANGES IMPLEMENTED --',
    '',
    '1. AI ENTRY THRESHOLD RAISED',
    '   Before: AI score >= 65 required to buy',
    '   After:  AI score >= 70 required to buy',
    '   Impact: Skips marginal/low-confidence setups that were',
    '           the main source of losing trades.',
    '   DB:     All 9 users updated',
    '',
    '2. STOP-LOSS TIGHTENED',
    '   Before: Stop-loss triggers at -7% loss',
    '   After:  Stop-loss triggers at -3% loss',
    '   Impact: Cuts individual trade losses 57% faster.',
    '           Losing trades now exit before damage compounds.',
    '',
    '3. TRAILING STOP TIGHTENED',
    '   Before: Trailing stop at 5% drop from peak',
    '   After:  Trailing stop at 3% drop from peak',
    '   Impact: Locks in profits sooner. Winners give back less',
    '           before the bot exits.',
    '',
    '4. BLEEDING SYMBOL GATE (NEW FEATURE)',
    '   Logic:  Any symbol with 3+ trades AND 60%+ loss rate',
    '           in the last 30 days is automatically BLOCKED',
    '           from new AI bot entries.',
    '   Scope:  Runs at start of every trading session, per user.',
    '   Cache:  Refreshes every 4 hours.',
    '',
    '5. MANUAL TRADE GUARD (NEW FEATURE)',
    '   Logic:  When a user manually buys a stock, the system',
    '           checks their own 30-day history for that symbol.',
    '           If loss rate >= 60% with 3+ trades, the buy is',
    '           BLOCKED with an explanation message.',
    '   Goal:   Prevents impulsive re-entries into known losers.',
    '',
    '-- EXPECTED IMPACT --',
    '  Win Rate:   44.3% -> Target 55%+ within 30 days',
    '  Avg Loss:   Per-trade loss reduced (3% cap vs 7%)',
    '  Avg Win:    Unchanged (take-profit levels kept same)',
    '  Risk/Trade: Reduced significantly',
    '',
    '-- WHAT STAYS THE SAME --',
    '  Take-profit: 25% (unchanged)',
    '  Partial exit: 15% profit (sell 50%, unchanged)',
    '  Kelly sizing: Already active (unchanged)',
    '  Circuit breakers: Daily/weekly/drawdown (unchanged)',
    '  All existing open positions: NOT affected (no forced exits)',
    '',
    '-- ACTION NEEDED --',
    '  Restart the trading server to activate code changes.',
    '  DB changes are already live for all 9 users.',
    '',
    '=== END OF UPGRADE REPORT ===',
  ].join('\n');

  const url = 'https://api.telegram.org/bot' + token + '/sendMessage';
  const resp = await axios.post(url, { chat_id: chatId, text: msg });
  if (!resp.data.ok) throw new Error('Telegram error: ' + JSON.stringify(resp.data));
  console.log('SUCCESS - Upgrade report sent to Telegram');
  process.exit(0);
}

sendUpgradeReport().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
