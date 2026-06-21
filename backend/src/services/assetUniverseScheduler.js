/**
 * Asset Universe Scheduler
 * =========================
 * Five-layer refresh schedule (all times ET):
 *
 *   ① 5:30 PM  Mon–Fri  (After-close) — incremental OHLCV refresh for all 244 static symbols → feeds Ollama DB-enriched verdicts
 *   ② 8:00 PM  Mon–Fri  (Evening)     — full Alpaca refresh + rebuild daily universe
 *   ③ 8:00 AM  Mon–Fri  (Morning)     — catch-up AI scan using prior-day close data (fills gaps if nightly scan was partial)
 *   ④ 7:30 AM  Mon–Fri  (Pre-market)  — add premarket movers to daily universe
 *   ⑤ Every 5 min during market hours — intraday dynamic symbol additions
 *
 * Purely additive — safe to start/stop at any time without affecting
 * the existing trading bot, signal scheduler, or news monitor.
 */

const cron                  = require('node-cron');
const assetUniverseService  = require('./assetUniverseService');
const { logger }            = require('../utils/logger');
const historicalDataService = require('./historicalDataService');
const { STATIC_STOCK_UNIVERSE } = require('./stockUniverseService');

const dynamicUniverseService = require('./dynamicUniverseService');

let schedulerActive         = false;
let afterCloseJob           = null;
let eveningJob              = null;
let nightlyScanJob          = null;
let morningCatchupJob       = null;
let premarketJob            = null;
let dynamicUniverseJob      = null;
let intradayJob             = null;
let intradayMoverJob        = null;

// ── Cron schedules (all ET via CRON_TZ) ──────────────────────────────────────
const AFTERCLOSE_CRON        = '30 17 * * 1-5'; // 5:30 PM — after NYSE close + 30 min data settle
const EVENING_CRON           = '0 20 * * 1-5';
const NIGHTLY_SCAN_CRON      = '30 16 * * 1-5'; // 4:30 PM — dedicated nightly AI scan, runs ~75 min
const MORNING_CATCHUP_CRON   = '0 8 * * 1-5';  // 8:00 AM — catch-up if prior-night scan was incomplete
const PREMARKET_CRON         = '30 7 * * 1-5';
const DYNAMIC_UNIVERSE_CRON  = '45 8 * * 1-5'; // 8:45 AM — build scan universe before 9:30 open
const INTRADAY_CRON          = '*/5 9-16 * * 1-5'; // every 5 min, 9 AM–4 PM
// Hourly nudge — refreshIntradayMovers has its own 75-min cooldown, so this just knocks
const INTRADAY_MOVER_CRON    = '0 10-15 * * 1-5'; // 10 AM, 11, 12, 1, 2, 3 PM ET

const CRON_TZ = { timezone: 'America/New_York' };

// ── After-close OHLCV refresh (5:30 PM ET Mon–Fri) ───────────────────────────

async function runAfterCloseOhlcvRefresh() {
    logger.info('[AssetUniverseScheduler] After-close OHLCV refresh starting…', { symbols: STATIC_STOCK_UNIVERSE.length });
    const t0 = Date.now();
    try {
        const result = await historicalDataService.downloadAll(STATIC_STOCK_UNIVERSE);
        logger.info('[AssetUniverseScheduler] After-close OHLCV refresh done', {
            ...result,
            ms: Date.now() - t0
        });
    } catch (err) {
        logger.error('[AssetUniverseScheduler] After-close OHLCV refresh failed', { error: err.message });
    }
}

// ── Evening job ───────────────────────────────────────────────────────────────

async function runEveningRefresh() {
    logger.info('[AssetUniverseScheduler] Evening refresh starting…');
    const t0 = Date.now();
    try {
        const masterResult = await assetUniverseService.refreshMasterAssets();
        logger.info('[AssetUniverseScheduler] Master assets refreshed', masterResult);

        const dailyResult = await assetUniverseService.buildDailyAnalysisUniverse();
        logger.info('[AssetUniverseScheduler] Daily universe built', dailyResult);

        logger.info('[AssetUniverseScheduler] Evening refresh done', { ms: Date.now() - t0 });
    } catch (err) {
        logger.error('[AssetUniverseScheduler] Evening refresh failed', { error: err.message });
    }
}

// ── Pre-market job ────────────────────────────────────────────────────────────

async function runPremarketRefresh() {
    logger.info('[AssetUniverseScheduler] Pre-market refresh starting…');
    try {
        // Ensure today's daily universe is seeded (handles the case where evening job
        // was missed — e.g. server was down at 8 PM).
        const status = await assetUniverseService.getStatus();
        const today  = new Date().toISOString().slice(0, 10);
        if (!status.daily?.date || status.daily.date.toISOString?.().slice(0,10) !== today) {
            logger.info('[AssetUniverseScheduler] Daily universe missing — building now');
            await assetUniverseService.buildDailyAnalysisUniverse();
        }

        // Pull premarket movers from Yahoo via the rateLimiter-wrapped screener
        // (reuse existing velocity logic rather than adding new Yahoo calls)
        try {
            const yahooFinance = require('yahoo-finance2').default;
            const yf = new yahooFinance();
            const rateLimiter = require('../utils/yahooFinanceRateLimiter');

            const [gainers, actives] = await Promise.all([
                rateLimiter.execute(() => yf.screener({ scrIds: 'day_gainers',   count: 30 })).catch(() => ({ quotes: [] })),
                rateLimiter.execute(() => yf.screener({ scrIds: 'most_actives',  count: 30 })).catch(() => ({ quotes: [] }))
            ]);

            const movers = new Set();
            [...(gainers?.quotes || []), ...(actives?.quotes || [])].forEach(q => {
                const s = (q.symbol || '').toUpperCase();
                if (s && /^[A-Z]{1,5}$/.test(s)) movers.add(s);
            });

            // Add each mover to today's universe and check if any are halted
            for (const symbol of movers) {
                await assetUniverseService.addDynamicSymbol(symbol, 'premarket_mover');
            }

            logger.info('[AssetUniverseScheduler] Pre-market movers added', { count: movers.size });
        } catch (yErr) {
            logger.warn('[AssetUniverseScheduler] Pre-market Yahoo screener failed', { error: yErr.message });
        }

    } catch (err) {
        logger.error('[AssetUniverseScheduler] Pre-market refresh failed', { error: err.message });
    }
}

// ── Dynamic universe build (8:45 AM ET) ──────────────────────────────────────

async function runDynamicUniverseBuild() {
    logger.info('[AssetUniverseScheduler] Dynamic universe build starting (8:45 AM pre-market)');
    try {
        await dynamicUniverseService.buildPreMarketCache();
        const stats = dynamicUniverseService.getCacheStats();
        logger.info('[AssetUniverseScheduler] Dynamic universe build done', stats);
    } catch (err) {
        logger.error('[AssetUniverseScheduler] Dynamic universe build failed', { error: err.message });
    }
}

// ── Intraday job ──────────────────────────────────────────────────────────────

async function runIntradayDiscovery() {
    try {
        const yahooFinance = require('yahoo-finance2').default;
        const yf = new yahooFinance();
        const rateLimiter = require('../utils/yahooFinanceRateLimiter');

        // Trending symbols — real-time market buzz
        const trending = await rateLimiter.execute(() =>
            yf.trendingSymbols('US', { count: 20 })
        ).catch(() => ({ quotes: [] }));

        for (const q of (trending?.quotes || [])) {
            const s = (q.symbol || '').toUpperCase();
            if (s && /^[A-Z]{1,5}$/.test(s) && !(await assetUniverseService.isBlacklisted(s))) {
                await assetUniverseService.addDynamicSymbol(s, 'velocity');
            }
        }
    } catch (err) {
        // Silently swallow — intraday discovery is best-effort
        logger.debug('[AssetUniverseScheduler] Intraday discovery tick failed', { error: err.message });
    }
}

// ── Intraday mover refresh (updates live in-memory scan cache) ────────────────

async function runIntradayMoversRefresh() {
    const result = await dynamicUniverseService.refreshIntradayMovers();
    if (result.skipped) {
        logger.debug('[AssetUniverseScheduler] Intraday movers refresh skipped', result);
    } else if (result.error) {
        logger.warn('[AssetUniverseScheduler] Intraday movers refresh error', result);
    } else {
        logger.info('[AssetUniverseScheduler] Intraday movers refresh done', result);
    }
}

// ── Nightly universe scan (4:30 PM ET Mon–Fri) ───────────────────────────────
// Dedicated reliable trigger — runs 30 min after NYSE close so data is settled.
// Scores all 455 symbols and writes to daily_universe_analysis for today's date.
// Takes ~75-90 min; completes well before next morning's open.

async function runNightlyUniverseScanJob() {
    const nightlyScanSvc = require('./nightlyUniverseScanService');
    if (nightlyScanSvc.isScanRunning()) {
        logger.info('[AssetUniverseScheduler] Nightly scan: already running, skipping duplicate');
        return;
    }
    logger.info('[AssetUniverseScheduler] Nightly scan: launching post-close universe scan');
    nightlyScanSvc.runNightlyUniverseScan({ missingOnly: false })
        .then(r => r && logger.info('[AssetUniverseScheduler] Nightly scan done', {
            analyzed: r.analyzed, passed: r.passed, failed: r.failed, elapsedMin: r.elapsedMin
        }))
        .catch(err => logger.error('[AssetUniverseScheduler] Nightly scan error', { error: err.message }));
}

// ── Morning catch-up scan (8:00 AM ET Mon–Fri) ───────────────────────────────
// Safety net: if the 4:30 PM nightly scan was incomplete or missed (server
// restart, crash), this fills the gap before the 9:30 AM market open.
// Checks TODAY's date specifically — does NOT count yesterday's data as "done".
const CATCHUP_THRESHOLD = 420; // ~92% of 455 symbols

async function runMorningCatchupScan() {
    const { query } = require('../config/database');
    try {
        const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

        // Check how many symbols have been scored for TODAY specifically.
        // Using today's date (not the most recent scan date) ensures yesterday's
        // complete data does not mask a missing today scan.
        const { rows } = await query(
            `SELECT COUNT(*) AS cnt
             FROM daily_universe_analysis
             WHERE analysis_date = $1::date AND ai_score IS NOT NULL`,
            [todayET]
        );
        const todayCount = parseInt(rows[0]?.cnt ?? 0);

        if (todayCount >= CATCHUP_THRESHOLD) {
            logger.info('[AssetUniverseScheduler] Morning catch-up: today scan already complete', { count: todayCount, date: todayET });
            return;
        }

        logger.info('[AssetUniverseScheduler] Morning catch-up: today scan incomplete — resuming', {
            done: todayCount, remaining: CATCHUP_THRESHOLD - todayCount, date: todayET
        });

        const nightlyScanSvc = require('./nightlyUniverseScanService');
        if (nightlyScanSvc.isScanRunning()) {
            logger.info('[AssetUniverseScheduler] Morning catch-up: scan already running, skipping');
            return;
        }
        // missingOnly=true if partial data exists for today, full scan if starting fresh
        nightlyScanSvc.runNightlyUniverseScan({ missingOnly: todayCount > 0 })
            .then(r => r && logger.info('[AssetUniverseScheduler] Morning catch-up done', {
                analyzed: r.analyzed, passed: r.passed, failed: r.failed, elapsedMin: r.elapsedMin
            }))
            .catch(err => logger.error('[AssetUniverseScheduler] Morning catch-up error', { error: err.message }));
    } catch (err) {
        logger.error('[AssetUniverseScheduler] Morning catch-up check failed', { error: err.message });
    }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function startAssetUniverseScheduler() {
    if (schedulerActive) {
        logger.warn('[AssetUniverseScheduler] Already running');
        return;
    }
    schedulerActive = true;

    afterCloseJob      = cron.schedule(AFTERCLOSE_CRON,        runAfterCloseOhlcvRefresh,    CRON_TZ);
    eveningJob         = cron.schedule(EVENING_CRON,           runEveningRefresh,            CRON_TZ);
    nightlyScanJob     = cron.schedule(NIGHTLY_SCAN_CRON,      runNightlyUniverseScanJob,    CRON_TZ);
    morningCatchupJob  = cron.schedule(MORNING_CATCHUP_CRON,   runMorningCatchupScan,        CRON_TZ);
    premarketJob       = cron.schedule(PREMARKET_CRON,         runPremarketRefresh,          CRON_TZ);
    dynamicUniverseJob = cron.schedule(DYNAMIC_UNIVERSE_CRON,  runDynamicUniverseBuild,      CRON_TZ);
    intradayJob        = cron.schedule(INTRADAY_CRON,          runIntradayDiscovery,         CRON_TZ);
    intradayMoverJob   = cron.schedule(INTRADAY_MOVER_CRON,    runIntradayMoversRefresh,     CRON_TZ);

    logger.info('[AssetUniverseScheduler] Started', {
        nightlyScan:      NIGHTLY_SCAN_CRON,
        afterClose:       AFTERCLOSE_CRON,
        evening:          EVENING_CRON,
        morningCatchup:   MORNING_CATCHUP_CRON,
        premarket:        PREMARKET_CRON,
        dynamicUniverse:  DYNAMIC_UNIVERSE_CRON,
        intraday:         INTRADAY_CRON,
        intradayMovers:   INTRADAY_MOVER_CRON,
        tz:               'America/New_York'
    });

    // On first start: if master universe is empty, do an immediate refresh so
    // tomorrow's nightly schedule has data to work with.
    assetUniverseService.getStatus().then(status => {
        if (status.master?.count === 0) {
            logger.info('[AssetUniverseScheduler] Master universe empty — running initial refresh now');
            runEveningRefresh().catch(err =>
                logger.error('[AssetUniverseScheduler] Initial refresh failed', { error: err.message })
            );
        } else {
            logger.info('[AssetUniverseScheduler] Master universe ready', {
                count: status.master.count,
                lastRefreshed: status.master.lastRefreshed
            });
        }
    }).catch(() => {});
}

function stopAssetUniverseScheduler() {
    schedulerActive = false;
    [afterCloseJob, eveningJob, nightlyScanJob, morningCatchupJob, premarketJob, dynamicUniverseJob, intradayJob, intradayMoverJob]
        .forEach(j => j?.stop());
    afterCloseJob = eveningJob = nightlyScanJob = morningCatchupJob = premarketJob = intradayJob = intradayMoverJob = null;
    logger.info('[AssetUniverseScheduler] Stopped');
}

function getSchedulerStatus() {
    return {
        active:    schedulerActive,
        schedules: {
            afterClose:      AFTERCLOSE_CRON,
            evening:         EVENING_CRON,
            premarket:       PREMARKET_CRON,
            dynamicUniverse: DYNAMIC_UNIVERSE_CRON,
            intraday:        INTRADAY_CRON,
            intradayMovers:  INTRADAY_MOVER_CRON,
        },
        timezone:       'America/New_York',
        dynamicUniverse: require('./dynamicUniverseService').getCacheStats(),
    };
}

// ── Manual triggers (for admin routes / testing) ──────────────────────────────

module.exports = {
    startAssetUniverseScheduler,
    stopAssetUniverseScheduler,
    getSchedulerStatus,
    runAfterCloseOhlcvRefresh,
    runEveningRefresh,
    runNightlyUniverseScanJob,
    runPremarketRefresh,
    runDynamicUniverseBuild,
    runIntradayDiscovery,
    runIntradayMoversRefresh,
};
