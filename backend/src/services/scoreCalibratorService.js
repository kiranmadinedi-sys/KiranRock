/**
 * Score Calibrator Service — Phase 1 (Recommendation Only)
 *
 * Reads closed trade history from trade_decision_journal and generates a
 * calibration report showing which PANTHEON score buckets and sectors are
 * actually profitable. The bot does NOT auto-apply changes — it sends the
 * suggestion to Telegram so the user can approve any threshold changes manually.
 *
 * Philosophy:
 *   • Never auto-apply threshold changes (overfitting risk, psychological safety).
 *   • Require minimum sample sizes before trusting a bucket's stats.
 *   • Use Profit Factor as the primary metric, not just win rate.
 *     A 45% win-rate system can outperform a 65% one if winners >> losers.
 *   • Sector-specific thresholds: Tech may need 88+, Healthcare may be fine at 80.
 *   • Send suggestion once per day; human approves the change in config.
 *
 * Runs once per trading day (gated by a per-user timestamp).
 */

const { query }   = require('../config/database');
const { logger }  = require('../utils/logger');

// Minimum trades in a bucket before we trust its stats
const MIN_TRADES_PER_BUCKET = 25;

// Profit factor threshold — gross wins / gross losses (abs). >1.0 = net positive.
// We require PF ≥ 1.1 so a bucket needs a meaningful edge, not just break-even.
const MIN_PROFIT_FACTOR = 1.1;

// Win rate floor (secondary filter — PF is primary)
const MIN_WIN_RATE = 45; // %

// Lookback in days
const LOOKBACK_DAYS = 90;

// Hard caps on any suggestion
const FLOOR_HARD_MIN = 75;
const FLOOR_HARD_MAX = 92;

// Per-user "last suggested at" guard — only fire once per calendar day
const _lastSuggested = new Map(); // userId → date string (YYYY-MM-DD)

// ── Helpers ───────────────────────────────────────────────────────────────────

function profitFactor(wins, losses) {
    // wins = array of positive pnl_percent values
    // losses = array of negative pnl_percent values (abs)
    const grossWin  = wins.reduce((s, v) => s + v, 0);
    const grossLoss = losses.reduce((s, v) => s + Math.abs(v), 0);
    return grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? 99 : 0;
}

function confidenceLabel(total) {
    if (total >= 60) return 'HIGH';
    if (total >= 30) return 'MEDIUM';
    return 'LOW';
}

/**
 * Expectancy = (winRate × avgWin) - (lossRate × avgLoss)
 * Answers: "how much does this setup earn per trade taken, on average?"
 * Unlike PF, expectancy is in the same units as returns (%) — intuitive to compare.
 */
function expectancy(wins, losses) {
    if (wins.length + losses.length === 0) return 0;
    const total    = wins.length + losses.length;
    const wr       = wins.length / total;
    const avgWin   = wins.length   > 0 ? wins.reduce((s, v) => s + v, 0) / wins.length       : 0;
    const avgLoss  = losses.length > 0 ? losses.reduce((s, v) => s + Math.abs(v), 0) / losses.length : 0;
    return parseFloat((wr * avgWin - (1 - wr) * avgLoss).toFixed(2));
}

/** Normalize free-form exit reason strings into canonical categories */
function normalizeExitReason(reason) {
    if (!reason) return 'unknown';
    const r = reason.toLowerCase();
    if (/trailing.stop|trail/i.test(r))                             return 'trailing_stop';
    if (/take.profit|profit.target|partial.*profit|locking.floor/i.test(r)) return 'profit_target';
    if (/stop.loss|stop loss|stopped.out|hit stop/i.test(r))        return 'stop_loss';
    if (/slow.mover|max.hold|held|time.exit|redeploy/i.test(r))     return 'time_exit';
    if (/score.decay|score.drop|conviction.drop/i.test(r))          return 'score_decay';
    if (/manual|override|user/i.test(r))                            return 'manual';
    return 'other';
}

// ── Score bucket analysis ─────────────────────────────────────────────────────

async function getScoreBuckets(userId) {
    const res = await query(`
        SELECT
            score,
            pnl_percent,
            pnl
        FROM trade_decision_journal
        WHERE user_id       = $1
          AND decision_phase = 'CLOSED'
          AND score          IS NOT NULL
          AND pnl_percent    IS NOT NULL
          AND closed_at      >= NOW() - ($2 * INTERVAL '1 day')
    `, [userId, LOOKBACK_DAYS]);

    const buckets = {
        '95-100': { floor: 95, trades: [] },
        '90-94':  { floor: 90, trades: [] },
        '85-89':  { floor: 85, trades: [] },
        '80-84':  { floor: 80, trades: [] },
        '75-79':  { floor: 75, trades: [] },
    };

    for (const r of res.rows) {
        const score = parseFloat(r.score);
        const pnl   = parseFloat(r.pnl_percent);
        const key   = score >= 95 ? '95-100'
                    : score >= 90 ? '90-94'
                    : score >= 85 ? '85-89'
                    : score >= 80 ? '80-84'
                    : score >= 75 ? '75-79' : null;
        if (key) buckets[key].trades.push(pnl);
    }

    return Object.entries(buckets).map(([bucket, data]) => {
        const trades  = data.trades;
        const total   = trades.length;
        const wins    = trades.filter(p => p > 0);
        const losses  = trades.filter(p => p <= 0);
        const winRate   = total > 0 ? parseFloat(((wins.length / total) * 100).toFixed(1)) : 0;
        const avgReturn = total > 0 ? parseFloat((trades.reduce((s, v) => s + v, 0) / total).toFixed(2)) : 0;
        const pf        = profitFactor(wins, losses);
        // Worst single-trade loss in this bucket — a bucket with PF=1.6 but max DD=-24%
        // is a very different risk profile than PF=1.6 with max DD=-7%.
        const maxDrawdown = losses.length > 0
            ? parseFloat(Math.min(...losses).toFixed(2))
            : 0;
        // Expectancy: how much this setup earns per trade taken, in % terms.
        // Unlike PF (a ratio), expectancy is in the same units as returns — directly comparable.
        const exp        = expectancy(wins, losses);
        const valid      = total >= MIN_TRADES_PER_BUCKET;
        const profitable = valid && pf >= MIN_PROFIT_FACTOR && winRate >= MIN_WIN_RATE;

        return {
            bucket,
            floor:        data.floor,
            total,
            wins:         wins.length,
            losses:       losses.length,
            // Ranked PF → expectancy → avgReturn → winRate — PF is primary, expectancy is tiebreaker
            profitFactor: pf,
            expectancy:   exp,
            avgReturn,
            winRate,
            maxDrawdown,
            valid,
            profitable,
            confidence:   confidenceLabel(total),
        };
    }).sort((a, b) => b.floor - a.floor);
}

// ── Exit reason attribution ───────────────────────────────────────────────────
// Answers: "which exit type produces the best outcomes?"
// If trailing_stop PF=2.1 but profit_target PF=1.2, winners should run longer.
// If stop_loss avg=-14% but trailing_stop avg=-3%, stop sizing is too loose.

async function getExitReasonAttribution(userId) {
    const res = await query(`
        SELECT
            metadata->>'reason'  AS reason,
            pnl_percent,
            opened_at,
            closed_at
        FROM trade_decision_journal
        WHERE user_id       = $1
          AND decision_phase = 'CLOSED'
          AND pnl_percent    IS NOT NULL
          AND closed_at      >= NOW() - ($2 * INTERVAL '1 day')
    `, [userId, LOOKBACK_DAYS]);

    const buckets = {};
    for (const r of res.rows) {
        const cat = normalizeExitReason(r.reason);
        if (!buckets[cat]) buckets[cat] = { pnls: [], holdDays: [] };
        buckets[cat].pnls.push(parseFloat(r.pnl_percent));
        if (r.opened_at && r.closed_at) {
            buckets[cat].holdDays.push((new Date(r.closed_at) - new Date(r.opened_at)) / 86_400_000);
        }
    }

    return Object.entries(buckets)
        .map(([exitType, data]) => {
            const trades = data.pnls;
            const total  = trades.length;
            const wins   = trades.filter(p => p > 0);
            const losses = trades.filter(p => p <= 0);
            const avgHoldDays = data.holdDays.length > 0
                ? parseFloat((data.holdDays.reduce((s, v) => s + v, 0) / data.holdDays.length).toFixed(1))
                : null;
            return {
                exitType,
                total,
                profitFactor: profitFactor(wins, losses),
                expectancy:   expectancy(wins, losses),
                avgReturn:    parseFloat((trades.reduce((s, v) => s + v, 0) / total).toFixed(2)),
                winRate:      parseFloat(((wins.length / total) * 100).toFixed(1)),
                maxDrawdown:  losses.length > 0 ? parseFloat(Math.min(...losses).toFixed(2)) : 0,
                avgHoldDays,
                valid:        total >= 10,
            };
        })
        .sort((a, b) => b.profitFactor - a.profitFactor);
}

// ── Score × Ratio cross-analysis ─────────────────────────────────────────────
// Answers: "does a high score overcome poor signal clarity, or does clarity
// dominate regardless of score?"  Requires bullBearRatio stored in metadata
// (written by the bot since this feature was added — earlier trades return null).

async function getScoreRatioCross(userId) {
    const res = await query(`
        SELECT
            score,
            pnl_percent,
            (metadata->>'bullBearRatio')::float AS ratio
        FROM trade_decision_journal
        WHERE user_id       = $1
          AND decision_phase = 'CLOSED'
          AND score          IS NOT NULL
          AND pnl_percent    IS NOT NULL
          AND metadata->>'bullBearRatio' IS NOT NULL
          AND closed_at      >= NOW() - ($2 * INTERVAL '1 day')
    `, [userId, LOOKBACK_DAYS]);

    if (res.rows.length === 0) return null; // no ratio data yet

    // Build 5×4 matrix: score bucket (row) × ratio bucket (col)
    const scoreBands = [
        { key: '95+',   test: s => s >= 95 },
        { key: '90-94', test: s => s >= 90 && s < 95 },
        { key: '85-89', test: s => s >= 85 && s < 90 },
        { key: '80-84', test: s => s >= 80 && s < 85 },
        { key: '75-79', test: s => s >= 75 && s < 80 },
    ];
    const ratioBands = [
        { key: '>2.5',    test: r => r >  2.5 },
        { key: '2.0–2.5', test: r => r >= 2.0 && r <= 2.5 },
        { key: '1.5–2.0', test: r => r >= 1.5 && r <  2.0 },
        { key: '1.2–1.5', test: r => r >= 1.2 && r <  1.5 },
        { key: '<1.2',    test: r => r <  1.2 },
    ];

    // cell[scoreKey][ratioKey] = array of pnl_percent
    const cells = {};
    for (const sb of scoreBands) {
        cells[sb.key] = {};
        for (const rb of ratioBands) cells[sb.key][rb.key] = [];
    }

    for (const r of res.rows) {
        const score = parseFloat(r.score);
        const pnl   = parseFloat(r.pnl_percent);
        const ratio = parseFloat(r.ratio);
        const sb = scoreBands.find(b => b.test(score));
        const rb = ratioBands.find(b => b.test(ratio));
        if (sb && rb) cells[sb.key][rb.key].push(pnl);
    }

    const rows = [];
    for (const sb of scoreBands) {
        for (const rb of ratioBands) {
            const trades  = cells[sb.key][rb.key];
            const total   = trades.length;
            if (total === 0) continue;
            const wins   = trades.filter(p => p > 0);
            const losses = trades.filter(p => p <= 0);
            rows.push({
                scoreBucket: sb.key,
                ratioBucket: rb.key,
                total,
                profitFactor: profitFactor(wins, losses),
                avgReturn:    parseFloat((trades.reduce((s, v) => s + v, 0) / total).toFixed(2)),
                winRate:      parseFloat(((wins.length / total) * 100).toFixed(1)),
                // Flag cells with enough data for a meaningful read
                valid:        total >= 15,
            });
        }
    }

    return rows.length > 0 ? rows : null;
}

// ── Sector analysis ───────────────────────────────────────────────────────────

async function getSectorThresholds(userId) {
    const res = await query(`
        SELECT
            COALESCE(metadata->>'sector', 'Unknown') AS sector,
            score,
            pnl_percent
        FROM trade_decision_journal
        WHERE user_id       = $1
          AND decision_phase = 'CLOSED'
          AND score          IS NOT NULL
          AND pnl_percent    IS NOT NULL
          AND closed_at      >= NOW() - ($2 * INTERVAL '1 day')
    `, [userId, LOOKBACK_DAYS]);

    const sectorMap = {};
    for (const r of res.rows) {
        const sector = r.sector || 'Unknown';
        const score  = parseFloat(r.score);
        const pnl    = parseFloat(r.pnl_percent);
        if (!sectorMap[sector]) sectorMap[sector] = [];
        sectorMap[sector].push({ score, pnl });
    }

    const results = [];
    for (const [sector, trades] of Object.entries(sectorMap)) {
        if (trades.length < 10) continue; // not enough sector data

        // Find the lowest score where trades are profitable (WR ≥ 45%, PF ≥ 1.1)
        // Try each floor from 75 upward; use the first floor that works
        let suggestedFloor = null;
        for (const floor of [75, 80, 82, 85, 88, 90]) {
            const inScope = trades.filter(t => t.score >= floor);
            if (inScope.length < 8) continue;
            const wins   = inScope.filter(t => t.pnl > 0);
            const losses = inScope.filter(t => t.pnl <= 0);
            const wr     = (wins.length / inScope.length) * 100;
            const pf     = profitFactor(wins.map(t => t.pnl), losses.map(t => t.pnl));
            if (wr >= MIN_WIN_RATE && pf >= MIN_PROFIT_FACTOR) {
                suggestedFloor = floor;
                break;
            }
        }

        const allWins   = trades.filter(t => t.pnl > 0);
        const allLosses = trades.filter(t => t.pnl <= 0);
        results.push({
            sector,
            total:        trades.length,
            winRate:      parseFloat(((allWins.length / trades.length) * 100).toFixed(1)),
            avgReturn:    parseFloat((trades.reduce((s, t) => s + t.pnl, 0) / trades.length).toFixed(2)),
            profitFactor: profitFactor(allWins.map(t => t.pnl), allLosses.map(t => t.pnl)),
            suggestedFloor,
        });
    }

    return results.sort((a, b) => b.total - a.total);
}

// ── Confidence bucket analysis ────────────────────────────────────────────────
// Answers: "does a higher predicted confidence actually correlate with better outcomes?"
// Helps detect whether the confidence signal is well-calibrated or consistently mis-estimated.

async function getConfidenceBuckets(userId) {
    const res = await query(`
        SELECT
            confidence,
            pnl_percent
        FROM trade_decision_journal
        WHERE user_id        = $1
          AND decision_phase  = 'CLOSED'
          AND confidence      IS NOT NULL
          AND pnl_percent     IS NOT NULL
          AND closed_at       >= NOW() - ($2 * INTERVAL '1 day')
    `, [userId, LOOKBACK_DAYS]);

    const buckets = {
        '<60':   { label: '<60%',   trades: [] },
        '60-69': { label: '60–69%', trades: [] },
        '70-79': { label: '70–79%', trades: [] },
        '80-89': { label: '80–89%', trades: [] },
        '90+':   { label: '90%+',   trades: [] },
    };

    for (const r of res.rows) {
        const conf = parseFloat(r.confidence);
        const pnl  = parseFloat(r.pnl_percent);
        const key  = conf >= 90 ? '90+'
                   : conf >= 80 ? '80-89'
                   : conf >= 70 ? '70-79'
                   : conf >= 60 ? '60-69'
                   : '<60';
        buckets[key].trades.push(pnl);
    }

    return Object.entries(buckets).map(([key, data]) => {
        const trades  = data.trades;
        const total   = trades.length;
        const wins    = trades.filter(p => p > 0);
        const losses  = trades.filter(p => p <= 0);
        const winRate   = total > 0 ? parseFloat(((wins.length / total) * 100).toFixed(1)) : 0;
        const avgReturn = total > 0 ? parseFloat((trades.reduce((s, v) => s + v, 0) / total).toFixed(2)) : 0;
        const pf        = profitFactor(wins, losses);
        const exp       = expectancy(wins, losses);
        return {
            bucket:       data.label,
            total,
            wins:         wins.length,
            losses:       losses.length,
            winRate,
            avgReturn,
            profitFactor: pf,
            expectancy:   exp,
            valid:        total >= 10,
        };
    }).filter(b => b.total > 0); // omit empty buckets
}

// ── Build suggestion report ───────────────────────────────────────────────────

async function buildCalibrationReport(userId) {
    const [buckets, sectors, scoreRatioCross, exitAttribution, confidenceBuckets] = await Promise.all([
        getScoreBuckets(userId),
        getSectorThresholds(userId),
        getScoreRatioCross(userId),
        getExitReasonAttribution(userId),
        getConfidenceBuckets(userId),
    ]);

    const totalTrades   = buckets.reduce((s, b) => s + b.total, 0);
    const validBuckets  = buckets.filter(b => b.valid);
    const profitableBuckets = validBuckets.filter(b => b.profitable);

    // Find the suggested global floor
    // = lowest bucket that is profitable (has enough data AND passes PF + WR)
    let suggestedFloor = null;
    let reason         = null;

    if (validBuckets.length === 0) {
        reason = `Not enough data — need ≥${MIN_TRADES_PER_BUCKET} trades per bucket (total: ${totalTrades})`;
    } else if (profitableBuckets.length === 0) {
        // No profitable bucket found — suggest the highest floor with data
        const highestValid = validBuckets[0]; // sorted descending
        suggestedFloor = Math.min(FLOOR_HARD_MAX, Math.max(FLOOR_HARD_MIN, highestValid.floor));
        reason = `No bucket meets PF ≥ ${MIN_PROFIT_FACTOR} threshold — suggesting top-bucket floor ${suggestedFloor}`;
    } else {
        // Lowest profitable bucket = most inclusive floor that still makes money
        const lowestProfitable = profitableBuckets[profitableBuckets.length - 1];
        suggestedFloor = Math.min(FLOOR_HARD_MAX, Math.max(FLOOR_HARD_MIN, lowestProfitable.floor));
        reason = `Lowest profitable bucket: ${lowestProfitable.bucket} ` +
                 `(PF ${lowestProfitable.profitFactor}, WR ${lowestProfitable.winRate}%, ` +
                 `avg +${lowestProfitable.avgReturn}%, n=${lowestProfitable.total})`;
    }

    // Sector insights — sectors where the global floor is wrong
    const sectorInsights = sectors
        .filter(s => s.suggestedFloor !== null && s.total >= 15)
        .map(s => ({
            sector:         s.sector,
            total:          s.total,
            winRate:        s.winRate,
            profitFactor:   s.profitFactor,
            suggestedFloor: s.suggestedFloor,
        }));

    return {
        generatedAt:    new Date().toISOString(),
        lookbackDays:   LOOKBACK_DAYS,
        totalTrades,
        hasEnoughData:  validBuckets.length > 0,
        suggestedFloor,
        reason,
        confidence:     confidenceLabel(totalTrades),
        buckets,
        sectorInsights,
        // confidence calibration — does higher predicted confidence → better outcomes?
        confidenceBuckets: confidenceBuckets.length > 0 ? confidenceBuckets : null,
        // null until trades with bullBearRatio metadata accumulate (≥15 per cell)
        scoreRatioCross,
        // exit reason breakdown — shows which exit type earns the best PF/expectancy
        exitAttribution: exitAttribution.length > 0 ? exitAttribution : null,
    };
}

// ── Action section builder ────────────────────────────────────────────────────
// Generates a clear "what should I do?" closing statement so the report never
// ends with a data table and no direction.

function buildActionSection(report, currentMinBuyScore) {
    if (!report.hasEnoughData || report.suggestedFloor === null) {
        return [
            `⏳ *STATUS: COLLECTING DATA*`,
            `Need ≥${MIN_TRADES_PER_BUCKET} trades per bucket before making a reliable recommendation.`,
            `Current total: ${report.totalTrades} closed trades. Keep trading.`,
        ].join('\n');
    }

    const suggested = report.suggestedFloor;
    const current   = currentMinBuyScore ?? null;

    if (current === null) {
        return [
            `💡 *SUGGESTED ACTION: Set minBuyScore = ${suggested}*`,
            `${report.reason}`,
            `Confidence: ${report.confidence}`,
            `To apply: update MIN\\_BUY\\_SCORE in your config or risk settings.`,
        ].join('\n');
    }

    const diff = suggested - current;

    if (diff === 0) {
        const bucket = report.buckets.find(b => b.floor === current);
        const stats  = bucket ? ` — PF ${bucket.profitFactor}, E=${bucket.expectancy > 0 ? '+' : ''}${bucket.expectancy}%` : '';
        return [
            `✅ *NO ACTION REQUIRED*`,
            `Current minBuyScore (${current}) is validated by performance data${stats}.`,
            `System performing within expected parameters.`,
        ].join('\n');
    }

    if (diff > 0) {
        const losing = report.buckets
            .filter(b => b.valid && !b.profitable && b.floor < suggested)
            .map(b => `${b.bucket} (PF ${b.profitFactor}, E=${b.expectancy > 0 ? '+' : ''}${b.expectancy}%)`)
            .join(', ');
        return [
            `⚡ *ACTION REQUIRED: Raise minBuyScore ${current} → ${suggested}*`,
            `Underperforming buckets: ${losing || 'see data above'}`,
            `Confidence: ${report.confidence} (${report.totalTrades} trades)`,
            `To apply: update MIN\\_BUY\\_SCORE in your config or risk settings.`,
        ].join('\n');
    }

    // diff < 0 — data supports a lower floor
    return [
        `📉 *OPTIONAL: Data supports lowering minBuyScore ${current} → ${suggested}*`,
        `${report.reason}`,
        `Confidence: ${report.confidence}. Review bucket data above before applying.`,
    ].join('\n');
}

// ── Telegram notification ─────────────────────────────────────────────────────

async function sendCalibrationToTelegram(userId, report, currentMinBuyScore) {
    try {
        const alertService = require('./telegramAlertService');
        const { display }  = await alertService.getUserInfo(userId);

        // Metric order: PF → expectancy → avgReturn → WR → maxDD
        const bucketLines = report.buckets
            .filter(b => b.valid || b.total > 0)
            .map(b => {
                const mark = !b.valid     ? '⚪'
                           : b.profitable ? '✅'
                           : '❌';
                const dd  = b.maxDrawdown < 0 ? ` | maxDD ${b.maxDrawdown}%` : '';
                const exp = b.expectancy !== undefined ? ` | E=${b.expectancy > 0 ? '+' : ''}${b.expectancy}%` : '';
                return `  ${mark} ${b.bucket}: n=${b.total} | PF ${b.profitFactor}${exp} | avg ${b.avgReturn > 0 ? '+' : ''}${b.avgReturn}% | WR ${b.winRate}%${dd}`;
            }).join('\n');

        const sectorLines = report.sectorInsights.slice(0, 5).map(s =>
            `  ${s.sector}: PF ${s.profitFactor} | avg ${s.avgReturn > 0 ? '+' : ''}${s.avgReturn}% | WR ${s.winRate}% | floor → ${s.suggestedFloor}`
        ).join('\n');

        // Score × ratio cross-analysis — only include cells with ≥15 trades
        const validCrossRows = (report.scoreRatioCross || []).filter(r => r.valid);
        const crossLines = validCrossRows.length > 0
            ? validCrossRows
                .sort((a, b) => b.profitFactor - a.profitFactor)
                .slice(0, 8)
                .map(r => `  Score ${r.scoreBucket} × Ratio ${r.ratioBucket}: PF ${r.profitFactor} | avg ${r.avgReturn > 0 ? '+' : ''}${r.avgReturn}% (n=${r.total})`)
                .join('\n')
            : null;

        const exitLines = (report.exitAttribution || [])
            .filter(e => e.valid)
            .map(e => {
                const hold = e.avgHoldDays !== null ? ` | hold ${e.avgHoldDays}d` : '';
                return `  ${e.exitType}: PF ${e.profitFactor} | E=${e.expectancy > 0 ? '+' : ''}${e.expectancy}% | WR ${e.winRate}%${hold} (n=${e.total})`;
            })
            .join('\n');

        const actionSection = buildActionSection(report, currentMinBuyScore);

        const msg = [
            `📊 *Score Calibration Report* — ${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' })}`,
            `👤 User: ${display}`,
            ``,
            `*Score Bucket Performance (last ${report.lookbackDays} days)*`,
            `_PF → Expectancy → Avg Return → WR → MaxDD_`,
            bucketLines || '  No closed trades yet',
            ``,
            sectorLines ? `*Sector Insights:*\n${sectorLines}` : '',
            exitLines   ? `\n*Exit Type Attribution:*\n${exitLines}` : '',
            crossLines  ? `\n*Score × Signal Clarity (top cells by PF):*\n${crossLines}` : '',
            ``,
            `━━━━━━━━━━━━━━━━━━━━`,
            actionSection,
        ].filter(l => l !== '').join('\n');

        await alertService.sendMessage(userId, msg);
    } catch (err) {
        logger.warn('[ScoreCalibrator] Failed to send Telegram suggestion', { userId, error: err.message });
    }
}

// ── Suggestion history — persistence + stability detection ───────────────────

async function persistSuggestion(userId, report, currentFloor) {
    try {
        await query(`
            INSERT INTO calibration_suggestions
                (user_id, suggested_floor, current_floor, confidence, total_trades, reason, has_enough_data, report_json)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
            userId,
            report.suggestedFloor,
            currentFloor,
            report.confidence,
            report.totalTrades,
            report.reason,
            report.hasEnoughData,
            JSON.stringify({ buckets: report.buckets, exitAttribution: report.exitAttribution }),
        ]);
    } catch (err) {
        logger.warn('[ScoreCalibrator] Failed to persist suggestion', { userId, error: err.message });
    }
}

/**
 * Returns the count of recent consecutive days where the same floor was suggested.
 * Used by Phase 2 to gate auto-apply: only apply when the same value appears ≥3 days.
 */
async function getStabilityScore(userId, suggestedFloor) {
    const res = await query(`
        SELECT suggested_floor
        FROM calibration_suggestions
        WHERE user_id = $1
          AND has_enough_data = true
          AND created_at >= NOW() - INTERVAL '14 days'
        ORDER BY created_at DESC
        LIMIT 10
    `, [userId]);

    let streak = 0;
    for (const row of res.rows) {
        if (row.suggested_floor === suggestedFloor) streak++;
        else break; // streak broken
    }
    return streak;
}

/**
 * Phase 2: auto-apply small stepwise threshold changes when:
 *  - AUTO_ACCEPT_THRESHOLD_CHANGES env flag is true
 *  - The same floor has been suggested ≥3 consecutive days (stability)
 *  - Change is within ±2 of current (no big jumps)
 *  - New floor is within hard rails
 */
async function maybeAutoApply(userId, suggestedFloor, currentFloor) {
    if (process.env.AUTO_ACCEPT_THRESHOLD_CHANGES !== 'true') return false;
    if (!suggestedFloor || !currentFloor) return false;

    const diff = suggestedFloor - currentFloor;
    if (Math.abs(diff) > 2) {
        logger.info('[ScoreCalibrator] Auto-apply skipped — change too large (stepwise max ±2)', { diff, suggestedFloor, currentFloor });
        return false;
    }
    if (suggestedFloor < FLOOR_HARD_MIN || suggestedFloor > FLOOR_HARD_MAX) return false;

    const streak = await getStabilityScore(userId, suggestedFloor);
    if (streak < 3) {
        logger.info('[ScoreCalibrator] Auto-apply skipped — not stable yet', { streak, suggestedFloor });
        return false;
    }

    // Apply: update user risk config
    try {
        const { upsertRiskConfig } = require('./tradingControlService');
        await upsertRiskConfig(userId, { minBuyScore: suggestedFloor });
        logger.info('[ScoreCalibrator] AUTO-APPLIED threshold change', { userId, from: currentFloor, to: suggestedFloor, streak });
        return true;
    } catch (err) {
        logger.error('[ScoreCalibrator] Auto-apply failed', { userId, error: err.message });
        return false;
    }
}

// ── Daily suggestion gate ─────────────────────────────────────────────────────

/**
 * Phase 1: recommendation-only (default).
 * Phase 2: auto-applies small stepwise changes when AUTO_ACCEPT_THRESHOLD_CHANGES=true
 *          and the same suggestion has been stable for ≥3 consecutive days.
 */
async function runDailySuggestion(userId, currentMinBuyScore = null) {
    const todayKey = new Date().toISOString().slice(0, 10);
    if (_lastSuggested.get(userId) === todayKey) return; // already ran today

    _lastSuggested.set(userId, todayKey);

    const report = await buildCalibrationReport(userId);

    logger.info('[ScoreCalibrator] Daily calibration report', {
        userId,
        totalTrades:    report.totalTrades,
        suggestedFloor: report.suggestedFloor,
        currentFloor:   currentMinBuyScore,
        confidence:     report.confidence,
        reason:         report.reason,
    });

    // Persist every day so stability detection has history to query
    await persistSuggestion(userId, report, currentMinBuyScore);

    // Phase 2: attempt auto-apply if flag is set and conditions are safe
    let autoApplied = false;
    if (report.hasEnoughData && report.suggestedFloor !== null && report.suggestedFloor !== currentMinBuyScore) {
        autoApplied = await maybeAutoApply(userId, report.suggestedFloor, currentMinBuyScore);
        if (autoApplied) {
            // Refresh the report so Telegram shows the updated state
            report.autoApplied = true;
            report.autoAppliedFrom = currentMinBuyScore;
        }
    }

    await sendCalibrationToTelegram(userId, report, autoApplied ? report.suggestedFloor : currentMinBuyScore);

    return report;
}

// ── API export (for /api/performance/calibration endpoint) ────────────────────

module.exports = { runDailySuggestion, buildCalibrationReport, getScoreBuckets, getConfidenceBuckets, getScoreRatioCross, getExitReasonAttribution };
