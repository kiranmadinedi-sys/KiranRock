const axios = require('axios');
const { sendReport } = require('../src/sendWeeklyReportToTelegram');

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS, 10) || 10000;
const MAX_WAIT_MS = process.env.WAIT_MS ? parseInt(process.env.WAIT_MS, 10) : 15 * 60 * 1000;
const PREDICTIONS_TIMEOUT_MS = process.env.PREDICTIONS_TIMEOUT_MS ? parseInt(process.env.PREDICTIONS_TIMEOUT_MS, 10) : 300000;
const WEEKLY_INTERVAL_MS = process.env.WEEKLY_INTERVAL_MS ? parseInt(process.env.WEEKLY_INTERVAL_MS, 10) : 7 * 24 * 60 * 60 * 1000;
const RETRY_BACKOFF_MS = process.env.RETRY_BACKOFF_MS ? parseInt(process.env.RETRY_BACKOFF_MS, 10) : 60 * 1000;
const MAX_RETRIES = process.env.MAX_RETRIES ? parseInt(process.env.MAX_RETRIES, 10) : 5;
const ONCE = process.env.ONCE === '1' || process.env.ONCE === 'true';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function login() {
  const res = await axios.post('http://localhost:3001/api/auth/login', {
    username: process.env.BOT_USERNAME || 'user',
    password: process.env.BOT_PASSWORD || 'password'
  }, { 
    timeout: 30000, // Increased to 30 seconds
    validateStatus: (status) => status < 500 // Don't throw on 4xx errors
  });
  return res.data.token;
}

async function predictionsReady(token) {
  const url = 'http://localhost:3001/api/weekly/predictions?limit=10&universe=TOP_200';
  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: PREDICTIONS_TIMEOUT_MS,
      validateStatus: (status) => status < 500
    });
    const preds = res.data.predictions || [];
    if (preds.length >= 10) {
      const first = preds[0];
      const hasComplete = first && first.symbol && first.currentPrice && first.prediction && first.prediction.targetPrice;
      return hasComplete;
    }
    return false;
  } catch (err) {
    console.log('[ReadyCheck] Error checking predictions:', err && err.message ? err.message : err);
    // Fallback: try a lightweight check (limit=1) to detect partial readiness faster
    try {
      const quick = await axios.get('http://localhost:3001/api/weekly/predictions?limit=1&universe=TOP_200', {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30000 // Increased to 30 seconds
      });
      const qp = quick.data.predictions || [];
      if (qp.length >= 1) {
        const f = qp[0];
        const hasComplete = f && f.symbol && f.currentPrice && f.prediction && f.prediction.targetPrice;
        if (hasComplete) {
          console.log('[ReadyCheck] Quick check succeeded (1)');
          return true;
        }
      }
    } catch (quickErr) {
      console.log('[ReadyCheck] Quick check failed:', quickErr && quickErr.message ? quickErr.message : quickErr);
    }
    return false;
  }
}

async function waitForPredictions(token, maxWaitMs = MAX_WAIT_MS, intervalMs = POLL_INTERVAL_MS) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const ok = await predictionsReady(token);
    if (ok) return true;
    console.log('[WaitSend] Predictions not ready — waiting', intervalMs, 'ms');
    await sleep(intervalMs);
  }
  return false;
}

async function runCycle() {
  const token = await login();
  console.log('[WaitSend] Logged in, polling for predictions...');

  const ready = await waitForPredictions(token);
  if (ready) {
    console.log('[WaitSend] Predictions ready — sending full report');
  } else {
    console.log('[WaitSend] Max wait reached — attempting to send whatever is available');
  }

  try {
    await sendReport();
    console.log('[WaitSend] Report send attempt finished');
  } catch (err) {
    console.error('[WaitSend] sendReport failed:', err && err.message ? err.message : err);
    throw err;
  }
}

async function main() {
  let consecutiveErrors = 0;
  while (true) {
    try {
      await runCycle();
      consecutiveErrors = 0;
      if (ONCE) {
        console.log('[WaitSend] ONCE mode — exiting after single run');
        break;
      }
      console.log('[WaitSend] Sleeping until next scheduled run:', WEEKLY_INTERVAL_MS, 'ms');
      await sleep(WEEKLY_INTERVAL_MS);
    } catch (err) {
      consecutiveErrors++;
      console.error('[WaitSend] Cycle failed:', err && err.message ? err.message : err);
      if (consecutiveErrors >= MAX_RETRIES) {
        const backoff = RETRY_BACKOFF_MS * Math.pow(2, consecutiveErrors - 1);
        console.error('[WaitSend] Reached max retries. Backing off for', backoff, 'ms');
        await sleep(backoff);
        consecutiveErrors = 0;
      } else {
        const backoff = RETRY_BACKOFF_MS * consecutiveErrors;
        console.log('[WaitSend] Temporary error — retrying after', backoff, 'ms');
        await sleep(backoff);
      }
    }
  }

  console.log('[WaitSend] Exiting main loop');
}

process.on('unhandledRejection', (reason) => {
  console.error('[WaitSend] UnhandledRejection:', reason && reason.message ? reason.message : reason);
});

process.on('uncaughtException', (err) => {
  console.error('[WaitSend] UncaughtException:', err && err.message ? err.message : err);
});

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error('[WaitSend] Fatal error:', err && err.message ? err.message : err);
    process.exit(1);
  });
}
