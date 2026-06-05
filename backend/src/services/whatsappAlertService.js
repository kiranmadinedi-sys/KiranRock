/**
 * WhatsApp Alert Service — Twilio Sandbox
 *
 * Fires in parallel with Telegram. All failures are swallowed so the existing
 * Telegram flow is never affected. Enable by setting NOTIFY_WHATSAPP=true in .env.
 */

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || '';
const FROM        = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
const TO          = process.env.TWILIO_WHATSAPP_TO   || '';
const ENABLED     = process.env.NOTIFY_WHATSAPP === 'true';

let _client = null;

function getClient() {
    if (!_client) {
        const twilio = require('twilio');
        _client = twilio(ACCOUNT_SID, AUTH_TOKEN);
    }
    return _client;
}

/**
 * Send a plain-text WhatsApp message.
 * Strips Telegram markdown (*bold* → text, _italic_ → text) for clean rendering.
 */
async function send(text) {
    if (!ENABLED || !ACCOUNT_SID || !AUTH_TOKEN || !TO) return;
    try {
        const body = text
            .replace(/\*([^*]+)\*/g, '$1')   // strip *bold*
            .replace(/_([^_]+)_/g,   '$1')   // strip _italic_
            .replace(/`([^`]+)`/g,   '$1')   // strip `code`
            .replace(/━+/g, '─────────────') // shorten dividers
            .trim();

        await getClient().messages.create({ from: FROM, to: TO, body });
    } catch (err) {
        // Swallow — never disrupt Telegram or the bot cycle
        console.warn('[WhatsApp] Send failed:', err.message);
    }
}

// ─── ALERT FUNCTIONS ─────────────────────────────────────────────────────────

async function alertTradeExecuted(action, symbol, shares, price, aiScore, reasoning) {
    const emoji  = action === 'BUY' ? '✅' : '📤';
    const total  = (shares * price).toFixed(2);
    const reason = reasoning ? `\n${reasoning.split('\n')[0]}` : '';
    await send(
        `${emoji} TRADE EXECUTED\n` +
        `${action} ${shares} shares of ${symbol}\n` +
        `Price: $${price.toFixed(2)} | Total: $${total}\n` +
        `Score: ${aiScore || '—'}/100${reason}`
    );
}

async function alertStopLossTriggered(symbol, shares, sellPrice, loss) {
    await send(
        `🛑 STOP LOSS — ${symbol}\n` +
        `Sold ${shares} shares @ $${sellPrice.toFixed(2)}\n` +
        `Loss: $${Math.abs(loss).toFixed(2)} (${((loss / (sellPrice * shares)) * 100).toFixed(1)}%)`
    );
}

async function alertTakeProfitExecuted(symbol, shares, sellPrice, profit, percentGain) {
    await send(
        `🎯 TAKE PROFIT — ${symbol}\n` +
        `Sold ${shares} shares @ $${sellPrice.toFixed(2)}\n` +
        `Profit: +$${profit.toFixed(2)} (+${percentGain.toFixed(2)}%) 🎉`
    );
}

async function alertLargeLoss(symbol, percentLoss, currentPrice, purchasePrice) {
    await send(
        `🚨 LARGE LOSS — ${symbol}\n` +
        `Down ${Math.abs(percentLoss).toFixed(2)}%\n` +
        `Current: $${currentPrice.toFixed(2)} | Entry: $${purchasePrice.toFixed(2)}`
    );
}

async function alertDailyLossLimitReached(dailyLoss) {
    await send(
        `🔴 DAILY LOSS LIMIT REACHED\n` +
        `Loss today: $${Math.abs(dailyLoss).toFixed(2)}\n` +
        `AI trading stopped for the day. Resumes tomorrow.`
    );
}

async function alertTradingStarted(balance, openPositions) {
    await send(
        `🤖 AI Bot Active\n` +
        `Balance: $${balance.toFixed(2)} | Open: ${openPositions} position(s)`
    );
}

async function alertOptionsSignalEntry(details) {
    const { symbol, stockPrice, momentum, score, regime, optionType,
            strike, expiration, dte, price, contracts, totalCost,
            delta, ivRankLabel } = details;
    const isBullish  = (optionType || '').toUpperCase() === 'CALL';
    const emoji      = isBullish ? '🟢' : '🔴';
    const direction  = isBullish ? 'BULLISH CALL' : 'BEARISH PUT';
    const momentumSign = momentum >= 0 ? '+' : '';
    await send(
        `${emoji} ${direction} — ${symbol}\n` +
        `Stock: $${Number(stockPrice).toFixed(2)} (${momentumSign}${momentum.toFixed(1)}%)\n` +
        `Score: ${Number(score).toFixed(0)}/100 | Regime: ${regime}\n` +
        `${optionType.toUpperCase()} $${Number(strike).toFixed(0)} exp ${expiration} (${dte} DTE)\n` +
        `$${Number(price).toFixed(2)}/contract × ${contracts} = $${Number(totalCost).toFixed(2)}\n` +
        `Delta: ${Number(delta).toFixed(2)} | IV: ${ivRankLabel}`
    );
}

async function alertOptionsPositionClosed(symbol, strike, contracts, entryPrice, exitPrice, pnl, pnlPercent, reason) {
    const emoji = pnl > 0 ? '✅' : '❌';
    const reasonLabels = {
        TAKE_PROFIT: '🎯 Take Profit',
        STOP_LOSS:   '🛑 Stop Loss',
        EXPIRATION_APPROACHING: '⏰ Expiration',
        HIGH_THETA_DECAY: '⏳ Theta Decay'
    };
    await send(
        `${emoji} OPTIONS CLOSED — ${symbol} $${strike}\n` +
        `${contracts} contracts | Entry: $${entryPrice.toFixed(2)} → Exit: $${exitPrice.toFixed(2)}\n` +
        `P&L: $${pnl.toFixed(2)} (${pnlPercent.toFixed(1)}%)\n` +
        `Reason: ${reasonLabels[reason] || reason}`
    );
}

async function alertMorningBriefing(date, tickerCount, topTickers) {
    const lines = [
        `📊 Morning Briefing — ${date}`,
        `🌟 ${tickerCount} STRONG BUY signals from overnight scan`,
        ''
    ];
    if (topTickers && topTickers.length > 0) {
        lines.push('Top picks:');
        topTickers.slice(0, 10).forEach(t => {
            lines.push(`  ${t.symbol} — Score ${t.ai_score} | ${t.sector || 'Unknown'}`);
        });
    }
    lines.push('\nBot goes live at 9:30 AM ET');
    await send(lines.join('\n'));
}

async function sendMessage(text) {
    await send(text);
}

module.exports = {
    send,
    sendMessage,
    alertTradeExecuted,
    alertStopLossTriggered,
    alertTakeProfitExecuted,
    alertLargeLoss,
    alertDailyLossLimitReached,
    alertTradingStarted,
    alertOptionsSignalEntry,
    alertOptionsPositionClosed,
    alertMorningBriefing
};
