/**
 * WhatsApp Alert Service — Twilio Sandbox
 *
 * Fires in parallel with Telegram. All failures are swallowed so the existing
 * Telegram flow is never affected. Enable by setting NOTIFY_WHATSAPP=true in .env.
 *
 * Per-user by design (2026-07-17): every alert function takes userId and looks up
 * THAT user's own phone number from users.phone — never a shared/global recipient.
 * Previously every call site silently sent to one hardcoded TWILIO_WHATSAPP_TO number
 * regardless of which user the trade belonged to, which would have mixed different
 * users' trade activity into one inbox the moment more than one account traded for
 * real. A user with no phone registered is skipped entirely, not redirected to
 * someone else's number. The one exception is alertMorningBriefing, which is
 * genuinely global content (the overnight scan's top tickers, same for everyone) and
 * intentionally still uses the single configured broadcast number.
 */

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN  || '';
const FROM         = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
const BROADCAST_TO = process.env.TWILIO_WHATSAPP_TO   || '';
const ENABLED      = process.env.NOTIFY_WHATSAPP === 'true';

let _client = null;

function getClient() {
    if (!_client) {
        const twilio = require('twilio');
        _client = twilio(ACCOUNT_SID, AUTH_TOKEN);
    }
    return _client;
}

async function getUserPhone(userId) {
    const { query } = require('../config/database');
    try {
        const result = await query('SELECT phone FROM users WHERE id = $1', [userId]);
        return result.rows[0]?.phone || null;
    } catch (error) {
        return null;
    }
}

/** US-only assumption matches how this platform's existing phone numbers are stored
 *  (10 digits, no country code) — same convention the old hardcoded TO value used. */
function toWhatsAppAddress(rawPhone) {
    if (!rawPhone) return null;
    const digits = String(rawPhone).replace(/[^\d+]/g, '');
    if (digits.startsWith('+')) return `whatsapp:${digits}`;
    if (digits.length === 10) return `whatsapp:+1${digits}`;
    return `whatsapp:+${digits}`;
}

function cleanBody(text) {
    return text
        .replace(/\*([^*]+)\*/g, '$1')   // strip *bold*
        .replace(/_([^_]+)_/g,   '$1')   // strip _italic_
        .replace(/`([^`]+)`/g,   '$1')   // strip `code`
        .replace(/━+/g, '─────────────') // shorten dividers
        .trim();
}

async function sendRaw(to, text) {
    if (!ENABLED || !ACCOUNT_SID || !AUTH_TOKEN || !to) return;
    try {
        await getClient().messages.create({ from: FROM, to, body: cleanBody(text) });
    } catch (err) {
        // Swallow — never disrupt Telegram or the bot cycle
        console.warn('[WhatsApp] Send failed:', err.message);
    }
}

/** Sends only to this specific user's own registered phone. No fallback recipient —
 *  a user with no phone on file simply doesn't get a WhatsApp message. */
async function send(userId, text) {
    const phone = await getUserPhone(userId);
    if (!phone) return;
    await sendRaw(toWhatsAppAddress(phone), text);
}

/** Genuinely global/non-user-specific content only — see file header. */
async function sendBroadcast(text) {
    await sendRaw(BROADCAST_TO, text);
}

// ─── ALERT FUNCTIONS (all per-user) ────────────────────────────────────────────

async function alertTradeExecuted(userId, action, symbol, shares, price, aiScore, reasoning) {
    const emoji  = action === 'BUY' ? '✅' : '📤';
    const total  = (shares * price).toFixed(2);
    const reason = reasoning ? `\n${reasoning.split('\n')[0]}` : '';
    await send(userId,
        `${emoji} TRADE EXECUTED\n` +
        `${action} ${shares} shares of ${symbol}\n` +
        `Price: $${price.toFixed(2)} | Total: $${total}\n` +
        `Score: ${aiScore || '—'}/100${reason}`
    );
}

async function alertStopLossTriggered(userId, symbol, shares, sellPrice, loss) {
    await send(userId,
        `🛑 STOP LOSS — ${symbol}\n` +
        `Sold ${shares} shares @ $${sellPrice.toFixed(2)}\n` +
        `Loss: $${Math.abs(loss).toFixed(2)} (${((loss / (sellPrice * shares)) * 100).toFixed(1)}%)`
    );
}

async function alertTakeProfitExecuted(userId, symbol, shares, sellPrice, profit, percentGain) {
    await send(userId,
        `🎯 TAKE PROFIT — ${symbol}\n` +
        `Sold ${shares} shares @ $${sellPrice.toFixed(2)}\n` +
        `Profit: +$${profit.toFixed(2)} (+${percentGain.toFixed(2)}%) 🎉`
    );
}

async function alertLargeLoss(userId, symbol, percentLoss, currentPrice, purchasePrice) {
    await send(userId,
        `🚨 LARGE LOSS — ${symbol}\n` +
        `Down ${Math.abs(percentLoss).toFixed(2)}%\n` +
        `Current: $${currentPrice.toFixed(2)} | Entry: $${purchasePrice.toFixed(2)}`
    );
}

async function alertDailyLossLimitReached(userId, dailyLoss) {
    await send(userId,
        `🔴 DAILY LOSS LIMIT REACHED\n` +
        `Loss today: $${Math.abs(dailyLoss).toFixed(2)}\n` +
        `AI trading stopped for the day. Resumes tomorrow.`
    );
}

async function alertTradingStarted(userId, balance, openPositions) {
    await send(userId,
        `🤖 AI Bot Active\n` +
        `Balance: $${balance.toFixed(2)} | Open: ${openPositions} position(s)`
    );
}

async function alertOptionsSignalEntry(userId, details) {
    const { symbol, stockPrice, momentum, score, regime, optionType,
            strike, expiration, dte, price, contracts, totalCost,
            delta, ivRankLabel } = details;
    const isBullish  = (optionType || '').toUpperCase() === 'CALL';
    const emoji      = isBullish ? '🟢' : '🔴';
    const direction  = isBullish ? 'BULLISH CALL' : 'BEARISH PUT';
    const momentumSign = momentum >= 0 ? '+' : '';
    await send(userId,
        `${emoji} ${direction} — ${symbol}\n` +
        `Stock: $${Number(stockPrice).toFixed(2)} (${momentumSign}${momentum.toFixed(1)}%)\n` +
        `Score: ${Number(score).toFixed(0)}/100 | Regime: ${regime}\n` +
        `${optionType.toUpperCase()} $${Number(strike).toFixed(0)} exp ${expiration} (${dte} DTE)\n` +
        `$${Number(price).toFixed(2)}/contract × ${contracts} = $${Number(totalCost).toFixed(2)}\n` +
        `Delta: ${Number(delta).toFixed(2)} | IV: ${ivRankLabel}`
    );
}

async function alertOptionsPositionClosed(userId, symbol, strike, contracts, entryPrice, exitPrice, pnl, pnlPercent, reason) {
    const emoji = pnl > 0 ? '✅' : '❌';
    const reasonLabels = {
        TAKE_PROFIT: '🎯 Take Profit',
        STOP_LOSS:   '🛑 Stop Loss',
        EXPIRATION_APPROACHING: '⏰ Expiration',
        HIGH_THETA_DECAY: '⏳ Theta Decay'
    };
    await send(userId,
        `${emoji} OPTIONS CLOSED — ${symbol} $${strike}\n` +
        `${contracts} contracts | Entry: $${entryPrice.toFixed(2)} → Exit: $${exitPrice.toFixed(2)}\n` +
        `P&L: $${pnl.toFixed(2)} (${pnlPercent.toFixed(1)}%)\n` +
        `Reason: ${reasonLabels[reason] || reason}`
    );
}

/** Global broadcast — same overnight-scan content for every user, not per-account. */
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
    await sendBroadcast(lines.join('\n'));
}

async function sendMessage(userId, text) {
    await send(userId, text);
}

module.exports = {
    send,
    sendBroadcast,
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
