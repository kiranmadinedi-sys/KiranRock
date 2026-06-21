/**
 * Market Monitor Service
 *
 * Runs inside the worker during market hours and sends Telegram alerts for:
 *   - Market open  (9:30 AM ET) — "Bot is live, ready to trade"
 *   - Bot stall    — no AI cycle in 15+ minutes during market hours
 *   - Error spike  — 10+ critical errors in a 10-minute window
 *   - 429 storm    — Yahoo/Polygon rate-limit errors detected
 *   - Market close (4:05 PM ET) — daily summary: trades, P/L, any issues
 *
 * All alerts go to every AI-enabled user's Telegram.
 * State is kept in memory only — resets on worker restart.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs     = require('fs');
const path   = require('path');
const { logger } = require('../utils/logger');
const { query }  = require('../config/database');

const LOG_DIR   = path.join(__dirname, '../../logs');
const CHECK_MS  = 10 * 60 * 1000;   // check every 10 minutes

// In-memory state — resets on restart (intentional: clean slate each day)
let _interval          = null;
let _marketOpenAlerted = false;   // sent "market open" message today
let _marketCloseAlerted= false;   // sent "market close" summary today
let _lastOpenDate      = null;    // date string to reset flags at midnight
let _botStallAlerted   = false;   // suppress repeated stall alerts
let _errorSpikeAlerted = false;   // suppress repeated error-spike alerts

// ─── Time helpers ─────────────────────────────────────────────────────────────

function etNow() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function isWeekday(d) { return d.getDay() >= 1 && d.getDay() <= 5; }

function marketState() {
    const d    = etNow();
    const mins = d.getHours() * 60 + d.getMinutes();
    const day  = isWeekday(d);
    return {
        isPreOpen:   day && mins >= 9 * 60 + 25 && mins < 9 * 60 + 30,
        isOpen:      day && mins >= 9 * 60 + 30 && mins < 16 * 60,
        isJustClosed:day && mins >= 16 * 60      && mins < 16 * 60 + 10,
        dateStr:     d.toISOString().slice(0, 10)
    };
}

// ─── Telegram helpers ─────────────────────────────────────────────────────────

async function getActiveUsers() {
    const res = await query(`SELECT id, username FROM users WHERE ai_trading_enabled = true`);
    return res.rows;
}

async function alertAll(message) {
    const alertSvc = require('./telegramAlertService');
    const users    = await getActiveUsers();
    for (const u of users) {
        try { await alertSvc.sendMessage(u.id, message); } catch { /* never break on alert failure */ }
    }
}

// ─── Check: bot activity ──────────────────────────────────────────────────────

async function checkBotActivity() {
    const users = await getActiveUsers();
    const stalled = [];
    for (const u of users) {
        const res = await query(
            `SELECT MAX(timestamp) AS last_run FROM ai_trading_logs WHERE user_id = $1`,
            [u.id]
        );
        const lastRun = res.rows[0]?.last_run ? new Date(res.rows[0].last_run) : null;
        const ageMin  = lastRun ? (Date.now() - lastRun.getTime()) / 60000 : 999;
        if (ageMin > 15) {
            stalled.push({ username: u.username, ageMin: Math.round(ageMin) });
        }
    }
    return stalled;
}

// ─── Check: error log ─────────────────────────────────────────────────────────

function readLastLines(filePath, maxBytes = 32768) {
    try {
        if (!fs.existsSync(filePath)) return '';
        const stat = fs.statSync(filePath);
        const start = Math.max(0, stat.size - maxBytes);
        const buf   = Buffer.alloc(Math.min(maxBytes, stat.size));
        const fd    = fs.openSync(filePath, 'r');
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        return buf.toString('utf8');
    } catch { return ''; }
}

function analyseErrorLog() {
    const today   = etNow().toISOString().slice(0, 10);
    const logFile = path.join(LOG_DIR, `error-${today}.log`);
    const content = readLastLines(logFile, 65536);
    if (!content) return { errorCount: 0, has429: false, hasCritical: false };

    const tenMinAgo  = new Date(Date.now() - 10 * 60 * 1000).toISOString().slice(0, 19);
    const lines      = content.split('\n').filter(Boolean);
    const recentLines = lines.filter(l => {
        try {
            const ts = JSON.parse(l)?.timestamp || '';
            return ts >= tenMinAgo;
        } catch { return false; }
    });

    const has429      = recentLines.some(l => l.includes('429') || l.toLowerCase().includes('too many requests'));
    const hasCritical = recentLines.some(l => {
        const lc = l.toLowerCase();
        return lc.includes('"level":"error"') && (
            lc.includes('uncaught') || lc.includes('fatal') || lc.includes('crash') || lc.includes('econnrefused')
        );
    });

    return { errorCount: recentLines.length, has429, hasCritical };
}

// ─── Daily summary ────────────────────────────────────────────────────────────

/**
 * Compute realized P/L for a sell.
 * Priority: (1) intraday buy of same symbol, (2) most recent prior-day buy.
 * Returns null if no cost basis is found.
 */
async function _realizedPnl(userId, sell, todayBuys, today) {
    const sellTotal = parseFloat(sell.total || 0);
    const qty       = parseFloat(sell.quantity || 1);

    // Intraday round-trip
    const intradayBuy = todayBuys.find(b => b.symbol === sell.symbol);
    if (intradayBuy) {
        return sellTotal - parseFloat(intradayBuy.total || 0);
    }

    // Prior-day cost basis — use most recent BUY for that symbol
    const res = await query(
        `SELECT price FROM trades
         WHERE user_id = $1 AND symbol = $2 AND action = 'BUY'
           AND trade_date::date < $3::date
         ORDER BY trade_date DESC LIMIT 1`,
        [userId, sell.symbol, today]
    );
    if (res.rows.length > 0) {
        const costBasis = parseFloat(res.rows[0].price) * qty;
        return sellTotal - costBasis;
    }

    return null;   // no cost basis available — don't show a misleading number
}

async function buildDailySummary() {
    const today   = etNow().toISOString().slice(0, 10);
    const users   = await getActiveUsers();
    const lines   = [`📊 *Market Close Summary — ${today}*`, ''];

    for (const u of users) {
        const trades = await query(
            `SELECT action, symbol, quantity, price, total
             FROM trades
             WHERE user_id = $1 AND trade_date::date = $2::date
             ORDER BY trade_date`,
            [u.id, today]
        );
        const buys  = trades.rows.filter(t => t.action === 'BUY');
        const sells = trades.rows.filter(t => t.action === 'SELL');

        lines.push(`👤 *${u.username}*`);

        if (buys.length === 0 && sells.length === 0) {
            lines.push('  No trades today');
        } else {
            // Buys = capital deployed into new positions — NOT a loss
            if (buys.length) {
                const deployed = buys.reduce((s, t) => s + parseFloat(t.total || 0), 0);
                lines.push(
                    `  🟢 Opened: ${buys.map(t => `${t.symbol}×${t.quantity}`).join(', ')}` +
                    ` (deployed $${deployed.toFixed(0)})`
                );
            }

            // Sells = compute realized P/L vs actual cost basis
            if (sells.length) {
                let totalRealized = 0;
                let missingBasis  = 0;
                const sellParts   = [];

                for (const sell of sells) {
                    const pnl = await _realizedPnl(u.id, sell, buys, today);
                    if (pnl !== null) {
                        totalRealized += pnl;
                        sellParts.push(`${sell.symbol}×${sell.quantity} (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`);
                    } else {
                        missingBasis++;
                        sellParts.push(`${sell.symbol}×${sell.quantity}`);
                    }
                }

                lines.push(`  🔴 Closed: ${sellParts.join(', ')}`);

                if (missingBasis < sells.length) {
                    // At least one sell has a known cost basis
                    const sign = totalRealized >= 0 ? '+' : '';
                    lines.push(`  💰 Realized P/L: ${sign}$${totalRealized.toFixed(2)}`);
                }
            }
        }
        lines.push('');
    }

    return lines.join('\n');
}

// ─── Main monitor cycle ───────────────────────────────────────────────────────

async function runMonitorCycle() {
    try {
        const { isPreOpen, isOpen, isJustClosed, dateStr } = marketState();

        // Reset daily flags when date rolls over
        if (_lastOpenDate && _lastOpenDate !== dateStr) {
            _marketOpenAlerted  = false;
            _marketCloseAlerted = false;
            _botStallAlerted    = false;
            _errorSpikeAlerted  = false;
        }
        _lastOpenDate = dateStr;

        // ── Pre-open warm-up message ─────────────────────────────────────────
        if (isPreOpen && !_marketOpenAlerted) {
            _marketOpenAlerted = true;
            await alertAll(
                `🔔 *Market Opening in 5 minutes*\n\nBot is live on Alpaca.\nRisk: max $150/order · $25 daily loss limit · 5 positions max.\nStop-loss trailing service active ✅\n\n_Good trading day!_`
            );
            logger.info('[MarketMonitor] Sent market open alert');
        }

        // ── Intraday checks ──────────────────────────────────────────────────
        if (isOpen) {
            // Bot stall check
            if (!_botStallAlerted) {
                const stalled = await checkBotActivity();
                if (stalled.length) {
                    _botStallAlerted = true;
                    const detail = stalled.map(s => `${s.username}: last cycle ${s.ageMin} min ago`).join('\n');
                    await alertAll(
                        `⚠️ *Bot Stall Detected*\n\nNo AI trading cycle in 15+ minutes during market hours.\n\n${detail}\n\n_Check the worker process — it may need a restart._`
                    );
                    logger.warn('[MarketMonitor] Bot stall alert sent', { stalled });
                } else {
                    _botStallAlerted = false; // reset so next check can re-alert if stall resumes
                }
            }

            // Error spike / 429 check
            const { errorCount, has429, hasCritical } = analyseErrorLog();
            if (!_errorSpikeAlerted && (errorCount >= 10 || has429 || hasCritical)) {
                _errorSpikeAlerted = true;
                const issues = [];
                if (hasCritical) issues.push('🔴 Critical errors detected');
                if (has429)      issues.push('🟡 Rate-limit (429) errors — data may be delayed');
                if (errorCount >= 10) issues.push(`🟠 ${errorCount} errors in last 10 min`);
                await alertAll(
                    `⚠️ *Application Error Alert*\n\n${issues.join('\n')}\n\n_Trading continues but data accuracy may be affected. Check backend logs._`
                );
                logger.warn('[MarketMonitor] Error spike alert sent', { errorCount, has429, hasCritical });
            }
            // Reset spike flag when errors clear
            if (_errorSpikeAlerted && errorCount < 5 && !has429 && !hasCritical) {
                _errorSpikeAlerted = false;
            }
        }

        // ── Market close summary ─────────────────────────────────────────────
        if (isJustClosed && !_marketCloseAlerted) {
            _marketCloseAlerted = true;
            const summary = await buildDailySummary();
            await alertAll(summary);
            logger.info('[MarketMonitor] Sent market close summary');
        }

    } catch (err) {
        logger.error('[MarketMonitor] Cycle error', { err: err.message });
    }
}

// ─── Start / stop ─────────────────────────────────────────────────────────────

function startMarketMonitor() {
    if (_interval) return;
    logger.info('[MarketMonitor] Started — checking every 10 min');
    setTimeout(runMonitorCycle, 10_000); // first check 10 s after startup
    _interval = setInterval(runMonitorCycle, CHECK_MS);
}

function stopMarketMonitor() {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
        logger.info('[MarketMonitor] Stopped');
    }
}

module.exports = { startMarketMonitor, stopMarketMonitor };
