/**
 * Overfitting Detector Service — PANTHEON Anti-Curve-Fit Shield
 *
 * Monitors the four classic signs that a bot's parameters have drifted from
 * durable statistical edge toward curve-fitting on recent history:
 *
 *   1. Walk-forward stability  — are win rates consistent across rolling windows?
 *   2. Out-of-sample decay     — is recent performance significantly worse than prior?
 *   3. Regime concentration    — is profit locked to a single market regime?
 *   4. Consistency ratio       — what fraction of rolling 10-trade windows are profitable?
 *
 * All checks are read-only and purely observational — nothing is modified.
 * Returns a composite OVERFIT_RISK level: LOW / MEDIUM / HIGH.
 *
 * Minimum data requirements before any flag fires:
 *   Walk-forward: ≥60 closed AI trades (2 full 30-trade windows)
 *   OOS decay:    ≥60 closed AI trades (30 recent + 30 prior)
 *   Regime:       ≥30 journal entries across ≥2 regimes
 *   Consistency:  ≥30 closed AI trades (3 full 10-trade windows)
 */

const { query }   = require('../config/database');
const { logger }  = require('../utils/logger');

const WINDOW_SIZE       = 30;  // trades per walk-forward window
const CONSISTENCY_WINDOW = 10; // trades per consistency window
const MIN_WIN_RATE_PCT  = 60;  // % win rate threshold for a "profitable" consistency window

// ── 1. Walk-forward stability ─────────────────────────────────────────────────
//
// Split all closed AI trades into chronological 30-trade blocks.
// Compute win rate per block, then measure variance.
// Declining trend in the last two windows = emerging curve-fit.

async function getWalkForwardAnalysis(userId) {
    try {
        const res = await query(`
            WITH ordered AS (
                SELECT
                    pnl,
                    trade_date,
                    ROW_NUMBER() OVER (ORDER BY trade_date ASC) AS rn
                FROM trades
                WHERE user_id    = $1
                  AND status     = 'CLOSED'
                  AND executed_by ILIKE 'AI%'
                  AND pnl IS NOT NULL
            ),
            windows AS (
                SELECT
                    FLOOR((rn - 1) / $2)                                    AS window_num,
                    COUNT(*)                                                  AS trades,
                    COUNT(*) FILTER (WHERE pnl > 0)                          AS wins,
                    ROUND(
                        COUNT(*) FILTER (WHERE pnl > 0)::numeric /
                        NULLIF(COUNT(*), 0) * 100, 1
                    )                                                         AS win_rate_pct,
                    ROUND(SUM(pnl)::numeric, 2)                              AS window_pnl
                FROM ordered
                GROUP BY 1
                HAVING COUNT(*) >= $3
            )
            SELECT
                window_num,
                trades,
                wins,
                win_rate_pct,
                window_pnl,
                LAG(win_rate_pct) OVER (ORDER BY window_num) AS prev_win_rate
            FROM windows
            ORDER BY window_num ASC
        `, [userId, WINDOW_SIZE, Math.floor(WINDOW_SIZE * 0.7)]);

        const windows = res.rows;

        if (windows.length < 2) {
            return {
                available: false,
                reason: `Need ≥${WINDOW_SIZE * 2} closed AI trades (have fewer than 2 windows)`,
                windows: [],
                stabilityFlag: 'INSUFFICIENT_DATA',
            };
        }

        const rates = windows.map(w => parseFloat(w.win_rate_pct));

        // Standard deviation of win rates across windows
        const mean   = rates.reduce((a, b) => a + b, 0) / rates.length;
        const sigma  = Math.sqrt(rates.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / rates.length);

        // Trend: is win rate going up or down in the last two windows?
        const last    = rates[rates.length - 1];
        const penult  = rates[rates.length - 2];
        const trend   = last - penult;
        const trendDir = trend > 3 ? 'IMPROVING' : trend < -3 ? 'DECLINING' : 'FLAT';

        // Stability flag
        let stabilityFlag;
        if      (sigma > 18) stabilityFlag = 'HIGH_VARIANCE';
        else if (sigma > 10) stabilityFlag = 'MODERATE_VARIANCE';
        else                 stabilityFlag = 'STABLE';

        const riskContrib = sigma > 18 ? 'HIGH' : sigma > 10 ? 'MEDIUM' : 'LOW';

        return {
            available:     true,
            windows:       windows.map(w => ({
                window:      parseInt(w.window_num) + 1,
                trades:      parseInt(w.trades),
                wins:        parseInt(w.wins),
                winRatePct:  parseFloat(w.win_rate_pct),
                windowPnl:   parseFloat(w.window_pnl),
            })),
            stats: {
                windowCount:    windows.length,
                meanWinRatePct: parseFloat(mean.toFixed(1)),
                sigmaPct:       parseFloat(sigma.toFixed(1)),
                trend:          trendDir,
                latestWinRatePct: last,
            },
            stabilityFlag,
            riskContrib,
            description: `${windows.length} windows of ${WINDOW_SIZE} trades — σ=${sigma.toFixed(1)}% — trend: ${trendDir}`,
        };
    } catch (err) {
        logger.error('[OverfitDetector] Walk-forward analysis failed', { error: err.message });
        return { available: false, reason: err.message, stabilityFlag: 'ERROR', riskContrib: 'LOW' };
    }
}

// ── 2. Out-of-sample decay ────────────────────────────────────────────────────
//
// Recent 30 trades (in-sample equivalent) vs prior 31–90 trades (out-of-sample).
// A significant win-rate drop in recent trades = edge may have been curve-fit.

async function getOOSDecayAnalysis(userId) {
    try {
        const res = await query(`
            WITH ordered AS (
                SELECT
                    pnl,
                    ROW_NUMBER() OVER (ORDER BY trade_date DESC) AS rn
                FROM trades
                WHERE user_id     = $1
                  AND status      = 'CLOSED'
                  AND executed_by  ILIKE 'AI%'
                  AND pnl IS NOT NULL
            )
            SELECT
                ROUND(
                    SUM(CASE WHEN rn <= 30 AND pnl > 0 THEN 1 ELSE 0 END)::numeric /
                    NULLIF(SUM(CASE WHEN rn <= 30 THEN 1 ELSE 0 END), 0) * 100, 1
                )  AS recent_win_rate,
                ROUND(
                    SUM(CASE WHEN rn BETWEEN 31 AND 90 AND pnl > 0 THEN 1 ELSE 0 END)::numeric /
                    NULLIF(SUM(CASE WHEN rn BETWEEN 31 AND 90 THEN 1 ELSE 0 END), 0) * 100, 1
                )  AS prior_win_rate,
                SUM(CASE WHEN rn <= 30 THEN 1 ELSE 0 END)       AS recent_count,
                SUM(CASE WHEN rn BETWEEN 31 AND 90 THEN 1 ELSE 0 END) AS prior_count,
                ROUND(SUM(CASE WHEN rn <= 30 THEN pnl ELSE 0 END)::numeric, 2)       AS recent_pnl,
                ROUND(SUM(CASE WHEN rn BETWEEN 31 AND 90 THEN pnl ELSE 0 END)::numeric, 2) AS prior_pnl
            FROM ordered
        `, [userId]);

        const row = res.rows[0];
        const recentCount = parseInt(row.recent_count || 0);
        const priorCount  = parseInt(row.prior_count  || 0);

        if (recentCount < 10 || priorCount < 10) {
            return {
                available:   false,
                reason:      `Need ≥60 closed AI trades (recent: ${recentCount}, prior: ${priorCount})`,
                decayFlag:   'INSUFFICIENT_DATA',
                riskContrib: 'LOW',
            };
        }

        const recentWR = parseFloat(row.recent_win_rate || 0);
        const priorWR  = parseFloat(row.prior_win_rate  || 0);
        const decay    = recentWR - priorWR;  // negative = performance dropping

        let decayFlag;
        if      (decay < -12) decayFlag = 'SEVERE_DECAY';
        else if (decay < -5)  decayFlag = 'MODERATE_DECAY';
        else if (decay >  5)  decayFlag = 'IMPROVING';
        else                  decayFlag = 'STABLE';

        const riskContrib = decay < -12 ? 'HIGH' : decay < -5 ? 'MEDIUM' : 'LOW';

        return {
            available:     true,
            recentTrades:  recentCount,
            priorTrades:   priorCount,
            recentWinRate: recentWR,
            priorWinRate:  priorWR,
            decayPct:      parseFloat(decay.toFixed(1)),
            recentPnl:     parseFloat(row.recent_pnl || 0),
            priorPnl:      parseFloat(row.prior_pnl || 0),
            decayFlag,
            riskContrib,
            description:   `Last 30 trades: ${recentWR}% win rate vs prior 60: ${priorWR}% (${decay >= 0 ? '+' : ''}${decay.toFixed(1)}%)`,
        };
    } catch (err) {
        logger.error('[OverfitDetector] OOS decay analysis failed', { error: err.message });
        return { available: false, reason: err.message, decayFlag: 'ERROR', riskContrib: 'LOW' };
    }
}

// ── 3. Regime concentration ───────────────────────────────────────────────────
//
// A bot that only works in BULL markets isn't robust — it may be curve-fit to a
// bull-run in its training history.  Flag when >65% of profitable trades come
// from a single regime AND the bot has seen 3+ distinct regimes.

async function getRegimeConcentrationAnalysis(userId) {
    try {
        const res = await query(`
            SELECT
                COALESCE(regime, 'UNKNOWN')                                          AS regime,
                COUNT(*)                                                              AS trades,
                COUNT(*) FILTER (WHERE pnl > 0)                                      AS wins,
                ROUND(
                    COUNT(*) FILTER (WHERE pnl > 0)::numeric /
                    NULLIF(COUNT(*), 0) * 100, 1
                )                                                                     AS win_rate_pct,
                ROUND(SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END)::numeric, 2)       AS profitable_pnl,
                ROUND(SUM(pnl)::numeric, 2)                                          AS net_pnl
            FROM trade_decision_journal
            WHERE user_id        = $1
              AND decision_phase = 'CLOSED'
              AND pnl IS NOT NULL
              AND regime IS NOT NULL
              AND regime NOT IN ('UNKNOWN', '')
            GROUP BY regime
            ORDER BY profitable_pnl DESC
        `, [userId]);

        const rows = res.rows;
        const totalTrades = rows.reduce((s, r) => s + parseInt(r.trades), 0);

        if (totalTrades < 30 || rows.length < 2) {
            return {
                available:   false,
                reason:      `Need ≥30 closed journal entries across ≥2 regimes (have ${totalTrades} trades, ${rows.length} regimes)`,
                byRegime:    rows,
                concFlag:    'INSUFFICIENT_DATA',
                riskContrib: 'LOW',
            };
        }

        const totalProfitablePnl = rows.reduce((s, r) => s + parseFloat(r.profitable_pnl || 0), 0);
        const topRegime = rows[0];
        const topShare  = totalProfitablePnl > 0
            ? (parseFloat(topRegime?.profitable_pnl || 0) / totalProfitablePnl) * 100
            : 0;
        const distinctRegimes = rows.length;

        let concFlag;
        if      (topShare > 75 && distinctRegimes >= 3) concFlag = 'HIGHLY_CONCENTRATED';
        else if (topShare > 65 && distinctRegimes >= 2) concFlag = 'MODERATELY_CONCENTRATED';
        else                                             concFlag = 'DIVERSIFIED';

        const riskContrib = concFlag === 'HIGHLY_CONCENTRATED' ? 'HIGH'
                          : concFlag === 'MODERATELY_CONCENTRATED' ? 'MEDIUM' : 'LOW';

        return {
            available:       true,
            distinctRegimes,
            totalTrades,
            topRegime:       topRegime?.regime || null,
            topRegimeShare:  parseFloat(topShare.toFixed(1)),
            byRegime:        rows.map(r => ({
                regime:         r.regime,
                trades:         parseInt(r.trades),
                wins:           parseInt(r.wins),
                winRatePct:     parseFloat(r.win_rate_pct),
                profitablePnl:  parseFloat(r.profitable_pnl),
                netPnl:         parseFloat(r.net_pnl),
            })),
            concFlag,
            riskContrib,
            description: `Top regime (${topRegime?.regime}) = ${topShare.toFixed(0)}% of profitable P&L across ${distinctRegimes} regimes`,
        };
    } catch (err) {
        logger.error('[OverfitDetector] Regime concentration analysis failed', { error: err.message });
        return { available: false, reason: err.message, concFlag: 'ERROR', riskContrib: 'LOW' };
    }
}

// ── 4. Consistency ratio ──────────────────────────────────────────────────────
//
// Roll a 10-trade window over all closed AI trades.
// Count windows where win rate ≥60%.
// Low consistency = high variance across time = potential overfitting or bad edge.

async function getConsistencyAnalysis(userId) {
    try {
        const res = await query(`
            WITH ordered AS (
                SELECT
                    pnl,
                    ROW_NUMBER() OVER (ORDER BY trade_date ASC) AS rn
                FROM trades
                WHERE user_id     = $1
                  AND status      = 'CLOSED'
                  AND executed_by  ILIKE 'AI%'
                  AND pnl IS NOT NULL
            ),
            windows AS (
                SELECT
                    FLOOR((rn - 1) / $2)                            AS window_num,
                    COUNT(*)                                          AS trades,
                    COUNT(*) FILTER (WHERE pnl > 0)                  AS wins
                FROM ordered
                GROUP BY 1
                HAVING COUNT(*) = $2
            )
            SELECT
                COUNT(*)                                                       AS total_windows,
                COUNT(*) FILTER (WHERE wins::numeric / $2 * 100 >= $3)        AS profitable_windows,
                ROUND(
                    COUNT(*) FILTER (WHERE wins::numeric / $2 * 100 >= $3)::numeric /
                    NULLIF(COUNT(*), 0) * 100, 1
                )                                                              AS consistency_pct,
                ROUND(AVG(wins::numeric / $2 * 100), 1)                       AS avg_window_win_rate
            FROM windows
        `, [userId, CONSISTENCY_WINDOW, MIN_WIN_RATE_PCT]);

        const row = res.rows[0];
        const totalWindows = parseInt(row.total_windows || 0);

        if (totalWindows < 3) {
            return {
                available:   false,
                reason:      `Need ≥${CONSISTENCY_WINDOW * 3} closed AI trades for consistency analysis (have fewer than 3 windows of ${CONSISTENCY_WINDOW})`,
                consistFlag: 'INSUFFICIENT_DATA',
                riskContrib: 'LOW',
            };
        }

        const consistencyPct = parseFloat(row.consistency_pct || 0);
        const avgWinRate     = parseFloat(row.avg_window_win_rate || 0);

        let consistFlag;
        if      (consistencyPct < 40) consistFlag = 'INCONSISTENT';
        else if (consistencyPct < 55) consistFlag = 'MODERATE';
        else                          consistFlag = 'CONSISTENT';

        const riskContrib = consistencyPct < 40 ? 'HIGH' : consistencyPct < 55 ? 'MEDIUM' : 'LOW';

        return {
            available:        true,
            totalWindows,
            profitableWindows: parseInt(row.profitable_windows || 0),
            consistencyPct,
            avgWindowWinRate: avgWinRate,
            windowSize:       CONSISTENCY_WINDOW,
            targetWinRatePct: MIN_WIN_RATE_PCT,
            consistFlag,
            riskContrib,
            description: `${parseInt(row.profitable_windows)}/${totalWindows} rolling ${CONSISTENCY_WINDOW}-trade windows had ≥${MIN_WIN_RATE_PCT}% win rate (${consistencyPct}% consistency)`,
        };
    } catch (err) {
        logger.error('[OverfitDetector] Consistency analysis failed', { error: err.message });
        return { available: false, reason: err.message, consistFlag: 'ERROR', riskContrib: 'LOW' };
    }
}

// ── 5. Confidence calibration ─────────────────────────────────────────────────
//
// Compares predicted confidence buckets to actual win rates.
// A calibrated system should win ~65% of trades where it predicted 65% confidence.
// A compressed system (everything 79-81%) is effectively uncalibrated.
// Requires ≥30 closed journal entries with confidence recorded.

async function getConfidenceCalibration(userId) {
    try {
        const res = await query(`
            SELECT
                CASE
                    WHEN confidence >= 0.80 THEN '80-100'
                    WHEN confidence >= 0.65 THEN '65-79'
                    WHEN confidence >= 0.50 THEN '50-64'
                    ELSE                         'below-50'
                END                                                                  AS bucket,
                COUNT(*)                                                              AS trades,
                COUNT(*) FILTER (WHERE pnl > 0)                                      AS wins,
                ROUND(
                    COUNT(*) FILTER (WHERE pnl > 0)::numeric /
                    NULLIF(COUNT(*), 0) * 100, 1
                )                                                                     AS actual_win_rate_pct,
                ROUND(AVG(confidence) * 100, 1)                                      AS avg_predicted_pct
            FROM trade_decision_journal
            WHERE user_id        = $1
              AND decision_phase = 'CLOSED'
              AND pnl            IS NOT NULL
              AND confidence     IS NOT NULL
              AND confidence      > 0
            GROUP BY 1
            ORDER BY avg_predicted_pct ASC
        `, [userId]);

        const rows = res.rows;
        const totalTrades = rows.reduce((s, r) => s + parseInt(r.trades), 0);

        if (totalTrades < 30) {
            return {
                available:   false,
                reason:      `Need ≥30 closed journal entries with confidence recorded (have ${totalTrades})`,
                calibFlag:   'INSUFFICIENT_DATA',
                riskContrib: 'LOW',
            };
        }

        // Calibration error: average |predicted - actual| across all buckets with ≥5 trades
        const qualifiedBuckets = rows.filter(r => parseInt(r.trades) >= 5);
        let calibrationError = null;
        if (qualifiedBuckets.length > 0) {
            const errors = qualifiedBuckets.map(r =>
                Math.abs(parseFloat(r.avg_predicted_pct) - parseFloat(r.actual_win_rate_pct))
            );
            calibrationError = parseFloat(
                (errors.reduce((a, b) => a + b, 0) / errors.length).toFixed(1)
            );
        }

        // Compression check: all predicted values within a 10% band = still compressed
        const predictedVals = rows.map(r => parseFloat(r.avg_predicted_pct));
        const predictedSpread = predictedVals.length > 1
            ? Math.max(...predictedVals) - Math.min(...predictedVals)
            : 0;
        const isCompressed = predictedSpread < 10;

        let calibFlag;
        if (isCompressed) calibFlag = 'COMPRESSED';
        else if (calibrationError !== null && calibrationError > 15) calibFlag = 'POORLY_CALIBRATED';
        else if (calibrationError !== null && calibrationError > 8)  calibFlag = 'MODERATE_CALIBRATION';
        else                                                          calibFlag = 'WELL_CALIBRATED';

        const riskContrib = calibFlag === 'COMPRESSED' || calibFlag === 'POORLY_CALIBRATED'
            ? 'MEDIUM' : 'LOW';

        return {
            available:        true,
            totalTrades,
            buckets:          rows.map(r => ({
                bucket:           r.bucket,
                trades:           parseInt(r.trades),
                wins:             parseInt(r.wins),
                actualWinRatePct: parseFloat(r.actual_win_rate_pct),
                avgPredictedPct:  parseFloat(r.avg_predicted_pct),
                calibrationError: parseFloat(
                    Math.abs(parseFloat(r.avg_predicted_pct) - parseFloat(r.actual_win_rate_pct)).toFixed(1)
                ),
            })),
            calibrationError,
            predictedSpread:  parseFloat(predictedSpread.toFixed(1)),
            isCompressed,
            calibFlag,
            riskContrib,
            description: isCompressed
                ? `Confidence compressed into ${predictedSpread.toFixed(0)}% spread — needs ${totalTrades < 200 ? 'more trades' : 'Platt scaling'}`
                : `Avg calibration error: ${calibrationError}% across ${qualifiedBuckets.length} bucket(s)`,
        };
    } catch (err) {
        logger.error('[OverfitDetector] Confidence calibration failed', { error: err.message });
        return { available: false, reason: err.message, calibFlag: 'ERROR', riskContrib: 'LOW' };
    }
}

// ── Composite risk score ──────────────────────────────────────────────────────

function _computeCompositeRisk(checks) {
    const contribs = [
        checks.walkForward?.riskContrib,
        checks.oosDecay?.riskContrib,
        checks.regimeConc?.riskContrib,
        checks.consistency?.riskContrib,
        checks.calibration?.riskContrib,
    ].filter(Boolean);

    const highCount   = contribs.filter(c => c === 'HIGH').length;
    const mediumCount = contribs.filter(c => c === 'MEDIUM').length;

    if (highCount >= 2)              return 'HIGH';
    if (highCount >= 1 || mediumCount >= 2) return 'MEDIUM';
    return 'LOW';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run all four overfitting checks and return a composite report.
 * Safe to call at any time — pure reads, zero writes.
 */
async function getOverfitReport(userId) {
    const t0 = Date.now();

    const [walkForward, oosDecay, regimeConc, consistency, calibration] = await Promise.all([
        getWalkForwardAnalysis(userId),
        getOOSDecayAnalysis(userId),
        getRegimeConcentrationAnalysis(userId),
        getConsistencyAnalysis(userId),
        getConfidenceCalibration(userId),
    ]);

    const overallRisk = _computeCompositeRisk({ walkForward, oosDecay, regimeConc, consistency, calibration });

    const report = {
        overallRisk,
        generatedAt: new Date().toISOString(),
        msElapsed:   Date.now() - t0,
        checks: {
            walkForward,
            oosDecay,
            regimeConc,
            consistency,
            calibration,
        },
        summary: _buildSummary(overallRisk, { walkForward, oosDecay, regimeConc, consistency, calibration }),
    };

    logger.info('[OverfitDetector] Report generated', {
        userId,
        overallRisk,
        walkForwardFlag:  walkForward.stabilityFlag  || 'N/A',
        oosDecayFlag:     oosDecay.decayFlag         || 'N/A',
        regimeConcFlag:   regimeConc.concFlag        || 'N/A',
        consistencyFlag:  consistency.consistFlag    || 'N/A',
        calibrationFlag:  calibration.calibFlag      || 'N/A',
        ms:               Date.now() - t0,
    });

    return report;
}

function _buildSummary(overallRisk, checks) {
    const warnings = [];
    const { walkForward, oosDecay, regimeConc, consistency, calibration } = checks;

    if (walkForward.available && walkForward.riskContrib !== 'LOW') {
        warnings.push(`Walk-forward: ${walkForward.description}`);
    }
    if (oosDecay.available && oosDecay.riskContrib !== 'LOW') {
        warnings.push(`OOS decay: ${oosDecay.description}`);
    }
    if (regimeConc.available && regimeConc.riskContrib !== 'LOW') {
        warnings.push(`Regime concentration: ${regimeConc.description}`);
    }
    if (consistency.available && consistency.riskContrib !== 'LOW') {
        warnings.push(`Consistency: ${consistency.description}`);
    }
    if (calibration?.available && calibration.riskContrib !== 'LOW') {
        warnings.push(`Calibration: ${calibration.description}`);
    }

    const labels = { LOW: 'Edge appears stable', MEDIUM: 'Watch for curve-fitting', HIGH: 'Strong overfitting signals — do NOT raise position sizes' };

    return {
        riskLabel: labels[overallRisk],
        warnings,
        recommendation: overallRisk === 'HIGH'
            ? 'Pause parameter changes. Run walk-forward backtest on the last 6 months before any threshold adjustments.'
            : overallRisk === 'MEDIUM'
            ? 'Avoid tweaking thresholds after individual bad days. Let the full walk-forward window complete.'
            : 'No significant overfitting signals detected. Continue monitoring.',
    };
}

module.exports = {
    getOverfitReport,
    getWalkForwardAnalysis,
    getOOSDecayAnalysis,
    getRegimeConcentrationAnalysis,
    getConsistencyAnalysis,
    getConfidenceCalibration,
};
