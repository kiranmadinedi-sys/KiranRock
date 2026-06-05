const axios = require('axios');
const { sendTelegramMessage, getPrimaryTelegramRecipient } = require('../src/services/telegramService');

async function login() {
  const res = await axios.post('http://localhost:3001/api/auth/login', {
    username: 'user',
    password: 'password'
  }, { timeout: 10000 });
  return res.data.token;
}

async function prewarmPredictions(token) {
  try {
    // trigger generation (fire-and-forget)
    axios.get('http://localhost:3001/api/weekly/predictions?limit=10&universe=TOP_200', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 120000
    }).then(() => {
      console.log('[Prewarm] Triggered predictions generation');
    }).catch(() => {
      console.log('[Prewarm] Trigger request sent (may be in progress)');
    });
  } catch (err) {
    console.log('[Prewarm] Error triggering predictions:', err.message);
  }
}

async function fetchPredictions(token, timeoutMs = 600000) {
  try {
    console.log(`[Fetch] Attempting to fetch predictions (timeout ${timeoutMs}ms)`);
    const res = await axios.get('http://localhost:3001/api/weekly/predictions?limit=10&universe=TOP_200', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: timeoutMs
    });
    return res.data;
  } catch (err) {
    console.error('[Fetch] Error fetching predictions:', err.message);
    return null;
  }
}

function buildPartialReport(predictionsData) {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US');
  let report = `📊 WEEKLY REPORT (Partial)\nGenerated: ${dateStr}\n\n`;
  const reportPicks = predictionsData?.topPicks || predictionsData?.predictions || [];
  if (reportPicks.length > 0) {
    const picks = reportPicks.slice(0, 5);
    report += `Top ${picks.length} available picks (partial):\n`;
    picks.forEach((p, i) => {
      report += `${i + 1}. ${p.symbol} - ${p.prediction?.signal || 'N/A'} | Current: $${p.currentPrice || 'N/A'} | Target: ${p.prediction?.targetPrice || 'N/A'}\n`;
    });
  } else {
    report += '⚠️ Predictions not ready. Sending placeholder report for testing.\n';
  }
  report += '\nThis is a forced send for testing; full report may follow when ready.';
  return report;
}

async function forceSend() {
  try {
    const token = await login();
    // Prewarm then wait briefly
    await prewarmPredictions(token);
    console.log('[Main] Waiting 8 seconds for prewarm...');
    await new Promise(r => setTimeout(r, 8000));

    // Try a long fetch first (10 min). For testing we will use 2 attempts: short then long.
    let data = await fetchPredictions(token, 120000); // 2 min
    if (!data) {
      console.log('[Main] Short fetch failed — trying extended timeout (10m)');
      data = await fetchPredictions(token, 600000); // 10 min
    }

    const report = buildPartialReport(data);

    const user = await getPrimaryTelegramRecipient('user');
    if (!user || (!user.telegram_chat_id && !user.phone && !user.username && !user.id)) {
      console.error('[Send] No Telegram recipient found for username "user" in PostgreSQL');
      return;
    }

    console.log('[Send] Sending report to Telegram (may throw if bot not configured)');
    await sendTelegramMessage(user.telegram_chat_id || user.id || user.username || user.phone, report, { parse_mode: 'Markdown' });
    console.log('[Send] ✅ Forced report sent to Telegram');
  } catch (err) {
    console.error('[ForceSend] Failed:', err.message || err);
  }
}

if (require.main === module) {
  forceSend();
}
