require('./bootstrapRuntime');

const os = require('os');
const enhancedAIScheduler  = require('./services/enhancedAIScheduler');
const istPipeline          = require('./services/istPipelineScheduler');
const redisState           = require('./services/redisStateService');
const optionsScheduler = require('./services/optionsScheduler');
const optionsBotScheduler = require('./services/optionsBotScheduler');
const newsMonitoringService = require('./services/newsMonitoringService');
const stockSignalSnapshotScheduler = require('./services/stockSignalSnapshotScheduler');
const stockSignalTelegramScheduler = require('./services/stockSignalTelegramScheduler');
const assetUniverseScheduler       = require('./services/assetUniverseScheduler');
const newsRescanService            = require('./services/newsRescanService');
const {
    acquireLeadership,
    releaseLeadership,
    updateLeadershipStatus
} = require('./services/workerCoordinationService');
const { pool } = require('./config/database');

const WORKER_NAME = process.env.WORKER_NAME || 'primary-worker';
const WORKER_SERVICES = ['enhanced-ai', 'options-scanner', 'options-bot', 'news-monitor', 'telegram-reports', 'stock-signal-snapshots', 'stock-signal-telegram', 'asset-universe', 'news-rescan'];
const workerInstanceId = `${os.hostname()}-${process.pid}-${Date.now()}`;
let shuttingDown = false;

function getWorkerMetadata(overrides = {}) {
    return {
        hostname: os.hostname(),
        pid: process.pid,
        services: WORKER_SERVICES,
        ...overrides
    };
}

async function shutdownWorker(signal, options = {}) {
    const exit = options.exit || process.exit;

    if (shuttingDown) {
        return { skipped: true, reason: 'already-shutting-down' };
    }

    shuttingDown = true;
    console.log(`[Worker] Shutdown requested${signal ? ` (${signal})` : ''}`);

    try {
        await updateLeadershipStatus('stopping', {
            ...getWorkerMetadata(),
            signal: signal || null
        });
    } catch (error) {
        console.error('[Worker] Failed to update stopping status:', error.message);
    }

    try {
        enhancedAIScheduler.stopScheduler();
        istPipeline.stopISTPipelineScheduler();
        await redisState.disconnect();
        optionsScheduler.stopOptionsScheduler();
        optionsBotScheduler.stopOptionsScheduler();
        newsMonitoringService.stopNewsMonitoring();
        stockSignalSnapshotScheduler.stopStockSignalSnapshotScheduler();
        stockSignalTelegramScheduler.stopStockSignalScheduler();
        assetUniverseScheduler.stopAssetUniverseScheduler();
        newsRescanService.stopNewsRescanService();
    } catch (error) {
        console.error('[Worker] Error while stopping services:', error.message);
    }

    await releaseLeadership('stopped', {
        ...getWorkerMetadata(),
        signal: signal || null
    });

    try {
        await pool.end();
    } catch (error) {
        console.error('[Worker] Failed to close database pool:', error.message);
    }

    exit(0);
    return { skipped: false, signal: signal || null };
}

async function startWorker(options = {}) {
    const exit = options.exit || process.exit;
    const loadTelegramSchedules = options.loadTelegramSchedules || (() => require('./scheduleTelegramReport'));

    console.log('Worker process starting...');

    const leadership = await acquireLeadership({
        workerName: WORKER_NAME,
        instanceId: workerInstanceId,
        metadata: getWorkerMetadata()
    });

    if (!leadership.acquired) {
        console.warn(`[Worker] Leadership already held for ${WORKER_NAME}. Exiting secondary worker.`);
        await pool.end();
        exit(0);
        return { started: false, reason: 'leadership-not-acquired' };
    }

    console.log(`[Worker] Leadership acquired for ${WORKER_NAME} (${workerInstanceId})`);

    console.log('\n🤖 Starting Enhanced AI Trading Bot...');
    enhancedAIScheduler.startScheduler();

    console.log('\n🕕 Starting IST Pre-Market Pipeline Scheduler...');
    istPipeline.startISTPipelineScheduler();

    console.log('\n📈 Starting Options Scanner...');
    optionsScheduler.startOptionsScheduler();

    console.log('\n⚡ Starting Autonomous Options Trading Bot...');
    optionsBotScheduler.startOptionsScheduler();

    // Seed with blue-chips; watchlist auto-expands to HERMES top stocks + user holdings every 30 min
    const seedSymbols = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'V', 'UNH'];
    newsMonitoringService.startNewsMonitoring(seedSymbols);

    console.log('\n🧠 Starting 24/7 Stock Signal Snapshot Scheduler...');
    stockSignalSnapshotScheduler.startStockSignalSnapshotScheduler();

    console.log('\n📣 Starting 24/7 Stock Signal Telegram Scheduler...');
    stockSignalTelegramScheduler.startStockSignalScheduler();

    console.log('\n🌐 Starting Asset Universe Scheduler (evening + premarket + intraday)...');
    assetUniverseScheduler.startAssetUniverseScheduler();

    console.log('\n📰 Starting News-Triggered Signal Rescan Service...');
    newsRescanService.startNewsRescanService();

    // Load Telegram schedules only after leadership is acquired.
    loadTelegramSchedules();

    await updateLeadershipStatus('running', getWorkerMetadata());

    console.log('\n✅ Worker services started');
    return { started: true, leadership };
}

function registerWorkerProcessHandlers(options = {}) {
    const exit = options.exit || process.exit;

    process.on('SIGINT', () => {
        shutdownWorker('SIGINT', { exit }).catch((error) => {
            console.error('[Worker] Shutdown failed:', error);
            exit(1);
        });
    });

    process.on('SIGTERM', () => {
        shutdownWorker('SIGTERM', { exit }).catch((error) => {
            console.error('[Worker] Shutdown failed:', error);
            exit(1);
        });
    });

    process.on('uncaughtException', (error) => {
        console.error('[Worker] Uncaught exception:', error);
        shutdownWorker('uncaughtException', { exit }).catch(() => exit(1));
    });

    process.on('unhandledRejection', (reason) => {
        console.error('[Worker] Unhandled rejection:', reason);
        shutdownWorker('unhandledRejection', { exit }).catch(() => exit(1));
    });
}

async function bootWorker(options = {}) {
    const exit = options.exit || process.exit;

    registerWorkerProcessHandlers({ exit });

    try {
        return await startWorker(options);
    } catch (error) {
        console.error('[Worker] Failed to start:', error);
        await releaseLeadership('failed', {
            ...getWorkerMetadata(),
            error: error.message
        });
        try {
            await pool.end();
        } catch (_) {
            // ignore shutdown errors on startup failure
        }
        exit(1);
        return { started: false, reason: 'startup-failed', error };
    }
}

function resetWorkerStateForTests() {
    shuttingDown = false;
}

if (require.main === module) {
    bootWorker();
}

module.exports = {
    bootWorker,
    getWorkerMetadata,
    registerWorkerProcessHandlers,
    resetWorkerStateForTests,
    shutdownWorker,
    startWorker
};