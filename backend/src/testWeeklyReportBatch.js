/**
 * Manual test script for Weekly Report Batch
 * Run this to test the Telegram report generation and sending
 * Usage: node src/testWeeklyReportBatch.js
 */

const { sendReportToTelegram } = require('./scheduleWeeklyReportBatch');

console.log('🧪 Testing Weekly Report Batch...\n');

sendReportToTelegram()
  .then(() => {
    console.log('\n✅ Test completed successfully');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ Test failed:', err);
    process.exit(1);
  });
