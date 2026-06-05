const enhancedAITradingBot = require('./enhancedAITradingBot');
const userDb = require('./userDatabaseService');
const { query } = require('../config/database');
const { getGlobalTradingControl } = require('./tradingControlService');
const redisState = require('./redisStateService');
const alertService = require('./telegramAlertService');

/**
 * Enhanced AI Trading Scheduler - PostgreSQL Version
 * Runs autonomous trading for all enabled users during market hours
 */

// Check every 5 minutes
const CHECK_INTERVAL = 5 * 60 * 1000;
let schedulerInterval = null;
let isRunning = false;

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
    if (isRunning) {
        console.log('[Enhanced AI Scheduler] Previous run still in progress, skipping...');
        return;
    }
    
    const timestamp = new Date().toISOString();
    console.log(`\n${'='.repeat(80)}`);
    console.log(`[Enhanced AI Scheduler] Starting at ${timestamp}`);
    console.log(`${'='.repeat(80)}\n`);
    
    isRunning = true;

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
        
        console.log('[Enhanced AI Scheduler] ✓ Market is OPEN - proceeding with trading');
        
        // Get users with AI trading enabled
        const activeUsers = await getActiveAIUsers();
        
        if (activeUsers.length === 0) {
            console.log('[Enhanced AI Scheduler] No users have AI trading enabled.');
            isRunning = false;
            return;
        }
        
        console.log(`[Enhanced AI Scheduler] Found ${activeUsers.length} users with AI trading enabled\n`);
        
        // Process each user
        for (const user of activeUsers) {
            console.log(`\n${'-'.repeat(80)}`);
            console.log(`[Enhanced AI Scheduler] Processing user: ${user.username} (ID: ${user.id})`);
            console.log(`${'-'.repeat(80)}\n`);
            
            try {
                const result = await enhancedAITradingBot.executeAutonomousTrading(user.id);
                
                if (result.success) {
                    console.log(`[Enhanced AI Scheduler] ✓ User ${user.username}: ${result.message || 'Trading completed'}`);
                    
                    if (result.tradesExecuted > 0) {
                        console.log(`  - Trades executed: ${result.tradesExecuted}`);
                        console.log(`  - Capital deployed: $${result.capitalDeployed.toFixed(2)}`);
                        console.log(`  - Opportunities found: ${result.opportunitiesFound}`);
                        
                        // Log trade details
                        result.trades.forEach((trade, index) => {
                            console.log(`  ${index + 1}. ${trade.action} ${trade.shares} ${trade.symbol} @ $${trade.price.toFixed(2)} (Score: ${trade.aiScore}, Sector: ${trade.sector})`);
                        });
                    }
                } else {
                    console.log(`[Enhanced AI Scheduler] ⚠ User ${user.username}: ${result.message || result.error}`);
                }
                
                // Save trading log to user profile
                await logTradingActivity(user.id, result);

                // Redis: update open positions list for this user (multi-process coordination)
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
            
            // Small delay between users
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        console.log(`\n${'='.repeat(80)}`);
        console.log('[Enhanced AI Scheduler] Trading cycle completed');
        console.log(`${'='.repeat(80)}\n`);
        
    } catch (error) {
        console.error('[Enhanced AI Scheduler] Error in trading cycle:', error);
    } finally {
        isRunning = false;
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
                        MAX(portfolio_value) AS peak,
                        (SELECT portfolio_value FROM portfolio_snapshots
                         WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1) AS current_val
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
    const et    = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day   = et.getDay();   // 0=Sun … 6=Sat
    const hour  = et.getHours();
    const min   = et.getMinutes();
    const etDate = et.toISOString().slice(0, 10);

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
 * Morning Briefing — fires once at 8:00 AM ET Mon-Fri.
 * Sends a Telegram message with all STRONG BUY tickers from the most recent
 * nightly PANTHEON scan so users know what to watch before the open.
 */
let _morningBriefRanDate = null;
// Tracks which Telegram chat IDs already received today's briefing.
// Prevents duplicate sends when multiple users share the same chat ID.
const _morningBriefSentChats = new Set();

async function runMorningBriefing() {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day  = et.getDay();   // 0=Sun … 6=Sat
    const hour = et.getHours();
    const min  = et.getMinutes();
    const etDate = et.toISOString().slice(0, 10);

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

        const lines = [
            `📊 *Morning Briefing — ${etDate}*`,
            `🐂 Market opens in ~1.5h | Regime: BULL`,
            '',
            `🌟 *STRONG BUY: ${tickers.length} tickers* from PANTHEON overnight scan`,
        ];

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
 * Nightly universe scan trigger — fires once at 16:15 ET Mon-Fri.
 *
 * The scan was previously launched from runEodCleanup (3:44 PM ET), but
 * nightlyUniverseScanService refuses to run while _isMarketHours() is true
 * (market closes at 4:00 PM). This dedicated trigger fires at 4:15 PM,
 * 15 minutes after close, so the scan always runs on trading days.
 */
let _nightlyScanTriggeredDate = null;

async function runNightlyScanTrigger() {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric', minute: 'numeric', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const parts   = formatter.formatToParts(new Date());
    const etHour  = parseInt(parts.find(p => p.type === 'hour').value,   10);
    const etMin   = parseInt(parts.find(p => p.type === 'minute').value, 10);
    const etDay   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
    const etDate  = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;

    // Mon-Fri only, fire at 16:15–16:29 ET (15 min after market close)
    if (etDay < 1 || etDay > 5) return;
    if (etHour !== 16 || etMin < 15 || etMin >= 30) return;
    if (_nightlyScanTriggeredDate === etDate) return;
    _nightlyScanTriggeredDate = etDate;

    console.log('[NightlyScanTrigger] 4:15 PM ET — launching nightly universe scan');
    try {
        const nightlyScanSvc = require('./nightlyUniverseScanService');
        nightlyScanSvc.runNightlyUniverseScan()
            .then(r => r && console.log(`[NightlyScan] Done: ${r.passed} passed / ${r.analyzed} analyzed in ${r.elapsedMin}min`))
            .catch(err => console.error('[NightlyScan] Background error:', err.message));
    } catch (err) {
        console.error('[NightlyScanTrigger] Failed to launch:', err.message);
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
        runWeeklyParameterHealthCheck();        // Friday 15:45 ET: health check + backtest summary
        runMorningBriefing();                   // 8:00 AM ET Mon-Fri: STRONG BUY pre-market alert
        runMorningReconciliationTick();         // 9:00 AM ET Mon-Fri: DB vs Alpaca position sync
    }, CHECK_INTERVAL);

    console.log('[Enhanced AI Scheduler] ✓ Scheduler started successfully\n');
    console.log('[Enhanced AI Scheduler] Nightly scan trigger: 16:15 ET Mon-Fri\n');
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
