/**
 * News-Triggered Intraday Rescan Service
 *
 * Every 5 minutes during market hours:
 *   1. Load today's STRONG BUY + BUY signal symbols
 *   2. Check news_alerts for HIGH/Critical impact news in the last 90 minutes
 *      that targets any of those symbols
 *   3. Skip symbols already rescanned in the last 2 hours
 *   4. For each newly impacted symbol, call rescanSymbol() to refresh its AI score
 *   5. If the recommendation changes, Telegram-alert all AI-enabled users
 *
 * This keeps the signals page accurate when breaking news hits a signal stock
 * mid-session (earnings surprise, regulatory action, analyst downgrade, etc.).
 */

const cron                  = require('node-cron');
const { query }             = require('../config/database');
const { rescanSymbol }      = require('./nightlyUniverseScanService');
const { logger }            = require('../utils/logger');
// Was a local weekday+time-only reimplementation — never checked NYSE holidays.
// See utils/marketCalendar.js (found 2026-09-06, the eve of Labor Day 2026-09-07).
const { isMarketOpen }      = require('../utils/marketCalendar');

const CRON_TZ = { timezone: 'America/New_York' };
let job = null;

function todayET() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function sendTelegramAlert(message) {
    try {
        const users = await query(
            `SELECT telegram_chat_id FROM users
             WHERE ai_trading_enabled = true AND telegram_chat_id IS NOT NULL AND is_active = true`
        );
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) return;
        for (const u of users.rows) {
            await fetch(
                `https://api.telegram.org/bot${token}/sendMessage`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: u.telegram_chat_id, text: message, parse_mode: 'HTML' })
                }
            ).catch(() => {});
        }
    } catch (err) {
        logger.warn('[NewsRescan] Telegram send failed', { error: err.message });
    }
}

async function runNewsRescan() {
    if (!isMarketOpen()) return;

    const today = todayET();

    try {
        // 1. Today's signal symbols
        const sigRes = await query(
            `SELECT symbol FROM daily_universe_analysis
             WHERE analysis_date = $1 AND recommendation IN ('STRONG BUY', 'BUY')`,
            [today]
        );
        if (!sigRes.rows.length) return;

        const signalSymbols = sigRes.rows.map(r => r.symbol);

        // 2. HIGH/Critical news in the last 90 min for those symbols,
        //    excluding symbols already rescanned in the last 2 hours
        const newsRes = await query(
            `SELECT DISTINCT ON (na.symbol)
                    na.symbol, na.title, na.impact, na.published_at
             FROM news_alerts na
             WHERE na.impact IN ('High', 'Critical')
               AND na.published_at >= NOW() - INTERVAL '90 minutes'
               AND na.symbol = ANY($1::text[])
               AND NOT EXISTS (
                   SELECT 1 FROM daily_universe_analysis dua
                   WHERE dua.symbol       = na.symbol
                     AND dua.analysis_date = $2::date
                     AND (dua.metadata->>'rescanAt')::timestamptz >= NOW() - INTERVAL '2 hours'
               )
             ORDER BY na.symbol, na.published_at DESC`,
            [signalSymbols, today]
        );

        if (!newsRes.rows.length) return;

        logger.info('[NewsRescan] Rescanning symbols impacted by breaking news', {
            count: newsRes.rows.length,
            symbols: newsRes.rows.map(r => r.symbol)
        });

        for (const row of newsRes.rows) {
            const { symbol, title, impact } = row;
            const shortReason = `${impact} impact: ${title.slice(0, 80)}`;

            logger.info('[NewsRescan] Triggering rescan', { symbol, reason: shortReason });

            const result = await rescanSymbol(symbol, shortReason);

            if (result.error) {
                logger.warn('[NewsRescan] Rescan failed', { symbol, error: result.error });
                continue;
            }

            logger.info('[NewsRescan] Rescan complete', {
                symbol,
                changed: result.changed,
                prevRec: result.prevRec,
                newRec:  result.newRec,
                newScore: result.newScore
            });

            // 3. Alert if recommendation changed
            if (result.changed) {
                const arrow  = _downgrade(result.prevRec, result.newRec) ? 'DOWNGRADE' : 'UPGRADE';
                const emoji  = arrow === 'DOWNGRADE' ? '⚠️' : '🚀';
                const msg    =
                    `${emoji} <b>Signal ${arrow}: ${symbol}</b>\n` +
                    `${result.prevRec} → <b>${result.newRec}</b> (score: ${result.newScore?.toFixed(0) ?? '?'})\n` +
                    `<i>Triggered by: ${shortReason}</i>\n` +
                    `<a href="http://99.47.183.33:3000/signals">View Signals</a>`;

                await sendTelegramAlert(msg);
                logger.info('[NewsRescan] Telegram alert sent', { symbol, arrow });
            }
        }
    } catch (err) {
        logger.error('[NewsRescan] Unexpected error', { error: err.message });
    }
}

function _downgrade(prev, next) {
    const rank = { 'STRONG BUY': 3, 'BUY': 2, 'HOLD': 1, 'AVOID': 0, 'WATCHLIST': 1 };
    return (rank[next] ?? 1) < (rank[prev] ?? 1);
}

function startNewsRescanService() {
    if (job) return;
    // Every 5 minutes during market hours (Mon–Fri)
    job = cron.schedule('*/5 9-16 * * 1-5', async () => {
        try { await runNewsRescan(); }
        catch (err) { logger.error('[NewsRescan] Cron error', { error: err.message }); }
    }, CRON_TZ);

    logger.info('[NewsRescan] Service started — watching signal stocks every 5 min during market hours');
}

function stopNewsRescanService() {
    if (job) { job.stop(); job = null; }
}

module.exports = { startNewsRescanService, stopNewsRescanService, runNewsRescan };
