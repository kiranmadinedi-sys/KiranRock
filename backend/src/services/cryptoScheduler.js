/**
 * Crypto Trading — Scheduler
 *
 * Modeled on intradayScheduler.js (Blitz), with the two changes that make
 * crypto genuinely different:
 *   - No market-hours gate, no weekday restriction. Crypto trades 24/7/365 —
 *     this is the first scheduler in the app that runs on weekends.
 *   - 5-minute cadence, not 1-minute. See cryptoTradingBot.js's docstring
 *     for why (multi-symbol batching turned out not to work reliably on
 *     this account, so cadence + a small curated universe are what keep
 *     this efficient instead).
 *   - No EOD-flatten job — there's no close to flatten against.
 *
 * Runs entirely independently of enhancedAIScheduler.js (swing) and
 * intradayScheduler.js (Blitz) — this file is never imported by, and never
 * imports, either of those.
 */
const cron = require('node-cron');
const cryptoBot = require('./cryptoTradingBot');
const cryptoDb = require('./cryptoDatabaseService');
const { logger } = require('../utils/logger');

let schedulerActive = false;
let tickJob = null;

async function runTick() {
    let users;
    try {
        users = await cryptoDb.getActiveUsers();
    } catch (err) {
        logger.error('[CryptoBot] Could not load active users', { error: err.message });
        return;
    }
    if (users.length === 0) return; // zero enrolled -> zero API calls, same as Options Bot with nobody opted in

    for (const user of users) {
        try {
            const result = await cryptoBot.runCycleForUser(user);
            // Always log, not just when trades>0 — added 2026-08-28. The only other
            // record of a "found nothing" cycle was a crypto_trading_logs DB row;
            // the PM2 log itself stayed completely silent, so "is it actually
            // running?" could only be answered by querying the DB directly. A
            // 5-min heartbeat is cheap (288 lines/day/user, same order of
            // magnitude as other schedulers' routine ticks) and makes that
            // question answerable at a glance from the log alone.
            logger.info('[CryptoBot] Cycle result', { userId: user.id, ...result });
        } catch (err) {
            logger.error('[CryptoBot] Cycle error for user', { userId: user.id, error: err.message });
        }
        // Brief gap between users — same reasoning as Blitz/options bot, avoids
        // bursting the shared Alpaca throttle across many users at once.
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

function startScheduler() {
    if (schedulerActive) {
        logger.warn('[CryptoBot] Scheduler already running');
        return;
    }

    // Every 5 minutes, every day, no timezone restriction — crypto has no
    // market-hours concept to anchor a cron timezone to either.
    tickJob = cron.schedule('*/5 * * * *', runTick);

    schedulerActive = true;
    logger.info('[CryptoBot] Scheduler started — 5-min cycle, 24/7 (no market-hours gate)');
}

function stopScheduler() {
    if (!schedulerActive) return;
    if (tickJob) { tickJob.stop(); tickJob = null; }
    schedulerActive = false;
    logger.info('[CryptoBot] Scheduler stopped');
}

function getSchedulerStatus() {
    return { active: schedulerActive };
}

async function manualTrigger(userId) {
    const users = await cryptoDb.getActiveUsers();
    const user = users.find(u => u.id === userId);
    if (!user) throw new Error('User not enrolled in crypto trading');
    return cryptoBot.runCycleForUser(user);
}

module.exports = { startScheduler, stopScheduler, getSchedulerStatus, manualTrigger };
