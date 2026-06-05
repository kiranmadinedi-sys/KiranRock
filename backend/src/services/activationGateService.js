/**
 * Activation Gate Service — PANTHEON Proven Activation Sequence
 *
 * Tracks whether the system has met the performance thresholds required to
 * advance to the next trading step.  Gates are advisory (warn, not block)
 * until manually overridden; hard-blocking is opt-in via env flags.
 *
 * Step 1: Swing trading active by default.
 *         Gate to Step 2: 60%+ win rate over ≥30 live AI trades.
 * Step 2: Kelly confidence sizing.
 *         Gate to Step 3: 8 consecutive profitable weeks.
 * Step 3: Options trading.
 *         Gate to Step 4: 62%+ win rate over ≥60 live AI trades.
 * Step 4: Short selling — NOT YET IMPLEMENTED.
 * Step 5: Stat arb + alt data — NOT YET IMPLEMENTED.
 */

const { query }           = require('../config/database');
const { logger }          = require('../utils/logger');

const ENFORCE_GATES = (process.env.ACTIVATION_GATES_ENFORCE || 'false').toLowerCase() === 'true';

const GATES = {
    STEP_1_TO_2: { winRateMin: 0.60, minTrades: 30,  consecutiveProfitableWeeks: null },
    STEP_2_TO_3: { winRateMin: null, minTrades: null, consecutiveProfitableWeeks: 8   },
    STEP_3_TO_4: { winRateMin: 0.62, minTrades: 60,  consecutiveProfitableWeeks: null },
};

/**
 * Fetch live AI trade stats: total, wins, win rate.
 * Only counts trades executed by the AI bot (executed_by LIKE 'AI%').
 */
async function getAITradeStats(userId) {
    try {
        const result = await query(`
            SELECT
                COUNT(*)                                            AS total,
                COUNT(*) FILTER (WHERE pnl > 0)                    AS wins,
                ROUND(
                    COUNT(*) FILTER (WHERE pnl > 0)::numeric /
                    NULLIF(COUNT(*), 0) * 100, 1
                )                                                   AS win_rate_pct
            FROM trades
            WHERE user_id      = $1
              AND status       = 'CLOSED'
              AND executed_by  ILIKE 'AI%'
              AND pnl IS NOT NULL
        `, [userId]);

        const row = result.rows[0];
        return {
            total:      parseInt(row.total   || 0,  10),
            wins:       parseInt(row.wins    || 0,  10),
            winRate:    parseFloat(row.win_rate_pct || 0) / 100,
        };
    } catch (error) {
        logger.error('[ActivationGate] Error fetching AI trade stats', { error: error.message });
        return { total: 0, wins: 0, winRate: 0 };
    }
}

/**
 * Count consecutive profitable weeks (Mon–Sun) looking back up to maxWeeks.
 */
async function getConsecutiveProfitableWeeks(userId, maxWeeks = 12) {
    try {
        const result = await query(`
            SELECT
                date_trunc('week', date) AS week_start,
                SUM(total_profit_loss)   AS weekly_pnl
            FROM ai_performance_metrics
            WHERE user_id = $1
              AND date >= CURRENT_DATE - ($2 * INTERVAL '1 week')
            GROUP BY 1
            ORDER BY 1 DESC
        `, [userId, maxWeeks]);

        let streak = 0;
        for (const row of result.rows) {
            if (parseFloat(row.weekly_pnl) > 0) streak++;
            else break;
        }
        return streak;
    } catch (error) {
        logger.error('[ActivationGate] Error counting profitable weeks', { error: error.message });
        return 0;
    }
}

/**
 * Count distinct market regimes the bot has traded in.
 * Reads from trade_decision_journal.regime — only rows with a real regime value.
 * Target: ≥3 distinct regimes before recommending live scaling.
 */
async function getRegimeCoverage(userId) {
    try {
        const result = await query(`
            SELECT
                ARRAY_AGG(DISTINCT regime ORDER BY regime) AS regimes,
                COUNT(DISTINCT regime)                     AS distinct_count
            FROM trade_decision_journal
            WHERE user_id  = $1
              AND regime IS NOT NULL
              AND regime NOT IN ('UNKNOWN', '')
        `, [userId]);

        const row = result.rows[0] || {};
        return {
            distinctRegimes: parseInt(row.distinct_count || 0),
            regimeList:      row.regimes || [],
        };
    } catch (error) {
        logger.error('[ActivationGate] Error fetching regime coverage', { error: error.message });
        return { distinctRegimes: 0, regimeList: [] };
    }
}

/**
 * Fetch rolling expectancy from trade_decision_journal.
 * Expectancy = (win rate × avg win $) − (loss rate × avg loss $).
 * Positive expectancy over ≥50 trades = edge is real.
 */
async function getExpectancyStats(userId, minTrades = 50) {
    try {
        const result = await query(`
            SELECT
                COUNT(*)                                             AS total,
                AVG(CASE WHEN outcome = 'WIN' THEN pnl ELSE NULL END)  AS avg_win,
                AVG(CASE WHEN outcome = 'LOSS' THEN ABS(pnl) ELSE NULL END) AS avg_loss,
                ROUND(
                    COUNT(*) FILTER (WHERE outcome = 'WIN')::numeric /
                    NULLIF(COUNT(*), 0) * 100, 1
                )                                                    AS win_rate_pct
            FROM trade_decision_journal
            WHERE user_id      = $1
              AND decision_phase = 'EXECUTION'
              AND pnl IS NOT NULL
        `, [userId]);

        const row    = result.rows[0] || {};
        const total  = parseInt(row.total || 0);
        if (total < minTrades) return { expectancy: null, total, sufficient: false };

        const winRate = parseFloat(row.win_rate_pct || 0) / 100;
        const avgWin  = parseFloat(row.avg_win  || 0);
        const avgLoss = parseFloat(row.avg_loss || 0);
        const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

        return {
            expectancy: parseFloat(expectancy.toFixed(2)),
            winRate,
            avgWin:  parseFloat(avgWin.toFixed(2)),
            avgLoss: parseFloat(avgLoss.toFixed(2)),
            total,
            sufficient: true,
        };
    } catch (error) {
        logger.error('[ActivationGate] Error fetching expectancy', { error: error.message });
        return { expectancy: null, total: 0, sufficient: false };
    }
}

/**
 * Evaluate all gates and return a status object.
 * This should be called at bot startup and logged for monitoring.
 */
async function evaluateGates(userId) {
    const [stats, profWeeks, regimeCoverage, expectancyStats] = await Promise.all([
        getAITradeStats(userId),
        getConsecutiveProfitableWeeks(userId),
        getRegimeCoverage(userId),
        getExpectancyStats(userId),
    ]);

    const step1to2Passed =
        stats.total >= GATES.STEP_1_TO_2.minTrades &&
        stats.winRate >= GATES.STEP_1_TO_2.winRateMin;

    const step2to3Passed =
        profWeeks >= GATES.STEP_2_TO_3.consecutiveProfitableWeeks;

    const step3to4Passed =
        stats.total >= GATES.STEP_3_TO_4.minTrades &&
        stats.winRate >= GATES.STEP_3_TO_4.winRateMin;

    // Regime coverage: advisory until ≥3 regimes seen (BULL/NEUTRAL/BEAR minimum)
    const regimeCoverageMet   = regimeCoverage.distinctRegimes >= 3;
    // Expectancy: advisory — positive edge over ≥50 closed trades
    const expectancyMet       = expectancyStats.sufficient && expectancyStats.expectancy > 0;

    const status = {
        trades:              stats.total,
        wins:                stats.wins,
        winRate:             stats.winRate,
        consecutiveProfitableWeeks: profWeeks,
        regimeCoverage: {
            distinctRegimes: regimeCoverage.distinctRegimes,
            regimeList:      regimeCoverage.regimeList,
            met:             regimeCoverageMet,
        },
        expectancy: {
            value:      expectancyStats.expectancy,
            total:      expectancyStats.total,
            sufficient: expectancyStats.sufficient,
            met:        expectancyMet,
        },
        gates: {
            STEP_1_TO_2: {
                passed:      step1to2Passed,
                description: `Win rate ≥60% over ≥30 AI trades (current: ${(stats.winRate * 100).toFixed(1)}% / ${stats.total} trades)`
            },
            STEP_2_TO_3: {
                passed:      step2to3Passed,
                description: `8 consecutive profitable weeks (current: ${profWeeks})`
            },
            STEP_3_TO_4: {
                passed:      step3to4Passed,
                description: `Win rate ≥62% over ≥60 AI trades (current: ${(stats.winRate * 100).toFixed(1)}% / ${stats.total} trades)`
            },
            REGIME_COVERAGE: {
                passed:      regimeCoverageMet,
                description: `Traded in ≥3 distinct regimes (current: ${regimeCoverage.distinctRegimes} — ${regimeCoverage.regimeList.join(', ') || 'none yet'})`
            },
            EXPECTANCY: {
                passed:      expectancyMet,
                description: expectancyStats.sufficient
                    ? `Positive expectancy over ≥50 trades (current: $${expectancyStats.expectancy} / ${expectancyStats.total} trades)`
                    : `Need ≥50 closed trades for expectancy (current: ${expectancyStats.total})`
            },
        },
        currentStep: step3to4Passed ? 4 : step2to3Passed ? 3 : step1to2Passed ? 2 : 1,
        // Advisory scaling readiness — all 5 gates including regime + expectancy
        readyToScale: step1to2Passed && regimeCoverageMet && expectancyMet,
        enforcing:    ENFORCE_GATES,
    };

    logger.info('[ActivationGate] Gate status evaluated', {
        userId,
        currentStep:      status.currentStep,
        readyToScale:     status.readyToScale,
        winRate:          `${(stats.winRate * 100).toFixed(1)}%`,
        totalTrades:      stats.total,
        profWeeks,
        regimes:          regimeCoverage.regimeList.join(',') || 'none',
        expectancy:       expectancyStats.sufficient ? `$${expectancyStats.expectancy}` : `insufficient (${expectancyStats.total} trades)`,
        gates: {
            step1to2:       step1to2Passed      ? 'PASSED' : 'PENDING',
            step2to3:       step2to3Passed      ? 'PASSED' : 'PENDING',
            step3to4:       step3to4Passed      ? 'PASSED' : 'PENDING',
            regimeCoverage: regimeCoverageMet   ? 'PASSED' : 'PENDING',
            expectancy:     expectancyMet       ? 'PASSED' : 'PENDING',
        }
    });

    return status;
}

/**
 * Check whether options trading is gated-off.
 * Returns true (blocked) only when ACTIVATION_GATES_ENFORCE=true AND gate not passed.
 */
async function isOptionsGated(userId) {
    if (!ENFORCE_GATES) return false;
    const stats = await getAITradeStats(userId);
    return !(stats.total >= GATES.STEP_1_TO_2.minTrades && stats.winRate >= GATES.STEP_1_TO_2.winRateMin);
}

module.exports = { evaluateGates, getAITradeStats, getConsecutiveProfitableWeeks, isOptionsGated, getRegimeCoverage, getExpectancyStats };
