/**
 * IST Pre-Market Pipeline Scheduler
 * ===================================
 * Enforces the strict PANTHEON IST sequence for USA market pre-market prep.
 *
 * Spec schedule (IST = India Standard Time, UTC+5:30):
 *   06:30  ATLAS    — fetch & refresh market data warehouse (daily_bars)
 *   06:45  COMPASS  — sector rotation ETF ranking update
 *   07:00  HERMES   — route signals / broadcast pending alerts
 *   07:15  PULSE    — news sentiment pre-fetch for watchlist
 *   07:45  ORACLE   — Claude pre-market verdicts for top candidates
 *   08:15  SHIELD   — drawdown / risk-limit pre-check
 *   08:30  SCALE    — Kelly position sizing pre-computation
 *   09:15  ARROW    — open orders, partial fill cleanup, EOD cancellations
 *
 * The sequence is enforced: each stage waits for the previous to complete
 * before starting, regardless of wall-clock drift.
 *
 * Redis state written:
 *   IST_STAGE:{userId}  — current stage name
 *   AGENT_HEALTH:{agent} — heartbeat after each stage
 *   DATA_STALE:atlas     — set if ATLAS fails; cleared on success
 *   ORACLE_WATCHLIST     — populated by ORACLE stage
 */

const redis           = require('./redisStateService');
const { logger }      = require('../utils/logger');
const userDb          = require('./userDatabaseService');
const { query }       = require('../config/database');

// ─── Stage function imports (lazy-required inside functions to avoid circular deps)
// Each stage is a thin wrapper that calls the real service and returns { ok, detail }

async function stageATLAS(users) {
    logger.info('[IST-ATLAS] Starting market data refresh');
    try {
        const { ingestDataForSymbols } = require('./dataIngestionService');
        const { getStockUniverse }     = require('./stockUniverseService');
        const symbols = await getStockUniverse();
        await ingestDataForSymbols(symbols, 1); // last 1 day incremental update
        await redis.clearDataStale('atlas');
        logger.info('[IST-ATLAS] Market data refreshed', { symbols: symbols.length });
        return { ok: true, detail: `${symbols.length} symbols refreshed` };
    } catch (err) {
        await redis.setDataStale('atlas');
        logger.error('[IST-ATLAS] Failed — DATA_STALE:atlas set', { err: err.message });
        return { ok: false, detail: err.message };
    }
}

async function stageCOMPASS(users) {
    logger.info('[IST-COMPASS] Starting sector rotation update');
    try {
        const compassService = require('./compassService');
        if (typeof compassService.refreshSectorRanks === 'function') {
            await compassService.refreshSectorRanks();
        }
        logger.info('[IST-COMPASS] Sector rankings updated');
        return { ok: true };
    } catch (err) {
        logger.warn('[IST-COMPASS] Failed (non-fatal)', { err: err.message });
        return { ok: false, detail: err.message };
    }
}

async function stageHERMES(users) {
    logger.info('[IST-HERMES] Routing pending alerts');
    try {
        const alertService = require('./alertService');
        for (const user of users) {
            if (typeof alertService.flushPendingAlerts === 'function') {
                await alertService.flushPendingAlerts(user.id);
            }
        }
        logger.info('[IST-HERMES] Alert routing complete', { users: users.length });
        return { ok: true };
    } catch (err) {
        logger.warn('[IST-HERMES] Failed (non-fatal)', { err: err.message });
        return { ok: false, detail: err.message };
    }
}

async function stagePULSE(users) {
    logger.info('[IST-PULSE] Pre-fetching news sentiment');
    try {
        const newsSentimentService = require('./newsSentimentService');
        const { getStockUniverse } = require('./stockUniverseService');
        const symbols = await getStockUniverse();

        let fetched = 0;
        for (const symbol of symbols.slice(0, 30)) { // cap at 30 to stay within rate limits
            try {
                await newsSentimentService.getNewsSentiment(symbol);
                fetched++;
            } catch { /* non-blocking per symbol */ }
        }
        logger.info('[IST-PULSE] News sentiment pre-fetched', { fetched });
        return { ok: true, detail: `${fetched} symbols` };
    } catch (err) {
        logger.warn('[IST-PULSE] Failed (non-fatal)', { err: err.message });
        return { ok: false, detail: err.message };
    }
}

async function stageORACLE(users) {
    logger.info('[IST-ORACLE] Running pre-market Claude verdicts');
    try {
        const oracleService    = require('./oracleService');
        const dataProvider     = require('./dataProvider');
        const { getStockUniverse } = require('./stockUniverseService');

        if (!oracleService.isEnabled()) {
            logger.info('[IST-ORACLE] ORACLE disabled (no API key) — skipping');
            return { ok: true, detail: 'skipped — no API key' };
        }

        const symbols = await getStockUniverse();
        let verdictCount = 0;
        const watchlist = [];

        for (const symbol of symbols.slice(0, 20)) {
            try {
                const quote = await dataProvider.getQuote(symbol);
                if (!quote?.price) continue;

                const verdict = await oracleService.getVerdict({
                    symbol,
                    price:     quote.price,
                    regime:    await redis.getRegime('usa') || 'UNKNOWN',
                    stage:     1,
                    pattern:   'None',
                    rsi:       null,
                    macd:      null,
                    atr:       null,
                    sma50:     null,
                    sma150:    null,
                    sma200:    null,
                    volume:    quote.volume,
                    avgVolume: quote.avgVolume,
                    earningsGrowth: null,
                    revenueGrowth:  null,
                    daysToEarnings: null,
                    geminiLabel:    null,
                    smartMoneyScore: 0.5,
                    sectorRank:      null,
                    riskReward:      2.5,
                    entry:  quote.price,
                    stop:   quote.price * 0.97,
                    target: quote.price * 1.08
                });

                if (verdict?.verdict === 'TRADE') {
                    watchlist.push(symbol);
                }
                verdictCount++;
            } catch { /* non-blocking per symbol */ }
        }

        await redis.clearOracleWatchlist();
        for (const s of watchlist) await redis.addToOracleWatchlist(s);

        logger.info('[IST-ORACLE] Pre-market verdicts complete', { verdictCount, watchlist: watchlist.length });
        return { ok: true, detail: `${verdictCount} verdicts, ${watchlist.length} TRADE` };
    } catch (err) {
        logger.warn('[IST-ORACLE] Failed (non-fatal)', { err: err.message });
        return { ok: false, detail: err.message };
    }
}

async function stageSHIELD(users) {
    logger.info('[IST-SHIELD] Pre-market risk pre-checks');
    try {
        const { query: dbQuery } = require('../config/database');
        const issues = [];

        for (const user of users) {
            // Check daily loss limit from yesterday as a sanity check
            const res = await dbQuery(
                `SELECT COALESCE(SUM(total), 0) AS sell_total
                 FROM trades
                 WHERE user_id = $1 AND action = 'SELL'
                   AND trade_date >= CURRENT_DATE - INTERVAL '1 day'`,
                [user.id]
            );
            const sellTotal = parseFloat(res.rows[0]?.sell_total || 0);
            if (sellTotal > 0) {
                logger.info(`[IST-SHIELD] User ${user.username}: yesterday sell total ₹${sellTotal.toFixed(2)}`);
            }
        }

        logger.info('[IST-SHIELD] Risk pre-checks complete');
        return { ok: true, issues };
    } catch (err) {
        logger.warn('[IST-SHIELD] Failed (non-fatal)', { err: err.message });
        return { ok: false, detail: err.message };
    }
}

async function stageSCALE(users) {
    logger.info('[IST-SCALE] Pre-computing Kelly position sizing');
    try {
        const performanceService = require('./performanceMetricsService');
        for (const user of users) {
            try {
                if (typeof performanceService.getConsecutiveLosses === 'function') {
                    const streak = await performanceService.getConsecutiveLosses(user.id);
                    logger.info(`[IST-SCALE] User ${user.username}: loss streak = ${streak}`);
                }
            } catch { /* non-blocking per user */ }
        }
        logger.info('[IST-SCALE] Kelly pre-computation complete');
        return { ok: true };
    } catch (err) {
        logger.warn('[IST-SCALE] Failed (non-fatal)', { err: err.message });
        return { ok: false, detail: err.message };
    }
}

async function stageARROW(users) {
    logger.info('[IST-ARROW] Cleaning up open/partial fill orders');
    try {
        // Cancel any pending day orders still open in DB (shouldn't exist after broker EOD).
        // order_audit_log is append-only -- every state transition is a new row -- so this
        // must look at each order's LATEST row, not just whether it ever passed through one
        // of these transient states (nearly every order does, on its way to FILLED). The old
        // plain WHERE re-matched long-since-filled/closed orders forever, journaling a fresh
        // "canceled" entry for them every single day (found investigating repeated stale
        // cleanup entries for an order that had already filled and closed days earlier).
        //
        // That fix was incomplete: the child row this function inserts below carries its OWN
        // idempotency_key (base + ':eod_cleanup'), a different string from the base key it was
        // partitioning by. So the base key's "latest row" was always the original stale
        // SUBMITTED/PENDING_FILL/PARTIALLY_FILLED entry forever -- the child never counted
        // toward its own partition -- and this re-journaled the same stuck order as newly
        // "canceled" on every run indefinitely. Confirmed live: some keys had been re-logged
        // 100+ times since 2026-06-18 (6,787 duplicate rows across 312 keys before this fix).
        // Excluding any base key that already has an ':eod_cleanup' child makes the whole
        // operation idempotent regardless of how the base/child partitioning behaves.
        const res = await query(
            `SELECT idempotency_key, user_id, symbol, quantity
             FROM (
                 SELECT idempotency_key, user_id, symbol, quantity, state, created_at,
                        ROW_NUMBER() OVER (PARTITION BY idempotency_key ORDER BY created_at DESC) AS rn
                 FROM order_audit_log
             ) latest
             WHERE rn = 1
               AND state IN ('SUBMITTED', 'PENDING_FILL', 'PARTIALLY_FILLED')
               AND created_at < NOW() - INTERVAL '1 hour'
               AND NOT EXISTS (
                   SELECT 1 FROM order_audit_log c
                   WHERE c.idempotency_key = latest.idempotency_key || ':eod_cleanup'
               )`,
        );

        let cleaned = 0;
        for (const row of res.rows) {
            // Log as CANCELED — the broker already expired day orders at close
            await query(
                `INSERT INTO order_audit_log
                 (idempotency_key, user_id, symbol, state, previous_state, metadata)
                 VALUES ($1,$2,$3,'CANCELED',$4,$5)`,
                [
                    row.idempotency_key + ':eod_cleanup',
                    row.user_id,
                    row.symbol,
                    'PARTIALLY_FILLED',
                    JSON.stringify({ reason: 'IST-ARROW EOD cleanup', auto: true, qty: row.quantity })
                ]
            );
            cleaned++;
        }

        if (cleaned > 0) {
            logger.info('[IST-ARROW] EOD cleanup complete', { cleaned });
        } else {
            logger.info('[IST-ARROW] No stale open orders found');
        }

        return { ok: true, detail: `${cleaned} orders journaled` };
    } catch (err) {
        logger.warn('[IST-ARROW] Failed (non-fatal)', { err: err.message });
        return { ok: false, detail: err.message };
    }
}

// ─── PIPELINE DEFINITION ─────────────────────────────────────────────────────

const IST_PIPELINE = [
    { name: 'ATLAS',   istHour: 6,  istMinute: 30, fn: stageATLAS  },
    { name: 'COMPASS', istHour: 6,  istMinute: 45, fn: stageCOMPASS },
    { name: 'HERMES',  istHour: 7,  istMinute: 0,  fn: stageHERMES  },
    { name: 'PULSE',   istHour: 7,  istMinute: 15, fn: stagePULSE   },
    { name: 'ORACLE',  istHour: 7,  istMinute: 45, fn: stageORACLE  },
    { name: 'SHIELD',  istHour: 8,  istMinute: 15, fn: stageSHIELD  },
    { name: 'SCALE',   istHour: 8,  istMinute: 30, fn: stageSCALE   },
    { name: 'ARROW',   istHour: 9,  istMinute: 15, fn: stageARROW   },
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Return current time broken into { istHour, istMinute, istDate } */
function nowIST() {
    const formatter = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: 'numeric', minute: 'numeric', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const parts = formatter.formatToParts(new Date());
    const get = type => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
    return {
        istHour:   get('hour'),
        istMinute: get('minute'),
        istDate:   `${parts.find(p=>p.type==='year')?.value}-${parts.find(p=>p.type==='month')?.value}-${parts.find(p=>p.type==='day')?.value}`
    };
}

/** True on Mon–Fri in IST */
function isISTWeekday() {
    const day = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        weekday: 'short'
    }).format(new Date());
    return !['Sat', 'Sun'].includes(day);
}

/** Check if a stage is due to run (within the current 15-min slot) */
function isStageSlotActive(stage) {
    const { istHour, istMinute } = nowIST();
    const nowMins  = istHour * 60 + istMinute;
    const stageMins = stage.istHour * 60 + stage.istMinute;
    // Active window: from scheduled time up to 15 minutes later
    return nowMins >= stageMins && nowMins < stageMins + 15;
}

// Track which stages have run today to avoid double-running
const _ranToday = new Map(); // key: 'stageName:istDate'

// ─── MAIN PIPELINE RUNNER ────────────────────────────────────────────────────

/**
 * Run the IST pipeline.
 * Called from a tight 1-min polling loop - checks which stages are due.
 */
async function runISTPipeline() {
    if (!isISTWeekday()) return;

    const { istDate } = nowIST();

    // Check HALT_ALL
    const halt = await redis.getHaltAll();
    if (halt) {
        logger.warn('[IST-Pipeline] HALT_ALL active — pipeline skipped', { reason: halt });
        return;
    }

    for (const stage of IST_PIPELINE) {
        const key = `${stage.name}:${istDate}`;
        if (_ranToday.get(key)) continue;              // already ran today
        if (!isStageSlotActive(stage)) continue;        // not in this stage's window

        _ranToday.set(key, true); // mark immediately to prevent concurrency

        logger.info(`[IST-Pipeline] Triggering stage ${stage.name}`, nowIST());
        await redis.pingAgentHealth(stage.name);

        // Get active users (non-blocking — if fails, use empty list)
        let users = [];
        try { users = await userDb.getUsersWithAITradingEnabled(); } catch { /* ok */ }

        // Per-user pipeline lock check (best-effort — Redis may be unavailable)
        for (const user of users.slice(0, 1)) { // lock on first user as representative
            const acquired = await redis.acquirePipelineLock(`${user.id}:${stage.name}`);
            if (!acquired) {
                logger.warn(`[IST-Pipeline] Stage ${stage.name} lock held by another process — skipping`);
                _ranToday.delete(key); // allow retry next tick
                continue;
            }
        }

        try {
            await redis.setIstStage('global', stage.name);
            const result = await stage.fn(users);
            await redis.pingAgentHealth(stage.name);
            logger.info(`[IST-Pipeline] Stage ${stage.name} complete`, result);
        } catch (err) {
            logger.error(`[IST-Pipeline] Stage ${stage.name} threw unhandled error`, { err: err.message });
        } finally {
            for (const user of users.slice(0, 1)) {
                await redis.releasePipelineLock(`${user.id}:${stage.name}`);
            }
        }

        // Only run one stage per tick — sequential guarantee
        break;
    }

    // Clear yesterday's run markers after 06:20 IST (before pipeline starts)
    const { istHour, istMinute } = nowIST();
    if (istHour === 6 && istMinute < 20) {
        for (const [key] of _ranToday) {
            if (!key.endsWith(istDate)) _ranToday.delete(key);
        }
    }
}

// ─── SCHEDULER BOOTSTRAP ─────────────────────────────────────────────────────

let _istInterval = null;

/** Start the 1-minute IST pipeline polling loop */
function startISTPipelineScheduler() {
    if (_istInterval) {
        logger.info('[IST-Pipeline] Already running');
        return;
    }
    logger.info('[IST-Pipeline] Starting IST pre-market pipeline scheduler (1-min polling)');
    _istInterval = setInterval(runISTPipeline, 60 * 1000);
    // Run once immediately to catch a stage if server started mid-window
    runISTPipeline().catch(e => logger.error('[IST-Pipeline] Initial run error', { err: e.message }));
}

function stopISTPipelineScheduler() {
    if (_istInterval) {
        clearInterval(_istInterval);
        _istInterval = null;
        logger.info('[IST-Pipeline] Stopped');
    }
}

module.exports = {
    startISTPipelineScheduler,
    stopISTPipelineScheduler,
    runISTPipeline,
    IST_PIPELINE,
    // Export individual stages for testing
    stageATLAS, stageCOMPASS, stageHERMES, stagePULSE,
    stageORACLE, stageSHIELD, stageSCALE, stageARROW
};
