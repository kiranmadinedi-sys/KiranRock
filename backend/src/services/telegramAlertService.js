const axios = require('axios');
const { logger } = require('../utils/logger');

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

        const response = await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: parseMode
        });

        logger.info('Telegram alert sent', { chatId, success: response.data.ok });
        return response.data.ok;
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

/**
 * Alert: Large Loss (>10%)
 */
async function alertLargeLoss(userId, symbol, percentLoss, currentPrice, purchasePrice) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const message = `
🚨 *LARGE LOSS ALERT*

📉 *${symbol}* is down *${Math.abs(percentLoss).toFixed(2)}%*

💰 Current: $${currentPrice.toFixed(2)}
📍 Purchase: $${purchasePrice.toFixed(2)}
📊 Loss: ${percentLoss.toFixed(2)}%

⚠️ Consider reviewing your position
`;

    await sendTelegramMessage(chatId, message);
    logger.riskEvent('LARGE_LOSS', symbol, { percentLoss, currentPrice, purchasePrice });
}

/**
 * Alert: Stop Loss Triggered
 */
async function alertStopLossTriggered(userId, symbol, shares, sellPrice, loss) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const message = `
🛑 *STOP LOSS TRIGGERED*

Symbol: *${symbol}*
Action: SOLD ${shares} shares
Price: $${sellPrice.toFixed(2)}
Loss: $${loss.toFixed(2)} (${((loss / (sellPrice * shares + loss)) * 100).toFixed(2)}%)

✅ Position closed to prevent further loss
`;

    await sendTelegramMessage(chatId, message);
}

/**
 * Alert: Take Profit Executed
 */
async function alertTakeProfitExecuted(userId, symbol, shares, sellPrice, profit, percentGain) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const message = `
🎯 *TAKE PROFIT EXECUTED*

Symbol: *${symbol}*
Action: SOLD ${shares} shares
Price: $${sellPrice.toFixed(2)}
Profit: $${profit.toFixed(2)} (+${percentGain.toFixed(2)}%)

🎉 Target reached!
`;

    await sendTelegramMessage(chatId, message);
}

/**
 * Alert: Daily Loss Limit Approaching
 */
async function alertDailyLossWarning(userId, dailyLoss, limit) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const percentOfLimit = (Math.abs(dailyLoss) / Math.abs(limit)) * 100;

    const message = `
⚠️ *DAILY LOSS WARNING*

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

    const message = `
🔴 *DAILY LOSS LIMIT REACHED*

Today's Loss: $${Math.abs(dailyLoss).toFixed(2)}

⛔ AI trading has been stopped for today
🔒 No new positions will be opened
✅ Existing positions will be monitored

Will resume tomorrow at market open.
`;

    await sendTelegramMessage(chatId, message);
    logger.error('Daily loss limit reached', { userId, dailyLoss });
}

/**
 * Alert: High VIX Warning
 */
async function alertHighVIX(userId, vixLevel) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const message = `
⚠️ *HIGH VOLATILITY WARNING*

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

    const message = `
🤖 *AI TRADING STARTED*

💰 Account Balance: $${balance.toFixed(2)}
📊 Current Holdings: ${holdings} positions
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

    const message = `
${emoji} *TRADE EXECUTED*

Action: *${action} ${shares} shares*
Symbol: *${symbol}*
Price: $${price.toFixed(2)}
Total: $${total.toFixed(2)}
AI Score: ${aiScore}/100

${reasoning ? `📝 ${reasoning}` : ''}
`;

    await sendTelegramMessage(chatId, message);
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

    const message = `
ℹ️ *AI TRADING UPDATE*

📊 Analyzed: ${scanned} stocks
🎯 Opportunities: 0
📈 VIX: ${vixLevel.toFixed(2)}

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

    const message = `
📊 *DAILY TRADING SUMMARY*

🔢 Trades: ${trades}
✅ Wins: ${profitTrades}
❌ Losses: ${lossTrades}
📈 Win Rate: ${winRate.toFixed(1)}%

💰 Total P&L: $${totalProfit.toFixed(2)}
🏆 Best: +$${bestTrade.toFixed(2)}
📉 Worst: -$${Math.abs(worstTrade).toFixed(2)}

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
    
    const emoji = action === 'BUY' ? '📈' : '📉';
    const strategyEmoji = {
        deltaNeutralScalping: '⚡',
        directionalSwing: '🎯',
        creditSpreads: '💰',
        protectivePuts: '🛡️'
    }[strategy] || '📊';

    const message = `
${emoji} *OPTIONS TRADE EXECUTED* ${strategyEmoji}

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

    const message = `
💰 *CREDIT SPREAD EXECUTED*

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
    
    const emoji = pnl > 0 ? '✅' : '❌';
    const reasonEmoji = {
        TAKE_PROFIT: '🎯',
        STOP_LOSS: '🛑',
        EXPIRATION_APPROACHING: '⏰',
        HIGH_THETA_DECAY: '⏳'
    }[reason] || '📊';

    const message = `
${emoji} *OPTIONS POSITION CLOSED* ${reasonEmoji}

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

    const message = `
🤖 *OPTIONS BOT STARTED*

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
 * Alert: High IV Rank Opportunity
 */
async function alertHighIVRank(userId, symbol, ivRank, strategy) {
    const chatId = await getUserTelegramChatId(userId);
    if (!chatId) return;

    const message = `
🔥 *HIGH IV OPPORTUNITY*

Symbol: *${symbol}*
IV Rank: ${ivRank.toFixed(1)}%

${ivRank > 70 ? '💰 Great for selling premium (credit spreads)' : '⚡ Good for scalping/long options'}

Recommended: ${strategy}
`;

    await sendTelegramMessage(chatId, message);
}

module.exports = {
    sendTelegramMessage,
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
    // Options-specific alerts
    alertOptionsTradeExecuted,
    alertCreditSpreadExecuted,
    alertOptionsPositionClosed,
    alertOptionsBotStarted,
    alertHighIVRank
};
