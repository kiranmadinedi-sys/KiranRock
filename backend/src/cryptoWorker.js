/**
 * Crypto Trading — Standalone Worker Process
 *
 * Runs the crypto scheduler in its own PM2 process, separate from
 * kiranrock-worker (which owns every other scheduler: swing, Blitz, options,
 * news, EOD ingestion, etc). Deliberately lean — doesn't import worker.js or
 * any of its other schedulers, doesn't do leader-election/coordination (that
 * machinery exists to stop *multiple copies of the same scheduler* racing
 * each other; a single dedicated process for one scheduler doesn't need it).
 *
 * Why a separate process at all, given it costs zero API calls with nobody
 * enrolled: keeps a 24/7/weekend-active scheduler's memory/event-loop
 * footprint fully isolated from the market-hours-only worker process, so a
 * problem in one can never compete with or destabilize the other. Still
 * fully owned by start.ps1 — same single start/restart control point as
 * kiranrock-backend and kiranrock-worker, just a third named PM2 process.
 */
require('./bootstrapRuntime');

const cryptoScheduler = require('./services/cryptoScheduler');
const { pool } = require('./config/database');
const { logger } = require('./utils/logger');

logger.info('[CryptoWorker] Starting standalone crypto trading process...');
cryptoScheduler.startScheduler();
logger.info('[CryptoWorker] Crypto scheduler running — 5-min cycle, 24/7, opt-in per user');

async function shutdown(signal) {
    logger.info(`[CryptoWorker] Received ${signal}, shutting down...`);
    try {
        cryptoScheduler.stopScheduler();
        await pool.end();
    } catch (err) {
        logger.error('[CryptoWorker] Error during shutdown', { error: err.message });
    }
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
    logger.error('[CryptoWorker] Uncaught exception — process will exit, PM2 will restart it', { error: err.message, stack: err.stack });
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    logger.error('[CryptoWorker] Unhandled rejection', { reason: reason?.message || reason });
});
