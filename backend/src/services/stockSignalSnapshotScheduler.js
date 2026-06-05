const stockSignalSnapshotService = require('./stockSignalSnapshotService');

const MARKET_INTERVAL_MS = Math.max(5 * 60 * 1000, Number.parseInt(process.env.STOCK_SIGNAL_SNAPSHOT_MARKET_INTERVAL_MS || `${10 * 60 * 1000}`, 10) || (10 * 60 * 1000));
const OFF_HOURS_INTERVAL_MS = Math.max(15 * 60 * 1000, Number.parseInt(process.env.STOCK_SIGNAL_SNAPSHOT_OFF_HOURS_INTERVAL_MS || `${60 * 60 * 1000}`, 10) || (60 * 60 * 1000));

let schedulerTimer = null;
let schedulerActive = false;
let runInProgress = false;
let lastRunStartedAt = null;
let lastRunFinishedAt = null;
let lastRunSummary = null;

function isMarketHours() {
    const now = new Date();
    const marketTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = marketTime.getDay();
    const minutes = marketTime.getHours() * 60 + marketTime.getMinutes();

    if (day === 0 || day === 6) {
        return false;
    }

    return minutes >= (9 * 60 + 30) && minutes <= (16 * 60);
}

function getNextIntervalMs() {
    return isMarketHours() ? MARKET_INTERVAL_MS : OFF_HOURS_INTERVAL_MS;
}

async function runSnapshotCycle(options = {}) {
    if (runInProgress) {
        return { skipped: true, reason: 'already-running' };
    }

    runInProgress = true;
    lastRunStartedAt = new Date().toISOString();

    try {
        const users = await stockSignalSnapshotService.getActiveSnapshotUsers();
        const results = [];

        for (const user of users) {
            const result = await stockSignalSnapshotService.refreshUserSwingSnapshots(user.id, {
                force: Boolean(options.force)
            });
            results.push({ username: user.username, ...result });
        }

        lastRunFinishedAt = new Date().toISOString();
        lastRunSummary = {
            usersProcessed: users.length,
            results,
            manual: Boolean(options.manual)
        };

        return {
            skipped: false,
            usersProcessed: users.length,
            results
        };
    } catch (error) {
        lastRunFinishedAt = new Date().toISOString();
        lastRunSummary = { error: error.message, manual: Boolean(options.manual) };
        throw error;
    } finally {
        runInProgress = false;
    }
}

function scheduleNextRun() {
    if (!schedulerActive) {
        return;
    }

    schedulerTimer = setTimeout(async () => {
        try {
            await runSnapshotCycle();
        } catch (error) {
            console.error('[Stock Signal Snapshot Scheduler] Cycle failed:', error.message);
        } finally {
            scheduleNextRun();
        }
    }, getNextIntervalMs());

    if (typeof schedulerTimer.unref === 'function') {
        schedulerTimer.unref();
    }
}

function startStockSignalSnapshotScheduler() {
    if (schedulerActive) {
        return;
    }

    schedulerActive = true;
    runSnapshotCycle({ force: true }).catch((error) => {
        console.error('[Stock Signal Snapshot Scheduler] Initial cycle failed:', error.message);
    }).finally(() => {
        scheduleNextRun();
    });
}

function stopStockSignalSnapshotScheduler() {
    schedulerActive = false;
    if (schedulerTimer) {
        clearTimeout(schedulerTimer);
        schedulerTimer = null;
    }
}

function getSchedulerStatus() {
    return {
        active: schedulerActive,
        inProgress: runInProgress,
        marketIntervalMs: MARKET_INTERVAL_MS,
        offHoursIntervalMs: OFF_HOURS_INTERVAL_MS,
        runningMode: isMarketHours() ? 'market-hours' : 'off-hours',
        lastRunStartedAt,
        lastRunFinishedAt,
        lastRunSummary
    };
}

module.exports = {
    getSchedulerStatus,
    runSnapshotCycle,
    startStockSignalSnapshotScheduler,
    stopStockSignalSnapshotScheduler
};