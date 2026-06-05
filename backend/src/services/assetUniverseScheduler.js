/**
 * Asset Universe Scheduler
 * =========================
 * Four-layer refresh schedule (all times ET):
 *
 *   ① 5:30 PM  Mon–Fri  (After-close) — incremental OHLCV refresh for all 244 static symbols → feeds Ollama DB-enriched verdicts
 *   ② 8:00 PM  Mon–Fri  (Evening)     — full Alpaca refresh + rebuild daily universe
 *   ③ 7:30 AM  Mon–Fri  (Pre-market)  — add premarket movers to daily universe
 *   ④ Every 5 min during market hours — intraday dynamic symbol additions
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
let premarketJob            = null;
let dynamicUniverseJob      = null;
let intradayJob             = null;
let intradayMoverJob        = null;

// ── Cron schedules (all ET via CRON_TZ) ──────────────────────────────────────
const AFTERCLOSE_CRON        = '30 17 * * 1-5'; // 5:30 PM — after NYSE close + 30 min data settle
const EVENING_CRON           = '0 20 * * 1-5';
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

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function startAssetUniverseScheduler() {
    if (schedulerActive) {
        logger.warn('[AssetUniverseScheduler] Already running');
        return;
    }
    schedulerActive = true;

    afterCloseJob      = cron.schedule(AFTERCLOSE_CRON,        runAfterCloseOhlcvRefresh,  CRON_TZ);
    eveningJob         = cron.schedule(EVENING_CRON,           runEveningRefresh,          CRON_TZ);
    premarketJob       = cron.schedule(PREMARKET_CRON,         runPremarketRefresh,        CRON_TZ);
    dynamicUniverseJob = cron.schedule(DYNAMIC_UNIVERSE_CRON,  runDynamicUniverseBuild,    CRON_TZ);
    intradayJob        = cron.schedule(INTRADAY_CRON,          runIntradayDiscovery,       CRON_TZ);
    intradayMoverJob   = cron.schedule(INTRADAY_MOVER_CRON,    runIntradayMoversRefresh,   CRON_TZ);

    logger.info('[AssetUniverseScheduler] Started', {
        afterClose:       AFTERCLOSE_CRON,
        evening:          EVENING_CRON,
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
    [afterCloseJob, eveningJob, premarketJob, dynamicUniverseJob, intradayJob, intradayMoverJob]
        .forEach(j => j?.stop());
    afterCloseJob = eveningJob = premarketJob = intradayJob = intradayMoverJob = null;
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
    runPremarketRefresh,
    runDynamicUniverseBuild,
    runIntradayDiscovery,
    runIntradayMoversRefresh,
};
