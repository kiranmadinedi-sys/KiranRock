const schedule = require('node-schedule');
const {
  sendReport,
  REPORT_PREDICTION_CONFIG,
  buildPredictionRequestPlan,
  buildReportPredictionOptions
} = require('./sendWeeklyReportToTelegram');
const { sendWeekendReport } = require('./sendWeekendPreviewReport');
const { sendClaudeWeeklyBuyList, sendClaudeDailyAnalysis } = require('./sendClaudeWeeklyBuyList');
const { sendDailyPerformanceReport, sendWeeklyPerformanceReport } = require('./sendPerformanceReport');
const { getWeeklyPredictions, buildWeeklyPredictionCacheKey } = require('./services/weeklyPredictionService');
const { loadWeeklyPredictionSnapshot } = require('./services/weeklyPredictionSnapshotService');
const fs = require('fs');
const path = require('path');
const { logger } = require('./utils/logger');

let activePrewarmPromise = null;

console.log('┌─────────────────────────────────────────────────────┐');
console.log('│ [Telegram Reports Scheduler] Loading...             │');
console.log('│ Schedule: Mon-Fri full-universe report at 7:00 AM  │');
console.log('│ Timezone: America/New_York (EST/EDT)                │');
console.log('│ Catch-up: Will send missed reports on restart       │');
console.log('└─────────────────────────────────────────────────────┘');
logger.info('[Telegram Reports Scheduler] Initialized with cron schedule');
logger.info('[Telegram Reports Scheduler] Mon-Fri 6:30 AM EST (prewarm full universe) → 7:00 AM EST (send)');
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
    tracking[day] = now; // key is the day name: Monday, Tuesday, etc.

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
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const hour = now.getHours();

  // Only check catch-up on business days (Mon-Fri)
  if (dayOfWeek === 0 || dayOfWeek === 6) return null;

  // Only send catch-up if it's after 7:00 AM but before midnight
  if (hour < 7 || hour >= 23) return null;

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[dayOfWeek];

  const tracking = getLastReportTimes();
  const lastSent = tracking[dayName] || null;

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
      const cacheKey = buildWeeklyPredictionCacheKey(
        buildReportPredictionOptions(REPORT_PREDICTION_CONFIG.primaryUniverse)
      );
      const snapshot = loadWeeklyPredictionSnapshot(cacheKey, REPORT_PREDICTION_CONFIG.snapshotMaxAgeMs);
      const reportPicks = snapshot?.payload?.topPicks || [];
      
      if (snapshot?.payload && reportPicks.length >= 10) {
        
        // Verify predictions have complete data
        const firstPrediction = reportPicks[0];
        const hasCompleteData = firstPrediction.symbol &&
                               firstPrediction.currentPrice &&
                               firstPrediction.prediction &&
                               firstPrediction.prediction.targetPrice;
        
        if (hasCompleteData) {
          console.log(`[Report Wait] ✓ Predictions ready from persisted snapshot! Found ${reportPicks.length} complete predictions`);
          logger.info('[Report Wait] Predictions ready for Telegram report', {
            picksReady: reportPicks.length,
            isStartup
          });
          return true;
        } else {
          console.log(`[Report Wait] Attempt ${attempt}/${maxRetries}: Predictions incomplete, waiting...`);
        }
      } else {
        const count = reportPicks.length;
        console.log(`[Report Wait] Attempt ${attempt}/${maxRetries}: Snapshot has only ${count} predictions ready, need 10+...`);
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
    if (dayName) {
      logger.info('[Report Send] Starting Telegram report send', { dayName, isStartup });
    }
    
    // Wait for predictions to be ready (critical - don't skip this!)
    const predictionsReady = await waitForPredictionsReady(isStartup);
    
    if (!predictionsReady) {
      console.error('[Report Send] ✗ Predictions not ready after max retries');
      console.log('[Report Send] Skipping report send to avoid fallback message');
      return; // Don't send report if predictions aren't ready
    }
    
    // Send the complete report (predictions confirmed ready)
    console.log('[Report Send] Sending complete weekly report...');
    if (dayName) {
      logger.info('[Report Send] Sending complete weekly report', { dayName, isStartup });
    }
    await sendReport();
    console.log('[Report Send] ✓ Complete report sent successfully');
    if (dayName) {
      logger.info('[Report Send] Complete weekly report sent successfully', { dayName, isStartup });
    }

    // Follow up with Claude beginner-friendly daily analysis (Mon-Fri)
    try {
      console.log('[Report Send] Sending Claude daily beginner analysis...');
      await sendClaudeDailyAnalysis();
      console.log('[Report Send] ✓ Claude daily analysis sent');
    } catch (claudeErr) {
      console.warn('[Report Send] Claude daily analysis skipped:', claudeErr.message);
    }

    // Track the send time
    if (dayName) {
      updateLastReportTime(dayName);
    }
    
  } catch (error) {
    console.error('[Report Send] ✗ Error sending report:', error.message);
    if (dayName) {
      logger.error('[Report Send] Error sending weekly report', { dayName, isStartup, error: error.message });
    }
    
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
        if (dayName) {
          logger.info('[Report Send] Weekly report retry successful', { dayName, isStartup });
        }
        
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

// ── Startup: always send a status ping, then catch-up if a report was missed ──
(async () => {
  logger.info('[Startup Catch-up] Waiting 30 seconds for backend to initialize...');
  await new Promise(resolve => setTimeout(resolve, 30000));

  // 1. Always send a startup status message so the user knows the system is live
  try {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (chatId) {
      const { sendTelegramMessage } = require('./services/telegramService');
      const { query } = require('./config/database');
      const axios = require('axios');

      // Grab account snapshot
      let balance = null, openPos = null;
      try {
        // Login to get userId
        const loginRes = await axios.post('http://localhost:3001/api/auth/login', {
          username: process.env.BOT_USERNAME || 'user',
          password: process.env.BOT_PASSWORD || 'password'
        }, { timeout: 8000 });
        if (loginRes.data?.token) {
          const payload = JSON.parse(Buffer.from(loginRes.data.token.split('.')[1], 'base64').toString());
          const userId = payload.userId || payload.id || payload.sub;
          if (userId) {
            const acct = await query('SELECT balance FROM trading_accounts WHERE user_id = $1', [userId]);
            balance = parseFloat(acct.rows[0]?.balance || 0);
            const pos = await query('SELECT COUNT(*) AS n FROM holdings WHERE user_id = $1 AND quantity > 0', [userId]);
            openPos = parseInt(pos.rows[0]?.n || 0, 10);
          }
        }
      } catch (_) { /* non-fatal — status still sends without account data */ }

      const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
      const balLine  = balance  !== null ? `Balance:  *$${balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}*` : '';
      const posLine  = openPos  !== null ? `Positions: ${openPos} open` : '';
      const statusMsg =
`🤖 *KiranRock AI Bot — System Restarted*
🕐 ${now} ET
━━━━━━━━━━━━━━━━━━━━
${balLine}
${posLine}

📅 *Next scheduled messages:*
  Mon-Fri 7:00 AM  — Daily stock predictions
  Mon-Fri 4:15 PM  — AI bot daily summary
  Sat    8:00 AM  — Weekend prep report
  Sun    8:00 AM  — Weekly buy list
  Sun    9:00 AM  — Weekly performance recap

✅ All schedulers active | Broker: Alpaca | Provider: Alpaca → Yahoo fallback
_This message fires on every restart to confirm the system is live._`;

      await sendTelegramMessage(chatId, statusMsg);
      logger.info('[Startup] ✓ Startup status message sent to Telegram');
      console.log('[Startup] ✓ Status message sent to Telegram');
    }
  } catch (startupErr) {
    logger.warn('[Startup] Could not send startup status message', { error: startupErr.message });
    console.warn('[Startup] Startup status message failed:', startupErr.message);
  }

  // 2. Catch-up: if a scheduled prediction report was missed while the system was down, send it now
  await new Promise(resolve => setTimeout(resolve, 60000)); // wait another 60 s for predictions
  const missedReport = shouldSendCatchupReport();
  if (missedReport) {
    logger.warn(`[Startup Catch-up] ⚠️ ${missedReport} report missed! Sending catch-up...`);
    console.log(`[Startup] 📬 Sending catch-up ${missedReport} report...`);
    await sendCompleteReport(missedReport, false); // bounded wait (5 min), not infinite
  } else {
    logger.info('[Startup Catch-up] No missed prediction reports — next send on schedule');
    console.log('[Startup] No missed reports. Next prediction send on schedule.');
  }
})();

/**
 * Prewarm predictions cache before scheduled report
 * This starts the prediction generation early
 */
async function prewarmPredictions() {
  if (activePrewarmPromise) {
    console.log('[Prewarm] Existing prewarm already running, reusing it...');
    return activePrewarmPromise;
  }

  activePrewarmPromise = (async () => {
  try {
    const universes = buildPredictionRequestPlan();
    console.log(`[Prewarm] Starting persisted prediction warmup for ${universes.join(', ')}...`);

    for (const universe of universes) {
      const options = {
        ...buildReportPredictionOptions(universe),
        executionProfile: universe === REPORT_PREDICTION_CONFIG.primaryUniverse ? 'warmup' : 'default'
      };
      console.log(`[Prewarm] Warming ${universe} snapshot...`);
      const result = await getWeeklyPredictions(options);
      console.log(`[Prewarm] ✓ ${universe} snapshot ready (${result.topPicks?.length || 0} top picks, ${result.totalAnalyzed || 0} analyzed)`);
    }
    
  } catch (error) {
    console.error('[Prewarm] Error:', error.message);
  } finally {
    activePrewarmPromise = null;
  }
  })();

  return activePrewarmPromise;
}

// ── Frontend-matching prewarm (2026-09-07) ──────────────────────────────────
// Found investigating "the /weekly page isn't fetching anything": the prewarm
// above and the frontend page have ALWAYS used different query parameters —
// prewarmPredictions() calls buildReportPredictionOptions() (limit=25,
// minScore=60, tuned for a concise Telegram digest), but the actual
// /weekly page requests limit=100&minScore=50 (see app/weekly/page.tsx).
// Different parameters produce a different cache key (buildWeeklyPredictionCacheKey
// includes both), so EVERY page load — for any of the three universe options —
// has always been a cache miss, forcing a live scan: ~15-20s for MEGA_CAP,
// ~60-90s for TOP_200, and 9-15 MINUTES for ALL (per getUniverseTimeoutMs's
// own documented estimate) — which is what "not fetching" actually was:
// a page load waiting on a scan far longer than any browser/proxy will wait.
// The ALL option's snapshot cache also turned out to be a stale leftover from
// May, under yet another parameter combination, doing nothing for anyone.
//
// This prewarms all three universes with the frontend's exact parameters, once
// daily, well before the two Telegram-report prewarms so the heavy Yahoo calls
// for ALL (the expensive one) don't overlap with them.
let activeFrontendPrewarmPromise = null;
const FRONTEND_UNIVERSES = ['MEGA_CAP', 'TOP_200', 'ALL'];

async function prewarmFrontendPredictions() {
  if (activeFrontendPrewarmPromise) {
    console.log('[FrontendPrewarm] Existing prewarm already running, reusing it...');
    return activeFrontendPrewarmPromise;
  }

  activeFrontendPrewarmPromise = (async () => {
    try {
      console.log(`[FrontendPrewarm] Starting warmup for ${FRONTEND_UNIVERSES.join(', ')} (limit=100, minScore=50, matching the /weekly page)...`);
      for (const universe of FRONTEND_UNIVERSES) {
        console.log(`[FrontendPrewarm] Warming ${universe} snapshot...`);
        const result = await getWeeklyPredictions({ limit: 100, minScore: 50, universe });
        console.log(`[FrontendPrewarm] ✓ ${universe} snapshot ready (${result.topPicks?.length || 0} top picks, ${result.totalAnalyzed || 0} analyzed)`);
      }
    } catch (error) {
      console.error('[FrontendPrewarm] Error:', error.message);
    } finally {
      activeFrontendPrewarmPromise = null;
    }
  })();

  return activeFrontendPrewarmPromise;
}

// 3:30 AM ET, Mon-Fri — before the 4:15/6:30 AM Telegram-report prewarms, so
// ALL's 9-15 min scan has finished (or at least isn't competing for the same
// Yahoo rate-limit budget) by the time those start.
schedule.scheduleJob({
  rule: '30 3 * * 1-5',
  tz: 'America/New_York'
}, async () => {
  logger.info('[Telegram Reports Scheduler] 3:30 AM ET - Prewarming /weekly page snapshots (MEGA_CAP, TOP_200, ALL)');
  await prewarmFrontendPredictions();
});

// Early full-universe warmup to persist the 820-name snapshot well before the send window.
schedule.scheduleJob({
  rule: '15 4 * * 1-5',
  tz: 'America/New_York'
}, async () => {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[new Date().getDay()];
  console.log(`[${new Date().toISOString()}] ${dayName} 4:15 AM - Early warmup for ${REPORT_PREDICTION_CONFIG.primaryUniverse} snapshot...`);
  logger.info(`[Telegram Reports Scheduler] ${dayName} 4:15 AM - Early warmup for ${REPORT_PREDICTION_CONFIG.primaryUniverse}`);
  await prewarmPredictions();
});

// Pre-warm Mon-Fri at 6:30 AM EST to give the full-universe scan time to complete.
schedule.scheduleJob({
  rule: '30 6 * * 1-5',
  tz: 'America/New_York'
}, async () => {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[new Date().getDay()];
  console.log(`[${new Date().toISOString()}] ${dayName} 6:30 AM - Prewarming ${REPORT_PREDICTION_CONFIG.primaryUniverse} predictions cache...`);
  logger.info(`[Telegram Reports Scheduler] ${dayName} 6:30 AM - Prewarming ${REPORT_PREDICTION_CONFIG.primaryUniverse} predictions`);
  await prewarmPredictions();
});

// Send daily report Mon-Fri at 7:00 AM EST
schedule.scheduleJob({
  rule: '0 7 * * 1-5',
  tz: 'America/New_York'
}, async () => {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[new Date().getDay()];
  console.log(`[${new Date().toISOString()}] ${dayName} 7:00 AM - Sending daily report...`);
  console.log('[Scheduled] Will wait INDEFINITELY until predictions ready');
  logger.info(`[Telegram Reports Scheduler] ${dayName} 7:00 AM - Sending daily report`);
  await sendCompleteReport(dayName, true);
});

// Send Claude AI weekly buy list every Sunday at 8:00 AM EST (prep for Monday open)
schedule.scheduleJob({
  rule: '0 8 * * 0',
  tz: 'America/New_York'
}, async () => {
  console.log(`[${new Date().toISOString()}] Sunday 8:00 AM - Sending Claude AI weekly buy list...`);
  logger.info('[Telegram Reports Scheduler] Sunday 8:00 AM - Claude AI weekly buy list');
  try {
    await sendClaudeWeeklyBuyList();
    logger.info('[Telegram Reports Scheduler] Claude weekly buy list sent successfully');
  } catch (error) {
    logger.error('[Telegram Reports Scheduler] Claude buy list failed', { error: error.message });
    console.error('[Claude Buy List] Failed:', error.message);
  }
});

// Send weekend prep report every Saturday at 8:00 AM EST
schedule.scheduleJob({
  rule: '0 8 * * 6',
  tz: 'America/New_York'
}, async () => {
  console.log(`[${new Date().toISOString()}] Saturday 8:00 AM - Sending weekend prep report...`);
  logger.info('[Telegram Reports Scheduler] Saturday 8:00 AM - Sending weekend prep report');
  try {
    await sendWeekendReport();
    logger.info('[Telegram Reports Scheduler] Weekend prep report sent successfully');
  } catch (error) {
    logger.error('[Telegram Reports Scheduler] Weekend prep report failed', { error: error.message });
    console.error('[Weekend Report] Failed:', error.message);
  }
});

// ── AI BOT DAILY SUMMARY: Right after market close (Mon–Fri 4:15 PM ET) ─────
schedule.scheduleJob({
  rule: '15 16 * * 1-5',
  tz: 'America/New_York'
}, async () => {
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const dayName = dayNames[new Date().getDay()];
  console.log(`[${new Date().toISOString()}] ${dayName} 4:15 PM - Sending AI bot daily summary...`);
  logger.info(`[Telegram Reports Scheduler] ${dayName} 4:15 PM - Sending AI bot daily summary`);
  try {
    await sendDailyPerformanceReport();
    logger.info('[Telegram Reports Scheduler] AI bot daily summary sent');
  } catch (error) {
    logger.error('[Telegram Reports Scheduler] AI bot daily summary failed', { error: error.message });
    console.error('[PerfReport] Daily failed:', error.message);
  }
});

// ── MY PERFORMANCE: Weekly recap (Sunday 9:00 AM EST) ───────────────────────
schedule.scheduleJob({
  rule: '0 9 * * 0',
  tz: 'America/New_York'
}, async () => {
  console.log(`[${new Date().toISOString()}] Sunday 9:00 AM - Sending My Performance weekly report...`);
  logger.info('[Telegram Reports Scheduler] Sunday 9:00 AM - Sending weekly performance report');
  try {
    await sendWeeklyPerformanceReport();
    logger.info('[Telegram Reports Scheduler] Weekly performance report sent');
  } catch (error) {
    logger.error('[Telegram Reports Scheduler] Weekly performance report failed', { error: error.message });
    console.error('[PerfReport] Weekly failed:', error.message);
  }
});

// ── MARKET REVIEW: Daily capture of the full scan universe + forward-return backfill ──
// Runs after close (4:25 PM ET) so the day's trades are already recorded. Read-only
// analytics — captures every scanned ticker's score/outcome regardless of whether the
// bot traded it, and backfills 1d/3d/5d forward returns for older snapshots once the
// price data exists. Used to validate scoring logic against real market outcomes.
schedule.scheduleJob({
  rule: '25 16 * * 1-5',
  tz: 'America/New_York'
}, async () => {
  const marketReviewService = require('./services/marketReviewService');
  console.log(`[${new Date().toISOString()}] 4:25 PM - Running daily market review capture...`);
  logger.info('[Telegram Reports Scheduler] 4:25 PM - Daily market review capture');
  try {
    const result = await marketReviewService.runDailyMarketReview();
    logger.info('[Telegram Reports Scheduler] Market review capture complete', result);
  } catch (error) {
    logger.error('[Telegram Reports Scheduler] Market review capture failed', { error: error.message });
    console.error('[MarketReview] Failed:', error.message);
  }
});

// ── PORTFOLIO SNAPSHOT: every 30 min, independent of anyone having the app open ──
// Ensures chart history keeps getting recorded even when no one has the page open (the
// 1M/3M chart's 30-min bucketing depends on this for a usable scrub experience).
// getPortfolioSummary() already saves a snapshot internally through its own sanity guard
// (median baseline + activity cross-check + skip-if-unresolved) — this job used to ALSO
// call savePortfolioSnapshot directly afterward with the same summary, which bypassed
// that guard entirely and could write an already-rejected bad value straight to history
// (confirmed 2026-07-13). Just calling getPortfolioSummary() is sufficient on its own now.
schedule.scheduleJob('*/30 * * * *', async () => {
  const { query } = require('./config/database');
  const portfolioTrackingService = require('./services/portfolioTrackingService');
  try {
    const users = await query('SELECT id FROM users');
    for (const { id: userId } of users.rows) {
      try {
        await portfolioTrackingService.getPortfolioSummary(userId);
      } catch (userError) {
        logger.debug('[Telegram Reports Scheduler] 30-min snapshot failed for user', { userId, error: userError.message });
      }
    }
  } catch (error) {
    logger.error('[Telegram Reports Scheduler] 30-min portfolio snapshot job failed', { error: error.message });
  }
});

console.log('  ✓ Scheduled: Mon-Fri at 4:15 AM (early warmup) → 6:30 AM (refresh warmup) → 7:00 AM (send daily report)');
console.log('  ✓ Scheduled: Saturday at 8:00 AM (weekend prep report)');
console.log('  ✓ Scheduled: Mon-Fri at 4:15 PM (AI bot daily summary)');
console.log('  ✓ Scheduled: Sunday at 9:00 AM (My Performance weekly recap)');
console.log('  ✓ Scheduled: Every 30 min (portfolio snapshot capture for chart history)');
console.log('  ✓ Scheduled: Mon-Fri at 4:25 PM (market review capture + forward-return backfill)');
logger.info('[Telegram Reports Scheduler] ✓ Daily schedule registered (Mon-Fri)');
logger.info('[Telegram Reports Scheduler] ✓ Weekend schedule registered (Saturday 8:00 AM EST)');
logger.info('[Telegram Reports Scheduler] ✓ Performance reports scheduled (Mon-Fri 4:15 PM + Sunday 9 AM)');
console.log('[Telegram Reports] ✓ All schedules configured');
console.log('  - Prewarm:    4:15 AM + 6:30 AM daily (Mon-Fri)');
console.log('  - Predictions: 7:00 AM daily (Mon-Fri)');
console.log('  - Performance: 4:15 PM daily (Mon-Fri) + 9:00 AM Sunday');
console.log('  - Startup: Waits 90 seconds + polling for predictions before sending');
logger.info('[Telegram Reports Scheduler] ✓ FULLY OPERATIONAL - Daily + Weekend schedules active');


// Keep process alive
setInterval(() => {}, 1000 * 60 * 60);

