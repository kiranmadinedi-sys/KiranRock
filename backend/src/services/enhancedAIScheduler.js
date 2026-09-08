const enhancedAITradingBot = require('./enhancedAITradingBot');
const userDb = require('./userDatabaseService');
const { query } = require('../config/database');
const { getGlobalTradingControl } = require('./tradingControlService');
const redisState = require('./redisStateService');
const alertService = require('./telegramAlertService');
const vixMonitor = require('./vixSpikeMonitorService');
const premarketGapService = require('./premarketGapAlertService');
const extendedHoursTradingService = require('./extendedHoursTradingService');
const { getMarketRegime } = require('./marketRegimeService');
const { getGlobalSentiment } = require('./globalSentimentService');

/**
 * Enhanced AI Trading Scheduler - PostgreSQL Version
 * Runs autonomous trading for all enabled users during market hours
 */

// Safe ET "now" accessor — returns wall-clock ET day-of-week, hour, minute, and calendar
// date, derived directly from Intl.DateTimeFormat's ET-formatted parts. Replaces the
// pattern used throughout this file until 2026-08-25,
// `new Date(new Date().toLocaleString('en-US', {timeZone:'America/New_York'}))
//    .toISOString().slice(0, 10)`,
// which has two independent bugs: (1) re-parsing an already-localized string
// reinterprets it in the machine's OWN local timezone, not ET; (2) even setting that
// aside, .toISOString() always normalizes to UTC, so the date portion reflects the UTC
// calendar day, not the ET one — meaning every site using this pattern reported
// TOMORROW's date for the entire 8 PM-midnight ET window, every single day, regardless
// of the machine's own timezone. Confirmed firing live 2026-08-25 ~9:30 PM ET: the
// nightly scan trigger read etDate as 2026-08-26 — a full day ahead of the true ET
// date — and launched a redundant full re-scan of a day that had already completed.
function _getETNow() {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const parts = formatter.formatToParts(new Date());
    const get = (type) => parts.find(p => p.type === type).value;
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        day:  weekdayMap[get('weekday')],
        hour: parseInt(get('hour'), 10) % 24, // Intl can return '24' for midnight
        min:  parseInt(get('minute'), 10),
        date: `${get('year')}-${get('month')}-${get('day')}`
    };
}

// Check every 5 minutes
const CHECK_INTERVAL = 5 * 60 * 1000;
let schedulerInterval = null;
let isRunning = false;
let isRunningAt = null; // timestamp when isRunning was set — used by watchdog

// Tracks each user's REAL in-flight executeAutonomousTrading call (not the race against
// the reporting timeout) — see processUser() for why this matters.
const _userCyclesInFlight = new Map(); // userId -> { startedAt }

// Watchdog: if isRunning has been true for > 6 minutes, something is stuck.
// Force-reset so the next tick can proceed instead of freezing the whole day.
const LOCK_MAX_AGE_MS = 6 * 60 * 1000;
function _watchdogCheck() {
    if (isRunning && isRunningAt && (Date.now() - isRunningAt) > LOCK_MAX_AGE_MS) {
        console.error(`[Enhanced AI Scheduler] ⚠ isRunning stuck for ${Math.round((Date.now()-isRunningAt)/60000)} min — force-resetting lock`);
        isRunning = false;
        isRunningAt = null;
    }
}

// Set AI_TRADING_ENABLED=false in .env to pause all autonomous trading without
// stopping the scheduler process (position monitoring / EOD cleanup still run).
const _tradingEnabled = () =>
    (process.env.AI_TRADING_ENABLED ?? 'true').toLowerCase() !== 'false';

/**
 * Get all users with AI trading enabled from database
 */
async function getActiveAIUsers() {
    try {
        return await userDb.getUsersWithAITradingEnabled();
    } catch (error) {
        console.error('[Enhanced AI Scheduler] Error loading users:', error);
        return [];
    }
}

/**
 * Main scheduler function
 */
async function runScheduledTrading() {
    _watchdogCheck(); // reset lock if stuck > 6 min before evaluating
    if (isRunning) {
        const stuckMin = isRunningAt ? Math.round((Date.now() - isRunningAt) / 60000) : '?';
        console.log(`[Enhanced AI Scheduler] Previous run still in progress (${stuckMin} min), skipping...`);
        return;
    }

    const timestamp = new Date().toISOString();
    console.log(`\n${'='.repeat(80)}`);
    console.log(`[Enhanced AI Scheduler] Starting at ${timestamp}`);
    console.log(`${'='.repeat(80)}\n`);

    isRunning = true;
    isRunningAt = Date.now();

    try {
        // Hard pause: set AI_TRADING_ENABLED=false to stop new trades instantly.
        // EOD cleanup (runEodCleanup) is unaffected and still runs every tick.
        if (!_tradingEnabled()) {
            console.log('[Enhanced AI Scheduler] AI_TRADING_ENABLED=false — autonomous trading paused. Skipping cycle.');
            isRunning = false;
            return;
        }

        const globalControl = await getGlobalTradingControl();
        if (!globalControl.globalTradingEnabled) {
            console.log('[Enhanced AI Scheduler] Global trading kill switch active. Skipping cycle.');
            isRunning = false;
            return;
        }

        // Redis HALT_ALL check — multi-process kill switch (AWS multi-EC2 coordination)
        const redisHalt = await redisState.getHaltAll();
        if (redisHalt) {
            console.log(`[Enhanced AI Scheduler] Redis HALT_ALL active (reason: ${redisHalt}). Skipping cycle.`);
            isRunning = false;
            return;
        }

        // Check if market is open
        if (!enhancedAITradingBot.isMarketOpen()) {
            console.log('[Enhanced AI Scheduler] Market is closed. Next check in 5 minutes.');
            isRunning = false;
            return;
        }

        // VIX Spike Monitor — runs every tick during market hours.
        // Fires Telegram alerts and invalidates regime/ATLAS caches on anomalous moves.
        // Non-blocking: a VIX fetch failure never stops the trading cycle.
        vixMonitor.checkVix().catch(err =>
            console.warn('[Enhanced AI Scheduler] VIX monitor tick failed:', err.message)
        );

        console.log('[Enhanced AI Scheduler] ✓ Market is OPEN - proceeding with trading');
        
        // Get users with AI trading enabled
        const activeUsers = await getActiveAIUsers();
        
        if (activeUsers.length === 0) {
            console.log('[Enhanced AI Scheduler] No users have AI trading enabled.');
            isRunning = false;
            return;
        }
        
        console.log(`[Enhanced AI Scheduler] Found ${activeUsers.length} users with AI trading enabled\n`);
        
        // Process all users in PARALLEL — sequential processing meant the last user
        // could be 25–60s behind on every cycle, missing time-sensitive opportunities.
        // Each user gets an independent 4-minute hard timeout so one slow account
        // cannot delay or block other accounts.
        const CYCLE_TIMEOUT_MS = 4 * 60 * 1000;

        async function processUser(user) {
            // Per-user execution lock — Promise.race below only stops the SCHEDULER from
            // waiting past 4 minutes; it never cancels the underlying executeAutonomousTrading
            // call, which keeps running in the background and can still place real trades
            // minutes later. Without this lock, the NEXT scheduled tick (5 min later) could
            // start a second, overlapping cycle for the same user while the first is still
            // silently in flight — both checking "room for a new position" / heat budget /
            // sector caps against the same stale snapshot and both deciding to buy. Invisible
            // for 14 days of CHOPPY (every cycle returned near-instantly); confirmed live
            // 2026-07-17 once real trading resumed and cycles ran long enough to still be
            // executing when the next tick fired.
            if (_userCyclesInFlight.has(user.id)) {
                const info = _userCyclesInFlight.get(user.id);
                const ageSec = Math.round((Date.now() - info.startedAt) / 1000);
                const MAX_LOCK_AGE_SEC = 15 * 60; // generous vs the 4-min reporting timeout — a lock this old is a genuine hang, not just slow external APIs
                if (ageSec > MAX_LOCK_AGE_SEC) {
                    console.error(`[Enhanced AI Scheduler] ⚠ ${user.username}: previous cycle lock stuck for ${ageSec}s — force-clearing so this user isn't permanently blocked`);
                    _userCyclesInFlight.delete(user.id);
                } else {
                    console.warn(`[Enhanced AI Scheduler] ⏭ ${user.username}: previous cycle still running (${ageSec}s in) — skipping this tick rather than starting an overlapping one`);
                    return;
                }
            }

            console.log(`[Enhanced AI Scheduler] ▶ Starting user: ${user.username} (${user.id})`);
            const _cycleStartedAt = Date.now();
            _userCyclesInFlight.set(user.id, { startedAt: _cycleStartedAt });

            // The REAL execution — never abandoned. A separate chain (not the race below)
            // clears the lock exactly when this actually finishes, however long that takes.
            const realExecution = enhancedAITradingBot.executeAutonomousTrading(user.id);
            realExecution
                .catch(() => {}) // swallow here so a late rejection is never "unhandled" once the race has already moved on
                .finally(() => {
                    _userCyclesInFlight.delete(user.id);
                    const durationSec = Math.round((Date.now() - _cycleStartedAt) / 1000);
                    if (durationSec > CYCLE_TIMEOUT_MS / 1000) {
                        console.warn(`[Enhanced AI Scheduler] ${user.username}: cycle actually finished after ${durationSec}s (scheduler already reported a timeout at ${Math.round(CYCLE_TIMEOUT_MS / 1000)}s)`);
                    }
                });

            try {
                const timeoutResult = {
                    success: false,
                    message: 'Trading cycle timed out (>4 min) — skipped to prevent scheduler freeze',
                    tradesExecuted: 0, capitalDeployed: 0, opportunitiesFound: 0, trades: []
                };
                const result = await Promise.race([
                    realExecution,
                    new Promise(resolve => setTimeout(() => resolve(timeoutResult), CYCLE_TIMEOUT_MS))
                ]);

                if (result.success) {
                    console.log(`[Enhanced AI Scheduler] ✓ ${user.username}: ${result.message || 'Trading completed'}`);
                    if (result.tradesExecuted > 0) {
                        console.log(`  trades=${result.tradesExecuted} deployed=$${result.capitalDeployed?.toFixed(2)} opps=${result.opportunitiesFound}`);
                        result.trades.forEach((t, i) =>
                            console.log(`  ${i + 1}. ${t.action} ${t.shares} ${t.symbol} @ $${t.price?.toFixed(2)} (score=${t.aiScore})`)
                        );
                    }
                } else {
                    console.log(`[Enhanced AI Scheduler] ⚠ ${user.username}: ${result.message || result.error}`);
                }

                await logTradingActivity(user.id, result);

                try {
                    const holdingsDb = require('./holdingsDatabaseService');
                    const holdings   = await holdingsDb.getUserHoldings(user.id);
                    const symbols    = (holdings || []).map(h => h.symbol);
                    await redisState.setOpenPositions(user.id, symbols);
                    await redisState.pingAgentHealth('ARROW');
                } catch { /* non-blocking */ }

            } catch (error) {
                console.error(`[Enhanced AI Scheduler] Error processing user ${user.username}:`, error.message);
            }
        }

        await Promise.all(activeUsers.map(processUser));
        
        console.log(`\n${'='.repeat(80)}`);
        console.log('[Enhanced AI Scheduler] Trading cycle completed');
        console.log(`${'='.repeat(80)}\n`);
        
    } catch (error) {
        console.error('[Enhanced AI Scheduler] Error in trading cycle:', error);
    } finally {
        isRunning = false;
        isRunningAt = null;
    }
}

/**
 * Log trading activity to database
 */
async function logTradingActivity(userId, result) {
    try {
        await query(`
            INSERT INTO ai_trading_logs (
                user_id, success, trades_executed, capital_deployed,
                opportunities_found, message, trades_detail
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
            userId,
            result.success,
            result.tradesExecuted || 0,
            result.capitalDeployed || 0,
            result.opportunitiesFound || 0,
            result.message || result.error,
            JSON.stringify(result.trades || [])
        ]);
    } catch (error) {
        console.error('[Enhanced AI Scheduler] Error logging activity:', error);
    }
}

/**
 * ARROW EOD: fires once per day at 15:45 ET to cancel partial fills before close.
 * Tracks run date so it only executes once per trading day.
 */
let _eodRanDate = null;

async function runEodCleanup() {
    if (!enhancedAITradingBot.isMarketOpen) return; // guard — skip if helper not available

    // Check time in ET
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric', minute: 'numeric', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const parts  = formatter.formatToParts(new Date());
    const etHour   = parseInt(parts.find(p => p.type === 'hour').value,   10);
    const etMinute = parseInt(parts.find(p => p.type === 'minute').value, 10);
    const etDate   = `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}-${parts.find(p=>p.type==='day').value}`;

    // Run only once, at 15:44–15:59 ET
    if (etHour !== 15 || etMinute < 44) return;
    if (_eodRanDate === etDate) return;
    _eodRanDate = etDate;

    console.log('[Enhanced AI Scheduler] ARROW EOD — canceling partial fills before market close');
    try {
        const brokerService = require('./brokerService');
        const result = await brokerService.eodCancelPartialFills();
        console.log(`[Enhanced AI Scheduler] ARROW EOD done — canceled: ${result.canceled}, journaled: ${result.journaled}`);
        await redisState.pingAgentHealth('ARROW');
    } catch (err) {
        console.error('[Enhanced AI Scheduler] ARROW EOD error:', err.message);
    }

    // ── Daily trade-flow anomaly detection ─────────────────────────────────────
    // Compares today's trade activity to the 90-day baseline.
    // Flags deviations > 50% in trade count, win rate, or avg position size —
    // symptoms of runaway bugs, sudden strategy breakdown, or market-structure changes.
    try {
        const activeUsers = await getActiveAIUsers();
        for (const user of activeUsers) {
            const statsRes = await query(`
                SELECT
                    ROUND(AVG(CASE WHEN created_at >= CURRENT_DATE THEN 1.0 ELSE NULL END) * COUNT(CASE WHEN created_at >= CURRENT_DATE THEN 1 END), 0) AS today_count,
                    COUNT(CASE WHEN created_at >= CURRENT_DATE THEN 1 END) AS today_count_raw,
                    ROUND(AVG(CASE WHEN created_at >= NOW() - INTERVAL '90 days' AND created_at < CURRENT_DATE THEN 1.0 ELSE NULL END)
                          * SUM(CASE WHEN created_at >= NOW() - INTERVAL '90 days' AND created_at < CURRENT_DATE THEN 1 ELSE 0 END) / 90.0, 1) AS baseline_daily_avg,
                    ROUND(AVG(CASE WHEN created_at >= CURRENT_DATE AND pnl IS NOT NULL THEN CASE WHEN pnl > 0 THEN 100.0 ELSE 0 END END)::numeric, 1) AS today_wr,
                    ROUND(AVG(CASE WHEN created_at >= NOW() - INTERVAL '90 days' AND created_at < CURRENT_DATE AND pnl IS NOT NULL THEN CASE WHEN pnl > 0 THEN 100.0 ELSE 0 END END)::numeric, 1) AS baseline_wr
                FROM trade_decision_journal
                WHERE user_id = $1 AND decision_phase = 'EXIT'
            `, [user.id]);

            const s = statsRes.rows[0];
            if (!s) continue;

            const todayCount  = parseInt(s.today_count_raw)  || 0;
            const baselineAvg = parseFloat(s.baseline_daily_avg) || 0;
            const todayWr     = parseFloat(s.today_wr) ?? null;
            const baselineWr  = parseFloat(s.baseline_wr) ?? null;

            const anomalies = [];
            let catastrophicReason = null;

            // Catastrophic: runaway bot — >5× normal daily trade count
            if (baselineAvg > 0 && todayCount > baselineAvg * 5) {
                const detail = `Runaway bot: ${todayCount} trades vs ~${baselineAvg.toFixed(1)}/day baseline`;
                anomalies.push(detail);
                catastrophicReason = `AUTO-PAUSE: ${detail}`;
            } else if (baselineAvg > 0 && todayCount > baselineAvg * 2.5) {
                anomalies.push(`Trade count: ${todayCount} today vs ~${baselineAvg.toFixed(1)}/day baseline (${((todayCount / baselineAvg - 1) * 100).toFixed(0)}% above)`);
            }

            // Catastrophic: strategy breakdown — WR < 20% when baseline > 40%, at least 3 trades
            if (todayWr !== null && baselineWr !== null && todayWr < 20 && baselineWr > 40 && todayCount >= 3) {
                const detail = `Strategy breakdown: ${todayWr}% win rate today vs ${baselineWr}% baseline (n=${todayCount})`;
                anomalies.push(detail);
                if (!catastrophicReason) catastrophicReason = `AUTO-PAUSE: ${detail}`;
            } else if (todayWr !== null && baselineWr !== null && baselineWr > 0 && todayWr < baselineWr * 0.5) {
                anomalies.push(`Win rate: ${todayWr}% today vs ${baselineWr}% baseline (sudden drop)`);
            }

            if (todayCount === 0 && baselineAvg >= 2) {
                anomalies.push(`No trades today (baseline ~${baselineAvg.toFixed(1)}/day) — check if bot is running`);
            }

            // Engage HALT_ALL kill switch for catastrophic conditions
            if (catastrophicReason) {
                try { await redisState.setHaltAll(catastrophicReason); } catch (_) {}
                const haltMsg = [
                    '🚨 *AUTO-PAUSE ACTIVATED*',
                    '',
                    `⛔ _${catastrophicReason}_`,
                    '',
                    '🔍 Review logs before resuming.',
                    '_To resume: clear Redis HALT\\_ALL key or restart with AI\\_TRADING\\_ENABLED=true_'
                ].join('\n');
                try { await alertService.sendMessage(user.id, haltMsg); } catch (_) {}
                console.log(`[AutoPause] HALT_ALL set for user ${user.id}: ${catastrophicReason}`);
            }

            if (anomalies.length > 0) {
                const msg = [
                    '🚨 *TRADE FLOW ANOMALY DETECTED*',
                    '',
                    ...anomalies.map(a => `  ⚠️ ${a}`),
                    '',
                    '_Check bot logs and market conditions._'
                ].join('\n');
                try { await alertService.sendMessage(user.id, msg); } catch (_) {}
                console.log(`[AnomalyDetection] Alert sent for user ${user.id}: ${anomalies.join('; ')}`);
            }
        }
    } catch (anomalyErr) {
        console.error('[AnomalyDetection] Error:', anomalyErr.message);
    }

    // ── Daily EOD digest ─────────────────────────────────────────────────────
    try {
        const digestUsers = await getActiveAIUsers();
        await runDailyDigest(digestUsers, etDate);
    } catch (digestErr) {
        console.error('[DailyDigest] Error:', digestErr.message);
    }

    // ── Nightly universe scan — fire-and-forget after EOD digest ─────────────
    // Scores ALL tickers overnight so market-hours scans use the pre-built list
    // (~120 candidates) instead of running live AI analysis on 300-500 symbols.
    try {
        const nightlyScanSvc = require('./nightlyUniverseScanService');
        // Run in background — doesn't block the scheduler loop
        nightlyScanSvc.runNightlyUniverseScan()
            .then(async r => {
                if (r) console.log(`[NightlyScan] Done: ${r.passed} passed / ${r.analyzed} analyzed in ${r.elapsedMin}min`);
                // ── Post-scan: send earnings setup alert to all active users ──────
                try {
                    await sendEarningsSetupAlert();
                } catch (alertErr) {
                    console.error('[EarningsSetupAlert] Error:', alertErr.message);
                }
            })
            .catch(err => console.error('[NightlyScan] Background error:', err.message));
        console.log('[NightlyScan] Background scan launched');
    } catch (scanErr) {
        console.error('[NightlyScan] Failed to launch:', scanErr.message);
    }
}

/**
 * After nightly scan: send a Telegram alert listing top pre-earnings setups
 * (daysToEarnings 5-15, score ≥ 88, passed_prescreen=true) to all active AI users.
 */
async function sendEarningsSetupAlert() {
    const { query: dbQuery } = require('../config/database');
    const res = await dbQuery(`
        SELECT symbol, ai_score, recommendation, sector,
               (metadata->>'daysToEarnings')::int AS days_to_earnings,
               (metadata->>'prophetVerdict')       AS prophet_verdict,
               (metadata->>'entry')::numeric       AS entry_price,
               (metadata->>'target')::numeric      AS target_price,
               (metadata->>'riskReward')::numeric  AS risk_reward
        FROM daily_universe_analysis
        WHERE analysis_date = (
            SELECT MAX(analysis_date) FROM daily_universe_analysis
            WHERE analysis_date >= CURRENT_DATE - INTERVAL '4 days'
              AND analysis_date <= CURRENT_DATE
              AND passed_prescreen = true
        )
          AND passed_prescreen = true
          AND ai_score >= 88
          AND (metadata->>'daysToEarnings')::int BETWEEN 5 AND 15
        ORDER BY ai_score DESC
        LIMIT 10
    `);

    if (!res.rows.length) return; // no qualifying setups today

    const activeUsers = await getActiveAIUsers();
    const lines = res.rows.map((r, i) => {
        const prophet = r.prophet_verdict ? ` | PROPHET: ${r.prophet_verdict}` : '';
        const rr      = r.risk_reward ? ` | R/R: ${parseFloat(r.risk_reward).toFixed(1)}` : '';
        return `${i + 1}. *${r.symbol}* — Score: ${r.ai_score} | ${r.days_to_earnings}d to earnings${prophet}${rr}`;
    });

    const msg = [
        '📅 *Pre-Earnings Setups (Nightly Scan)*',
        `${res.rows.length} stock${res.rows.length > 1 ? 's' : ''} with earnings in 5-15 days, score ≥ 88:`,
        '',
        ...lines,
        '',
        '_Bot will auto-enter these at half position size. Auto-exit 1 day before earnings._'
    ].join('\n');

    for (const user of activeUsers) {
        try { await alertService.sendMessage(user.id, msg); } catch (_) {}
    }
    console.log(`[EarningsSetupAlert] Sent ${res.rows.length} setups to ${activeUsers.length} users`);
}

/**
 * EOD daily digest — one clean Telegram message per user with today's stats,
 * open positions, and best/worst trade stories (auto-tags + setup + exit reason).
 */
async function runDailyDigest(activeUsers, etDate) {
    for (const user of activeUsers) {
        try {
            const [statsRes, holdingsRes, bigWinRes, bigLossRes,
                   orderStatsRes, reconFixesRes, drawdownRes] = await Promise.all([
                // Closed-trade P&L stats
                query(`
                    SELECT
                        COUNT(*)                                              AS total_trades,
                        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)             AS wins,
                        ROUND(SUM(pnl)::numeric, 2)                           AS total_pnl,
                        ROUND(AVG(pnl_percent)::numeric, 2)                   AS avg_pnl_pct
                    FROM trade_decision_journal
                    WHERE user_id = $1 AND created_at >= CURRENT_DATE
                      AND decision_phase = 'EXIT' AND pnl IS NOT NULL
                `, [user.id]),
                // Open positions
                query(`
                    SELECT symbol, quantity, average_price, current_price,
                        ROUND(((current_price - average_price) / NULLIF(average_price, 0) * 100)::numeric, 2) AS unrealized_pct
                    FROM holdings WHERE user_id = $1 AND quantity > 0 ORDER BY symbol
                `, [user.id]),
                // Best trade today
                query(`
                    SELECT symbol, pnl, pnl_percent, setup_family, metadata
                    FROM trade_decision_journal
                    WHERE user_id = $1 AND created_at >= CURRENT_DATE
                      AND decision_phase = 'EXIT' AND pnl > 0
                    ORDER BY pnl DESC LIMIT 1
                `, [user.id]),
                // Worst trade today
                query(`
                    SELECT symbol, pnl, pnl_percent, setup_family, metadata
                    FROM trade_decision_journal
                    WHERE user_id = $1 AND created_at >= CURRENT_DATE
                      AND decision_phase = 'EXIT' AND pnl < 0
                    ORDER BY pnl ASC LIMIT 1
                `, [user.id]),
                // Order execution stats from audit log
                query(`
                    SELECT
                        COUNT(*) FILTER (WHERE state = 'SUBMITTED')          AS submitted,
                        COUNT(*) FILTER (WHERE state = 'FILLED')             AS filled,
                        COUNT(*) FILTER (WHERE state = 'PARTIALLY_FILLED')   AS partial,
                        COUNT(*) FILTER (WHERE state IN ('CANCELED','REJECTED')) AS cancelled
                    FROM order_audit_log
                    WHERE user_id = $1 AND created_at >= CURRENT_DATE
                `, [user.id]),
                // Reconciliation fixes today
                query(`
                    SELECT COUNT(*) AS fixes,
                           COUNT(*) FILTER (WHERE action = 'ERROR') AS errors
                    FROM position_reconciliation_log
                    WHERE user_id = $1 AND reconciled_at >= CURRENT_DATE
                `, [user.id]),
                // Current drawdown from peak (portfolio snapshots)
                query(`
                    SELECT
                        MAX(total_portfolio_value) AS peak,
                        (SELECT total_portfolio_value FROM portfolio_snapshots
                         WHERE user_id = $1 ORDER BY captured_at DESC LIMIT 1) AS current_val
                    FROM portfolio_snapshots
                    WHERE user_id = $1
                `, [user.id])
            ]);

            const s          = statsRes.rows[0];
            const totalTrades = parseInt(s?.total_trades)  || 0;
            const wins        = parseInt(s?.wins)          || 0;
            const totalPnl    = parseFloat(s?.total_pnl)   || 0;
            const avgPnlPct   = parseFloat(s?.avg_pnl_pct) || 0;
            const winRate     = totalTrades > 0 ? Math.round(wins / totalTrades * 100) : 0;
            const pnlEmoji    = totalPnl > 0 ? '🟢' : totalPnl < 0 ? '🔴' : '⚪';

            // Order execution counters
            const os         = orderStatsRes.rows[0];
            const submitted  = parseInt(os?.submitted)  || 0;
            const filled     = parseInt(os?.filled)     || 0;
            const partial    = parseInt(os?.partial)    || 0;
            const cancelled  = parseInt(os?.cancelled)  || 0;
            const fillRate   = submitted > 0 ? Math.round(filled / submitted * 100) : 0;

            // Reconciliation
            const reconFixes  = parseInt(reconFixesRes.rows[0]?.fixes)  || 0;
            const reconErrors = parseInt(reconFixesRes.rows[0]?.errors) || 0;

            // Drawdown from peak
            const peak       = parseFloat(drawdownRes.rows[0]?.peak)        || 0;
            const curVal     = parseFloat(drawdownRes.rows[0]?.current_val) || 0;
            const drawdownPct = peak > 0 ? ((peak - curVal) / peak * 100) : 0;
            const ddEmoji     = drawdownPct >= 10 ? '🚨' : drawdownPct >= 5 ? '⚠️' : '✅';

            const lines = [
                `📅 *EOD Daily Digest — ${etDate}*`,
                '',
                `📊 Trades: ${totalTrades}  ✅ Wins: ${wins}  📈 Win Rate: ${winRate}%`,
                `${pnlEmoji} Total P&L: $${totalPnl.toFixed(2)}  Avg: ${avgPnlPct > 0 ? '+' : ''}${avgPnlPct}%`,
                '',
                `🔄 *Order Execution:* ${submitted} submitted | ${filled} filled | ${partial} partial | ${cancelled} cancelled`,
                submitted > 0 ? `  Fill rate: ${fillRate}%` : null,
                `${ddEmoji} *Drawdown from peak:* ${drawdownPct.toFixed(1)}%`,
                reconFixes > 0 || reconErrors > 0
                    ? `⚖️ *Reconciliation:* ${reconFixes} fix(es)${reconErrors > 0 ? ` | ⛔ ${reconErrors} error(s)` : ''}`
                    : `⚖️ *Reconciliation:* clean`,
            ].filter(l => l !== null);

            if (bigWinRes.rows.length > 0) {
                const w = bigWinRes.rows[0];
                const tags = Array.isArray(w.metadata?.autoTags) ? w.metadata.autoTags.join(', ') : '—';
                const exitReason = w.metadata?.exitReason || '';
                lines.push('');
                lines.push(`🏆 *Best:* ${w.symbol}  +$${parseFloat(w.pnl).toFixed(2)} (+${parseFloat(w.pnl_percent).toFixed(1)}%)`);
                lines.push(`  Setup: ${w.setup_family || '—'}  Tags: ${tags}`);
                if (exitReason) lines.push(`  Exit: ${exitReason}`);
            }

            if (bigLossRes.rows.length > 0) {
                const l = bigLossRes.rows[0];
                const tags = Array.isArray(l.metadata?.autoTags) ? l.metadata.autoTags.join(', ') : '—';
                const exitReason = l.metadata?.exitReason || '';
                lines.push('');
                lines.push(`📉 *Worst:* ${l.symbol}  -$${Math.abs(parseFloat(l.pnl)).toFixed(2)} (${parseFloat(l.pnl_percent).toFixed(1)}%)`);
                lines.push(`  Setup: ${l.setup_family || '—'}  Tags: ${tags}`);
                if (exitReason) lines.push(`  Exit: ${exitReason}`);
            }

            if (holdingsRes.rows.length > 0) {
                lines.push('');
                lines.push(`📦 *Open (${holdingsRes.rows.length}):*`);
                for (const h of holdingsRes.rows) {
                    const pct = parseFloat(h.unrealized_pct) || 0;
                    lines.push(`  ${pct >= 0 ? '↗' : '↘'} ${h.symbol}: ${pct > 0 ? '+' : ''}${pct}%  (${h.quantity} @ $${parseFloat(h.average_price).toFixed(2)})`);
                }
            } else {
                lines.push('');
                lines.push('📦 Flat into close — no open positions');
            }

            if (totalTrades === 0) {
                lines.push('');
                lines.push('_No completed trades today._');
            }

            // Nightly scan coverage + analytics (today's scan ran earlier)
            try {
                const precomputedSvc = require('./precomputedUniverseService');
                const [scanSummary, exclusions, newTickers] = await Promise.all([
                    precomputedSvc.getDailyScanSummary(),
                    precomputedSvc.getExclusionSummary(),
                    precomputedSvc.getNewTickers()
                ]);
                if (scanSummary && parseInt(scanSummary.total_analyzed) > 0) {
                    lines.push('');
                    lines.push(`🔭 *Universe Scan:* ${scanSummary.total_analyzed} analyzed | ${scanSummary.passed} passed | avg score ${scanSummary.avg_score} | top ${scanSummary.max_score}`);
                    // Top exclusion category
                    const topExclusion = exclusions[0];
                    if (topExclusion) {
                        lines.push(`  Top exclusion: ${topExclusion.category} (${topExclusion.count} stocks)`);
                    }
                    // Flag high error rate — usually means data provider issue
                    const errRow = exclusions.find(r => r.category === 'api_rate_limit' || r.category === 'error');
                    if (errRow && errRow.count > parseInt(scanSummary.total_analyzed) * 0.10) {
                        lines.push(`  ⚠️ High error rate: ${errRow.count} failures — check data provider`);
                    }
                }
                // New tickers spotted today
                if (newTickers.length > 0) {
                    lines.push(`🆕 New tickers: ${newTickers.slice(0, 8).join(', ')}${newTickers.length > 8 ? ` (+${newTickers.length - 8})` : ''}`);
                }
            } catch (_) {}

            // Gate trigger summary — shows how often each protective gate fired today
            const gateStats = enhancedAITradingBot.getGateStats(user.id);
            if (gateStats && (gateStats.edgeGate + gateStats.volumeGate + gateStats.regimeCap + gateStats.distressMode > 0)) {
                lines.push('');
                lines.push('🛡️ *Gate Activity Today:*');
                if (gateStats.edgeGate    > 0) lines.push(`  EdgeGate (no strong signal): ${gateStats.edgeGate}×`);
                if (gateStats.volumeGate  > 0) lines.push(`  VolumeGate (low volume):     ${gateStats.volumeGate}×`);
                if (gateStats.regimeCap   > 0) lines.push(`  RegimeCap (position limit):  ${gateStats.regimeCap}×`);
                if (gateStats.distressMode > 0) lines.push(`  DistressMode (≥2 reds):      ${gateStats.distressMode}×`);
            }

            // Sector health check (30-day window) — warn if any sector WR < 40% or P&L < -$200
            try {
                const sectorHealthRes = await query(`
                    SELECT COALESCE(metadata->>'sector', 'Unknown') AS sector,
                           COUNT(*)                                                                   AS trades,
                           ROUND(100.0 * COUNT(*) FILTER (WHERE pnl > 0) / NULLIF(COUNT(*), 0), 1)  AS win_rate,
                           ROUND(SUM(pnl)::numeric, 2)                                               AS total_pnl
                    FROM trade_decision_journal
                    WHERE user_id = $1 AND decision_phase = 'CLOSED' AND pnl IS NOT NULL
                      AND opened_at >= NOW() - INTERVAL '30 days'
                    GROUP BY 1 HAVING COUNT(*) >= 3
                    ORDER BY win_rate ASC
                `, [user.id]);
                const badSectors = sectorHealthRes.rows.filter(r =>
                    parseFloat(r.win_rate) < 40 || parseFloat(r.total_pnl) < -200
                );
                if (badSectors.length > 0) {
                    lines.push('');
                    lines.push('⚠️ *Sector Warning (30d):*');
                    for (const sec of badSectors) {
                        const pnlSign = parseFloat(sec.total_pnl) >= 0 ? '+' : '';
                        lines.push(`  ${sec.sector}: ${sec.win_rate}% WR | ${pnlSign}$${parseFloat(sec.total_pnl).toFixed(2)} (${sec.trades} trades)`);
                    }
                }
            } catch (_) {}

            await alertService.sendMessage(user.id, lines.join('\n'));
            console.log(`[DailyDigest] Sent for user ${user.id} — ${totalTrades} trades, P&L $${totalPnl.toFixed(2)}`);
        } catch (err) {
            console.error(`[DailyDigest] Error for user ${user.id}:`, err.message);
        }
    }
}

/**
 * Morning Position Reconciliation — fires once at 9:00 AM ET Mon-Fri.
 * Compares DB holdings against Alpaca before the first trading cycle starts.
 * Phantom/shadow/drift corrections are applied automatically; a Telegram
 * alert is sent only when discrepancies exist.
 */
let _morningReconRanDate = null;

async function runMorningReconciliationTick() {
    const { day, hour, min, date: etDate } = _getETNow();

    // Mon-Fri only, 09:00-09:09 ET window (before market open at 09:30)
    if (day < 1 || day > 5) return;
    if (hour !== 9 || min >= 10) return;
    if (_morningReconRanDate === etDate) return;
    _morningReconRanDate = etDate;

    console.log('[MorningReconcile] 9:00 AM ET — running position reconciliation');
    try {
        const reconSvc   = require('./positionReconciliationService');
        const activeUsers = await getActiveAIUsers();
        await reconSvc.runMorningReconciliation(activeUsers);
    } catch (err) {
        console.error('[MorningReconcile] Error:', err.message);
    }
}

/**
 * Morning Stop Verification — fires once at 9:31 AM ET Mon-Fri (1 min after open).
 *
 * Problem: ARROW EOD cancels unfilled buy orders before close. Even after the fix that
 * preserves sell-side stops, Alpaca GTC bracket legs can occasionally lapse. This function
 * runs a safety net: for every open position, ensure at least one active stop/stop_limit
 * order exists. If one is missing, it places a fresh GTC stop and fires a Telegram alert.
 */
let _morningStopVerifyRanDate = null;

async function runMorningStopVerification() {
    const { day, hour, min, date: etDate } = _getETNow();

    // Mon-Fri only, 09:31-09:44 ET window (just after market open)
    if (day < 1 || day > 5) return;
    if (hour !== 9 || min < 31 || min >= 45) return;
    if (_morningStopVerifyRanDate === etDate) return;
    _morningStopVerifyRanDate = etDate;

    console.log('[StopVerify] 9:31 AM ET — verifying protective stop orders for all positions');
    try {
        const Alpaca         = require('@alpacahq/alpaca-trade-api');
        const { query }      = require('../config/database');
        // Was requiring './alertService' — that module manages user-configured price
        // alerts (getAlertsByUserId/addAlert/deleteAlert) and has no sendMessage export
        // at all. Found 2026-08-18: 83f08677's 9:31 AM stop restore fired the log line
        // but the "stops restored" Telegram notification silently failed every time
        // with "alertService.sendMessage is not a function", caught by the outer
        // per-user try/catch so it never surfaced as anything louder than a warn log.
        const alertService   = require('./telegramAlertService');
        const userDb         = require('./userDatabaseService');
        const activeUsers    = await getActiveAIUsers();

        for (const user of activeUsers) {
            try {
                // Resolve credentials the same way brokerService/StopRepair do (falls back to
                // the shared .env paper account when a user has no personal keys) instead of
                // skipping outright — a prior version skipped any user without personal
                // credentials, which meant this 9:31 AM safety net silently never ran for
                // shared-fallback-account users at all, extended-hours or not. Found while
                // checking why a shared-account user's extended-hours entry didn't get its
                // promised 9:31 AM stop until StopRepair (a different mechanism) caught it hours
                // later during an outage (2026-08-03).
                const creds = await userDb.getUserAlpacaCredentials(user.id);
                if (!creds.keyId || !creds.secretKey) continue;

                const client = new Alpaca({
                    keyId: creds.keyId, secretKey: creds.secretKey,
                    paper: creds.isPaper !== false
                });

                const [positions, openOrders] = await Promise.all([
                    client.getPositions(),
                    client.getOrders({ status: 'open', limit: 200 })
                ]);

                if (!positions || positions.length === 0) continue;

                // Build set of symbols with active stop protection
                const protectedSymbols = new Set(
                    openOrders
                        .filter(o => o.side === 'sell' &&
                            (o.type === 'stop' || o.type === 'stop_limit' || o.type === 'trailing_stop'))
                        .map(o => o.symbol)
                );

                const riskCfg = await query(
                    `SELECT stop_loss FROM risk_configs WHERE user_id=$1 LIMIT 1`, [user.id]
                );
                const stopLossPct = riskCfg.rows[0]
                    ? Math.abs(parseFloat(riskCfg.rows[0].stop_loss))
                    : 0.05;

                const restored = [];
                for (const pos of positions) {
                    if (parseFloat(pos.qty) <= 0) continue;
                    if (protectedSymbols.has(pos.symbol)) continue;

                    // No stop found — place one immediately
                    const avgEntry = parseFloat(pos.avg_entry_price || pos.avg_cost || 0);
                    if (avgEntry <= 0) continue;
                    const stopPrice = parseFloat((avgEntry * (1 - stopLossPct)).toFixed(2));
                    const qty       = pos.qty;

                    try {
                        // Alpaca rejects GTC stop orders on fractional quantities (422) — only
                        // 'day' is accepted. This path builds its own Alpaca client instead of
                        // going through brokerService.placeStopOrder (which already handles this,
                        // fixed for the 2026-07-21 incident), so it had the same bug independently:
                        // AZO/PNC 422s in the logs traced back to this hardcoded 'gtc' (2026-08-23).
                        const isFractional = parseFloat(qty) !== Math.floor(parseFloat(qty));
                        await client.createOrder({
                            symbol: pos.symbol, qty, side: 'sell',
                            type: 'stop', time_in_force: isFractional ? 'day' : 'gtc',
                            stop_price: String(stopPrice)
                        });
                        restored.push(`${pos.symbol} stop@$${stopPrice}`);
                        console.log(`[StopVerify] Restored missing stop for ${pos.symbol} @ $${stopPrice}`);
                    } catch (placeErr) {
                        console.warn(`[StopVerify] Could not place stop for ${pos.symbol}:`, placeErr.message);
                    }
                }

                if (restored.length > 0) {
                    await alertService.sendMessage(user.id,
                        `⚠️ *Stop-loss gaps detected at open — restored automatically*\n\n` +
                        restored.map(r => `  ✅ ${r}`).join('\n') + `\n\n` +
                        `_These stops were missing at market open. Stops are now active._`
                    );
                }
            } catch (userErr) {
                console.warn(`[StopVerify] Error for user ${user.id}:`, userErr.message);
            }
        }
    } catch (err) {
        console.error('[StopVerify] Error:', err.message);
    }
}

/**
 * Morning Briefing — fires once at 8:00 AM ET Mon-Fri.
 * Sends a Telegram message with all STRONG BUY tickers from the most recent
 * nightly PANTHEON scan so users know what to watch before the open.
 */
let _morningBriefRanDate = null;
// Tracks which Telegram chat IDs already received today's briefing.
// Prevents duplicate sends when multiple users share the same chat ID.
const _morningBriefSentChats = new Set();

async function runMorningBriefing() {
    const { day, hour, min, date: etDate } = _getETNow();

    // Mon-Fri only, 08:00-08:09 ET window
    if (day < 1 || day > 5) return;
    if (hour !== 8 || min >= 10) return;

    // Reset chat-level dedup set on a new day
    if (_morningBriefRanDate !== etDate) {
        _morningBriefRanDate = etDate;
        _morningBriefSentChats.clear();
    }

    console.log('[MorningBriefing] Preparing 8 AM scan briefing…');
    try {
        const activeUsers = await getActiveAIUsers();
        if (!activeUsers.length) return;

        // Pull STRONG BUY tickers from the most recent scan (last 4 days)
        const strongBuyRes = await query(`
            SELECT symbol, ai_score, sector, setup_family
            FROM daily_universe_analysis
            WHERE analysis_date = (
                SELECT MAX(analysis_date)
                FROM   daily_universe_analysis
                WHERE  analysis_date >= CURRENT_DATE - INTERVAL '4 days'
                  AND  analysis_date <= CURRENT_DATE
                  AND  passed_prescreen = true
            )
            AND recommendation = 'STRONG BUY'
            ORDER BY ai_score DESC
        `);

        const tickers = strongBuyRes.rows;
        if (!tickers.length) {
            console.log('[MorningBriefing] No STRONG BUY tickers — skipping send');
            return;
        }

        // Group by setup family
        const leaders    = tickers.filter(t => t.setup_family === 'breakout_leader');
        const quality    = tickers.filter(t => t.setup_family === 'quality_continuation');
        const reversals  = tickers.filter(t => t.setup_family === 'oversold_reversal');
        const other      = tickers.filter(t => !['breakout_leader','quality_continuation','oversold_reversal'].includes(t.setup_family));

        // Real regime + VIX read, replacing what used to be a hardcoded "Regime: BULL"
        // string here regardless of actual conditions (found 2026-09-08, in response to
        // a request for routine VIX/situation updates — real spikes already get their
        // own immediate alert from vixSpikeMonitorService; this is the calm-state daily
        // context companion to that, reusing the same 20/25/30/40 thresholds so the two
        // never disagree on what counts as "elevated").
        let regimeLine = '🐂 Market opens in ~1.5h';
        let vixLine = null;
        try {
            const regime = await getMarketRegime();
            const vix = regime.vixLevel;
            const vixTag = vix >= 40 ? '🚨 Panic' : vix >= 30 ? '🔴 Extreme' : vix >= 25 ? '🟠 High' : vix >= 20 ? '🟡 Elevated' : '🟢 Calm';
            regimeLine = `${regime.regime === 'BULL' ? '🐂' : regime.regime === 'BEAR' ? '🐻' : '⚖️'} Market opens in ~1.5h | Regime: ${regime.regime} (${regime.regimeType})`;
            vixLine = `📉 VIX: ${vix.toFixed(1)} — ${vixTag}`;
        } catch (err) {
            console.warn('[MorningBriefing] Regime/VIX lookup failed, using generic line:', err.message);
        }

        let overnightLine = null;
        try {
            const sentiment = await getGlobalSentiment();
            const d = sentiment?.rawData || {};
            const parts = [];
            if (d.nikkeiPct !== null && d.nikkeiPct !== undefined) parts.push(`Nikkei ${d.nikkeiPct >= 0 ? '+' : ''}${d.nikkeiPct.toFixed(1)}%`);
            if (d.hsiPct    !== null && d.hsiPct    !== undefined) parts.push(`HSI ${d.hsiPct >= 0 ? '+' : ''}${d.hsiPct.toFixed(1)}%`);
            if (d.sensexPct !== null && d.sensexPct !== undefined) parts.push(`Sensex ${d.sensexPct >= 0 ? '+' : ''}${d.sensexPct.toFixed(1)}%`);
            if (parts.length) overnightLine = `🌏 Overnight: ${parts.join(' | ')}`;
        } catch (err) {
            console.warn('[MorningBriefing] Overnight sentiment lookup failed, omitting:', err.message);
        }

        const lines = [
            `📊 *Morning Briefing — ${etDate}*`,
            regimeLine,
        ];
        if (vixLine) lines.push(vixLine);
        if (overnightLine) lines.push(overnightLine);
        lines.push('');
        lines.push(`🌟 *STRONG BUY: ${tickers.length} tickers* from PANTHEON overnight scan`);

        const fmt = t => `  ${t.symbol} — Score ${t.ai_score} | ${t.sector || 'Unknown'}`;

        if (leaders.length) {
            lines.push('');
            lines.push('🚀 *Breakout Leaders:*');
            leaders.forEach(t => lines.push(fmt(t)));
        }
        if (quality.length) {
            lines.push('');
            lines.push('💎 *Quality Continuation:*');
            quality.forEach(t => lines.push(fmt(t)));
        }
        if (reversals.length) {
            lines.push('');
            lines.push('🔄 *Oversold Reversal:*');
            reversals.forEach(t => lines.push(fmt(t)));
        }
        if (other.length) {
            lines.push('');
            lines.push('📌 *Other:*');
            other.forEach(t => lines.push(fmt(t)));
        }

        lines.push('');
        lines.push('_Bot will analyze top candidates live from 9:30 AM ET_');

        const message = lines.join('\n');
        let sentCount = 0;
        let waSent = false;
        for (const user of activeUsers) {
            const chatId = await alertService.getUserTelegramChatId
                ? await alertService.getUserTelegramChatId(user.id)
                : null;
            const dedupeKey = chatId || user.id;
            if (_morningBriefSentChats.has(dedupeKey)) continue;
            _morningBriefSentChats.add(dedupeKey);
            await alertService.sendMessage(user.id, message);
            sentCount++;
        }
        // WhatsApp — once only, regardless of user count
        if (sentCount > 0 && !waSent) {
            const wa = require('./whatsappAlertService');
            wa.alertMorningBriefing(etDate, tickers.length, tickers.slice(0, 10)).catch(() => {});
            waSent = true;
        }
        console.log(`[MorningBriefing] Sent to ${sentCount}/${activeUsers.length} unique chat(s) — ${tickers.length} STRONG BUY tickers`);
    } catch (err) {
        console.error('[MorningBriefing] Error:', err.message);
    }
}

/**
 * Nightly universe scan trigger — called every 5 min by the scheduler loop.
 *
 * Completion-driven: keeps retrying (missing tickers only) until today's
 * analysis count reaches SCAN_COMPLETE_THRESHOLD. This handles partial scans
 * caused by backend restarts, rate-limit crashes, or any other interruption.
 *
 * Operating window: Mon–Fri, 16:15–23:00 ET.
 * Stops for the day once complete so it doesn't burn API quota overnight.
 */
const SCAN_COMPLETE_THRESHOLD = 420; // ~92% of 455-symbol universe (allows for ETF nulls)
let _scanCompletedDate = null;       // date string when we saw >= threshold for the day

async function runNightlyScanTrigger() {
    const { day: etDay, hour: etHour, min: etMin, date: etDate } = _getETNow();

    // One continuous overnight window: 4:15 PM ET (15 min after close) through 9:25 AM ET
    // the next morning (5 min before open) — the entire quiet stretch when there's no live
    // trading to compete with for API throughput. Previously this was two separate windows
    // (4:15 PM–11 PM, then 6:00–9:25 AM) with a 7-hour dead zone between 11 PM and 6 AM
    // where an incomplete scan just sat stalled doing nothing — found 2026-08-25: the scan
    // now switched to the full ~13,000-symbol universe (see the getStockUniverse() comment
    // a few lines below in nightlyUniverseScanService.js) genuinely needs the full night to
    // reliably finish before market open, not just fragments of it. Modeled as "blocked
    // only during market-adjacent daytime hours" (9:26 AM–4:14 PM ET) rather than two
    // separate allow-windows, so it naturally covers the full night including the midnight
    // crossover without special-casing it.
    if (etDay < 1 || etDay > 5) return;
    const inDaytimeBlock = (etHour > 9 || (etHour === 9 && etMin > 25)) &&
                            (etHour < 16 || (etHour === 16 && etMin < 15));
    if (inDaytimeBlock) return;

    // Already confirmed complete for today
    if (_scanCompletedDate === etDate) return;

    // Check current progress in DB — use most recent scan date (not CURRENT_DATE).
    // Nightly scan stores rows with the date it ran (e.g. 4:15 PM Jun 11 → analysis_date=Jun 11).
    // Querying CURRENT_DATE would always find 0 on the same evening and re-launch redundantly.
    let todayCount = 0;
    try {
        // COUNT(*) of all rows, not just ai_score IS NOT NULL — the latter never reached
        // SCAN_COMPLETE_THRESHOLD on a night with any permanent failures (delisted/bad
        // data symbols), since those write a row with a null score and stay null forever.
        // Paired with the same fix in nightlyUniverseScanService.js's missingOnly resume
        // set: found 2026-08-26, both together caused an infinite ~9min retry loop on the
        // same 17 permanently-failing symbols, all day, every day a batch had failures.
        const { rows } = await query(
            `SELECT analysis_date, COUNT(*) AS cnt
             FROM daily_universe_analysis
             WHERE analysis_date = (
                 SELECT MAX(analysis_date)
                 FROM daily_universe_analysis
                 WHERE analysis_date >= CURRENT_DATE - INTERVAL '1 day'
                   AND analysis_date <= CURRENT_DATE
             )
             GROUP BY analysis_date`
        );
        const row = rows[0];
        // The window above deliberately allows yesterday's date to match (a scan
        // started before midnight still needs its in-progress count recognized).
        // But if NOTHING has been scanned yet today, that same window still
        // matches yesterday's already-COMPLETED scan, and its count would
        // wrongly look like today's progress — declaring today "done" without
        // it ever running. Found 2026-08-20/21: Aug 19's success (434 scored)
        // sat un-superseded and got misread as complete on both following
        // evenings, so the real scan never launched for two days straight.
        // Only trust the count when the matched date is actually today.
        if (row && new Date(row.analysis_date).toISOString().slice(0, 10) === etDate) {
            todayCount = parseInt(row.cnt ?? 0);
        }
    } catch (_) { return; }

    // Scan is complete for today — stop checking
    if (todayCount >= SCAN_COMPLETE_THRESHOLD) {
        if (_scanCompletedDate !== etDate) {
            console.log(`[NightlyScanTrigger] ✅ Complete for ${etDate}: ${todayCount} symbols analyzed`);
            _scanCompletedDate = etDate;
        }
        return;
    }

    // A scan is already running — wait for it to finish before launching another
    const nightlyScanSvc = require('./nightlyUniverseScanService');
    if (nightlyScanSvc.isScanRunning()) return;

    // Launch scan — resume mode if partial data exists, full scan if starting fresh
    const isResume = todayCount > 0;
    console.log(`[NightlyScanTrigger] ${isResume ? `Resuming (${todayCount} done, ${SCAN_COMPLETE_THRESHOLD - todayCount}+ remaining)` : 'Starting'} nightly scan for ${etDate}`);

    nightlyScanSvc.runNightlyUniverseScan({ missingOnly: isResume })
        .then(r => {
            if (!r) return;
            console.log(`[NightlyScanTrigger] Run finished: +${r.analyzed} analyzed, ${r.passed} passed, ${r.failed} failed in ${r.elapsedMin}min`);
        })
        .catch(err => console.error('[NightlyScanTrigger] Run error:', err.message));
}

// Debounce state for runScanHealthCheck — module-level so it survives across the
// 5-minute ticks that call it.
let _lastStallAlertAt     = 0;
let _deadlineAlertSentFor = null;

/**
 * Nightly scan health check — the actual gap this closes: every failure mode found
 * this session (the 38-min/symbol slowdown, the cache stampede, the 7+ hour single-build
 * cost) was only ever discovered by manually watching logs for hours. Nothing paged
 * anyone when the scan silently underperformed. Two checks, both admin-only via the
 * existing alertNightlyScanFailure Telegram alert:
 *   1. Stall detection — the scan believes it's still running (isScanRunning() true)
 *      but hasn't written a new scored symbol in 45+ minutes. Fires at most once per
 *      hour so a genuinely slow-but-alive scan doesn't spam.
 *   2. Deadline miss — checked once, in the last few minutes before market open: did
 *      today's scan actually reach SCAN_COMPLETE_THRESHOLD? If not, today's trading
 *      is about to run on stale/fallback data and someone should know before 9:30,
 *      not discover it by accident hours later.
 */
async function runScanHealthCheck() {
    const { day: etDay, hour: etHour, min: etMin, date: etDate } = _getETNow();
    if (etDay < 1 || etDay > 5) return;

    const nightlyScanSvc = require('./nightlyUniverseScanService');

    // --- Stall detection ---
    if (nightlyScanSvc.isScanRunning()) {
        try {
            const { rows } = await query(
                `SELECT MAX(created_at) AS last_write,
                        COUNT(*) AS total,
                        COUNT(*) FILTER (WHERE ai_score IS NOT NULL) AS scored
                 FROM daily_universe_analysis WHERE analysis_date = CURRENT_DATE`
            );
            const lastWrite     = rows[0]?.last_write ? new Date(rows[0].last_write) : null;
            const scored        = parseInt(rows[0]?.scored ?? 0, 10);
            const totalToday    = parseInt(rows[0]?.total ?? 0, 10);
            const cooldownOk    = Date.now() - _lastStallAlertAt > 60 * 60 * 1000;

            // A scan that already reached completion threshold naturally goes quiet —
            // nothing left to write — and isScanRunning() can still read true for a
            // while after (in-memory flag, only cleared in the scan's own finally
            // block; a resume/rescan on the same date, or a restart mid-transition,
            // can leave a window where the flag hasn't caught up with reality). Found
            // 2026-09-01: last night's scan genuinely completed (438 symbols, 3
            // separate "✅ Complete" confirmations logged) and this fired a false
            // "stalled — no new symbol scored in 59 min, still marked running" alert
            // anyway, because it only ever checked isScanRunning() + time-since-write,
            // never whether the day's work was actually done. Same false-positive
            // class as the earlier "Infinity min" fix, different trigger condition.
            if (totalToday >= SCAN_COMPLETE_THRESHOLD) return;

            // Was `lastWrite ? ... : Infinity` — zero rows written yet is the NORMAL
            // state for the first 1-2+ hours of a run (the HERMES universe-build pass
            // over ~13,000 symbols happens entirely before the first AI-analysis row is
            // ever upserted; validated live this session at well over an hour on a slow
            // night). Infinity trivially exceeds any threshold, so this fired a false
            // "stalled — Infinity min" alert on every restart, every single night,
            // during the completely normal pre-scoring build phase. Confirmed live
            // 2026-08-28. Now falls back to elapsed time since the scan actually
            // started (nightlyUniverseScanService now tracks and exposes this) instead
            // of a sentinel that always trips. Threshold for "never written anything
            // yet" is deliberately looser (90 min) than "went quiet after scoring
            // started" (45 min) — the build phase legitimately runs long; genuine
            // per-symbol stalls after scoring starts are what the tighter 45 min
            // threshold still exists to catch.
            let staleMinutes;
            let stallThreshold;
            if (lastWrite) {
                staleMinutes = (Date.now() - lastWrite.getTime()) / 60000;
                stallThreshold = 45;
            } else {
                const scanStart = nightlyScanSvc.getScanStartTime();
                staleMinutes = scanStart ? (Date.now() - scanStart) / 60000 : 0;
                stallThreshold = 90;
            }

            if (staleMinutes >= stallThreshold && cooldownOk) {
                _lastStallAlertAt = Date.now();
                const reason = lastWrite
                    ? `Scan appears stalled — no new symbol scored in ${Math.round(staleMinutes)} min, still marked running`
                    : `Scan has been running ${Math.round(staleMinutes)} min without writing its first row — universe build may be stuck`;
                await alertService.alertNightlyScanFailure({
                    analyzed: scored, universe: SCAN_COMPLETE_THRESHOLD, failed: 0, reason
                });
            }
        } catch (e) {
            console.warn('[ScanHealthCheck] Stall check failed:', e.message);
        }
    }

    // --- Deadline miss — check once, 9:20-9:29 AM ET, right before open ---
    if (etHour === 9 && etMin >= 20 && etMin <= 29 && _deadlineAlertSentFor !== etDate) {
        try {
            const { rows } = await query(
                `SELECT COUNT(*) FILTER (WHERE ai_score IS NOT NULL) AS scored
                 FROM daily_universe_analysis WHERE analysis_date = CURRENT_DATE`
            );
            const scored = parseInt(rows[0]?.scored ?? 0, 10);
            if (scored < SCAN_COMPLETE_THRESHOLD) {
                _deadlineAlertSentFor = etDate;
                await alertService.alertNightlyScanFailure({
                    analyzed: scored, universe: SCAN_COMPLETE_THRESHOLD, failed: 0,
                    reason: `Only ${scored} symbols scored before market open — today's trading will run on stale/fallback data`
                });
            }
        } catch (e) {
            console.warn('[ScanHealthCheck] Deadline check failed:', e.message);
        }
    }
}

/**
 * Pre-Market Gap Briefing — fires once at 8:30 AM ET Mon-Fri.
 * Checks each STRONG BUY setup from last night's scan against the current
 * pre-market price. Sends a Telegram message bucketing stocks into:
 *   CHASE   (gapped >+2% — wait for pullback, bot will skip at entry time)
 *   VALID   (within −1% to +2% of scan entry — still tradeable)
 *   BELOW   (gapped down >−1.5% — possible better entry than expected)
 */
let _premarketGapRanDate = null;

async function runPremarketGapBriefing() {
    const { day, hour, min, date: etDate } = _getETNow();

    // Mon-Fri only, 08:30-08:39 ET window
    if (day < 1 || day > 5) return;
    if (hour !== 8 || min < 30 || min >= 40) return;
    if (_premarketGapRanDate === etDate) return;
    _premarketGapRanDate = etDate;

    console.log('[PremarketGap] 8:30 AM ET — running gap check on tonight setups…');
    try {
        await premarketGapService.runPremarketGapAlert();
    } catch (err) {
        console.error('[PremarketGap] Error:', err.message);
    }
}

/**
 * Sunday Night Global Market Scout — fires once at 20:00–20:59 ET every Sunday.
 *
 * By 8 PM ET on Sunday, Asian markets are already open (Tokyo 9 AM Monday,
 * Hong Kong 9:15 AM Monday, Sydney already trading).  European futures open
 * around 8 PM ET as well.  This gives a ~13-hour head start on Monday's US session.
 *
 * What it does:
 *   1. Pulls US futures (ES=F, NQ=F, YM=F) + Asian/European indices from Yahoo Finance
 *   2. Determines global sentiment: BULLISH / BEARISH / MIXED / NEUTRAL
 *   3. Runs the full nightly universe scan for Monday (same as weekday EOD scan)
 *   4. Sends a Telegram "Monday Morning Preview" with sentiment + top setups
 */
let _sundayScoutRanDate = null;

async function runSundayGlobalScout() {
    const { day, hour, date: etDate } = _getETNow();

    // Sunday only, 20:00–20:59 ET window
    if (day !== 0) return;
    if (hour !== 20) return;
    if (_sundayScoutRanDate === etDate) return;
    _sundayScoutRanDate = etDate;

    console.log('[SundayScout] 8 PM ET Sunday — starting global market scout for Monday preview');

    // ── 1. Fetch global market data from Yahoo Finance ────────────────────────
    const GLOBAL_MARKETS = [
        { sym: 'ES=F',   label: 'S&P 500 Futures',    region: 'US_FUTURES'  },
        { sym: 'NQ=F',   label: 'NASDAQ Futures',      region: 'US_FUTURES'  },
        { sym: 'YM=F',   label: 'Dow Futures',         region: 'US_FUTURES'  },
        { sym: '^N225',  label: 'Nikkei 225 (Japan)',  region: 'ASIA'        },
        { sym: '^HSI',   label: 'Hang Seng (HK)',      region: 'ASIA'        },
        { sym: '^AXJO',  label: 'ASX 200 (Australia)', region: 'ASIA'        },
        { sym: '^FTSE',  label: 'FTSE 100 (UK)',       region: 'EUROPE'      },
        { sym: '^GDAXI', label: 'DAX (Germany)',       region: 'EUROPE'      },
    ];

    const marketData = [];
    try {
        // yahoo-finance2 must be called with spacing to avoid 429 rate limiting
        const yf = require('yahoo-finance2');
        const quoteFn = yf.default?.quoteSummary
            ? async (sym) => {
                const r = await yf.default.quoteSummary(sym, { modules: ['price'] });
                return r?.price;
            }
            : null;

        // Fallback: direct HTTP fetch from Yahoo Finance query API
        const https = require('https');
        const fetchYahooQuote = (sym) => new Promise((resolve, reject) => {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;
            const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const j = JSON.parse(data);
                        const meta = j?.chart?.result?.[0]?.meta;
                        resolve(meta ? {
                            price:         meta.regularMarketPrice,
                            prevClose:     meta.chartPreviousClose || meta.previousClose,
                            changePct:     meta.regularMarketPrice && meta.chartPreviousClose
                                           ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100)
                                           : null,
                        } : null);
                    } catch { resolve(null); }
                });
            });
            req.on('error', reject);
            req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
        });

        for (const mkt of GLOBAL_MARKETS) {
            try {
                await new Promise(r => setTimeout(r, 600)); // 600ms spacing to avoid 429
                const q = await fetchYahooQuote(mkt.sym);
                if (q && q.changePct !== null) {
                    marketData.push({ ...mkt, changePct: parseFloat(q.changePct.toFixed(2)), price: q.price });
                    console.log(`[SundayScout] ${mkt.sym}: ${q.changePct >= 0 ? '+' : ''}${q.changePct?.toFixed(2)}%`);
                }
            } catch (e) {
                console.warn(`[SundayScout] ${mkt.sym} fetch failed: ${e.message}`);
            }
        }
    } catch (fetchErr) {
        console.warn('[SundayScout] Global market fetch error:', fetchErr.message);
    }

    // ── 2. Determine global sentiment ─────────────────────────────────────────
    let sentiment = 'NEUTRAL';
    let sentimentEmoji = '⚪';
    if (marketData.length >= 3) {
        const avgChange = marketData.reduce((s, m) => s + m.changePct, 0) / marketData.length;
        const usFutures = marketData.filter(m => m.region === 'US_FUTURES');
        const usAvg     = usFutures.length ? usFutures.reduce((s, m) => s + m.changePct, 0) / usFutures.length : 0;
        const positives = marketData.filter(m => m.changePct > 0.3).length;
        const negatives = marketData.filter(m => m.changePct < -0.3).length;

        if (usAvg > 0.5 && positives >= negatives) { sentiment = 'BULLISH';  sentimentEmoji = '🟢'; }
        else if (usAvg < -0.5 || negatives > positives + 1) { sentiment = 'BEARISH'; sentimentEmoji = '🔴'; }
        else if (positives > 0 && negatives > 0)  { sentiment = 'MIXED';    sentimentEmoji = '🟡'; }
    }
    console.log(`[SundayScout] Global sentiment: ${sentiment} (${marketData.length} markets tracked)`);

    // ── 3. Trigger full nightly universe scan (Monday candidates) ─────────────
    try {
        const nightlyScanSvc = require('./nightlyUniverseScanService');
        nightlyScanSvc.runNightlyUniverseScan()
            .then(r => {
                if (r) console.log(`[SundayScout] Monday scan done: ${r.passed} passed / ${r.analyzed} analyzed`);
            })
            .catch(err => console.error('[SundayScout] Scan error:', err.message));
        console.log('[SundayScout] Monday nightly scan launched in background');
    } catch (scanErr) {
        console.error('[SundayScout] Failed to launch scan:', scanErr.message);
    }

    // ── 4. Send Telegram Monday Morning Preview ────────────────────────────────
    try {
        const activeUsers = await getActiveAIUsers();
        if (!activeUsers.length) return;

        // Build global market summary lines
        const byRegion = { US_FUTURES: [], ASIA: [], EUROPE: [] };
        for (const m of marketData) {
            const sign = m.changePct >= 0 ? '+' : '';
            byRegion[m.region]?.push(`  • ${m.label}: ${sign}${m.changePct}%`);
        }

        let globalBlock = '';
        if (byRegion.US_FUTURES.length) globalBlock += `*🇺🇸 US Futures*\n${byRegion.US_FUTURES.join('\n')}\n\n`;
        if (byRegion.ASIA.length)       globalBlock += `*🌏 Asian Markets*\n${byRegion.ASIA.join('\n')}\n\n`;
        if (byRegion.EUROPE.length)     globalBlock += `*🌍 European Futures*\n${byRegion.EUROPE.join('\n')}\n\n`;
        if (!globalBlock) globalBlock = '_Global market data unavailable — check manually_\n\n';

        // Pull strong buy candidates from the most recent scan (scan just launched — use last 4 days as fallback)
        const tickers = await query(`
            SELECT symbol, ai_score, sector, setup_family, recommendation
            FROM daily_universe_analysis
            WHERE analysis_date = (
                SELECT MAX(analysis_date) FROM daily_universe_analysis
                WHERE analysis_date >= CURRENT_DATE - INTERVAL '4 days'
                  AND passed_prescreen = true
            )
            AND ai_score >= 80
            ORDER BY ai_score DESC
            LIMIT 8
        `);

        let tickerBlock = '';
        if (tickers.rows.length) {
            tickerBlock = `*📋 Monday Watchlist* (top scored)\n` +
                tickers.rows.map(t =>
                    `  • *${t.symbol}* — score ${t.ai_score} | ${t.recommendation} | ${t.sector || 'N/A'}`
                ).join('\n') + '\n\n';
        } else {
            tickerBlock = '_Scan still running — check Universe Scanner in ~15 min for Monday setups_\n\n';
        }

        const sentNote = sentiment === 'BULLISH'  ? '📈 Global markets are GREEN heading into Monday. Conditions favor BUY setups.'
                       : sentiment === 'BEARISH'  ? '📉 Global markets are RED. Consider tighter stops and reduced position sizes Monday.'
                       : sentiment === 'MIXED'    ? '⚠️ Mixed signals from global markets. Be selective — wait for clean setups after open.'
                       :                            '➡️ Global markets are flat. Watch for momentum signals after the US open.';

        const msg =
            `${sentimentEmoji} *Monday Morning Preview*\n` +
            `_Generated Sunday ${et.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })} ET_\n\n` +
            `*Global Sentiment: ${sentiment}*\n${sentNote}\n\n` +
            globalBlock +
            tickerBlock +
            `_Bot will scan for Strong Buys (≥90) at market open. Full universe results in Universe Scanner._`;

        const sentChats = new Set();
        for (const user of activeUsers) {
            try {
                const chatId = user.telegram_chat_id;
                if (!chatId || sentChats.has(chatId)) continue;
                sentChats.add(chatId);
                await alertService.sendMessage(user.id, msg);
            } catch (_) {}
        }
        console.log(`[SundayScout] Monday preview sent to ${sentChats.size} chat(s) — sentiment: ${sentiment}`);
    } catch (msgErr) {
        console.error('[SundayScout] Telegram send error:', msgErr.message);
    }
}

/**
 * Morning Portfolio Digest — fires once at 9:25 AM ET Mon-Fri (5 min before open).
 * Sends a Telegram summary: equity, cash, open positions with hold age + P/L,
 * max-hold warnings, and SENTINEL status.  Useful when away from the desk.
 */
let _morningDigestRanDate = null;
const _morningDigestSentChats = new Set();

async function runMorningDigest() {
    const { day, hour, min, date: etDate } = _getETNow();

    // Mon-Fri only, 09:25-09:34 ET window
    if (day < 1 || day > 5) return;
    if (hour !== 9 || min < 25 || min >= 35) return;

    if (_morningDigestRanDate !== etDate) {
        _morningDigestRanDate = etDate;
        _morningDigestSentChats.clear();
    }

    const activeUsers = await getActiveAIUsers();
    for (const user of activeUsers) {
        const chatId = user.telegram_chat_id;
        if (!chatId || _morningDigestSentChats.has(chatId)) continue;
        _morningDigestSentChats.add(chatId);

        try {
            const { query: dbQuery } = require('../config/database');
            const axios = require('axios');
            const userDb = require('./userDatabaseService');
            const { checkLiveReadiness } = require('./liveReadinessService');

            // Alpaca account
            const creds   = await userDb.getUserAlpacaCredentials(user.id);
            const base    = creds.isPaper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
            const headers = { 'APCA-API-KEY-ID': creds.keyId, 'APCA-API-SECRET-KEY': creds.secretKey };

            const [acctRes, posRes] = await Promise.all([
                axios.get(`${base}/v2/account`, { headers, timeout: 8000 }),
                axios.get(`${base}/v2/positions`, { headers, timeout: 8000 }),
            ]);
            const acct      = acctRes.data;
            const positions = posRes.data;
            const equity    = parseFloat(acct.equity);
            const cash      = parseFloat(acct.cash);
            const dayPL     = parseFloat(acct.equity) - parseFloat(acct.last_equity);

            // DB holdings for hold-age
            const holdRes = await dbQuery(
                `SELECT symbol, purchase_date, quantity FROM holdings WHERE user_id=$1 AND quantity>0`,
                [user.id]
            );
            const holdMap = new Map(holdRes.rows.map(r => [r.symbol, r.purchase_date]));

            // SENTINEL
            const readiness = await checkLiveReadiness(String(user.id));

            // Build position lines
            const posLines = positions
                .filter(p => parseFloat(p.qty) > 0.0001)
                .map(p => {
                    const pl     = (parseFloat(p.unrealized_plpc) * 100).toFixed(2);
                    const plSign = parseFloat(pl) >= 0 ? '+' : '';
                    const purchaseDate = holdMap.get(p.symbol);
                    const holdHrs = purchaseDate
                        ? Math.round((Date.now() - new Date(purchaseDate).getTime()) / 3600000)
                        : null;
                    const holdTag = holdHrs != null ? ` ${holdHrs}h` : '';
                    const warn    = holdHrs != null && holdHrs >= 168 ? ' ⚠️ MAX-HOLD' : '';
                    return `  ${plSign}${pl}%${holdTag}${warn} — *${p.symbol}*`;
                });

            const sentinelLine = readiness.ready
                ? `✅ SENTINEL clear`
                : `⛔ SENTINEL blocked: ${readiness.reason}`;

            const dayPLSign = dayPL >= 0 ? '+' : '';
            const lines = [
                `📊 *Morning Digest — ${etDate}*`,
                ``,
                `💰 Equity: *$${equity.toFixed(2)}*  Cash: $${cash.toFixed(2)}`,
                `📈 Day P/L: *${dayPLSign}$${dayPL.toFixed(2)}*`,
                ``,
                `🗂 Open Positions (${posLines.length}):`,
                ...(posLines.length > 0 ? posLines : ['  — none —']),
                ``,
                sentinelLine,
            ];

            await alertService.sendTelegramMessage(chatId, lines.join('\n'));
            console.log(`[MorningDigest] Sent to chat ${chatId} (${etDate})`);
        } catch (err) {
            console.error('[MorningDigest] Error sending digest:', err.message);
        }
    }
}

/**
 * Start the scheduler
 */
function startScheduler() {
    if (schedulerInterval) {
        console.log('[Enhanced AI Scheduler] Already running');
        return;
    }

    console.log('[Enhanced AI Scheduler] Starting enhanced AI trading scheduler...');
    console.log('[Enhanced AI Scheduler] Check interval: 5 minutes');
    console.log('[Enhanced AI Scheduler] Will only trade during market hours (9:30 AM - 4:00 PM ET, Mon-Fri)');

    // Startup reconciliation — verify DB holdings match Alpaca before the first
    // trading cycle runs.  A crash or restart at any time of day can create
    // divergence; this fires once on every process start, not just at 9 AM.
    (async () => {
        try {
            const reconSvc    = require('./positionReconciliationService');
            const activeUsers = await getActiveAIUsers();
            if (activeUsers.length > 0) {
                console.log('[Enhanced AI Scheduler] Running startup position reconciliation…');
                await reconSvc.runMorningReconciliation(activeUsers, { trigger: 'STARTUP' });
            }
        } catch (reconErr) {
            console.error('[Enhanced AI Scheduler] Startup reconciliation error:', reconErr.message);
        }
    })();

    // Run immediately on start
    runScheduledTrading();

    // Then run every 5 minutes
    schedulerInterval = setInterval(() => {
        runScheduledTrading();
        runEodCleanup();                   // cancel partial fills at 15:44 ET
        runNightlyScanTrigger();           // nightly universe scan at 16:15 ET (after close)
        runScanHealthCheck();              // stall/deadline alert — catches a bad scan in hours, not days
        runWeeklyParameterHealthCheck();   // Friday 15:45 ET: health check + backtest summary
        runMorningBriefing();              // 8:00 AM ET Mon-Fri: STRONG BUY pre-market alert
        runPremarketGapBriefing();         // 8:30 AM ET Mon-Fri: gap check on tonight's setups
        runMorningReconciliationTick();    // 9:00 AM ET Mon-Fri: DB vs Alpaca position sync
        runMorningStopVerification();      // 9:31 AM ET Mon-Fri: ensure every position has an active stop
        runMorningDigest();                // 9:25 AM ET Mon-Fri: portfolio digest via Telegram
        runSundayGlobalScout();            // 8:00 PM ET Sunday: global markets + Monday preview
        extendedHoursTradingService.runExtendedHoursCycle().catch(err =>
            console.error('[ExtendedHours] Cycle error:', err.message)
        );                                 // 4:00-9:30 AM & 4:00-8:00 PM ET Mon-Fri: opt-in extended-hours entries
    }, CHECK_INTERVAL);

    console.log('[Enhanced AI Scheduler] ✓ Scheduler started successfully\n');
    console.log('[Enhanced AI Scheduler] Nightly scan trigger: 16:15 ET Mon-Fri\n');
    console.log('[Enhanced AI Scheduler] Sunday global scout: 20:00 ET Sunday\n');
}

/**
 * Stop the scheduler
 */
function stopScheduler() {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
        console.log('[Enhanced AI Scheduler] Scheduler stopped');
    }
}

// ─── WEEKLY PARAMETER HEALTH CHECK ──────────────────────────────────────────
// Fires once per week (Friday after 3:45 PM ET).
// Reads trade_decision_journal to compute win rates by score bucket and regime,
// then sends a Telegram summary with suggested threshold adjustments.
// Does NOT auto-apply — gives the operator visibility to decide.
let _weeklyHealthRanDate = null;

async function runWeeklyParameterHealthCheck() {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const parts  = formatter.formatToParts(new Date());
    const etDay  = parts.find(p => p.type === 'weekday').value;
    const etHour = parseInt(parts.find(p => p.type === 'hour').value,   10);
    const etMin  = parseInt(parts.find(p => p.type === 'minute').value, 10);
    const etDate = `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}-${parts.find(p=>p.type==='day').value}`;

    if (etDay !== 'Fri' || etHour !== 15 || etMin < 45) return;
    if (_weeklyHealthRanDate === etDate) return;
    _weeklyHealthRanDate = etDate;

    console.log('[Weekly Health] Starting weekly parameter health check...');
    try {
        const since30  = new Date(); since30.setDate(since30.getDate() - 30);
        const since90  = new Date(); since90.setDate(since90.getDate() - 90);
        const str30    = since30.toISOString().split('T')[0];
        const str90    = since90.toISOString().split('T')[0];

        // ── Win rate by score bucket (last 30 days) ──────────────────────────
        const scoreRes = await query(`
            SELECT
                CASE
                    WHEN score >= 90 THEN '90+'
                    WHEN score >= 85 THEN '85-89'
                    WHEN score >= 82 THEN '82-84'
                    ELSE '<82'
                END AS bucket,
                COUNT(*) AS total,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
                ROUND(AVG(pnl_percent)::numeric, 2) AS avg_pnl_pct
            FROM trade_decision_journal
            WHERE created_at >= $1 AND pnl IS NOT NULL AND decision_phase = 'EXIT'
            GROUP BY 1 ORDER BY 1 DESC
        `, [str30]);

        // ── Win rate by regime (last 30 days) ─────────────────────────────────
        const regimeRes = await query(`
            SELECT
                COALESCE(regime, 'UNKNOWN') AS regime,
                COUNT(*) AS total,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
                ROUND(AVG(pnl_percent)::numeric, 2) AS avg_pnl_pct
            FROM trade_decision_journal
            WHERE created_at >= $1 AND pnl IS NOT NULL AND decision_phase = 'EXIT'
            GROUP BY 1 ORDER BY 4 DESC
        `, [str30]);

        // ── Alpha decay: 30-day win rate vs. prior 60-day window ──────────────
        const decayRes = await query(`
            SELECT
                COALESCE(setup_family, 'unknown') AS setup_family,
                SUM(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END) AS total_30d,
                SUM(CASE WHEN created_at >= NOW() - INTERVAL '30 days' AND pnl > 0 THEN 1 ELSE 0 END) AS wins_30d,
                SUM(CASE WHEN created_at < NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END) AS total_prior,
                SUM(CASE WHEN created_at < NOW() - INTERVAL '30 days' AND pnl > 0 THEN 1 ELSE 0 END) AS wins_prior,
                ROUND(AVG(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN pnl_percent END)::numeric, 2) AS avg_30d,
                ROUND(AVG(CASE WHEN created_at < NOW() - INTERVAL '30 days' THEN pnl_percent END)::numeric, 2) AS avg_prior
            FROM trade_decision_journal
            WHERE created_at >= $1 AND pnl IS NOT NULL AND decision_phase = 'EXIT'
            GROUP BY 1 ORDER BY 1
        `, [str90]);

        // ── Slippage report (last 30 days) ────────────────────────────────────
        const slippageRes = await query(`
            SELECT
                COALESCE(setup_family, 'unknown') AS setup_family,
                COUNT(*) AS n,
                ROUND(AVG((metadata->>'slippagePct')::numeric), 3) AS avg_slip_pct,
                ROUND(MAX(ABS((metadata->>'slippagePct')::numeric)), 3) AS max_slip_pct
            FROM trade_decision_journal
            WHERE created_at >= $1
              AND decision_phase = 'EXECUTED'
              AND metadata->>'slippagePct' IS NOT NULL
            GROUP BY 1 ORDER BY 3 DESC
        `, [str30]);

        // ── Build Telegram message ─────────────────────────────────────────────
        const lines = [`📊 *Weekly Parameter Health Check* — ${etDate}\n`];
        const suggestedSQL = [];

        // Score bucket section
        lines.push('*Win Rate by Score Bucket (30d):*');
        for (const r of scoreRes.rows) {
            const wr = r.total > 0 ? Math.round(r.wins / r.total * 100) : null;
            const wrStr = wr !== null ? `${wr}%` : '—';
            let flag = '';
            if (wr !== null && wr < 35 && r.total >= 3) {
                flag = ' ⚠️';
                if (r.bucket === '82-84') suggestedSQL.push('  raise minBuyScore: 85');
                if (r.bucket === '85-89') suggestedSQL.push('  raise minBuyScore: 90');
            }
            lines.push(`  ${r.bucket}: ${wrStr} win (n=${r.total}, avg ${r.avg_pnl_pct}%)${flag}`);
        }

        // Regime section
        lines.push('\n*Win Rate by Regime (30d):*');
        for (const r of regimeRes.rows) {
            const wr = r.total > 0 ? Math.round(r.wins / r.total * 100) : null;
            lines.push(`  ${r.regime}: ${wr !== null ? wr + '%' : '—'} win (n=${r.total}, avg ${r.avg_pnl_pct}%)`);
        }

        // Alpha decay section
        if (decayRes.rows.length > 0) {
            lines.push('\n*Alpha Decay (30d vs prior 60d):*');
            for (const r of decayRes.rows) {
                const wr30   = r.total_30d   > 0 ? Math.round(r.wins_30d   / r.total_30d   * 100) : null;
                const wrPrior = r.total_prior > 0 ? Math.round(r.wins_prior / r.total_prior * 100) : null;
                if (wr30 === null && wrPrior === null) continue;
                const wr30Str   = wr30   !== null ? `${wr30}%`   : '—';
                const wrPriorStr = wrPrior !== null ? `${wrPrior}%` : '—';
                let flag = '';
                if (wr30 !== null && wrPrior !== null && wr30 < wrPrior - 15 && r.total_30d >= 3) {
                    flag = ' 🔻 alpha decaying';
                    suggestedSQL.push(`  reduce allocation: ${r.setup_family}`);
                }
                lines.push(`  ${r.setup_family}: ${wr30Str} now vs ${wrPriorStr} prior (avg: ${r.avg_30d}% vs ${r.avg_prior}%)${flag}`);
            }
        }

        // Slippage section
        if (slippageRes.rows.length > 0) {
            lines.push('\n*Execution Slippage by Setup (30d):*');
            for (const r of slippageRes.rows) {
                const slipStr = r.avg_slip_pct !== null ? `${r.avg_slip_pct > 0 ? '+' : ''}${r.avg_slip_pct}%` : '—';
                const flag = Math.abs(r.avg_slip_pct || 0) > 0.15 ? ' ⚠️ high slippage' : '';
                lines.push(`  ${r.setup_family}: avg ${slipStr} (max ${r.max_slip_pct}%, n=${r.n})${flag}`);
            }
        }

        // ── Top / Worst symbols ────────────────────────────────────────────────
        try {
            const symbolRes = await query(`
                SELECT symbol,
                       COUNT(*) AS total,
                       SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
                       ROUND(SUM(pnl)::numeric, 2) AS total_pnl,
                       ROUND(AVG(pnl_percent)::numeric, 2) AS avg_pnl_pct
                FROM trade_decision_journal
                WHERE created_at >= $1 AND pnl IS NOT NULL AND decision_phase = 'EXIT'
                GROUP BY symbol HAVING COUNT(*) >= 2
                ORDER BY total_pnl DESC
            `, [str30]);

            if (symbolRes.rows.length > 0) {
                lines.push('\n*Top Symbols (30d):*');
                symbolRes.rows.slice(0, 5).forEach(r => {
                    const wr = r.total > 0 ? Math.round(r.wins / r.total * 100) : 0;
                    lines.push(`  ${r.symbol}: $${r.total_pnl} | ${wr}% win | avg ${r.avg_pnl_pct}% (n=${r.total})`);
                });
                const worst = [...symbolRes.rows].sort((a, b) => a.total_pnl - b.total_pnl).slice(0, 5);
                lines.push('*Worst Symbols (30d):*');
                worst.forEach(r => {
                    const wr = r.total > 0 ? Math.round(r.wins / r.total * 100) : 0;
                    lines.push(`  ${r.symbol}: $${r.total_pnl} | ${wr}% win | avg ${r.avg_pnl_pct}% (n=${r.total})`);
                });
            }
        } catch (_symErr) {}

        // ── What-If Simulator ──────────────────────────────────────────────────
        // Re-filters trade_decision_journal at various score thresholds to show
        // what win rate and avg return would have been if minBuyScore were higher.
        try {
            const whatIfRes = await query(`
                SELECT
                    threshold,
                    COUNT(*) AS trades,
                    SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
                    ROUND(AVG(pnl_percent)::numeric, 2) AS avg_pnl_pct,
                    ROUND(SUM(pnl)::numeric, 2) AS total_pnl
                FROM trade_decision_journal
                CROSS JOIN (SELECT unnest(ARRAY[82,84,85,86,88,90]) AS threshold) t
                WHERE created_at >= $1 AND pnl IS NOT NULL AND decision_phase = 'EXIT'
                  AND score >= t.threshold
                GROUP BY threshold ORDER BY threshold
            `, [str30]);

            if (whatIfRes.rows.length > 0) {
                lines.push('\n*What-If: minBuyScore scenarios (30d):*');
                lines.push('`Score  Trades WinRate AvgReturn TotalPnL`');
                for (const r of whatIfRes.rows) {
                    const wr = r.trades > 0 ? Math.round(r.wins / r.trades * 100) : 0;
                    const flag = wr > 50 && r.trades >= 3 ? ' ✅' : '';
                    lines.push(`\`  ≥${r.threshold}    ${String(r.trades).padEnd(4)} ${String(wr + '%').padEnd(7)} ${String(r.avg_pnl_pct + '%').padEnd(9)} $${r.total_pnl}\`${flag}`);
                }
                lines.push('_Current minBuyScore = 82. Rows with ✅ = >50% win rate._');
            }
        } catch (_wiErr) {}

        // Suggested actions
        if (suggestedSQL.length > 0) {
            lines.push('\n*Suggested Actions (manual review required):*');
            lines.push('```');
            for (const s of suggestedSQL) lines.push(s);
            lines.push('```');
            lines.push('_Run: UPDATE risk\\_configs SET ... WHERE user\\_id = \'YOUR\\_ID\' after reviewing_');
        } else {
            lines.push('\n✅ _All parameters within healthy ranges — no action needed._');
        }

        const message = lines.join('\n');
        console.log('[Weekly Health]\n' + message.replace(/[*_`]/g, ''));

        const activeUsers = await getActiveAIUsers();
        for (const user of activeUsers) {
            try { await alertService.sendMessage(user.id, message); } catch (_) {}
        }

        // ── Lightweight backtest on top RS symbols ─────────────────────────────
        try {
            const { runBacktest } = require('./historicalBacktestEngine');
            const topSymbolsRes = await query(`
                SELECT DISTINCT symbol FROM asset_universe_daily
                WHERE universe_date >= CURRENT_DATE - INTERVAL '3 days'
                  AND rs_score IS NOT NULL
                ORDER BY rs_score DESC NULLS LAST LIMIT 20
            `);
            const btSymbols = topSymbolsRes.rows.map(r => r.symbol);
            if (btSymbols.length >= 5) {
                console.log(`[Weekly Health] Running backtest on ${btSymbols.length} top RS symbols...`);
                const btResult = await runBacktest(btSymbols, { lookbackDays: 30 });
                const btLines = [
                    `\n📈 *Weekly Backtest Snapshot* (top ${btSymbols.length} RS symbols, 30d)`,
                    `  Win rate: ${(btResult.winRate * 100).toFixed(1)}%`,
                    `  Avg return: ${(btResult.avgReturn * 100).toFixed(2)}%`,
                    `  Sharpe: ${(btResult.sharpeRatio || 0).toFixed(2)}`,
                    `  Max drawdown: ${(btResult.maxDrawdown * 100).toFixed(1)}%`,
                    `  Trades simulated: ${btResult.totalTrades || btSymbols.length}`,
                ];
                const btMsg = btLines.join('\n');
                console.log('[Weekly Health]' + btMsg.replace(/\*/g, ''));
                for (const user of activeUsers) {
                    try { await alertService.sendMessage(user.id, btMsg); } catch (_) {}
                }
            }
        } catch (btErr) {
            console.warn('[Weekly Health] Backtest skipped:', btErr.message);
        }

        // ── Weekly Performance Report (per-user, stored in DB for Performance page) ─
        try {
            const weeklyReportSvc = require('./weeklyTradingReportService');
            const { weekStart, weekEnd } = weeklyReportSvc.currentWeekRange();
            console.log(`[Weekly Health] Generating trading performance reports for week ${weekStart}–${weekEnd}...`);
            const reportResult = await weeklyReportSvc.generateFridayReportsForAllUsers();
            console.log(`[Weekly Health] Reports generated: ${reportResult.generated} users, ${reportResult.failed} failed`);
            if (reportResult.generated > 0) {
                for (const user of activeUsers) {
                    try {
                        await alertService.sendMessage(user.id,
                            `📋 *Weekly Trading Report Ready* — ${weekStart} to ${weekEnd}\n` +
                            `Your report is available on the Performance page under "Weekly Report".`
                        );
                    } catch (_) {}
                }
            }
        } catch (rptErr) {
            console.warn('[Weekly Health] Weekly report generation skipped:', rptErr.message);
        }

    } catch (err) {
        console.error('[Weekly Health] Error:', err.message);
    }
}

/**
 * Get scheduler status
 */
async function getStatus() {
    const globalControl = await getGlobalTradingControl();
    return {
        running: schedulerInterval !== null,
        isProcessing: isRunning,
        checkInterval: CHECK_INTERVAL,
        marketOpen: enhancedAITradingBot.isMarketOpen(),
        globalTradingEnabled: globalControl.globalTradingEnabled,
        killSwitchReason: globalControl.killSwitchReason
    };
}

module.exports = {
    startScheduler,
    stopScheduler,
    getStatus,
    runScheduledTrading,
    runWeeklyParameterHealthCheck
};
