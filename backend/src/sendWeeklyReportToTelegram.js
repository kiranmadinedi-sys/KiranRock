const { sendTelegramMessage } = require('./services/telegramService');
const users = require('../users.json');
const axios = require('axios');

async function getWeeklyReport() {
  try {
    // Step 1: Login to get JWT token
    const loginRes = await axios.post('http://localhost:3001/api/auth/login', {
      username: 'user',
      password: 'password'
    });
    const token = loginRes.data.token;
    if (!token) throw new Error('No token received from login');

    // Step 2: Fetch backend API for real prediction data using JWT
    const res = await axios.get('http://localhost:3001/api/weekly/predictions?limit=10', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.data && res.data.topPicks) {
      // Format as Telegram-friendly table
      const picks = res.data.topPicks;
      let table = 'Weekly Stock Picks\n';
      table += 'Rank | Symbol | Tier | Score | Signal | Move% | Confidence | Price | 1W% | Target | Volatility\n';
      table += '-----|--------|------|-------|--------|-------|-----------|-------|-----|--------|----------\n';
      picks.forEach((p, i) => {
        table += `${i+1} | ${p.symbol} | ${p.tier} | ${p.totalScore} | ${p.prediction.signal} | ${p.prediction.expectedMove} | ${p.prediction.confidence} | $${p.currentPrice} | ${p.priceChange1w} | $${p.prediction.targetPrice} | ${p.volatility.toFixed(2)}\n`;
      });
      return table;
    }
    return 'No weekly picks available.';
  } catch (err) {
    return 'Error fetching weekly report: ' + err.message;
  }
}

async function sendReport() {
  const user = users.find(u => u.username === 'user' && u.phone);
  if (!user) throw new Error('User with phone not found');
  const report = await getWeeklyReport();
  const MAX_LENGTH = 4000; // Telegram max message length (safe margin)
  const chunks = [];
  let text = 'Weekly Report:\n' + report;
  while (text.length > 0) {
    chunks.push(text.slice(0, MAX_LENGTH));
    text = text.slice(MAX_LENGTH);
  }
  try {
    for (let i = 0; i < chunks.length; i++) {
      await sendTelegramMessage(user.phone, chunks[i]);
    }
    console.log('Telegram message(s) sent.');
  } catch (err) {
    console.error('Failed to send Telegram message:', err.message);
  }
}

if (require.main === module) {
  sendReport();
}
