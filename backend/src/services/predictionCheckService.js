/**
 * Daily prediction check (2026-11-07) — does the nightly score still predict returns?
 *
 * For every scan night D whose 5-day outcome is known: buy each scored stock at the next
 * open, sell at the close 5 trading days later (history_bars, same convention as the
 * research lab), and measure
 *   - ic          rank correlation between ai_score and the 5-day return (>0 = score works)
 *   - spread80    avg return of score ≥ 80 minus the avg of all scored stocks that night
 *   - top20Spread avg return of the 20 highest scores minus the night's avg
 * Rows go into prediction_checks (backfilled from the first scan). If the last 10 nights
 * turn negative on both ic and spread80 the admin is warned once — the edge is fading
 * before it shows up as lost money. Report only.
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const HOLD = 5;
const CLAMP = 30;       // % — same outlier clamp as the experiment report
const FADE_WINDOW = 10; // scan nights

let _ready = false;
async function ensureTable() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS prediction_checks (
            scan_date     DATE PRIMARY KEY,
            n             INT,
            ic            REAL,
            mean_r5       REAL,
            n80           INT,
            spread80      REAL,
            top20_spread  REAL,
            details       JSONB,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    _ready = true;
}

/** Spearman rank correlation (average ranks for ties). */
function spearman(xs, ys) {
    const n = xs.length;
    if (n < 3) return null;
    const rank = a => {
        const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
        const r = new Array(n);
        for (let i = 0; i < n;) {
            let j = i;
            while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
            for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
            i = j + 1;
        }
        return r;
    };
    const rx = rank(xs), ry = rank(ys);
    const mx = rx.reduce((s, v) => s + v, 0) / n, my = ry.reduce((s, v) => s + v, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
    return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = v => (v == null ? null : +v.toFixed(3));

/** Metrics for one night from [{ score, r5 }]. */
function measure(rows) {
    const mean = avg(rows.map(r => r.r5));
    const hi = rows.filter(r => r.score >= 80);
    const top = [...rows].sort((a, b) => b.score - a.score).slice(0, 20);
    return {
        n: rows.length,
        ic: r2(spearman(rows.map(r => r.score), rows.map(r => r.r5))),
        meanR5: r2(mean),
        n80: hi.length,
        spread80: hi.length ? r2(avg(hi.map(r => r.r5)) - mean) : null,
        top20Spread: top.length ? r2(avg(top.map(r => r.r5)) - mean) : null,
        buckets: Object.fromEntries([['90+', 90, 999], ['80-89', 80, 90], ['70-79', 70, 80], ['60-69', 60, 70], ['<60', -1, 60]].map(([k, lo, hi2]) => {
            const b = rows.filter(r => r.score >= lo && r.score < hi2);
            return [k, { n: b.length, avgR5: r2(avg(b.map(r => r.r5))) }];
        })),
    };
}

/** Scan nights not yet checked whose 5-day window has closed, with entry/exit dates. */
async function _pending() {
    const cal = (await query(`SELECT to_char(d, 'YYYY-MM-DD') AS d FROM history_bars WHERE symbol = 'SPY' ORDER BY d`)).rows.map(r => r.d);
    const nights = (await query(`
        SELECT DISTINCT to_char(analysis_date, 'YYYY-MM-DD') AS d FROM daily_universe_analysis
        WHERE ai_score IS NOT NULL AND analysis_date NOT IN (SELECT scan_date FROM prediction_checks) ORDER BY 1`)).rows.map(r => r.d);
    const out = [];
    for (const d of nights) {
        const i = cal.findIndex(x => x > d);
        if (i < 0 || i + HOLD - 1 >= cal.length) continue;
        out.push({ scanDate: d, entry: cal[i], exit: cal[i + HOLD - 1] });
    }
    return out;
}

async function _rows({ scanDate, entry, exit }) {
    const r = await query(`
        SELECT a.ai_score::float AS score, (x.c / NULLIF(e.o, 0) - 1) * 100 AS r5
        FROM daily_universe_analysis a
        JOIN history_bars e ON e.symbol = a.symbol AND e.d = $2::date
        JOIN history_bars x ON x.symbol = a.symbol AND x.d = $3::date
        WHERE a.analysis_date = $1::date AND a.ai_score IS NOT NULL`, [scanDate, entry, exit]);
    return r.rows.filter(x => x.r5 != null).map(x => ({ score: x.score, r5: Math.max(-CLAMP, Math.min(CLAMP, Number(x.r5))) }));
}

/** Rolling view over the last `nights` checked scans. */
async function rolling({ nights = 20 } = {}) {
    await ensureTable();
    const rows = (await query(`SELECT * FROM prediction_checks ORDER BY scan_date DESC LIMIT $1`, [nights])).rows;
    const vals = k => rows.map(r => r[k]).filter(v => v != null).map(Number);
    return {
        nights: rows.length,
        from: rows.length ? rows[rows.length - 1].scan_date : null,
        to: rows.length ? rows[0].scan_date : null,
        avgIc: r2(avg(vals('ic'))),
        avgSpread80: r2(avg(vals('spread80'))),
        avgTop20Spread: r2(avg(vals('top20_spread'))),
        nightsSpread80Positive: vals('spread80').filter(v => v > 0).length,
    };
}

const isFading = r => r.nights >= FADE_WINDOW && r.avgIc != null && r.avgSpread80 != null && r.avgIc < 0 && r.avgSpread80 < 0;

/** Check every finished scan night. Never throws. */
async function runDaily({ refreshBars = true } = {}) {
    try {
        await ensureTable();
        if (refreshBars) await require('./historyBarsService').appendRecent();
        const before = await rolling({ nights: FADE_WINDOW });
        const pending = await _pending();
        let done = 0;
        for (const p of pending) {
            const rows = await _rows(p);
            if (rows.length < 50) continue; // a thin night (scan cut short) says nothing
            const m = measure(rows);
            await query(
                `INSERT INTO prediction_checks (scan_date, n, ic, mean_r5, n80, spread80, top20_spread, details)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (scan_date) DO NOTHING`,
                [p.scanDate, m.n, m.ic, m.meanR5, m.n80, m.spread80, m.top20Spread, JSON.stringify({ entry: p.entry, exit: p.exit, buckets: m.buckets })]);
            done++;
        }
        const after = await rolling({ nights: FADE_WINDOW });
        if (done && isFading(after) !== isFading(before)) {
            const msg = isFading(after)
                ? `⚠️ <b>Score edge fading</b> — last ${after.nights} scan nights: score ≥80 picks did ${after.avgSpread80}pp vs the average stock over 5 days, rank correlation ${after.avgIc}. The nightly score is not picking winners right now. Report only — nothing changed.`
                : `✅ <b>Score edge back</b> — last ${after.nights} scan nights: score ≥80 picks +${after.avgSpread80}pp vs average, rank correlation ${after.avgIc}.`;
            await require('./telegramAlertService').sendAdminMessage(msg, 'HTML').catch(() => {});
            await require('./reportArchiveService').save({ kind: 'prediction_check', body: msg, format: 'html', adminOnly: true }).catch(() => {});
        }
        logger.info('[PredictionCheck] Done', { checked: done, rolling: after });
        return { checked: done, rolling: after };
    } catch (err) {
        logger.warn('[PredictionCheck] Daily run failed', { error: err.message });
        return null;
    }
}

module.exports = { runDaily, rolling, measure, spearman, isFading, ensureTable };
