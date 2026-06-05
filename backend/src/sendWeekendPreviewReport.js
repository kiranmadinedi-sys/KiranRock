/**
 * Weekend Market Prep Report
 * Sent every Saturday at 8:00 AM EST
 * Covers: earnings results, new contracts/deals, next week calendar, Monday watchlist
 */
const axios = require('axios');
const { sendTelegramMessage } = require('./services/telegramService');
const { logger } = require('./utils/logger');

const BASE_URL = 'http://localhost:3001';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

function isRecent(dateStr, maxDays = 5) {
  if (!dateStr) return false;
  return new Date(dateStr) >= new Date(daysAgo(maxDays));
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric'
  });
}

function nextWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const daysUntilMon = day === 0 ? 1 : 8 - day;
  const mon = new Date(now.getTime() + daysUntilMon * 86400000);
  const fri = new Date(mon.getTime() + 4 * 86400000);
  return {
    from: mon.toISOString().split('T')[0],
    to:   fri.toISOString().split('T')[0],
    monLabel: mon.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
    friLabel: fri.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  };
}

// ─── Data Fetchers ────────────────────────────────────────────────────────────

async function login() {
  const res = await axios.post(`${BASE_URL}/api/auth/login`, {
    username: process.env.BOT_USERNAME || 'user',
    password: process.env.BOT_PASSWORD || 'password'
  }, { timeout: 10000 });
  if (!res.data.token) throw new Error('Login failed');
  return res.data.token;
}

/** Pull all recent news (last 5 days) from the aggregation service */
async function fetchRecentNews(token) {
  try {
    const res = await axios.get(`${BASE_URL}/api/news-aggregation/aggregate?refresh=true`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000
    });
    return (res.data?.news || []).filter(n => isRecent(n.published_at, 6));
  } catch (e) {
    logger.warn('[WeekendReport] News fetch failed:', e.message);
    return [];
  }
}

/** Filter news for earnings results (beat/miss/reported) */
function extractEarningsNews(news) {
  const keywords = [
    'earnings', 'eps', 'beats', 'misses', 'quarterly results',
    'q1 results', 'q2 results', 'q3 results', 'q4 results',
    'revenue beat', 'profit', 'quarterly profit', 'reported earnings',
    'guidance', 'fiscal quarter'
  ];
  return news
    .filter(n => keywords.some(k => n.headline.toLowerCase().includes(k)))
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
    .slice(0, 12);
}

/** Filter news for contract wins, partnerships, major deals */
function extractContractDealNews(news) {
  const keywords = [
    'contract', 'awarded', 'wins deal', 'wins contract', 'secures contract',
    'partnership', 'collaboration', 'agreement', 'joint venture',
    'acquisition', 'merger', 'acquires', 'takeover', 'buyout',
    'government contract', 'pentagon', 'dod contract', 'nasa contract',
    'deal worth', 'billion deal', 'million contract', 'strategic alliance'
  ];
  return news
    .filter(n => keywords.some(k => n.headline.toLowerCase().includes(k)))
    .sort((a, b) => (b.market_impact || 1) - (a.market_impact || 1))
    .slice(0, 10);
}

/** Filter news for analyst upgrades/downgrades */
function extractAnalystActions(news) {
  const keywords = [
    'upgrade', 'downgrade', 'price target', 'raised target',
    'cut target', 'buy rating', 'sell rating', 'overweight', 'underweight',
    'outperform', 'underperform', 'initiates coverage', 'raises price'
  ];
  return news
    .filter(n => keywords.some(k => n.headline.toLowerCase().includes(k)))
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
    .slice(0, 6);
}

/** Filter for macro / market-moving news */
function extractMacroNews(news) {
  const keywords = [
    'federal reserve', 'fed rate', 'interest rate', 'inflation', 'cpi',
    'jobs report', 'unemployment', 'gdp', 'tariff', 'trade deal',
    'treasury', 'bond yield', 'recession', 'economic data', 'fomc'
  ];
  return news
    .filter(n => keywords.some(k => n.headline.toLowerCase().includes(k)))
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
    .slice(0, 5);
}

/** Fetch upcoming earnings for major stocks using Yahoo Finance via backend */
async function fetchUpcomingEarnings(token) {
  const watchlist = [
    'AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','JPM','V','WMT',
    'JNJ','PG','MA','HD','BAC','XOM','CVX','ABBV','MRK','PFE',
    'KO','PEP','COST','AVGO','ORCL','CSCO','ADBE','CRM','NFLX','AMD'
  ];
  const upcoming = [];
  const range = nextWeekRange();

  await Promise.allSettled(
    watchlist.map(sym =>
      axios.get(`${BASE_URL}/api/weekly/analyze/${sym}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 8000
      }).then(r => {
        const events = r.data?.upcomingEvents || [];
        const hasEarnings = events.some(e =>
          typeof e === 'string' && e.toLowerCase().includes('earnings')
        );
        if (hasEarnings) upcoming.push({ symbol: sym, events });
      }).catch(() => {})
    )
  );

  return upcoming.slice(0, 15);
}

/** Quick Monday watchlist: top picks from predictions */
async function fetchMondayWatchlist(token) {
  try {
    const res = await axios.get(
      `${BASE_URL}/api/weekly/predictions?limit=8&universe=MEGA_CAP`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 120000 }
    );
    return (res.data?.topPicks || []).slice(0, 8);
  } catch (e) {
    logger.warn('[WeekendReport] Watchlist fetch failed:', e.message);
    return [];
  }
}

// ─── Report Builder ───────────────────────────────────────────────────────────

async function buildWeekendReport() {
  const token = await login();
  const range = nextWeekRange();

  const now = new Date();
  const weekLabel = now.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric'
  });

  // Fetch everything in parallel
  const [news, watchlist] = await Promise.all([
    fetchRecentNews(token),
    fetchMondayWatchlist(token)
  ]);

  const earningsNews    = extractEarningsNews(news);
  const contractNews    = extractContractDealNews(news);
  const analystActions  = extractAnalystActions(news);
  const macroNews       = extractMacroNews(news);

  // Build report
  let r = '';

  // Header
  r += `📋 *WEEKEND MARKET PREP*\n`;
  r += `━━━━━━━━━━━━━━━━━━━━\n`;
  r += `📅 ${weekLabel}\n`;
  r += `_Preparing you for Monday ${range.monLabel}_\n\n`;

  // ── Macro news ──────────────────────────────────────────────
  if (macroNews.length > 0) {
    r += `🌍 *THIS WEEK'S BIG MACRO EVENTS*\n`;
    r += `━━━━━━━━━━━━━━━━━━━━\n`;
    macroNews.forEach(n => {
      const src = n.source === 'X' ? '𝕏' : '📰';
      r += `${src} ${n.headline}\n`;
      r += `   _— ${n.source}, ${formatDate(n.published_at)}_\n`;
    });
    r += `\n`;
  }

  // ── Earnings results ──────────────────────────────────────
  if (earningsNews.length > 0) {
    r += `📊 *THIS WEEK'S EARNINGS RESULTS*\n`;
    r += `━━━━━━━━━━━━━━━━━━━━\n`;
    earningsNews.forEach(n => {
      const beat = n.headline.toLowerCase().includes('beat') ||
                   n.headline.toLowerCase().includes('surpass') ||
                   n.headline.toLowerCase().includes('tops');
      const miss = n.headline.toLowerCase().includes('miss') ||
                   n.headline.toLowerCase().includes('below') ||
                   n.headline.toLowerCase().includes('falls short');
      const emoji = beat ? '✅' : miss ? '❌' : '📋';
      r += `${emoji} ${n.headline}\n`;
      r += `   _— ${n.source}_\n`;
    });
    r += `\n`;
  }

  // ── Contract & deal wins ──────────────────────────────────
  if (contractNews.length > 0) {
    r += `🤝 *NEW CONTRACTS & DEALS THIS WEEK*\n`;
    r += `━━━━━━━━━━━━━━━━━━━━\n`;
    contractNews.forEach(n => {
      const isAcq = ['acquisition','merger','acquires','buyout'].some(k =>
        n.headline.toLowerCase().includes(k));
      const emoji = isAcq ? '🔀' : '📝';
      r += `${emoji} ${n.headline}\n`;
      r += `   _— ${n.source}, ${formatDate(n.published_at)}_\n`;
    });
    r += `\n`;
  }

  // ── Analyst actions ───────────────────────────────────────
  if (analystActions.length > 0) {
    r += `🔬 *ANALYST UPGRADES & DOWNGRADES*\n`;
    r += `━━━━━━━━━━━━━━━━━━━━\n`;
    analystActions.forEach(n => {
      const up   = n.headline.toLowerCase().includes('upgrade') ||
                   n.headline.toLowerCase().includes('raises') ||
                   n.headline.toLowerCase().includes('outperform');
      const down = n.headline.toLowerCase().includes('downgrade') ||
                   n.headline.toLowerCase().includes('cut') ||
                   n.headline.toLowerCase().includes('underperform');
      const emoji = up ? '⬆️' : down ? '⬇️' : '🔬';
      r += `${emoji} ${n.headline}\n`;
      r += `   _— ${n.source}_\n`;
    });
    r += `\n`;
  }

  // ── Next week earnings calendar ───────────────────────────
  r += `📅 *NEXT WEEK EARNINGS CALENDAR*\n`;
  r += `━━━━━━━━━━━━━━━━━━━━\n`;
  r += `_${range.monLabel} – ${range.friLabel}_\n`;

  // Pull earnings from news for next week
  const nextWeekEarningsNews = news.filter(n => {
    const headline = n.headline.toLowerCase();
    return (headline.includes('earnings') || headline.includes('results')) &&
           (headline.includes('expected') || headline.includes('preview') ||
            headline.includes('scheduled') || headline.includes('reports') ||
            headline.includes('next week'));
  }).slice(0, 8);

  if (nextWeekEarningsNews.length > 0) {
    nextWeekEarningsNews.forEach(n => {
      r += `📋 ${n.headline}\n`;
    });
  } else {
    // Major companies that typically report around this time
    const majorEarningsWatch = ['AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','JPM','BAC','GS'];
    r += `Watch these major reporters next week:\n`;
    r += `${majorEarningsWatch.map(s => `$${s}`).join(' • ')}\n`;
    r += `_Check earnings.com or Yahoo Finance for exact dates_\n`;
  }
  r += `\n`;

  // ── Economic events next week ─────────────────────────────
  r += `🏦 *KEY EVENTS TO WATCH NEXT WEEK*\n`;
  r += `━━━━━━━━━━━━━━━━━━━━\n`;

  // Filter macro news that mentions "next week" or upcoming events
  const upcomingMacro = news.filter(n => {
    const h = n.headline.toLowerCase();
    return (h.includes('fomc') || h.includes('fed meeting') || h.includes('cpi') ||
            h.includes('jobs') || h.includes('payroll') || h.includes('gdp') ||
            h.includes('next week') || h.includes('upcoming')) &&
           ['macro','market','rates'].includes(n.category);
  }).slice(0, 4);

  if (upcomingMacro.length > 0) {
    upcomingMacro.forEach(n => {
      r += `⚡ ${n.headline}\n`;
      r += `   _— ${n.source}_\n`;
    });
  } else {
    r += `📌 Monitor: Fed speakers, Treasury auctions, earnings calls\n`;
    r += `📌 Check economic calendar at investing.com for exact times\n`;
  }
  r += `\n`;

  // ── Monday Watchlist ──────────────────────────────────────
  if (watchlist.length > 0) {
    r += `🎯 *MONDAY WATCHLIST — TOP SETUPS*\n`;
    r += `━━━━━━━━━━━━━━━━━━━━\n`;
    r += `_AI-scored picks to monitor at open_\n\n`;

    watchlist.forEach((p, i) => {
      const signal = p.prediction?.signal || 'Hold';
      const score  = p.totalScore || 0;
      const price  = p.currentPrice || '?';
      const target = p.prediction?.targetPrice || '?';
      const move   = p.prediction?.expectedMove || 0;
      const conf   = p.prediction?.confidence || 0;
      const emoji  = signal === 'Strong Buy' ? '🚀' :
                     signal === 'Buy'        ? '📈' :
                     signal === 'Avoid'      ? '⛔' : '👀';

      r += `${emoji} *${i + 1}. $${p.symbol}* — ${signal} (${conf}% conf)\n`;
      r += `   Score: ${score}/100 | $${price} → $${target} (${move > 0 ? '+' : ''}${move}%)\n`;
      if (p.rationale) r += `   📌 ${p.rationale}\n`;
      r += `\n`;
    });
  }

  // ── Weekend tips ──────────────────────────────────────────
  r += `━━━━━━━━━━━━━━━━━━━━\n`;
  r += `💡 *WEEKEND PREP CHECKLIST*\n`;
  r += `   ✓ Review your open positions — are stop losses set?\n`;
  r += `   ✓ Check earnings dates for stocks you hold\n`;
  r += `   ✓ Size positions conservatively around earnings\n`;
  r += `   ✓ Have a plan before market opens Monday\n`;
  r += `   ✓ Don't trade on emotion — stick to your levels\n\n`;

  r += `🔗 Full dashboard: http://99.47.183.33:3000/weekly\n\n`;
  r += `━━━━━━━━━━━━━━━━━━━━\n`;
  r += `⚖️ _Not financial advice. For educational purposes only._`;

  return r;
}

// ─── Send ─────────────────────────────────────────────────────────────────────

async function sendWeekendReport() {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID not set in .env');

  logger.info('[WeekendReport] Building weekend prep report...');
  const report = await buildWeekendReport();

  const MAX_LENGTH = 4000;
  const chunks = [];
  let text = report;
  while (text.length > 0) {
    chunks.push(text.slice(0, MAX_LENGTH));
    text = text.slice(MAX_LENGTH);
  }

  for (let i = 0; i < chunks.length; i++) {
    await sendTelegramMessage(chatId, chunks[i]);
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  logger.info('[WeekendReport] Weekend prep report sent successfully');
  console.log('[WeekendReport] ✓ Weekend prep report sent!');
}

module.exports = { sendWeekendReport };

if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
  sendWeekendReport()
    .then(() => process.exit(0))
    .catch(e => { console.error(e.message); process.exit(1); });
}
