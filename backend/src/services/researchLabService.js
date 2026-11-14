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
 *
 * Stricter grading (2026-11-14):
 *   - Costs: COST_PP (round trip) comes off the idea's edge before any threshold.
 *   - Overlapping holds: a 10-day idea firing on consecutive days counts the same move
 *     several times, which inflates a plain t-stat. t is Newey-West with lag = hold - 1.
 *   - Many ideas tested: Benjamini-Hochberg false-discovery control across every idea ever
 *     tested. A pass needs q <= FDR_Q as well as the other bars.
 *   - The holdout must also beat SPY over the same hold after costs (not only "any stock").
 *   - "promising": positive after costs in both periods with train t >= 2, but not a pass.
 *     Re-tested every Saturday as data grows; never traded.
 *   - Reported for reading: win rate, profit factor, avg win / avg loss, worst losing
 *     stretch, SPY above vs below its 200-day, and 5/10/20-day horizons.
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');
const { rsiSeries } = require('./historyBacktestService');

const HOLDOUT_START = '2025-07-01';
const MIN_PRICE = 3;
const MIN_IEX_DOLLAR_VOL = 200_000; // IEX is ~2-3% of US volume
const PASS = { trainDates: 50, trainEdge: 0.3, trainT: 2.5, holdDates: 30, holdEdge: 0.2, holdT: 1.5, positiveYearsShare: 0.75 };
const COST_PP = 0.15;   // round-trip spread + slippage, % of the position (liquid $3+ names)
const FDR_Q = 0.10;     // Benjamini-Hochberg false-discovery level across all tested ideas
const PROMISING = { trainT: 2.0 };
const HORIZONS = [5, 10, 20];

/** Feature names a spec may use (all computed from bars up to and including the signal day). */
const FEATURES = {
    ret1: '1-day % change', ret5: '5-day % change', ret20: '20-day % change', ret60: '60-day % change',
    gap: 'open vs prior close %', volRatio: 'volume / prior 20-day average', sma50Dist: '% above 50-day average',
    sma200Dist: '% above 200-day average', rsi14: 'RSI(14)', high52Dist: '% below 52-week high (≤0)',
    low52Dist: '% above 52-week low', rangePos: 'close position in day range 0-1', price: 'close',
    atrPct: '14-day ATR as % of price', spyRet5: 'SPY 5-day % change', spyAbove200: 'SPY above its 200-day average (1/0)',
    prevRet1: 'prior day 1-day % change',
    // The one forward-looking field that is still honest: the simulated buy happens AT the next
    // open, so how far that open gapped is known at the moment of entry (2026-11-13).
    nextGap: 'next open vs today\'s close % (known at the entry open)',
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
            status      TEXT        NOT NULL DEFAULT 'queued',
            result      JSONB,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            tested_at   TIMESTAMPTZ
        )`);
    await query(`ALTER TABLE research_hypotheses DROP CONSTRAINT IF EXISTS research_hypotheses_status_check`);
    await query(`ALTER TABLE research_hypotheses ADD CONSTRAINT research_hypotheses_status_check
                 CHECK (status IN ('queued', 'pass', 'promising', 'fail', 'error'))`);
    _ready = true;
}

function validateSpec(spec) {
    const events = spec?.event == null ? null : [].concat(spec.event);
    if (events) {
        const { EVENT_TYPES } = require('./newsEventService');
        for (const e of events) if (!EVENT_TYPES.includes(e) || e === 'noise') throw new Error(`unknown event ${e}`);
    }
    if (!spec || !Array.isArray(spec.when) || (!spec.when.length && !events)) throw new Error('spec.when must be a non-empty list (or give an event)');
    for (const c of spec.when) {
        if (!Array.isArray(c) || c.length !== 3) throw new Error(`condition must be [feature, op, value]: ${JSON.stringify(c)}`);
        if (!(c[0] in FEATURES)) throw new Error(`unknown feature ${c[0]}`);
        if (!(c[1] in OPS)) throw new Error(`unknown op ${c[1]}`);
        if (c[1] === 'between' ? !(Array.isArray(c[2]) && c[2].length === 2) : typeof c[2] !== 'number') throw new Error(`bad value in ${JSON.stringify(c)}`);
    }
    const hold = spec.hold ?? 5;
    if (!Number.isInteger(hold) || hold < 1 || hold > 60) throw new Error('hold must be 1-60 trading days');
    if (spec.stopPct != null && !(spec.stopPct > 0 && spec.stopPct < 50)) throw new Error('stopPct must be between 0 and 50');
    return { when: spec.when, hold, stopPct: spec.stopPct ?? null, ...(events ? { event: events } : {}) };
}

/**
 * Signal day for a news item: the trading day before the first open AFTER the news, so the
 * simulated buy (next open) never uses news that wasn't out yet. Pre-9:30 ET news on a
 * trading day → buy that day's open; later or non-trading-day news → the next open.
 */
function eventSignalDay(etDate, preOpen, calendar, calIdx) {
    let entry = preOpen && calIdx.has(etDate) ? calIdx.get(etDate) : null;
    if (entry == null) {
        let lo = 0, hi = calendar.length; // first calendar day > etDate
        while (lo < hi) { const mid = (lo + hi) >> 1; if (calendar[mid] <= etDate) lo = mid + 1; else hi = mid; }
        entry = lo;
    }
    return entry >= 1 && entry < calendar.length ? calendar[entry - 1] : null;
}

async function _eventDays(types, calendar, calIdx) {
    const sets = new Map(types.map(t => [t, new Set()]));
    if (!types.length) return sets;
    const r = await query(
        `SELECT symbol, event_type, (created_at AT TIME ZONE 'America/New_York')::date::text AS d,
                (created_at AT TIME ZONE 'America/New_York')::time < '09:30' AS pre
         FROM news_events WHERE event_type = ANY($1)`, [types]);
    for (const row of r.rows) {
        const sd = eventSignalDay(row.d, row.pre, calendar, calIdx);
        if (sd) sets.get(row.event_type).add(`${row.symbol}|${sd}`);
    }
    return sets;
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
            nextGap: i + 1 < n ? pct(bars[i + 1].o, c[i]) : null,
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
 * Newey-West t-stat for a dated series whose holds overlap. pts: [{i (trading-day index), v}].
 * Pairs fewer than `hold` trading days apart share part of the same move; they get Bartlett
 * weights 1 - k/hold. hold = 1 gives the ordinary t (population variance).
 */
function nwTStat(pts, hold) {
    const n = pts.length;
    if (n < 3) return null;
    const m = mean(pts.map(p => p.v));
    const e = pts.map(p => ({ i: p.i, x: p.v - m })).sort((a, b) => a.i - b.i);
    let v = e.reduce((s, p) => s + p.x * p.x, 0);
    if (hold > 1) {
        for (let a = 0; a < n; a++) {
            for (let b = a + 1; b < n && e[b].i - e[a].i < hold; b++) v += 2 * (1 - (e[b].i - e[a].i) / hold) * e[a].x * e[b].x;
        }
    }
    v /= n;
    return v > 0 ? m / Math.sqrt(v / n) : null;
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26), accurate enough for p-values. */
function normCdf(z) {
    const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
    const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Benjamini-Hochberg q-values for p-values (input order preserved). */
function bhQ(ps) {
    const idx = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
    const q = new Array(ps.length);
    let prev = 1;
    for (let k = idx.length - 1; k >= 0; k--) {
        prev = Math.min(prev, idx[k][0] * idx.length / (k + 1));
        q[idx[k][1]] = prev;
    }
    return q;
}

/** Largest peak-to-trough fall (pp) of the running sum of daily edges, and the longest run of losing dates. */
function worstStretch(vals) {
    let cum = 0, peak = 0, dd = 0, run = 0, maxRun = 0;
    for (const v of vals) {
        cum += v; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum);
        run = v < 0 ? run + 1 : 0; maxRun = Math.max(maxRun, run);
    }
    return { maxDrawdownPp: +dd.toFixed(1), longestLosingDates: maxRun };
}

const r2 = x => (x == null || !Number.isFinite(x) ? null : +x.toFixed(2));

/**
 * Score one idea from per-date sums. sig/base: Map date → {s, n, w, g, l}. Returns the result
 * object stored on the row; the FDR check is applied afterwards across all ideas (applyFdr).
 * opts: hold (Newey-West lag), cost, calIdx (date → trading-day index), spy (date → SPY % over
 * the same hold from the next open), regime (date → SPY above its 200-day, 1/0).
 */
function scoreIdea(sig, base, { hold = 1, cost = COST_PP, calIdx = null, spy = null, regime = null } = {}) {
    const diffs = [];
    let trades = 0, wins = 0, gains = 0, losses = 0, k = 0;
    for (const [d, a] of [...sig].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
        const b = base.get(d);
        if (!b || !b.n) continue;
        const ideaRet = a.s / a.n;
        diffs.push({ d, i: calIdx?.get(d) ?? k, v: ideaRet - b.s / b.n - cost,
                     vsSpy: spy?.has(d) ? ideaRet - cost - spy.get(d) : null, up: regime?.get(d) ?? null });
        trades += a.n; wins += a.w; gains += a.g || 0; losses += a.l || 0; k++;
    }
    const part = arr => {
        const vals = arr.map(x => x.v), sp = arr.filter(x => x.vsSpy != null).map(x => x.vsSpy);
        return { dates: vals.length, edgePp: vals.length ? r2(mean(vals) + cost) : null, netPp: vals.length ? r2(mean(vals)) : null,
                 t: vals.length ? r2(nwTStat(arr, hold) ?? 0) : null, vsSpyPp: sp.length ? r2(mean(sp)) : null };
    };
    const train = part(diffs.filter(x => x.d < HOLDOUT_START)), holdout = part(diffs.filter(x => x.d >= HOLDOUT_START));
    const byYear = {};
    for (const x of diffs) (byYear[x.d.slice(0, 4)] ||= []).push(x.v);
    const years = Object.fromEntries(Object.entries(byYear).map(([y, a]) => [y, r2(mean(a))]));
    const yv = Object.values(years);
    const positiveYears = yv.filter(x => x > 0).length;
    const reg = up => { const a = diffs.filter(x => x.up === up).map(x => x.v); return a.length ? { dates: a.length, netPp: r2(mean(a)) } : null; };
    const why = [];
    if (train.dates < PASS.trainDates) why.push(`only ${train.dates} train dates`);
    else if (!(train.netPp >= PASS.trainEdge && train.t >= PASS.trainT)) why.push(`train ${train.netPp}pp after costs, t=${train.t} (needs ≥${PASS.trainEdge}pp, t≥${PASS.trainT})`);
    if (holdout.dates < PASS.holdDates) why.push(`only ${holdout.dates} holdout dates`);
    else if (!(holdout.netPp >= PASS.holdEdge && holdout.t >= PASS.holdT)) why.push(`holdout ${holdout.netPp}pp after costs, t=${holdout.t} (needs ≥${PASS.holdEdge}pp, t≥${PASS.holdT})`);
    else if (holdout.vsSpyPp != null && !(holdout.vsSpyPp > 0)) why.push(`holdout lags SPY by ${holdout.vsSpyPp}pp after costs`);
    if (yv.length && positiveYears / yv.length < PASS.positiveYearsShare) why.push(`${positiveYears}/${yv.length} years positive`);
    const promising = why.length > 0 && train.dates >= PASS.trainDates && holdout.dates >= PASS.holdDates
        && train.netPp > 0 && train.t >= PROMISING.trainT && holdout.netPp > 0;
    return {
        trades, winPct: trades ? +(wins / trades * 100).toFixed(1) : null,
        profitFactor: losses > 0 ? r2(gains / losses) : null,
        avgWinPct: wins ? r2(gains / wins) : null, avgLossPct: trades - wins ? r2(-losses / (trades - wins)) : null,
        // v / hold ≈ a portfolio that spreads its money over `hold` overlapping daily batches
        ...worstStretch(diffs.map(x => x.v / hold)),
        regimes: { spyAbove200: reg(1), spyBelow200: reg(0) },
        train, holdout, years, costPp: cost,
        verdict: why.length ? (promising ? 'promising' : 'fail') : 'pass',
        why: why.join('; ') || 'cleared train, holdout, SPY and year checks',
    };
}

/** One-sided p from each train t; BH q across every tested idea; a pass also needs q ≤ FDR_Q. */
function applyFdr(results) {
    const ps = results.map(r => (r.train?.t != null ? 1 - normCdf(r.train.t) : 1));
    const qs = bhQ(ps);
    return results.map((r, i) => {
        const out = { ...r, fdrQ: r2(qs[i]), testedIdeas: results.length };
        if (out.verdict === 'pass' && !(qs[i] <= FDR_Q)) {
            out.verdict = 'promising';
            out.why = `could be luck: q=${out.fdrQ} across ${results.length} ideas tested (needs ≤${FDR_Q})`;
        }
        return out;
    });
}

async function _market() {
    const spy = (await query(`SELECT d::text AS d, o, c FROM history_bars WHERE symbol = 'SPY' ORDER BY d`)).rows;
    const c = spy.map(r => r.c), s200 = rollingMean(c, 200), out = {};
    spy.forEach((r, i) => {
        out[r.d] = { spyRet5: i >= 5 ? (c[i] / c[i - 5] - 1) * 100 : null, spyAbove200: s200[i] ? (c[i] > s200[i] ? 1 : 0) : null };
    });
    // SPY % from the next open to the close `hold` days later: the same trade the idea makes.
    const spyFwd = hold => new Map(spy.map((r, i) => [r.d, i + hold < spy.length && spy[i + 1].o > 0 ? (spy[i + hold].c / spy[i + 1].o - 1) * 100 : null])
        .filter(([, v]) => v != null));
    return { calendar: spy.map(r => r.d), market: out, spyFwd };
}

/**
 * Test ideas (default: every queued one) in one pass over history_bars and store results.
 * Returns the updated rows. Never touches live trading.
 */
async function runQueued({ ids = null, batch = 300, includePromising = false } = {}) {
    await ensureTable();
    const rows = (await query(
        ids ? `SELECT * FROM research_hypotheses WHERE id = ANY($1)`
            : `SELECT * FROM research_hypotheses WHERE status = 'queued'${includePromising ? ` OR status = 'promising'` : ''} ORDER BY id`,
        ids ? [ids] : [])).rows;
    if (!rows.length) return [];
    const specs = rows.map(r => ({ id: r.id, ...validateSpec(r.spec) }));
    const baseKeys = [...new Set([...specs.map(s => `${s.hold}|${s.stopPct ?? ''}`), ...HORIZONS.map(h => `${h}|`)])];
    const sig = new Map(specs.map(s => [s.id, new Map()]));
    const sigH = new Map(specs.map(s => [s.id, new Map(HORIZONS.map(h => [h, new Map()]))]));
    const base = new Map(baseKeys.map(k => [k, new Map()]));
    const add = (m, d, r) => {
        const a = m.get(d) || { s: 0, n: 0, w: 0, g: 0, l: 0 };
        a.s += r; a.n++; if (r > 0) { a.w++; a.g += r; } else a.l -= r;
        m.set(d, a);
    };

    const { calendar, market, spyFwd } = await _market();
    const calIdx = new Map(calendar.map((d, i) => [d, i]));
    const eventSets = await _eventDays([...new Set(specs.flatMap(s => s.event || []))], calendar, calIdx);
    const hasEvent = (sp, sym, d) => !sp.event || sp.event.some(t => eventSets.get(t).has(`${sym}|${d}`));
    const symbols = (await query(`SELECT DISTINCT symbol FROM history_bars WHERE symbol <> 'SPY' ORDER BY symbol`)).rows.map(r => r.symbol);
    const t0 = Date.now();
    for (let s = 0; s < symbols.length; s += batch) {
        const res = await query(`SELECT symbol, d::text AS d, o, h, l, c, v::float AS v FROM history_bars WHERE symbol = ANY($1) ORDER BY symbol, d`, [symbols.slice(s, s + batch)]);
        const bySym = new Map();
        for (const r of res.rows) { if (!bySym.has(r.symbol)) bySym.set(r.symbol, []); bySym.get(r.symbol).push(r); }
        for (const bars of bySym.values()) {
            const feats = computeFeatures(bars, market);
            const maxHold = Math.max(...specs.map(x => x.hold), ...HORIZONS);
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
                    if (!matches(sp.when, f) || !hasEvent(sp, bars[i].symbol, d)) continue;
                    if (r != null) add(sig.get(sp.id), d, r);
                    for (const h of HORIZONS) if (cache[`${h}|`] != null) add(sigH.get(sp.id).get(h), d, cache[`${h}|`]);
                }
            }
        }
    }

    const regime = new Map(Object.entries(market).map(([d, m]) => [d, m.spyAbove200]));
    const fresh = new Map();
    for (const sp of specs) {
        const result = { ...scoreIdea(sig.get(sp.id), base.get(`${sp.hold}|${sp.stopPct ?? ''}`), { hold: sp.hold, calIdx, spy: spyFwd(sp.hold), regime }), holdoutStart: HOLDOUT_START };
        result.horizons = Object.fromEntries(HORIZONS.map(h => {
            const x = scoreIdea(sigH.get(sp.id).get(h), base.get(`${h}|`), { hold: h, calIdx, spy: spyFwd(h) });
            return [h, { trainNetPp: x.train.netPp, holdoutNetPp: x.holdout.netPp, holdoutVsSpyPp: x.holdout.vsSpyPp }];
        }));
        fresh.set(sp.id, result);
    }
    // FDR across every idea ever tested (fresh results replace stored ones), then save.
    const prior = (await query(`SELECT id, result FROM research_hypotheses WHERE status NOT IN ('queued', 'error') AND result IS NOT NULL`)).rows;
    const all = new Map(prior.map(p => [p.id, p.result]));
    for (const [id, r] of fresh) all.set(id, r);
    const allIds = [...all.keys()];
    const graded = applyFdr(allIds.map(id => all.get(id)));
    const out = [];
    for (let k = 0; k < allIds.length; k++) {
        const id = allIds[k], g = graded[k];
        if (fresh.has(id)) {
            const r = await query(`UPDATE research_hypotheses SET status = $2, result = $3, tested_at = NOW() WHERE id = $1 RETURNING *`,
                [id, g.verdict, JSON.stringify(g)]);
            out.push(r.rows[0]);
        } else {
            // Older ideas keep their verdict but get a fresh q (more ideas tested = stricter), so a stored pass can drop to promising.
            await query(`UPDATE research_hypotheses SET status = $2, result = $3 WHERE id = $1`, [id, g.verdict || 'fail', JSON.stringify(g)]);
        }
    }
    logger.info('[ResearchLab] Tested ideas', { count: out.length, passed: out.filter(r => r.status === 'pass').length, promising: out.filter(r => r.status === 'promising').length, seconds: Math.round((Date.now() - t0) / 1000) });
    return out;
}

function formatResult(row) {
    const r = row.result || {};
    const yrs = Object.entries(r.years || {}).map(([y, v]) => `${y} ${v >= 0 ? '+' : ''}${v}`).join(', ');
    const icon = row.status === 'pass' ? '✅' : row.status === 'promising' ? '🟡' : '❌';
    return `${icon} ${row.name}: train ${r.train?.netPp ?? r.train?.edgePp ?? '–'}pp after costs (t ${r.train?.t ?? '–'}), ` +
        `holdout ${r.holdout?.netPp ?? r.holdout?.edgePp ?? '–'}pp (t ${r.holdout?.t ?? '–'}), ${r.trades ?? 0} trades · ${yrs}`;
}

/** Saturday: test the queue and send admin a short summary. Never throws. */
async function runWeekly() {
    try {
        const tested = await runQueued({ includePromising: true });
        if (!tested.length) return null;
        const total = (await query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE status = 'pass')::int AS p, COUNT(*) FILTER (WHERE status = 'promising')::int AS pr FROM research_hypotheses WHERE status <> 'queued'`)).rows[0];
        const msg = `🔬 *Research lab* — ${tested.length} idea(s) tested\n\n${tested.map(formatResult).join('\n')}\n\n` +
            `All-time: ${total.p} passed, ${total.pr} promising (re-tested weekly) of ${total.n} tested. A pass goes to paper first; live only by approval.`;
        await require('./telegramAlertService').sendAdminMessage(msg).catch(() => {});
        await require('./reportArchiveService').save({ kind: 'research_lab', body: msg, adminOnly: true }).catch(() => {});
        return tested;
    } catch (err) {
        logger.warn('[ResearchLab] Weekly run failed', { error: err.message });
        return null;
    }
}

module.exports = {
    ensureTable, addHypothesis, runQueued, runWeekly, validateSpec, computeFeatures, tradeReturn, scoreIdea, matches, eventSignalDay,
    formatResult, rollingExtreme, FEATURES, PASS, HOLDOUT_START,
    nwTStat, normCdf, bhQ, applyFdr, worstStretch, COST_PP, FDR_Q,
};
