const schedule = require('node-schedule');
const { sendBestPredictions } = require('./batchSendBestPredictions');
const path = require('path');
const fs = require('fs');

// Load schedule config
const configPath = path.join(__dirname, '../config/telegramReportSchedule.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const daysMap = {
  'Monday': 1,
  'Tuesday': 2,
  'Wednesday': 3,
  'Thursday': 4,
  'Friday': 5
};

function scheduleJobs() {
  for (const day of config.days) {
    for (const time of config.timesCST) {
      // time format: HH:mm (CST)
      const [hour, minute] = time.split(':').map(Number);
      // node-schedule uses cron format: 'm h * * d' (d=1=Mon)
      const cron = `${minute} ${hour} * * ${daysMap[day]}`;
      schedule.scheduleJob({
        rule: cron,
        tz: config.timezone
      }, async () => {
        console.log(`[${new Date().toISOString()}] Sending best prediction stocks report to Telegram (${day} ${time} CST)`);
        await sendBestPredictions();
      });
      console.log(`Scheduled: ${day} at ${time} CST (cron: ${cron})`);
    }
  }
}

scheduleJobs();

console.log('Telegram best predictions report scheduler started.');

// Keep process alive
setInterval(() => {}, 1000 * 60 * 60);
