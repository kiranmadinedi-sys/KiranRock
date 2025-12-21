// Quick test script to manually send weekly report to Telegram
const { sendReportToTelegram } = require('./src/scheduleWeeklyReportBatch');

console.log('='.repeat(60));
console.log('Testing Weekly Report Send to Telegram');
console.log('='.repeat(60));
console.log(`TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? 'Set' : 'NOT SET'}`);
console.log(`TELEGRAM_CHAT_ID: ${process.env.TELEGRAM_CHAT_ID || 'NOT SET'}`);
console.log('='.repeat(60));

sendReportToTelegram()
  .then(() => {
    console.log('\n✅ Report sent successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Failed to send report:', error.message);
    console.error('Full error:', error);
    process.exit(1);
  });
