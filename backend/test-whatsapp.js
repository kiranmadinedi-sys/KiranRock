/**
 * WhatsApp integration test.
 * Run: node test-whatsapp.js
 * Before running: fill in TWILIO_AUTH_TOKEN in .env and set NOTIFY_WHATSAPP=true
 */
require('dotenv').config();

const sid   = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
const from  = process.env.TWILIO_WHATSAPP_FROM;
const to    = process.env.TWILIO_WHATSAPP_TO;
const enabled = process.env.NOTIFY_WHATSAPP === 'true';

console.log('\n=== WhatsApp / Twilio Test ===\n');
console.log(`Account SID : ${sid ? sid.slice(0,10) + '****' : '❌ MISSING'}`);
console.log(`Auth Token  : ${token ? '✅ Set' : '❌ MISSING — fill TWILIO_AUTH_TOKEN in .env'}`);
console.log(`From        : ${from || '❌ MISSING'}`);
console.log(`To          : ${to   || '❌ MISSING'}`);
console.log(`Enabled     : ${enabled ? '✅ true' : '⚠️  false — set NOTIFY_WHATSAPP=true to activate'}`);
console.log('');

if (!sid || !token || !to) {
    console.error('❌  Cannot test — missing credentials above.');
    process.exit(1);
}

if (!enabled) {
    console.log('⚠️  NOTIFY_WHATSAPP=false — set to true in .env then rerun to send a real message.');
    console.log('    The service will silently skip all sends while disabled.\n');
    process.exit(0);
}

(async () => {
    const wa = require('./src/services/whatsappAlertService');

    console.log('Sending test trade alert to WhatsApp...');
    await wa.alertTradeExecuted('BUY', 'NVDA', 2, 430.50, 92, 'Strong momentum + BULL regime');
    console.log('✅  Test message sent — check your WhatsApp.\n');

    console.log('Sending morning briefing sample...');
    const tickers = [
        { symbol: 'MDB',  ai_score: 97, sector: 'Technology' },
        { symbol: 'AMAT', ai_score: 95, sector: 'Technology' },
        { symbol: 'QCOM', ai_score: 93, sector: 'Technology' }
    ];
    await wa.alertMorningBriefing(new Date().toISOString().slice(0, 10), 40, tickers);
    console.log('✅  Morning briefing sent — check your WhatsApp.\n');
})();
