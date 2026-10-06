/**
 * Weekly score-component validation.
 *
 * Measures, for every component of the AI score, whether stocks where it fired
 * positively went on to beat the other stocks scanned the same day over the next
 * 5 trading days — and whether that holds in both halves of the window (one regime
 * can make anything look predictive: on 2026-10-06 the big "mean reversion beats
 * momentum" effect was strong Jul 15-Aug 31 and gone by Sep 1-Oct 5).
 *
 * Built after the 2026-10-06 finding that the final score had no ranking power on
 * clean forward returns and five components' bonuses predicted equal-or-worse
 * returns in both halves (now UNSCORED_BONUSES in enhancedAITradingBot.js, still
 * logged so this report keeps measuring them). Report only — it never changes
 * scoring; it flags candidates for a human to re-enable or disable.
 *
 * Data: market_review_snapshots (base_close → close_5d, the clean close-to-close
 * return — see marketReviewService.js) joined to the nightly scan's scoringLog.
 */

const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const WINSOR_PCT = 30;       // cap |5d return| so a few wild small-caps can't dominate
const MIN_ROWS = 2000;       // below this the per-component t-stats are too noisy to act on
const MIN_COMPONENT_N = 150; // ignore components that fired positively fewer times than this
const FLAG_T = 2;            // |t| threshold for a flag (rough: samples overlap, so t is optimistic)

let _tableReady = false;
async function ensureTable() {
    if (_tableReady) return;
    await query(`
        CREATE TABLE IF NOT EXISTS score_component_validation (
            id           SERIAL PRIMARY KEY,
            run_at       TIMESTAMP DEFAULT NOW(),
            window_start DATE,
            window_end   DATE,
            rows_used    INTEGER,
            results      JSONB
        )`);
    _tableReady = true;
}

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;

/** Mean difference (on minus off) of excess returns, with a rough t-stat. */
function _diffStat(on, off) {
    if (on.length < 2 || off.length < 2) return { diff: 0, t: 0 };
    const mOn = mean(on), mOff = mean(off);
    const v = (a, m) => a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
    const se = Math.sqrt(v(on, mOn) / on.length + v(off, mOff) / off.length);
    return { diff: mOn - mOff, t: se > 0 ? (mOn - mOff) / se : 0 };
}

/** Parse "Name: +3.5 (...)" log lines into { Name: summedValue }. */
function parseScoringLog(log) {
    const parts = {};
    for (const line of (log || [])) {
        const m = String(line).match(/^([A-Za-z0-9_ ]+?):\s*([+-]?\d+(?:\.\d+)?)/);
        if (!m) continue;
        const k = m[1].trim();
        parts[k] = (parts[k] || 0) + parseFloat(m[2]);
    }
    return parts;
}

/**
 * Pure analysis over prepared rows: [{ d, score, ret5, parts }] — split out for tests.
 * Returns component stats, score-ranking spread, and re-enable / disable flags.
 */
function analyzeRows(rows, unscored = new Set()) {
    // Excess return vs the same scan date's average — strips out market-wide moves.
    const byDate = {};
    for (const r of rows) (byDate[r.d] ||= []).push(r.ret5);
    const dateMean = Object.fromEntries(Object.entries(byDate).map(([d, a]) => [d, mean(a)]));
    for (const r of rows) r.ex = r.ret5 - dateMean[r.d];

    const dates = Object.keys(byDate).sort();
    const splitDate = dates[Math.floor(dates.length / 2)];
    const older = rows.filter(r => r.d < splitDate), newer = rows.filter(r => r.d >= splitDate);

    const names = new Set();
    for (const r of rows) for (const k of Object.keys(r.parts)) names.add(k);

    const components = [];
    for (const k of names) {
        const fired = r => (r.parts[k] || 0) > 0;
        const nPos = rows.filter(fired).length;
        if (nPos < MIN_COMPONENT_N) continue;
        const split = set => _diffStat(set.filter(fired).map(r => r.ex), set.filter(r => !fired(r)).map(r => r.ex));
        const all = split(rows), o = split(older), n = split(newer);
        components.push({
            component: k, unscored: unscored.has(k), nPos,
            diff: +all.diff.toFixed(2), t: +all.t.toFixed(1),
            diffOlder: +o.diff.toFixed(2), diffNewer: +n.diff.toFixed(2),
        });
    }
    components.sort((a, b) => b.t - a.t);

    // Does the final score rank? Top vs bottom quintile of the score, per half.
    const spread = set => {
        const s = [...set].sort((a, b) => b.score - a.score);
        const q = Math.floor(s.length / 5);
        if (q < 20) return null;
        return +(mean(s.slice(0, q).map(r => r.ex)) - mean(s.slice(-q).map(r => r.ex))).toFixed(2);
    };

    const reEnable = components.filter(c => c.unscored && c.t >= FLAG_T && c.diffOlder > 0 && c.diffNewer > 0);
    const disable  = components.filter(c => !c.unscored && c.t <= -FLAG_T && c.diffOlder < 0 && c.diffNewer < 0);

    return {
        rows: rows.length, dates: dates.length, splitDate,
        scoreSpread: { all: spread(rows), older: spread(older), newer: spread(newer) },
        components, reEnable, disable,
    };
}

async function runComponentValidation({ weeks = 8 } = {}) {
    await ensureTable();
    const res = await query(`
        SELECT m.scan_date::text AS d, m.ai_score::float AS score,
               m.base_close::float AS base, m.close_5d::float AS c5,
               a.metadata->'scoringLog' AS log
        FROM market_review_snapshots m
        JOIN daily_universe_analysis a ON a.symbol = m.symbol AND a.analysis_date = m.scan_date
        WHERE m.scan_date >= CURRENT_DATE - ($1::int * 7)
          AND m.base_close > 0 AND m.close_5d IS NOT NULL
          AND a.metadata ? 'scoringLog'
    `, [weeks]);

    const rows = res.rows.map(r => ({
        d: r.d, score: r.score,
        ret5: Math.max(-WINSOR_PCT, Math.min(WINSOR_PCT, (r.c5 / r.base - 1) * 100)),
        parts: parseScoringLog(r.log),
    }));

    if (rows.length < MIN_ROWS) {
        logger.info('[ScoreValidation] Not enough rows for a reliable read — skipping', { rows: rows.length, weeks });
        return { skipped: true, rows: rows.length };
    }

    const { UNSCORED_BONUSES } = require('./enhancedAITradingBot');
    const result = analyzeRows(rows, UNSCORED_BONUSES);
    const windowStart = rows.reduce((m, r) => (r.d < m ? r.d : m), rows[0].d);
    const windowEnd   = rows.reduce((m, r) => (r.d > m ? r.d : m), rows[0].d);

    await query(
        `INSERT INTO score_component_validation (window_start, window_end, rows_used, results) VALUES ($1, $2, $3, $4)`,
        [windowStart, windowEnd, result.rows, JSON.stringify(result)]
    );
    logger.info('[ScoreValidation] Weekly component validation stored', {
        rows: result.rows, scoreSpread: result.scoreSpread,
        reEnable: result.reEnable.map(c => c.component), disable: result.disable.map(c => c.component),
    });
    return { ...result, windowStart, windowEnd };
}

function formatReport(r) {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fmt = c => `${esc(c.component)}${c.unscored ? ' (unscored)' : ''}: ${c.diff >= 0 ? '+' : ''}${c.diff}% (t ${c.t}; halves ${c.diffOlder} / ${c.diffNewer})`;
    const sp = v => v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${v}%`;
    const top = r.components.slice(0, 4), bottom = r.components.slice(-4).reverse();
    return [
        `<b>🧪 Weekly score validation</b> (${r.windowStart} → ${r.windowEnd}, ${r.rows} scans)`,
        `Does the final score rank? top-vs-bottom 20% over 5d: <b>${sp(r.scoreSpread.all)}</b> (halves ${sp(r.scoreSpread.older)} / ${sp(r.scoreSpread.newer)})`,
        '',
        '<b>Most predictive</b>', ...top.map(fmt),
        '',
        '<b>Least predictive</b>', ...bottom.map(fmt),
        '',
        r.reEnable.length ? `✅ <b>Consider re-enabling</b> (positive in both halves): ${r.reEnable.map(c => esc(c.component)).join(', ')}` : '✅ No unscored component earned its way back this week.',
        r.disable.length  ? `⚠️ <b>Consider disabling</b> (negative in both halves): ${r.disable.map(c => esc(c.component)).join(', ')}` : '⚠️ No scored component was negative in both halves.',
        '',
        '<i>Report only — scoring is unchanged. Toggle via SCORE_UNSCORED_BONUSES.</i>',
    ].join('\n');
}

async function runWeeklyReport() {
    const r = await runComponentValidation();
    if (r.skipped) return r;
    const { sendAdminMessage } = require('./telegramAlertService');
    await sendAdminMessage(formatReport(r), 'HTML').catch(err =>
        logger.warn('[ScoreValidation] Telegram send failed', { error: err.message })
    );
    return r;
}

module.exports = { runComponentValidation, runWeeklyReport, analyzeRows, parseScoringLog, formatReport };
