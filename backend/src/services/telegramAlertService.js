const axios = require('axios');
const { logger } = require('../utils/logger');
const wa = require('./whatsappAlertService'); // parallel WhatsApp channel — fire-and-forget

/**
 * Telegram Alert Service
 * Sends real-time alerts for important trading events
 */

// Get bot token and chat ID from environment or database
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

/**
 * Send Telegram message
 * @param {string} chatId - Telegram chat ID
 * @param {string} message - Message text
 * @param {string} parseMode - Message format ('Markdown' or 'HTML')
 */
async function sendTelegramMessage(chatId, message, parseMode = 'Markdown') {
    try {
        if (!TELEGRAM_BOT_TOKEN) {
            logger.warn('Telegram bot token not configured');
            return false;
        }

        try {
            const response = await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
                chat_id: chatId,
                text: message,
                parse_mode: parseMode
            });
            logger.info('Telegram alert sent', { chatId, success: response.data.ok });
            return response.data.ok;
        } catch (err) {
            // 400 = Telegram rejected the Markdown formatting — retry as plain text so
            // the message is never silently lost due to a formatting edge case.
            if (err.response?.status === 400 && parseMode) {
                logger.warn('Telegram Markdown parse failed, retrying as plain text', { chatId, status: 400 });
                const plain = await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
                    chat_id: chatId,
                    text: message.replace(/[*_`\[\]]/g, '')   // strip Markdown symbols
                });
                logger.info('Telegram alert sent (plain fallback)', { chatId, success: plain.data.ok });
                return plain.data.ok;
            }
            throw err;
        }
    } catch (error) {
        logger.error('Failed to send Telegram alert', { error: error.message, chatId });
        return false;
    }
}

/**
 * Get user's Telegram chat ID from database
 */
async function getUserTelegramChatId(userId) {
    const { query } = require('../config/database');
    try {
        const result = await query(
            'SELECT telegram_chat_id FROM users WHERE id = $1',
            [userId]
        );
        return result.rows[0]?.telegram_chat_id;
    } catch (error) {
        logger.error('Failed to get user Telegram chat ID', { userId, error: error.message });
        return null;
    }
}

// 5-minute cache — avoids a DB hit on every alert for the same user
const _userInfoCache = new Map();
async function getUserInfo(userId) {
    const cached = _userInfoCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) return cached.info;
    const { query } = require('../config/database');
    try {
        const r = await query('SELECT username, email FROM users WHERE id = $1', [userId]);
        const username = r.rows[0]?.username || r.rows[0]?.email || 'unknown';
        const shortId  = String(userId).slice(0, 8);
        const info = { display: `${username} \`(${shortId}...)\`` };
        _userInfoCache.set(userId, { info, expiresAt: Date.now() + 300_000 });
        return info;
    } catch (_) {
        return { display: `\`${String(userId).slice(0, 8)}...\`` };
    }
}

/**
 * Send a plain message to a user's Telegram (used by scheduler & health check).
 */
async function sendMessage(userId, message) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return false;
    return sendTelegramMessage(chatId, message);
}

// 60-second cache: multiple alerts firing in the same event (BUY + stop-loss cascade)
// would otherwise each hit the DB with the same holdings query.
const _holdingsLineCache = new Map(); // userId → { line: string, expiresAt: number }

/**
 * Clears the holdings line cache for a user so the next alert reflects
 * the current (post-sell) portfolio. Call this immediately after any sell.
 */
function invalidateHoldingsCache(userId) {
    _holdingsLineCache.delete(userId);
}

/**
 * Returns a formatted single line showing open holding symbols, e.g.
 *   📦 Holdings: AAPL, MSFT, TSLA (3 open)
 * Falls back silently to an empty string on any error.
 */
async function getHoldingsLine(userId) {
    const cached = _holdingsLineCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) return cached.line;

    const { query } = require('../config/database');
    try {
        const res = await query(
            `SELECT symbol FROM holdings WHERE user_id = $1 AND quantity > 0 ORDER BY symbol`,
            [userId]
        );
        const line = res.rows.length
            ? `📦 Holdings: ${res.rows.map(r => r.symbol).join(', ')} (${res.rows.length} open)`
            : '📦 Holdings: None';
        _holdingsLineCache.set(userId, { line, expiresAt: Date.now() + 60_000 });
        return line;
    } catch (_) {
        return '';
    }
}

/**
 * Alert: Large Loss (>10%)
 */
async function alertLargeLoss(userId, symbol, percentLoss, currentPrice, purchasePrice) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const [holdingsLine, { display }] = await Promise.all([getHoldingsLine(userId), getUserInfo(userId)]);
    const message = `
🚨 *LARGE LOSS ALERT*
👤 User: ${display}

📉 *${symbol}* is down *${Math.abs(percentLoss).toFixed(2)}%*

💰 Current: $${currentPrice.toFixed(2)}
📍 Purchase: $${purchasePrice.toFixed(2)}
📊 Loss: ${percentLoss.toFixed(2)}%

${holdingsLine}
⚠️ Consider reviewing your position
`;

    await sendTelegramMessage(chatId, message);
    wa.alertLargeLoss(userId, symbol, percentLoss, currentPrice, purchasePrice).catch(() => {});
    logger.riskEvent('LARGE_LOSS', symbol, { percentLoss, currentPrice, purchasePrice });
}

/**
 * Alert: Stop Loss Triggered
 */
async function alertStopLossTriggered(userId, symbol, shares, sellPrice, loss) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const [holdingsLine, { display }] = await Promise.all([getHoldingsLine(userId), getUserInfo(userId)]);
    const message = `
🛑 *STOP LOSS TRIGGERED*
👤 User: ${display}

Symbol: *${symbol}*
Action: SOLD ${shares} shares
Price: $${sellPrice.toFixed(2)}
Loss: $${loss.toFixed(2)} (${((loss / (sellPrice * shares + loss)) * 100).toFixed(2)}%)

${holdingsLine}
✅ Position closed to prevent further loss
`;

    await sendTelegramMessage(chatId, message);
    wa.alertStopLossTriggered(userId, symbol, shares, sellPrice, loss).catch(() => {});
}

/**
 * Alert: Take Profit Executed
 */
async function alertTakeProfitExecuted(userId, symbol, shares, sellPrice, profit, percentGain) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const [holdingsLine, { display }] = await Promise.all([getHoldingsLine(userId), getUserInfo(userId)]);
    const message = `
🎯 *TAKE PROFIT EXECUTED*
👤 User: ${display}

Symbol: *${symbol}*
Action: SOLD ${shares} shares
Price: $${sellPrice.toFixed(2)}
Profit: $${profit.toFixed(2)} (+${percentGain.toFixed(2)}%)

${holdingsLine}
🎉 Target reached!
`;

    await sendTelegramMessage(chatId, message);
    wa.alertTakeProfitExecuted(userId, symbol, shares, sellPrice, profit, percentGain).catch(() => {});
}

/**
 * Alert: Daily Loss Limit Approaching
 */
async function alertDailyLossWarning(userId, dailyLoss, limit) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const percentOfLimit = (Math.abs(dailyLoss) / Math.abs(limit)) * 100;
    const { display } = await getUserInfo(userId);

    const message = `
⚠️ *DAILY LOSS WARNING*
👤 User: ${display}

Today's Loss: $${Math.abs(dailyLoss).toFixed(2)}
Limit: $${Math.abs(limit).toFixed(2)}
Used: ${percentOfLimit.toFixed(1)}%

🚨 AI trading will stop if limit is reached
`;

    await sendTelegramMessage(chatId, message);
}

/**
 * Alert: Daily Loss Limit Reached
 */
async function alertDailyLossLimitReached(userId, dailyLoss) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const { display } = await getUserInfo(userId);
    const message = `
🔴 *DAILY LOSS LIMIT REACHED*
👤 User: ${display}

Today's Loss: $${Math.abs(dailyLoss).toFixed(2)}

⛔ AI trading has been stopped for today
🔒 No new positions will be opened
✅ Existing positions will be monitored

Will resume tomorrow at market open.
`;

    await sendTelegramMessage(chatId, message);
    wa.alertDailyLossLimitReached(userId, dailyLoss).catch(() => {});
    logger.error('Daily loss limit reached', { userId, dailyLoss });
}

/**
 * Alert: High VIX Warning
 */
async function alertHighVIX(userId, vixLevel) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const { display } = await getUserInfo(userId);
    const message = `
⚠️ *HIGH VOLATILITY WARNING*
👤 User: ${display}

VIX Level: ${vixLevel.toFixed(2)}

📊 Market is experiencing high volatility
🛡️ AI trading will be conservative
⚠️ No new positions until VIX < 30

Existing positions are being monitored.
`;

    await sendTelegramMessage(chatId, message);
}

/**
 * Alert: AI Trading Started
 */
async function alertTradingStarted(userId, balance, holdings) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const [holdingsLine, { display }] = await Promise.all([getHoldingsLine(userId), getUserInfo(userId)]);
    const message = `
🤖 *AI TRADING STARTED*
👤 User: ${display}

💰 Account Balance: $${balance.toFixed(2)}
📊 Open Positions: ${holdings}
${holdingsLine}
⏰ Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET

✅ Bot is analyzing market opportunities...
`;

    await sendTelegramMessage(chatId, message);
}

/**
 * Alert: Trade Executed
 */
async function alertTradeExecuted(userId, action, symbol, shares, price, aiScore, reasoning) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const emoji = action === 'BUY' ? '✅' : '📤';
    const total = shares * price;
    const [holdingsLine, { display }] = await Promise.all([getHoldingsLine(userId), getUserInfo(userId)]);

    const message = `
${emoji} *TRADE EXECUTED*
👤 User: ${display}

Action: *${action} ${shares} shares*
Symbol: *${symbol}*
Price: $${price.toFixed(2)}
Total: $${total.toFixed(2)}
AI Score: ${aiScore}/100

${holdingsLine}
${reasoning ? `📝 ${reasoning}` : ''}
`;

    await sendTelegramMessage(chatId, message);
    wa.alertTradeExecuted(userId, action, symbol, shares, price, aiScore, reasoning).catch(() => {});
}

/**
 * Alert: No Opportunities Found
 */
async function alertNoOpportunities(userId, scanned, vixLevel) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    // Only send this alert once per day to avoid spam
    const today = new Date().toDateString();
    const lastAlertKey = `no_opp_alert_${userId}_${today}`;
    
    // Simple in-memory check (in production, use Redis or database)
    if (global.sentAlerts && global.sentAlerts[lastAlertKey]) {
        return;
    }

    const [holdingsLine, { display }] = await Promise.all([getHoldingsLine(userId), getUserInfo(userId)]);
    const message = `
ℹ️ *AI TRADING UPDATE*
👤 User: ${display}

📊 Analyzed: ${scanned} stocks
🎯 Opportunities: 0
📈 VIX: ${vixLevel.toFixed(2)}

${holdingsLine}
No qualifying opportunities at this time.
Bot will continue monitoring.
`;

    await sendTelegramMessage(chatId, message);
    
    if (!global.sentAlerts) global.sentAlerts = {};
    global.sentAlerts[lastAlertKey] = true;
}

/**
 * Alert: Performance Summary (Daily)
 */
async function alertDailySummary(userId, stats) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const { trades, profitTrades, lossTrades, totalProfit, winRate, bestTrade, worstTrade } = stats;
    const [holdingsLine, { display }] = await Promise.all([getHoldingsLine(userId), getUserInfo(userId)]);

    const message = `
📊 *DAILY TRADING SUMMARY*
👤 User: ${display}

🔢 Trades: ${trades}
✅ Wins: ${profitTrades}
❌ Losses: ${lossTrades}
📈 Win Rate: ${winRate.toFixed(1)}%

💰 Total P&L: $${totalProfit.toFixed(2)}
🏆 Best: +$${bestTrade.toFixed(2)}
📉 Worst: -$${Math.abs(worstTrade).toFixed(2)}

${holdingsLine}
${totalProfit > 0 ? '🎉 Profitable day!' : totalProfit < 0 ? '💪 Tomorrow is another day' : '➡️ Break even'}
`;

    await sendTelegramMessage(chatId, message);
}

/**
 * Alert: Options Trade Executed
 */
async function alertOptionsTradeExecuted(userId, tradeDetails) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const { action, symbol, contracts, strike, expiration, optionType, price, totalCost, strategy, greeks } = tradeDetails;
    const { display } = await getUserInfo(userId);
    const emoji = action === 'BUY' ? '📈' : '📉';
    const strategyEmoji = {
        deltaNeutralScalping: '⚡',
        directionalSwing: '🎯',
        creditSpreads: '💰',
        protectivePuts: '🛡️'
    }[strategy] || '📊';

    const message = `
${emoji} *OPTIONS TRADE EXECUTED* ${strategyEmoji}
👤 User: ${display}

Action: *${action}*
Symbol: *${symbol}*
Type: ${optionType.toUpperCase()}
Strike: $${strike.toFixed(2)}
Expiration: ${expiration}

Contracts: ${contracts}
Price: $${price.toFixed(2)}
Total: $${totalCost.toFixed(2)}

Strategy: ${strategy}

📊 Greeks:
• Delta: ${greeks.delta.toFixed(3)}
• Gamma: ${greeks.gamma.toFixed(3)}
• Theta: ${greeks.theta.toFixed(3)}
• Vega: ${greeks.vega.toFixed(3)}
`;

    await sendTelegramMessage(chatId, message);
}

/**
 * Alert: Credit Spread Executed
 */
async function alertCreditSpreadExecuted(userId, spreadDetails) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const { type, symbol, contracts, shortLeg, longLeg, credit, maxRisk, returnOnRisk, expiration } = spreadDetails;
    const { display } = await getUserInfo(userId);

    const message = `
💰 *CREDIT SPREAD EXECUTED*
👤 User: ${display}

Type: ${type}
Symbol: *${symbol}*
Expiration: ${expiration}

Short: $${shortLeg.strike} ${shortLeg.optionType}
Long: $${longLeg.strike} ${longLeg.optionType}

Contracts: ${contracts}
Credit: $${credit.toFixed(2)}/contract
Total Credit: $${(credit * contracts * 100).toFixed(2)}

Max Risk: $${maxRisk.toFixed(2)}/contract
Return on Risk: ${returnOnRisk.toFixed(1)}%

🎯 Probability of profit: ~${(100 - Math.abs(shortLeg.greeks.delta) * 100).toFixed(0)}%
`;

    await sendTelegramMessage(chatId, message);
}

/**
 * Alert: Options Position Closed
 */
async function alertOptionsPositionClosed(userId, closeDetails) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const { symbol, strike, expiration, contracts, entryPrice, exitPrice, pnl, pnlPercent, reason } = closeDetails;
    const { display } = await getUserInfo(userId);
    const emoji = pnl > 0 ? '✅' : '❌';
    const reasonEmoji = {
        TAKE_PROFIT: '🎯',
        STOP_LOSS: '🛑',
        EXPIRATION_APPROACHING: '⏰',
        HIGH_THETA_DECAY: '⏳'
    }[reason] || '📊';

    const message = `
${emoji} *OPTIONS POSITION CLOSED* ${reasonEmoji}
👤 User: ${display}

Symbol: *${symbol}*
Strike: $${strike}
Expiration: ${expiration}

Contracts: ${contracts}
Entry: $${entryPrice.toFixed(2)}
Exit: $${exitPrice.toFixed(2)}

P&L: $${pnl.toFixed(2)} (${pnlPercent.toFixed(1)}%)

Reason: ${reason.replace(/_/g, ' ')}
`;

    await sendTelegramMessage(chatId, message);
}

/**
 * Alert: Options Bot Started
 */
async function alertOptionsBotStarted(userId, config) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const { balance, strategies, maxPositions, vix } = config;
    const { display } = await getUserInfo(userId);

    const message = `
🤖 *OPTIONS BOT STARTED*
👤 User: ${display}

💰 Account: $${balance.toFixed(2)}
📊 VIX: ${vix.toFixed(2)}

Strategies Enabled:
${strategies.scalping ? '⚡ Delta-Neutral Scalping' : ''}
${strategies.swing ? '🎯 Directional Swing' : ''}
${strategies.spreads ? '💰 Credit Spreads' : ''}
${strategies.hedging ? '🛡️ Protective Hedging' : ''}

Max Positions: ${maxPositions}

🔍 Scanning for opportunities...
`;

    await sendTelegramMessage(chatId, message);
}

/**
 * Alert: Nightly universe scan failed or had low coverage.
 */
async function alertNightlyScanFailure(userId, { analyzed, universe, failed, reason }) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const coveragePct = universe > 0 ? ((analyzed / universe) * 100).toFixed(1) : '0';
    const { display } = await getUserInfo(userId);
    const message = `
🚨 *NIGHTLY SCAN WARNING*
👤 User: ${display}

📊 Universe expected: ${universe}
✅ Analyzed: ${analyzed} (${coveragePct}% coverage)
❌ Failed: ${failed}

${reason ? `Reason: ${reason}` : ''}

⚠️ Market-hours scan may fall back to live analysis.
Check server logs for details.
`;
    await sendTelegramMessage(chatId, message);
}

/**
 * Alert: Edge Gate blocked all new entries for today (once per day).
 */
async function alertEdgeGateBlocked(userId, opportunityCount) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    // Rate-limit to once per day — cycle runs every 30 min, no need to spam
    const todayKey = `edge_gate_${userId}_${new Date().toDateString()}`;
    if (!global._edgeGateAlerts) global._edgeGateAlerts = {};
    if (global._edgeGateAlerts[todayKey]) return;
    global._edgeGateAlerts[todayKey] = true;

    const [holdingsLine, { display }] = await Promise.all([getHoldingsLine(userId), getUserInfo(userId)]);
    const message = `
ℹ️ *NO NEW TRADES TODAY*
👤 User: ${display}

🔍 Scanned: ${opportunityCount} stocks
🎯 STRONG BUY signals: 0

All entries skipped — no high-conviction signal found.
Bot continues monitoring and managing exits.

${holdingsLine}
`;
    await sendTelegramMessage(chatId, message);
}

/**
 * Alert: Distress mode lifted — normal stop-loss restored.
 */
async function alertDistressModeRecovery(userId) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const [holdingsLine, { display }] = await Promise.all([getHoldingsLine(userId), getUserInfo(userId)]);
    const message = `
✅ *DISTRESS MODE LIFTED*
👤 User: ${display}

Portfolio stress has eased — fewer than 2 positions remain down >3%.
Normal stop-loss (-7%) has been restored.

${holdingsLine}
Monitoring continues as usual.
`;
    await sendTelegramMessage(chatId, message);
}

/**
 * Alert: Options signal entry — fired when the bot decides to buy a Call or Put.
 * Shows the full directional thesis so the user understands WHY the trade was taken.
 */
async function alertOptionsSignalEntry(userId, details) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const {
        symbol, stockPrice, momentum, score, regime,
        optionType, strike, expiration, dte, price, contracts, totalCost,
        delta, gamma, theta, ivRankLabel, ivRank, strategy
    } = details;

    const { display } = await getUserInfo(userId);
    const isBullish = (optionType || '').toUpperCase() === 'CALL';
    const directionEmoji = isBullish ? '🟢' : '🔴';
    const directionLabel = isBullish ? 'BULLISH CALL ENTRY' : 'BEARISH PUT ENTRY';
    const momentumSign = momentum >= 0 ? '+' : '';

    const ivLine = ivRankLabel === 'LOW'
        ? `✅ IV LOW (Rank: ${ivRank != null ? ivRank.toFixed(0) : 'N/A'}) — cheap premium`
        : ivRankLabel === 'HIGH'
        ? `⚠️ IV HIGH (Rank: ${ivRank != null ? ivRank.toFixed(0) : 'N/A'}) — expensive premium`
        : `📊 IV NORMAL (Rank: ${ivRank != null ? ivRank.toFixed(0) : 'N/A'})`;

    const deltaLabel = Math.abs(delta) >= 0.60
        ? `${Math.abs(delta).toFixed(3)} ← ITM, high conviction`
        : `${Math.abs(delta).toFixed(3)} ← near ATM`;

    const whyLine = isBullish
        ? `Momentum ${momentumSign}${momentum.toFixed(1)}% + ${regime} regime → buying CALL`
        : `Momentum ${momentumSign}${momentum.toFixed(1)}% + ${regime} regime → buying PUT`;

    const message = `
${directionEmoji} *${directionLabel} — ${symbol}*
👤 User: ${display}

📊 *${symbol}* @ $${Number(stockPrice).toFixed(2)} (${momentumSign}${momentum.toFixed(1)}% today)
🎯 Signal Score: *${Number(score).toFixed(0)}/100*
📈 Regime: ${regime}

*Contract:*
Type: *${(optionType || '').toUpperCase()}*
Strike: $${Number(strike).toFixed(2)}
Expiry: ${expiration} (${dte} DTE)
Price: $${Number(price).toFixed(2)}/contract

📐 *Greeks at entry:*
• Delta: ${deltaLabel}
• Gamma: ${gamma.toFixed(3)}
• Theta: ${theta.toFixed(3)}/day
• ${ivLine}

💡 *Why:* ${whyLine}
📋 Strategy: ${strategy}

Contracts: ${contracts} | Cost: $${Number(totalCost).toFixed(2)}
`;

    await sendTelegramMessage(chatId, message);
    wa.alertOptionsSignalEntry(userId, details).catch(() => {});
}

/**
 * Alert: High IV Rank Opportunity
 */
async function alertHighIVRank(userId, symbol, ivRank, strategy) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const { display } = await getUserInfo(userId);
    const message = `
🔥 *HIGH IV OPPORTUNITY*
👤 User: ${display}

Symbol: *${symbol}*
IV Rank: ${ivRank.toFixed(1)}%

${ivRank > 70 ? '💰 Great for selling premium (credit spreads)' : '⚡ Good for scalping/long options'}

Recommended: ${strategy}
`;

    await sendTelegramMessage(chatId, message);
}

module.exports = {
    sendTelegramMessage,
    sendMessage,
    getUserTelegramChatId,
    invalidateHoldingsCache,
    alertLargeLoss,
    alertStopLossTriggered,
    alertTakeProfitExecuted,
    alertDailyLossWarning,
    alertDailyLossLimitReached,
    alertHighVIX,
    alertTradingStarted,
    alertTradeExecuted,
    alertNoOpportunities,
    alertDailySummary,
    alertNightlyScanFailure,
    alertEdgeGateBlocked,
    alertDistressModeRecovery,
    // Options-specific alerts
    alertOptionsSignalEntry,
    alertOptionsTradeExecuted,
    alertCreditSpreadExecuted,
    alertOptionsPositionClosed,
    alertOptionsBotStarted,
    alertHighIVRank
};
