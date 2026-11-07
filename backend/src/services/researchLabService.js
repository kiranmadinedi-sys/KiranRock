/**
 * Research lab (2026-11-07) — a permanent log of trading ideas and an honest test bench.
 *
 * Every idea is a declarative spec (price/volume conditions, hold days, optional stop),
 * so people and the weekend agent can add ideas without new code. Each run tests every
 * queued idea in ONE pass over history_bars (2023 →) and records the result for good, so
 * nothing is tested twice and failures are remembered as well as wins.
 *
 * Honesty rules (fixed before any result is seen):
 *   - Entry next open, exit at the close `hold` trading days later, optional stop that
 *     respects gaps. Liquid $3+ stocks only.
 *   - Edge = the idea's average return minus the average of ALL eligible stocks bought the
 *     same day with the same hold, paired by date. Market moves and survivorship bias
 *     (today's symbol list) cancel out; t-stats are over dates, not trades.
 *   - TRAIN (before HOLDOUT_START) must clear a strict bar, because many ideas get tested
 *     and some look good by luck. The HOLDOUT months must then agree on their own, and
 *     most years must be positive.
 *   - A pass only queues the idea for paper; nothing here touches live trading.
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');
const { rsiSeries } = require('./historyBacktestService');

const HOLDOUT_START = '2025-07-01';
const MIN_PRICE = 3;
const MIN_IEX_DOLLAR_VOL = 200_000; // IEX is ~2-3% of US volume
const PASS = { trainDates: 50, trainEdge: 0.3, trainT: 2.5, holdDates: 30, holdEdge: 0.2, holdT: 1.5, positiveYearsShare: 0.75 };

/** Feature names a spec may use (all computed from bars up to and including the signal day). */
const FEATURES = {
    ret1: '1-day % change', ret5: '5-day % change', ret20: '20-day % change', ret60: '60-day % change',
    gap: 'open vs prior close %', volRatio: 'volume / prior 20-day average', sma50Dist: '% above 50-day average',
    sma200Dist: '% above 200-day average', rsi14: 'RSI(14)', high52Dist: '% below 52-week high (≤0)',
    low52Dist: '% above 52-week low', rangePos: 'close position in day range 0-1', price: 'close',
    atrPct: '14-day ATR as % of price', spyRet5: 'SPY 5-day % change', spyAbove200: 'SPY above its 200-day average (1/0)',
    prevRet1: 'prior day 1-day % change',
};
const OPS = {
    '>': (x, v) => x > v, '>=': (x, v) => x >= v, '<': (x, v) => x < v, '<=': (x, v) => x <= v,
    between: (x, v) => x >= v[0] && x <= v[1],
};

let _ready = false;
async function ensureTable() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS research_hypotheses (
            id          SERIAL      PRIMARY KEY,
            name        TEXT        NOT NULL UNIQUE,
            family      TEXT,
            idea        TEXT,
            spec        JSONB       NOT NULL,
            source      TEXT        NOT NULL DEFAULT 'manual',
            status      TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'pass', 'fail', 'error')),
            result      JSONB,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            tested_at   TIMESTAMPTZ
        )`);
    _ready = true;
}

function validateSpec(spec) {
    if (!spec || !Array.isArray(spec.when) || !spec.when.length) throw new Error('spec.when must be a non-empty list');
    for (const c of spec.when) {
        if (!Array.isArray(c) || c.length !== 3) throw new Error(`condition must be [feature, op, value]: ${JSON.stringify(c)}`);
        if (!(c[0] in FEATURES)) throw new Error(`unknown feature ${c[0]}`);
        if (!(c[1] in OPS)) throw new Error(`unknown op ${c[1]}`);
        if (c[1] === 'between' ? !(Array.isArray(c[2]) && c[2].length === 2) : typeof c[2] !== 'number') throw new Error(`bad value in ${JSON.stringify(c)}`);
    }
    const hold = spec.hold ?? 5;
    if (!Number.isInteger(hold) || hold < 1 || hold > 60) throw new Error('hold must be 1-60 trading days');
    if (spec.stopPct != null && !(spec.stopPct > 0 && spec.stopPct < 50)) throw new Error('stopPct must be between 0 and 50');
    return { when: spec.when, hold, stopPct: spec.stopPct ?? null };
}

/** Add an idea (or return the existing one with the same name). */
async function addHypothesis({ name, family = null, idea = null, spec, source = 'manual' }) {
    await ensureTable();
    const clean = validateSpec(spec);
    const r = await query(
        `INSERT INTO research_hypotheses (name, family, idea, spec, source) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (name) DO NOTHING RETURNING *`,
        [name, family, idea, JSON.stringify(clean), source]);
    if (r.rows.length) return { hypothesis: r.rows[0], created: true };
    return { hypothesis: (await query(`SELECT * FROM research_hypotheses WHERE name = $1`, [name])).rows[0], created: false };
}

const matches = (when, f) => when.every(([k, op, v]) => f[k] != null && OPS[op](f[k], v));

/** Rolling max/min over the last n values (inclusive), O(len). */
function rollingExtreme(a, n, isMax) {
    const out = new Array(a.length).fill(null), dq = [];
    for (let i = 0; i < a.length; i++) {
        while (dq.length && (isMax ? a[dq[dq.length - 1]] <= a[i] : a[dq[dq.length - 1]] >= a[i])) dq.pop();
        dq.push(i);
        if (dq[0] <= i - n) dq.shift();
        if (i >= n - 1) out[i] = a[dq[0]];
    }
    return out;
}

function rollingMean(a, n) {
    const out = new Array(a.length).fill(null);
    let s = 0;
    for (let i = 0; i < a.length; i++) {
        s += a[i];
        if (i >= n) s -= a[i - n];
        if (i >= n - 1) out[i] = s / n;
    }
    return out;
}

/** Per-bar features for one symbol (bars sorted by date). market: d → {spyRet5, spyAbove200}. */
function computeFeatures(bars, market = {}) {
    const n = bars.length;
    const c = bars.map(b => b.c), h = bars.map(b => b.h), l = bars.map(b => b.l), v = bars.map(b => b.v);
    const dv = bars.map(b => b.c * b.v);
    const s50 = rollingMean(c, 50), s200 = rollingMean(c, 200), v20 = rollingMean(v, 20), dv20 = rollingMean(dv, 20);
    const hi252 = rollingExtreme(h, 252, true), lo252 = rollingExtreme(l, 252, false);
    const tr = bars.map((b, i) => i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - c[i - 1]), Math.abs(b.l - c[i - 1])));
    const atr = rollingMean(tr, 14), rsi = rsiSeries(c);
    const pct = (a, b) => (b > 0 ? (a / b - 1) * 100 : null);
    const out = new Array(n).fill(null);
    for (let i = 21; i < n; i++) {
        const m = market[bars[i].d] || {};
        out[i] = {
            ret1: pct(c[i], c[i - 1]), prevRet1: pct(c[i - 1], c[i - 2]), ret5: pct(c[i], c[i - 5]), ret20: pct(c[i], c[i - 20]),
            ret60: i >= 60 ? pct(c[i], c[i - 60]) : null, gap: pct(bars[i].o, c[i - 1]),
            volRatio: v20[i - 1] > 0 ? v[i] / v20[i - 1] : null,
            sma50Dist: s50[i] ? pct(c[i], s50[i]) : null, sma200Dist: s200[i] ? pct(c[i], s200[i]) : null,
            rsi14: rsi[i], high52Dist: hi252[i] ? pct(c[i], hi252[i]) : null, low52Dist: lo252[i] ? pct(c[i], lo252[i]) : null,
            rangePos: h[i] > l[i] ? (c[i] - l[i]) / (h[i] - l[i]) : 0.5, price: c[i],
            atrPct: atr[i] ? atr[i] / c[i] * 100 : null, spyRet5: m.spyRet5 ?? null, spyAbove200: m.spyAbove200 ?? null,
            _dv20: dv20[i],
        };
    }
    return out;
}

/** Return % for a buy at bars[i+1].o held `hold` days, with an optional gap-aware stop. */
function tradeReturn(bars, i, hold, stopPct) {
    const e = bars[i + 1]?.o, x = bars[i + hold];
    if (!(e > 0) || !x) return null;
    if (stopPct) {
        const stop = e * (1 - stopPct / 100);
        for (let k = i + 1; k <= i + hold; k++) {
            if (bars[k].l <= stop) return (Math.min(bars[k].o, stop) / e - 1) * 100;
        }
    }
    return Math.max(-50, Math.min(50, (x.c / e - 1) * 100));
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
function tStat(a) {
    if (a.length < 3) return null;
    const m = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
    return sd > 0 ? m / (sd / Math.sqrt(a.length)) : null;
}

/**
 * Score one idea from per-date sums. sig/base: Map date → {s, n}. Returns the result
 * object stored on the row, including the verdict against the fixed PASS rule.
 */
function scoreIdea(sig, base) {
    const diffs = [];
    let trades = 0, wins = 0;
    for (const [d, a] of sig) {
        const b = base.get(d);
        if (!b || !b.n) continue;
        diffs.push({ d, v: a.s / a.n - b.s / b.n });
        trades += a.n; wins += a.w;
    }
    const part = arr => {
        const vals = arr.map(x => x.v);
        return { dates: vals.length, edgePp: vals.length ? +mean(vals).toFixed(2) : null, t: vals.length ? +(tStat(vals) ?? 0).toFixed(2) : null };
    };
    const train = part(diffs.filter(x => x.d < HOLDOUT_START)), holdout = part(diffs.filter(x => x.d >= HOLDOUT_START));
    const byYear = {};
    for (const x of diffs) (byYear[x.d.slice(0, 4)] ||= []).push(x.v);
    const years = Object.fromEntries(Object.entries(byYear).map(([y, a]) => [y, +mean(a).toFixed(2)]));
    const yv = Object.values(years);
    const positiveYears = yv.filter(x => x > 0).length;
    const why = [];
    if (train.dates < PASS.trainDates) why.push(`only ${train.dates} train dates`);
    else if (!(train.edgePp >= PASS.trainEdge && train.t >= PASS.trainT)) why.push(`train ${train.edgePp}pp t=${train.t} (needs ≥${PASS.trainEdge}pp, t≥${PASS.trainT})`);
    if (holdout.dates < PASS.holdDates) why.push(`only ${holdout.dates} holdout dates`);
    else if (!(holdout.edgePp >= PASS.holdEdge && holdout.t >= PASS.holdT)) why.push(`holdout ${holdout.edgePp}pp t=${holdout.t} (needs ≥${PASS.holdEdge}pp, t≥${PASS.holdT})`);
    if (yv.length && positiveYears / yv.length < PASS.positiveYearsShare) why.push(`${positiveYears}/${yv.length} years positive`);
    return {
        trades, winPct: trades ? +(wins / trades * 100).toFixed(1) : null, train, holdout, years,
        verdict: why.length ? 'fail' : 'pass', why: why.join('; ') || 'cleared train, holdout and year checks',
    };
}

async function _market() {
    const spy = (await query(`SELECT d::text AS d, c FROM history_bars WHERE symbol = 'SPY' ORDER BY d`)).rows;
    const c = spy.map(r => r.c), s200 = rollingMean(c, 200), out = {};
    spy.forEach((r, i) => {
        out[r.d] = { spyRet5: i >= 5 ? (c[i] / c[i - 5] - 1) * 100 : null, spyAbove200: s200[i] ? (c[i] > s200[i] ? 1 : 0) : null };
    });
    return { calendar: spy.map(r => r.d), market: out };
}

/**
 * Test ideas (default: every queued one) in one pass over history_bars and store results.
 * Returns the updated rows. Never touches live trading.
 */
async function runQueued({ ids = null, batch = 300 } = {}) {
    await ensureTable();
    const rows = (await query(
        ids ? `SELECT * FROM research_hypotheses WHERE id = ANY($1)` : `SELECT * FROM research_hypotheses WHERE status = 'queued' ORDER BY id`,
        ids ? [ids] : [])).rows;
    if (!rows.length) return [];
    const specs = rows.map(r => ({ id: r.id, ...validateSpec(r.spec) }));
    const baseKeys = [...new Set(specs.map(s => `${s.hold}|${s.stopPct ?? ''}`))];
    const sig = new Map(specs.map(s => [s.id, new Map()]));
    const base = new Map(baseKeys.map(k => [k, new Map()]));
    const add = (m, d, r) => { const a = m.get(d) || { s: 0, n: 0, w: 0 }; a.s += r; a.n++; if (r > 0) a.w++; m.set(d, a); };

    const { calendar, market } = await _market();
    const calIdx = new Map(calendar.map((d, i) => [d, i]));
    const symbols = (await query(`SELECT DISTINCT symbol FROM history_bars WHERE symbol <> 'SPY' ORDER BY symbol`)).rows.map(r => r.symbol);
    const t0 = Date.now();
    for (let s = 0; s < symbols.length; s += batch) {
        const res = await query(`SELECT symbol, d::text AS d, o, h, l, c, v::float AS v FROM history_bars WHERE symbol = ANY($1) ORDER BY symbol, d`, [symbols.slice(s, s + batch)]);
        const bySym = new Map();
        for (const r of res.rows) { if (!bySym.has(r.symbol)) bySym.set(r.symbol, []); bySym.get(r.symbol).push(r); }
        for (const bars of bySym.values()) {
            const feats = computeFeatures(bars, market);
            const maxHold = Math.max(...specs.map(x => x.hold));
            for (let i = 200; i < bars.length - 1; i++) {
                const f = feats[i];
                if (!f || f.price < MIN_PRICE || !(f._dv20 >= MIN_IEX_DOLLAR_VOL)) continue;
                const ci = calIdx.get(bars[i].d);
                if (ci == null) continue;
                // contiguous with the market calendar through the longest hold, so "N days" means N trading days
                const span = Math.min(maxHold, bars.length - 1 - i);
                if (calIdx.get(bars[i + span].d) !== ci + span) continue;
                const d = bars[i].d;
                const cache = {};
                for (const k of baseKeys) {
                    const [hold, stop] = k.split('|');
                    const r = tradeReturn(bars, i, +hold, stop ? +stop : null);
                    if (r != null) { cache[k] = r; add(base.get(k), d, r); }
                }
                for (const sp of specs) {
                    const r = cache[`${sp.hold}|${sp.stopPct ?? ''}`];
                    if (r != null && matches(sp.when, f)) add(sig.get(sp.id), d, r);
                }
            }
        }
    }

    const out = [];
    for (const sp of specs) {
        const result = { ...scoreIdea(sig.get(sp.id), base.get(`${sp.hold}|${sp.stopPct ?? ''}`)), holdoutStart: HOLDOUT_START };
        const r = await query(`UPDATE research_hypotheses SET status = $2, result = $3, tested_at = NOW() WHERE id = $1 RETURNING *`,
            [sp.id, result.verdict, JSON.stringify(result)]);
        out.push(r.rows[0]);
    }
    logger.info('[ResearchLab] Tested ideas', { count: out.length, passed: out.filter(r => r.status === 'pass').length, seconds: Math.round((Date.now() - t0) / 1000) });
    return out;
}

function formatResult(row) {
    const r = row.result || {};
    const yrs = Object.entries(r.years || {}).map(([y, v]) => `${y} ${v >= 0 ? '+' : ''}${v}`).join(', ');
    return `${row.status === 'pass' ? '✅' : '❌'} ${row.name}: train ${r.train?.edgePp ?? '–'}pp (t ${r.train?.t ?? '–'}), ` +
        `holdout ${r.holdout?.edgePp ?? '–'}pp (t ${r.holdout?.t ?? '–'}), ${r.trades ?? 0} trades · ${yrs}`;
}

/** Saturday: test the queue and send admin a short summary. Never throws. */
async function runWeekly() {
    try {
        const tested = await runQueued();
        if (!tested.length) return null;
        const total = (await query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE status = 'pass')::int AS p FROM research_hypotheses WHERE status <> 'queued'`)).rows[0];
        const msg = `🔬 *Research lab* — ${tested.length} idea(s) tested\n\n${tested.map(formatResult).join('\n')}\n\n` +
            `All-time: ${total.p} passed of ${total.n} tested. A pass goes to paper first; live only by approval.`;
        await require('./telegramAlertService').sendAdminMessage(msg).catch(() => {});
        return tested;
    } catch (err) {
        logger.warn('[ResearchLab] Weekly run failed', { error: err.message });
        return null;
    }
}

module.exports = {
    ensureTable, addHypothesis, runQueued, runWeekly, validateSpec, computeFeatures, tradeReturn, scoreIdea, matches,
    formatResult, rollingExtreme, FEATURES, PASS, HOLDOUT_START,
};
