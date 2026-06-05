/**
 * Claude AI Reports
 *
 * sendClaudeWeeklyBuyList  — Sunday 8 AM EST
 *   Full analyst-grade weekly report: bull/base/bear scenarios, R/R ratios,
 *   sector rotation overlay, Kelly position sizing, 7-section structured output.
 *   Designed for investors who want the complete picture for the whole week.
 *
 * sendClaudeDailyAnalysis  — Mon-Fri 7 AM EST (after predictions report)
 *   Short beginner-friendly briefing: plain English, top 3 picks, $1k examples,
 *   what to avoid, one tip. Designed for someone just starting out.
 */

const axios = require('axios');
const { analyzeMarketWithClaude, analyzeDailyWithClaude } = require('./services/claudeMarketAnalysisService');
const { sendTelegramMessage } = require('./services/telegramService');
const { logger } = require('./utils/logger');

const BASE_URL = 'http://localhost:3001';

function weekLabel() {
    const now = new Date();
    const day = now.getDay();
    const mon = new Date(now.getTime() - ((day === 0 ? 6 : day - 1) * 86400000));
    const fri = new Date(mon.getTime() + 4 * 86400000);
    const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${fmt(mon)} – ${fmt(fri)}, ${now.getFullYear()}`;
}

function todayLabel() {
    return new Date().toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
}

async function login() {
    const res = await axios.post(`${BASE_URL}/api/auth/login`, {
        username: process.env.BOT_USERNAME || 'user',
        password: process.env.BOT_PASSWORD || 'password'
    }, { timeout: 10000 });
    if (!res.data.token) throw new Error('Login failed');
    return res.data.token;
}

async function fetchPredictions(token, limit = 20) {
    const res = await axios.get(
        `${BASE_URL}/api/weekly/predictions?limit=${limit}&universe=TOP_200`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 300000 }
    );
    return {
        picks:         (res.data?.topPicks || []).slice(0, limit),
        marketContext: res.data?.marketContext || null
    };
}

async function fetchMacroNews(token) {
    try {
        const res = await axios.get(
            `${BASE_URL}/api/news-aggregation/category/macro`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
        );
        return (res.data?.news || [])
            .filter(n => n.headline)
            .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
            .slice(0, 8);
    } catch {
        return [];
    }
}

async function sendChunked(chatId, text) {
    const MAX = 4000;
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        chunks.push(remaining.slice(0, MAX));
        remaining = remaining.slice(MAX);
    }
    for (let i = 0; i < chunks.length; i++) {
        await sendTelegramMessage(chatId, chunks[i]);
        if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 1000));
    }
    return chunks.length;
}

/**
 * Select the single best pick as "Trade of the Week".
 * Scoring: (confidence * R/R) where R/R = |expectedMove| / max(1, riskScore * 0.15)
 */
function pickTradeOfTheWeek(picks) {
    let best = null;
    let bestScore = -Infinity;
    for (const p of picks) {
        const move = Math.abs(p.prediction?.expectedMove || 0);
        const conf = (p.prediction?.confidence || 0) / 100;
        const risk = Math.max(1, (p.riskAnalysis?.riskScore || 50) * 0.15);
        const rr   = move / risk;
        const composite = conf * rr;
        if (composite > bestScore) { bestScore = composite; best = p; }
    }
    return best;
}

function buildTradeOfWeekHeader(pick, wk) {
    if (!pick) return '';
    const move   = pick.prediction?.expectedMove || 0;
    const conf   = pick.prediction?.confidence   || 0;
    const price  = pick.currentPrice             || '?';
    const target = pick.prediction?.targetPrice  || '?';
    const risk   = pick.riskAnalysis?.riskScore  || 50;
    const rrNum  = (Math.abs(move) / Math.max(1, risk * 0.15)).toFixed(1);
    return `🏆 *TRADE OF THE WEEK — ${wk}*\n` +
           `━━━━━━━━━━━━━━━━━━━━\n` +
           `📌 *$${pick.symbol}* — ${pick.name || pick.symbol}\n` +
           `💡 Signal: *${pick.prediction?.signal || 'Buy'}* | AI Confidence: *${conf}%*\n` +
           `💰 Price: $${price} → Target: $${target} | Expected: ${move > 0 ? '+' : ''}${move}%\n` +
           `⚖️ Risk/Reward: *${rrNum}:1* | Risk score: ${risk}/100\n` +
           `📋 ${pick.rationale || 'Top-ranked by AI across all metrics this week.'}\n` +
           `━━━━━━━━━━━━━━━━━━━━\n\n`;
}

// ─── Weekly: full analyst report (Sunday 8 AM) ───────────────────────────────

async function sendClaudeWeeklyBuyList() {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) throw new Error('TELEGRAM_CHAT_ID not set in .env');
    if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY not set in .env — get your key at console.anthropic.com');
    }

    logger.info('[ClaudeBuyList] Starting Claude WEEKLY buy list...');
    const token = await login();
    const [{ picks, marketContext }, macroNews] = await Promise.all([
        fetchPredictions(token, 20),
        fetchMacroNews(token)
    ]);

    if (picks.length === 0) throw new Error('No predictions available');
    console.log(`[ClaudeBuyList] ${picks.length} picks + ${macroNews.length} news items`);

    const wk = weekLabel();
    const tradeOfWeek = pickTradeOfTheWeek(picks);
    const totHeader   = buildTradeOfWeekHeader(tradeOfWeek, wk);

    const claudeReport = await analyzeMarketWithClaude({
        picks, marketContext, macroNews,
        weekLabel: wk
    });

    const footer = `\n━━━━━━━━━━━━━━━━━━━━\n🤖 _Analysed by Claude AI (${process.env.CLAUDE_MODEL || 'claude-sonnet-4-6'}) · Live market data_\n⚖️ _Not financial advice. Do your own research._`;
    const count = await sendChunked(chatId, `${totHeader}${claudeReport}${footer}`);

    logger.info('[ClaudeBuyList] ✓ Weekly report sent', { picks: picks.length, tradeOfWeek: tradeOfWeek?.symbol, chunks: count });
    console.log(`[ClaudeBuyList] ✓ Weekly report sent (${count} message(s)) | Trade of Week: ${tradeOfWeek?.symbol}`);
}

// ─── Daily: beginner-friendly briefing (Mon-Fri 7 AM) ────────────────────────

async function sendClaudeDailyAnalysis() {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) throw new Error('TELEGRAM_CHAT_ID not set in .env');
    if (!process.env.ANTHROPIC_API_KEY) {
        logger.warn('[ClaudeDaily] ANTHROPIC_API_KEY not set — skipping Claude daily analysis');
        console.log('[ClaudeDaily] Skipping: ANTHROPIC_API_KEY not configured');
        return;
    }

    logger.info('[ClaudeDaily] Starting Claude DAILY beginner analysis...');
    const token = await login();
    const [{ picks, marketContext }, macroNews] = await Promise.all([
        fetchPredictions(token, 10),
        fetchMacroNews(token)
    ]);

    if (picks.length === 0) {
        logger.warn('[ClaudeDaily] No predictions available — skipping');
        return;
    }
    console.log(`[ClaudeDaily] ${picks.length} picks fetched`);

    const claudeReport = await analyzeDailyWithClaude({
        picks, marketContext, macroNews,
        todayLabel: todayLabel()
    });

    const footer = `\n━━━━━━━━━━━━━━━━━━━━\n🤖 _Claude AI · ${process.env.CLAUDE_MODEL || 'claude-sonnet-4-6'}_\n⚖️ _Not financial advice. Learn before you invest._`;
    const count = await sendChunked(chatId, `${claudeReport}${footer}`);

    logger.info('[ClaudeDaily] ✓ Daily beginner analysis sent', { picks: picks.length, chunks: count });
    console.log(`[ClaudeDaily] ✓ Daily analysis sent (${count} message(s))`);
}

module.exports = { sendClaudeWeeklyBuyList, sendClaudeDailyAnalysis };

if (require.main === module) {
    require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
    const mode = process.argv[2] || 'daily';
    const fn = mode === 'weekly' ? sendClaudeWeeklyBuyList : sendClaudeDailyAnalysis;
    fn()
        .then(() => process.exit(0))
        .catch(e => { console.error('[Claude] Failed:', e.message); process.exit(1); });
}
