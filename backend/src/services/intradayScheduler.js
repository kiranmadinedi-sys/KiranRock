/**
 * Blitz — Intraday Scheduler
 *
 * Modeled directly on optionsBotScheduler.js: own config-table join for
 * enrollment, own market-hours check, sequential per-user loop. Runs
 * entirely independently of enhancedAIScheduler.js (swing) — this file is
 * never imported by, and never imports, swing's scheduler.
 *
 * Cadence: 1 minute during market hours. Not a guess — dataProvider.js's
 * Alpaca quote path already caches for 60 seconds, shared by every caller
 * in the process, so polling faster than that wouldn't yield fresher data,
 * it would just re-hit the same cache.
 */

const cron = require('node-cron');
const intradayBot = require('./intradayTradingBot');
const intradayDb = require('./intradayDatabaseService');
const alertService = require('./telegramAlertService');
const { logger } = require('../utils/logger');
// Was a local weekday+time-only reimplementation — never checked NYSE holidays.
// See utils/marketCalendar.js for why this changed (found 2026-09-06, the eve
// of Labor Day 2026-09-07 — this would have believed the market was open).
const { isMarketOpen } = require('../utils/marketCalendar');

let schedulerActive = false;
let tickJob = null;
let flattenJob = null;

async function runTick() {
    if (!isMarketOpen()) return;

    let users;
    try {
        users = await intradayDb.getActiveUsers();
    } catch (err) {
        logger.error('[Blitz] Could not load active users', { error: err.message });
        return;
    }
    if (users.length === 0) return;

    for (const user of users) {
        try {
            await intradayBot.monitorPositionsForUser(user);
            const result = await intradayBot.scanForUser(user);
            if (result.trades > 0) {
                logger.info('[Blitz] Cycle result', { userId: user.id, ...result });
            }
        } catch (err) {
            logger.error('[Blitz] Cycle error for user', { userId: user.id, error: err.message });
        }
        // Brief gap between users — same reasoning as options bot's own loop,
        // avoids bursting the shared Alpaca throttle across many users at once.
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

async function runForceFlatten() {
    let users;
    try {
        users = await intradayDb.getActiveUsers();
    } catch (err) {
        logger.error('[Blitz] Could not load active users for EOD flatten', { error: err.message });
        return;
    }
    for (const user of users) {
        try {
            await intradayBot.forceFlattenUser(user);
        } catch (err) {
            logger.error('[Blitz] EOD flatten error for user', { userId: user.id, error: err.message });
        }

        // One digest per day, not a message per trade — Blitz's 1-min cadence
        // would otherwise spam far more than swing's own per-trade alerts.
        try {
            const stats = await intradayDb.getTodaySummaryStats(user.id);
            await alertService.alertBlitzDailySummary(user.id, { ...stats, flattened: !!user.force_flat_eod });
        } catch (err) {
            logger.error('[Blitz] Daily summary alert failed for user', { userId: user.id, error: err.message });
        }
    }
}

function startScheduler() {
    if (schedulerActive) {
        logger.warn('[Blitz] Scheduler already running');
        return;
    }

    tickJob = cron.schedule('* * * * 1-5', runTick, { timezone: 'America/New_York' });
    // 15:50 ET — 10 minutes before close, force-flatten anyone with force_flat_eod set.
    flattenJob = cron.schedule('50 15 * * 1-5', runForceFlatten, { timezone: 'America/New_York' });

    schedulerActive = true;
    logger.info('[Blitz] Scheduler started — 1-min cycle during market hours, EOD flatten at 15:50 ET');
}

function stopScheduler() {
    if (!schedulerActive) return;
    if (tickJob) { tickJob.stop(); tickJob = null; }
    if (flattenJob) { flattenJob.stop(); flattenJob = null; }
    schedulerActive = false;
    logger.info('[Blitz] Scheduler stopped');
}

function getSchedulerStatus() {
    return { active: schedulerActive, marketOpen: isMarketOpen() };
}

async function manualTrigger(userId) {
    const users = await intradayDb.getActiveUsers();
    const user = users.find(u => u.id === userId);
    if (!user) throw new Error('User not enrolled in Blitz');
    await intradayBot.monitorPositionsForUser(user);
    return intradayBot.scanForUser(user);
}

module.exports = { startScheduler, stopScheduler, getSchedulerStatus, manualTrigger, isMarketOpen };
