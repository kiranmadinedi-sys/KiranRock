const schedule = require('node-schedule');
const { sendReport } = require('./sendWeeklyReportToTelegram');

console.log('[Telegram Reports] Scheduling weekly reports...');
console.log('  - Schedule: Monday & Wednesday at 6:00 AM EST');
console.log('  - Timezone: America/New_York (EST/EDT)');

// Send fresh report immediately on service startup
(async () => {
  console.log('[Startup] Sending fresh weekly report to Telegram...');
  try {
    await sendReport();
    console.log('[Startup] ✓ Successfully sent startup report');
  } catch (error) {
    console.error('[Startup] ✗ Error sending startup report:', error);
  }
})();

// Schedule Monday 6:00 AM EST
schedule.scheduleJob({
  rule: '0 6 * * 1', // Minute 0, Hour 6, Day of week 1 (Monday)
  tz: 'America/New_York'
}, async () => {
  console.log(`[${new Date().toISOString()}] Triggered scheduled report: Monday 6:00 AM EST`);
  try {
    await sendReport();
    console.log(`[${new Date().toISOString()}] ✓ Successfully sent Monday report`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ✗ Error sending Monday report:`, error);
  }
});

console.log('  ✓ Scheduled: Monday at 6:00 AM EST');

// Schedule Wednesday 6:00 AM EST
schedule.scheduleJob({
  rule: '0 6 * * 3', // Minute 0, Hour 6, Day of week 3 (Wednesday)
  tz: 'America/New_York'
}, async () => {
  console.log(`[${new Date().toISOString()}] Triggered scheduled report: Wednesday 6:00 AM EST`);
  try {
    await sendReport();
    console.log(`[${new Date().toISOString()}] ✓ Successfully sent Wednesday report`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ✗ Error sending Wednesday report:`, error);
  }
});

console.log('  ✓ Scheduled: Wednesday at 6:00 AM EST');
console.log('Telegram weekly report scheduler started.');

// Keep process alive
setInterval(() => {}, 1000 * 60 * 60);

