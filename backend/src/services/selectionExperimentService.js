/**
 * Phase 1 stock-selection experiment (agreed 2026-10-08, built 2026-10-12).
 *
 * Problem it tests: the final AI score doesn't rank forward returns. On a clean
 * re-analysis (scan-day close → 5th close, date-demeaned, ~15k rows) its top band
 * did no better than the bottom, mean-reversion components predicted POSITIVELY
 * (WilliamsR, Wyckoff_VDU, BB, MeanRev) and momentum/trend components NEGATIVELY
 * (RelStrength5d/20d, VISION, WeeklyAlign, 52wkHigh, SmartMoney, TrendTemplate,
 * DayChange). An in-sample check over 52 scan days (score ≥80 pool) put this
 * ordering's top 5 ahead by +0.58pp over 5 days — t 1.2, negative in September —
 * i.e. promising, not proven. Hence a forward test on paper only.
 *
 * What changes for an experiment account (SELECTION_EXPERIMENT_USER_IDS):
 *   - which 40 overnight candidates get the live re-score: highest "oversold score"
 *     instead of highest AI score (same ≥ minScore pool), and
 *   - buy order among live opportunities that clear minBuyScore: oversold score first.
 * Nothing else changes: same minBuyScore, gates, sizing, stops and exits.
 *
 * Every trading day both orderings of the same pool are logged (selection_experiment_picks),
 * so the report compares them on identical days via market_review_snapshots' clean
 * forward returns — independent of how many buys the paper account could afford.
 *
 * PASS (roadmap): after ~3 weeks / ~30 closed paper trades, the new ordering is
 * ≥ +1pp per pick over the current one with a win rate not lower.
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const MEAN_REVERSION = ['WilliamsR', 'Wyckoff_VDU', 'BB', 'MeanRev'];
const MOMENTUM = ['RelStrength5d', 'RelStrength20d', 'VISION', 'WeeklyAlign', '52wkHigh', 'SmartMoney', 'TrendTemplate', 'DayChange'];
const PICKS_PER_ARM = 40;

function experimentUserIds() {
    return new Set((process.env.SELECTION_EXPERIMENT_USER_IDS || '')
        .split(',').map(s => s.trim()).filter(Boolean));
}

function isExperimentUser(userId) {
    return experimentUserIds().has(String(userId));
}

/** Same "Name: +3 (...)" format as scoreComponentValidationService.parseScoringLog. */
function _parts(scoringLog) {
    const parts = {};
    for (const line of (Array.isArray(scoringLog) ? scoringLog : [])) {
        const m = String(line).match(/^([A-Za-z0-9_ ]+?):\s*([+-]?\d+(?:\.\d+)?)/);
        if (!m) continue;
        const k = m[1].trim();
        parts[k] = (parts[k] || 0) + parseFloat(m[2]);
    }
    return parts;
}

/**
 * Mean-reversion points (signed — they are negative when overbought) minus any
 * positive momentum points. Higher = more "oversold, not yet chased".
 */
function oversoldScore(scoringLog) {
    const p = _parts(scoringLog);
    const mr = MEAN_REVERSION.reduce((s, k) => s + (p[k] || 0), 0);
    const mom = MOMENTUM.reduce((s, k) => s + Math.max(0, p[k] || 0), 0);
    return Math.round((mr - mom) * 100) / 100;
}

/** Sort comparator for the experiment ordering: oversold score, then AI score. */
function compareOversold(a, b) {
    const d = (b.oversoldScore ?? -Infinity) - (a.oversoldScore ?? -Infinity);
    if (d !== 0) return d;
    return (Number(b.aiScore) || 0) - (Number(a.aiScore) || 0);
}

let _tableReady = false;
async function ensureTable() {
    if (_tableReady) return;
    await query(`
        CREATE TABLE IF NOT EXISTS selection_experiment_picks (
            id             SERIAL PRIMARY KEY,
            scan_date      DATE        NOT NULL,
            user_id        TEXT        NOT NULL,
            arm            TEXT        NOT NULL CHECK (arm IN ('control', 'oversold')),
            rank           INT         NOT NULL,
            symbol         TEXT        NOT NULL,
            ai_score       NUMERIC,
            oversold_score NUMERIC,
            logged_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (scan_date, user_id, arm, symbol)
        )`);
    _tableReady = true;
}

const _ranOn = new Set();     // `${userId}:${etDate}` — scheduler already logged this trading day
const _loggedFor = new Set(); // `${userId}:${scanDate}` — one log per account per scan day

/**
 * Record both orderings of the same candidate pool, once per scan day.
 * pool rows: { symbol, scanDate, aiScore, oversoldScore }. Never throws.
 */
async function logDailyPicks(userId, pool) {
    try {
        if (!pool?.length) return;
        const scanDate = pool[0].scanDate;
        const key = `${userId}:${scanDate}`;
        if (_loggedFor.has(key)) return true;
        await ensureTable();

        // Control mirrors loadCandidates' default order (AI score desc; ties fall to the
        // same md5 order the SQL used, which the pool already arrives in).
        const control = pool.slice(0, PICKS_PER_ARM);
        const oversold = [...pool].sort(compareOversold).slice(0, PICKS_PER_ARM);
        const rows = [
            ...control.map((c, i) => ['control', i + 1, c]),
            ...oversold.map((c, i) => ['oversold', i + 1, c]),
        ];
        const values = [], params = [];
        rows.forEach(([arm, rank, c], i) => {
            const o = i * 7;
            values.push(`($${o + 1}::date, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7})`);
            params.push(scanDate, String(userId), arm, rank, c.symbol, c.aiScore, c.oversoldScore);
        });
        await query(
            `INSERT INTO selection_experiment_picks (scan_date, user_id, arm, rank, symbol, ai_score, oversold_score)
             VALUES ${values.join(',')}
             ON CONFLICT (scan_date, user_id, arm, symbol) DO NOTHING`,
            params
        );
        _loggedFor.add(key);
        logger.info('[SelectionExperiment] Daily picks logged', {
            userId, scanDate,
            controlTop5: control.slice(0, 5).map(c => c.symbol),
            oversoldTop5: oversold.slice(0, 5).map(c => c.symbol),
        });
        return true;
    } catch (err) {
        logger.warn('[SelectionExperiment] Could not log daily picks (non-blocking)', { userId, err: err.message });
        return false;
    }
}

/**
 * Scheduler hook (every 5-min tick): once per trading day, from 9:35 ET, log both
 * orderings of the same fixed pool (score ≥ 80) for each experiment account. A fixed
 * pool keeps every day comparable, whatever the account's own minBuyScore or regime.
 */
async function runDailyPickLog(now = new Date()) {
    const ids = [...experimentUserIds()];
    if (!ids.length) return;
    const { isMarketOpen } = require('../utils/marketCalendar');
    if (!isMarketOpen(now)) return;
    const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false })
        .formatToParts(now);
    const etMin = parseInt(et.find(p => p.type === 'hour').value, 10) * 60 + parseInt(et.find(p => p.type === 'minute').value, 10);
    if (etMin < 9 * 60 + 35) return;

    const etDate = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const precomputed = require('./precomputedUniverseService');
    for (const userId of ids) {
        const dayKey = `${userId}:${etDate}`;
        if (_ranOn.has(dayKey)) continue; // already logged today — skip the query on every later tick
        let ok = false;
        await precomputed.loadCandidates({
            minScore: 80, limit: PICKS_PER_ARM, rankBy: 'oversold',
            onPool: async pool => { ok = await logDailyPicks(userId, pool); },
        }).catch(err => logger.warn('[SelectionExperiment] Daily pick log failed', { userId, err: err.message }));
        if (ok) _ranOn.add(dayKey);
    }
}

/**
 * Forward-return comparison of the two arms on the same scan days, using
 * market_review_snapshots (base_close = scan-day close, close_5d = 5th close after).
 * Returns per-arm stats for the top 5 and top 40 picks plus closed experiment trades.
 */
async function getExperimentReport({ userId = null, sinceDate = '2026-10-12' } = {}) {
    await ensureTable();
    const res = await query(`
        SELECT p.scan_date::text AS d, p.arm, p.rank,
               (LEAST(30, GREATEST(-30, (m.close_5d / m.base_close - 1) * 100)))::float AS ret5
        FROM selection_experiment_picks p
        JOIN market_review_snapshots m ON m.symbol = p.symbol AND m.scan_date = p.scan_date
        WHERE p.scan_date >= $1::date
          AND ($2::text IS NULL OR p.user_id = $2)
          AND m.base_close > 0 AND m.close_5d IS NOT NULL`,
        [sinceDate, userId]
    );

    const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
    const days = [...new Set(res.rows.map(r => r.d))].sort();
    const arm = (name, topN) => {
        const perDay = days.map(d => avg(res.rows.filter(r => r.d === d && r.arm === name && r.rank <= topN).map(r => r.ret5)))
            .filter(v => v != null);
        const picks = res.rows.filter(r => r.arm === name && r.rank <= topN);
        return {
            days: perDay.length,
            avgReturn5dPct: perDay.length ? +avg(perDay).toFixed(2) : null,
            winRatePct: picks.length ? +(picks.filter(r => r.ret5 > 0).length / picks.length * 100).toFixed(1) : null,
            picks: picks.length,
        };
    };
    const top5 = { control: arm('control', 5), oversold: arm('oversold', 5) };
    const top40 = { control: arm('control', 40), oversold: arm('oversold', 40) };
    const edge = (t) => (t.oversold.avgReturn5dPct != null && t.control.avgReturn5dPct != null)
        ? +(t.oversold.avgReturn5dPct - t.control.avgReturn5dPct).toFixed(2) : null;

    return {
        sinceDate, daysWithReturns: days.length,
        top5: { ...top5, edgePp: edge(top5) },
        top40: { ...top40, edgePp: edge(top40) },
        passRule: 'oversold ≥ +1pp per pick over control, win rate not lower, after ~3 weeks / ~30 closed paper trades',
    };
}

module.exports = {
    isExperimentUser, oversoldScore, compareOversold, logDailyPicks, runDailyPickLog, getExperimentReport,
    MEAN_REVERSION, MOMENTUM,
};
