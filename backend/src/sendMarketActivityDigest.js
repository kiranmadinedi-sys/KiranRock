/**
 * Market + Activity Digest — admin-only, 3x/day (morning/afternoon/evening).
 *
 * Answers exactly what gets asked in chat each time: how's the market, what's the
 * regime, and what did every enrolled user's bot actually do today. Distinct from
 * sendDailyPerformanceReport (single service-account P&L metrics) and from the
 * per-user Telegram/WhatsApp trade alerts (one user's own activity) — this is the
 * cross-user, admin-facing view (2026-07-17).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { query } = require('./config/database');
const { sendTelegramMessage } = require('./services/telegramService');
const dataProvider = require('./services/dataProvider');
const marketRegimeService = require('./services/marketRegimeService');
const { logger } = require('./utils/logger');

async function buildMarketSnapshot() {
    const lines = [];
    for (const symbol of ['SPY', 'QQQ', 'DIA']) {
        try {
            const q = await dataProvider.getQuote(symbol);
            const sign = q.changePercent >= 0 ? '+' : '';
            lines.push(`${symbol} $${q.price.toFixed(2)} (${sign}${q.changePercent.toFixed(2)}%)`);
        } catch (e) {
            lines.push(`${symbol} unavailable`);
        }
    }

    let regimeLine = 'Regime unavailable';
    try {
        const regime = await marketRegimeService.getMarketRegime();
        regimeLine = `${regime.regimeType} (5d range ${regime.spy5dRangePct}%, ATR ratio ${regime.atrExpansion}, VIX ${regime.vixLevel})`;
    } catch (e) { /* best-effort */ }

    return { indexLine: lines.join(' | '), regimeLine };
}

async function buildUserActivityTable() {
    const result = await query(`
        SELECT u.username, t.symbol, t.action, t.quantity, t.price, t.ai_score, t.trade_date
        FROM trades t
        JOIN users u ON u.id = t.user_id
        WHERE t.trade_date::date = CURRENT_DATE
          AND u.ai_trading_enabled = true
        ORDER BY u.username, t.trade_date ASC
    `);

    const enrolledRes = await query(`
        SELECT username FROM users WHERE ai_trading_enabled = true AND is_active IS NOT FALSE ORDER BY username
    `);
    const enrolledUsernames = enrolledRes.rows.map(r => r.username);

    const byUser = {};
    for (const row of result.rows) {
        if (!byUser[row.username]) byUser[row.username] = [];
        byUser[row.username].push(row);
    }

    return { byUser, enrolledUsernames };
}

async function sendMarketActivityDigest(periodLabel) {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) {
        logger.warn('[MarketActivityDigest] TELEGRAM_CHAT_ID not set, skipping');
        return;
    }

    try {
        const { indexLine, regimeLine } = await buildMarketSnapshot();
        const { byUser, enrolledUsernames } = await buildUserActivityTable();

        const lines = [
            `📈 *${periodLabel} Market + Activity Digest*`,
            '',
            `_${indexLine}_`,
            `Regime: ${regimeLine}`,
            '',
            `👥 Enrolled: ${enrolledUsernames.length} (${enrolledUsernames.join(', ') || 'none'})`,
            ''
        ];

        if (enrolledUsernames.length === 0) {
            lines.push('No users currently have AI trading enabled.');
        } else {
            let anyTrades = false;
            for (const username of enrolledUsernames) {
                const trades = byUser[username] || [];
                if (trades.length === 0) {
                    lines.push(`*${username}*: no trades today`);
                    continue;
                }
                anyTrades = true;
                lines.push(`*${username}*:`);
                for (const t of trades) {
                    lines.push(`  ${t.action} ${t.quantity} ${t.symbol} @ $${parseFloat(t.price).toFixed(2)} (score ${t.ai_score})`);
                }
            }
            if (!anyTrades) lines.push('\nNo trades executed by any enrolled user today so far.');
        }

        await sendTelegramMessage(chatId, lines.join('\n'));
        logger.info(`[MarketActivityDigest] ${periodLabel} digest sent`);
    } catch (error) {
        logger.error('[MarketActivityDigest] Failed', { periodLabel, error: error.message });
    }
}

module.exports = { sendMarketActivityDigest };
