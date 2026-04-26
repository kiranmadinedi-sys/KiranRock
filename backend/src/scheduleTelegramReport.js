const schedule = require('node-schedule');
const { sendReport } = require('./sendWeeklyReportToTelegram');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { logger } = require('./utils/logger');

console.log('┌─────────────────────────────────────────────────────┐');
console.log('│ [Telegram Reports Scheduler] Loading...             │');
console.log('│ Schedule: Monday & Wednesday at 6:00 AM EST          │');
console.log('│ Timezone: America/New_York (EST/EDT)                │');
console.log('│ Catch-up: Will send missed reports on restart       │');
console.log('└─────────────────────────────────────────────────────┘');
logger.info('[Telegram Reports Scheduler] Initialized with cron schedule');
logger.info('[Telegram Reports Scheduler] Monday 5:50 AM EST (prewarm) → 6:00 AM EST (send)');
logger.info('[Telegram Reports Scheduler] Wednesday 5:50 AM EST (prewarm) → 6:00 AM EST (send)');

// Track last report send times
const REPORT_TRACKING_FILE = path.join(__dirname, '../config/lastReportSent.json');

function getLastReportTimes() {
  try {
    if (fs.existsSync(REPORT_TRACKING_FILE)) {
      const data = fs.readFileSync(REPORT_TRACKING_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.log('[Report Tracking] Error reading tracking file:', error.message);
  }
  return { lastMonday: null, lastWednesday: null };
}

function updateLastReportTime(day) {
  try {
    const tracking = getLastReportTimes();
    const now = new Date().toISOString();
    
    if (day === 'Monday') {
      tracking.lastMonday = now;
    } else if (day === 'Wednesday') {
      tracking.lastWednesday = now;
    }
    
    // Ensure config directory exists
    const configDir = path.dirname(REPORT_TRACKING_FILE);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    fs.writeFileSync(REPORT_TRACKING_FILE, JSON.stringify(tracking, null, 2));
    console.log(`[Report Tracking] Updated ${day} report time: ${now}`);
  } catch (error) {
    console.error('[Report Tracking] Error updating tracking file:', error.message);
  }
}

function shouldSendCatchupReport() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sunday, 1=Monday, 3=Wednesday
  const hour = now.getHours();
  
  // Only check catch-up for Monday (1) or Wednesday (3)
  if (dayOfWeek !== 1 && dayOfWeek !== 3) {
    return null;
  }
  
  // Only send catch-up if it's after 6:00 AM but before midnight
  if (hour < 6 || hour >= 23) {
    return null;
  }
  
  const tracking = getLastReportTimes();
  const dayName = dayOfWeek === 1 ? 'Monday' : 'Wednesday';
  const lastSent = dayOfWeek === 1 ? tracking.lastMonday : tracking.lastWednesday;
  
  // Check if report was already sent today
  if (lastSent) {
    const lastSentDate = new Date(lastSent);
    const isSameDay = lastSentDate.getFullYear() === now.getFullYear() &&
                     lastSentDate.getMonth() === now.getMonth() &&
                     lastSentDate.getDate() === now.getDate();
    
    if (isSameDay) {
      console.log(`[Catch-up] ${dayName} report already sent today at ${lastSentDate.toLocaleTimeString()}`);
      return null;
    }
  }
  
  console.log(`[Catch-up] ⚠️ ${dayName} report not sent yet today (missed scheduled time)`);
  return dayName;
}

/**
 * Wait for predictions to be ready before sending report
 * Polls the API with retries to ensure complete data
 * @param {boolean} isStartup - If true, waits indefinitely; if false, uses maxRetries limit
 */
async function waitForPredictionsReady(isStartup = false) {
  console.log(`[Report Wait] Waiting for predictions to be ready... ${isStartup ? '(Startup - will wait indefinitely)' : '(Max 5 minutes)'}`);
  
  const maxRetries = isStartup ? Infinity : 30; // Infinite retries on startup, 30 for scheduled
  const retryDelay = 10000; // 10 seconds between retries
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Login to get token
      const loginRes = await axios.post('http://localhost:3001/api/auth/login', {
        username: 'user',
        password: 'password'
      }, { timeout: 10000 });
      
      const token = loginRes.data.token;
      if (!token) {
        console.log(`[Report Wait] Attempt ${attempt}/${maxRetries}: No token received`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      
      // Check if predictions are ready (with full data)
      const predictionsRes = await axios.get('http://localhost:3001/api/weekly/predictions?limit=10&universe=TOP_200', {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 300000 // 5 minute timeout for generation
      });
      
      if (predictionsRes.data && 
          predictionsRes.data.predictions && 
          predictionsRes.data.predictions.length >= 10) {
        
        // Verify predictions have complete data
        const firstPrediction = predictionsRes.data.predictions[0];
        const hasCompleteData = firstPrediction.symbol &&
                               firstPrediction.currentPrice &&
                               firstPrediction.prediction &&
                               firstPrediction.prediction.targetPrice;
        
        if (hasCompleteData) {
          console.log(`[Report Wait] ✓ Predictions ready! Found ${predictionsRes.data.predictions.length} complete predictions`);
          return true;
        } else {
          console.log(`[Report Wait] Attempt ${attempt}/${maxRetries}: Predictions incomplete, waiting...`);
        }
      } else {
        const count = predictionsRes.data?.predictions?.length || 0;
        console.log(`[Report Wait] Attempt ${attempt}/${maxRetries}: Only ${count} predictions ready, need 10+...`);
      }
      
    } catch (error) {
      console.log(`[Report Wait] Attempt ${attempt}/${maxRetries}: Error - ${error.message}`);
    }
    
    // Wait before next retry
    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
  
  console.log('[Report Wait] ⚠️ Max retries reached, will send whatever is available');
  return false;
}

/**
 * Send complete report with retry logic
 * @param {string} dayName - 'Monday' or 'Wednesday' for tracking
 * @param {boolean} isStartup - If true, waits indefinitely for predictions
 */
async function sendCompleteReport(dayName = null, isStartup = false) {
  try {
    console.log(`[Report Send] Starting report generation... ${isStartup ? '(Startup mode - will wait as long as needed)' : ''}`);
    
    // Wait for predictions to be ready (critical - don't skip this!)
    const predictionsReady = await waitForPredictionsReady(isStartup);
    
    if (!predictionsReady) {
      console.error('[Report Send] ✗ Predictions not ready after max retries');
      console.log('[Report Send] Skipping report send to avoid fallback message');
      return; // Don't send report if predictions aren't ready
    }
    
    // Send the complete report (predictions confirmed ready)
    console.log('[Report Send] Sending complete weekly report...');
    await sendReport();
    console.log('[Report Send] ✓ Complete report sent successfully');
    
    // Track the send time
    if (dayName) {
      updateLastReportTime(dayName);
    }
    
  } catch (error) {
    console.error('[Report Send] ✗ Error sending report:', error.message);
    
    // Don't retry if it's a "no predictions" error
    if (error.message.includes('No predictions available')) {
      console.log('[Report Send] Skipping retry - predictions not ready');
      return;
    }
    
    // Retry once after 30 seconds for other errors
    console.log('[Report Send] Retrying in 30 seconds...');
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    try {
      // Check predictions again before retry
      const predictionsReady = await waitForPredictionsReady(isStartup);
      if (predictionsReady) {
        await sendReport();
        console.log('[Report Send] ✓ Retry successful');
        
        // Track the send time on retry success
        if (dayName) {
          updateLastReportTime(dayName);
        }
      } else {
        console.log('[Report Send] ✗ Retry skipped - predictions still not ready');
      }
    } catch (retryError) {
      console.error('[Report Send] ✗ Retry failed:', retryError.message);
    }
  }
}

// Send fresh report after delay to allow predictions to generate
(async () => {
  logger.info('[Startup Catch-up] Waiting 90 seconds for backend to initialize...');
  
  // Initial wait for backend to start (increased from 60 to 90 seconds)
  await new Promise(resolve => setTimeout(resolve, 90000)); // 90 seconds initial wait
  
  // Check if we missed a scheduled report today
  const missedReport = shouldSendCatchupReport();
  
  if (missedReport) {
    logger.warn(`[Startup Catch-up] ⚠️ ${missedReport} report missed! Sending catch-up...`);
    console.log(`[Startup] 📬 Sending catch-up ${missedReport} report (missed due to restart)...`);
    await sendCompleteReport(missedReport, true); // isStartup = true (wait indefinitely)
  } else {
    logger.info('[Startup Catch-up] No missed reports for today');
    console.log('[Startup] Checking if predictions are ready for startup report...');
    await sendCompleteReport(null, true); // isStartup = true (wait indefinitely)
  }
})();

/**
 * Prewarm predictions cache before scheduled report
 * This starts the prediction generation early
 */
async function prewarmPredictions() {
  try {
    console.log('[Prewarm] Starting prediction generation early...');
    
    const loginRes = await axios.post('http://localhost:3001/api/auth/login', {
      username: 'user',
      password: 'password'
    }, { timeout: 10000 });
    
    const token = loginRes.data.token;
    
    // Trigger prediction generation (fire and forget)
    axios.get('http://localhost:3001/api/weekly/predictions?limit=10&universe=TOP_200', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 300000
    }).then(() => {
      console.log('[Prewarm] ✓ Predictions generation triggered');
    }).catch(err => {
      console.log('[Prewarm] Note: Predictions generation in progress');
    });
    
  } catch (error) {
    console.error('[Prewarm] Error:', error.message);
  }
}

// Pre-warm cache 10 minutes before Monday report (5:50 AM)
schedule.scheduleJob({
  rule: '50 5 * * 1',
  tz: 'America/New_York'
}, async () => {
  console.log(`[${new Date().toISOString()}] Monday 5:50 AM - Prewarming predictions cache...`);
  await prewarmPredictions();
});

// Schedule Monday 6:00 AM EST
schedule.scheduleJob({
  rule: '0 6 * * 1',
  tz: 'America/New_York'
}, async () => {
  console.log(`[${new Date().toISOString()}] Monday 6:00 AM - Sending complete weekly report...`);
  console.log('[Scheduled] Will wait INDEFINITELY until predictions ready');
  await sendCompleteReport('Monday', true); // Wait indefinitely
});

console.log('  ✓ Scheduled: Monday at 5:50 AM (prewarm) → 6:00 AM (send complete report)');
logger.info('[Telegram Reports Scheduler] ✓ Monday schedule registered');

// Pre-warm cache 10 minutes before Wednesday report (5:50 AM)
schedule.scheduleJob({
  rule: '50 5 * * 3',
  tz: 'America/New_York'
}, async () => {
  console.log(`[${new Date().toISOString()}] Wednesday 5:50 AM - Prewarming predictions cache...`);
  logger.info('[Telegram Reports Scheduler] Wednesday 5:50 AM - Prewarming predictions');
  await prewarmPredictions();
});

// Schedule Wednesday 6:00 AM EST
schedule.scheduleJob({
  rule: '0 6 * * 3',
  tz: 'America/New_York'
}, async () => {
  console.log(`[${new Date().toISOString()}] Wednesday 6:00 AM - Sending complete weekly report...`);
  logger.info('[Telegram Reports Scheduler] Wednesday 6:00 AM - Sending complete weekly report');
  console.log('[Scheduled] Will wait INDEFINITELY until predictions ready');
  await sendCompleteReport('Wednesday', true); // Wait indefinitely
});

console.log('  ✓ Scheduled: Wednesday at 5:50 AM (prewarm) → 6:00 AM (send complete report)');
logger.info('[Telegram Reports Scheduler] ✓ Wednesday schedule registered');
console.log('[Telegram Reports] ✓ All schedules configured with complete report waiting logic');
console.log('  - Prewarm: 10 minutes early to start prediction generation');
console.log('  - Send: Waits up to 5 minutes (30 retries × 10 sec) for predictions ready');
console.log('  - Startup: Waits 90 seconds + polling for predictions before sending');
logger.info('[Telegram Reports Scheduler] ✓ FULLY OPERATIONAL - All schedules registered and active');


// Keep process alive
setInterval(() => {}, 1000 * 60 * 60);

