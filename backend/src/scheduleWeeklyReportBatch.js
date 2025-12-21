const cron = require('node-cron');
const telegramLogger = require('./telegramLogger');
const users = require('../users.json');
const axios = require('axios');

/**
 * Fetch weekly predictions from the backend API
 */
async function getWeeklyReport() {
  try {
    // Step 1: Login to get JWT token
    const loginRes = await axios.post('http://localhost:3001/api/auth/login', {
      username: 'user',
      password: 'password'
    });
    const token = loginRes.data.token;
    if (!token) throw new Error('No token received from login');

    // Step 2: Fetch weekly predictions from backend API
    const res = await axios.get('http://localhost:3001/api/weekly/predictions?limit=10', {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    if (res.data && res.data.topPicks) {
      const picks = res.data.topPicks;
      const timestamp = new Date().toLocaleString('en-US', { 
        timeZone: 'America/Chicago',
        dateStyle: 'full',
        timeStyle: 'short'
      });
      
      // Format as Telegram-friendly message
      let message = `📊 *Weekly Stock Analysis Report*\n`;
      message += `🕒 ${timestamp}\n`;
      message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      picks.forEach((p, i) => {
        message += `*${i+1}. ${p.symbol}* (${p.tier || 'N/A'})\n`;
        message += `   📈 Signal: *${p.prediction.signal}*\n`;
        message += `   💯 Confidence: ${p.prediction.confidence}%\n`;
        message += `   💰 Price: $${p.currentPrice}\n`;
        message += `   🎯 Target: $${p.prediction.targetPrice}\n`;
        message += `   📊 Expected Move: ${p.prediction.expectedMove}\n`;
        message += `   📉 Volatility: ${p.volatility?.toFixed(2) || 'N/A'}\n`;
        message += `   🔢 Score: ${p.totalScore}\n\n`;
      });
      
      message += `━━━━━━━━━━━━━━━━━━━━\n`;
      message += `💡 Total picks analyzed: ${picks.length}\n`;
      message += `🔗 View full report: http://99.47.183.33:3000/weekly`;
      
      return message;
    }
    return '⚠️ No weekly picks available at this time.';
  } catch (err) {
    console.error('[Weekly Report Batch] Error fetching report:', err.message);
    return `❌ Error fetching weekly report: ${err.message}`;
  }
}

/**
 * Send the weekly report to all users with Telegram configured
 */
async function sendReportToTelegram() {
  console.log('[Weekly Report Batch] Starting report generation...');
  
  try {
    const report = await getWeeklyReport();
    
    // Find all users with phone numbers (Telegram configured)
    const telegramUsers = users.filter(u => u.phone);
    
    if (telegramUsers.length === 0) {
      console.log('[Weekly Report Batch] No users with Telegram configured');
      return;
    }
    
    console.log(`[Weekly Report Batch] Sending to ${telegramUsers.length} user(s)...`);
    
    // Send to Telegram
    // Using the chat_id from environment variable
    // Default to personal chat (8574952938) if group chat not available
    const chatId = process.env.TELEGRAM_CHAT_ID || '8574952938';
    
    console.log(`[Weekly Report Batch] Attempting to send to chat ID: ${chatId}`);
    console.log(`[Weekly Report Batch] Report length: ${report.length} characters`);
    try {
      const result = await telegramLogger.sendTelegramMessage(report, chatId);
      console.log(`[Weekly Report Batch] ✅ Successfully sent to Telegram (${chatId})`);
      console.log(`[Weekly Report Batch] Response:`, result);
    } catch (err) {
      console.error(`[Weekly Report Batch] ❌ Failed to send to Telegram:`, err.message);
      console.error(`[Weekly Report Batch] Error details:`, err);
    }
    
    console.log('[Weekly Report Batch] Report batch completed');
  } catch (err) {
    console.error('[Weekly Report Batch] Fatal error:', err);
  }
}

/**
 * Schedule the weekly report batch job
 * Runs twice daily:
 * - 7:00 AM CST (Central Standard Time)
 * - 2:45 PM CST
 */
function startWeeklyReportScheduler() {
  // Cron format: minute hour day month day-of-week
  // CST is UTC-6 (or UTC-5 during CDT)
  // 7:00 AM CST = 13:00 UTC (during CST) or 12:00 UTC (during CDT)
  // 2:45 PM CST = 20:45 UTC (during CST) or 19:45 UTC (during CDT)
  
  console.log('[Weekly Report Batch] ✓ Starting scheduler...');
  console.log('[Weekly Report Batch] Current time:', new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  
  // Run immediately on startup for testing
  console.log('[Weekly Report Batch] 🚀 Running initial report on startup...');
  sendReportToTelegram().catch(err => {
    console.error('[Weekly Report Batch] ❌ Initial report failed:', err.message);
  });
  
  // Morning report at 7:00 AM CST
  const morningSchedule = cron.schedule('0 7 * * *', async () => {
    console.log('[Weekly Report Batch] 🌅 Morning report triggered (7:00 AM CST)');
    try {
      await sendReportToTelegram();
    } catch (err) {
      console.error('[Weekly Report Batch] ❌ Morning report failed:', err.message);
    }
  }, {
    scheduled: true,
    timezone: "America/Chicago" // CST/CDT timezone
  });

  // Afternoon report at 2:45 PM CST
  const afternoonSchedule = cron.schedule('45 14 * * *', async () => {
    console.log('[Weekly Report Batch] 🌆 Afternoon report triggered (2:45 PM CST)');
    try {
      await sendReportToTelegram();
    } catch (err) {
      console.error('[Weekly Report Batch] ❌ Afternoon report failed:', err.message);
    }
  }, {
    scheduled: true,
    timezone: "America/Chicago" // CST/CDT timezone
  });
  
  // Additional scheduler: Every 6 hours for more frequent updates
  const frequentSchedule = cron.schedule('0 */6 * * *', async () => {
    console.log('[Weekly Report Batch] 🔄 Frequent update triggered (every 6 hours)');
    try {
      await sendReportToTelegram();
    } catch (err) {
      console.error('[Weekly Report Batch] ❌ Frequent update failed:', err.message);
    }
  }, {
    scheduled: true,
    timezone: "America/Chicago"
  });

  console.log('[Weekly Report Batch] ✅ All schedulers started successfully');
  console.log('[Weekly Report Batch] 📅 Morning report: 7:00 AM CST (Daily)');
  console.log('[Weekly Report Batch] 📅 Afternoon report: 2:45 PM CST (Daily)');
  console.log('[Weekly Report Batch] 📅 Frequent updates: Every 6 hours');
  
  return { morningSchedule, afternoonSchedule, frequentSchedule };
}

module.exports = { startWeeklyReportScheduler, sendReportToTelegram };
