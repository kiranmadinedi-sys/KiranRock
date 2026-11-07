/**
 * Portfolio lab (2026-11-07) — tests HOW we trade the nightly picks, not which signal
 * to use: number of slots, minimum score, sector cap, stop/trail/target, hold time and
 * cash reserve. Past reviews found idle cash and sizing, not stock picks, were the biggest
 * drag on dollars (26% capital use; caps blocked CCL/NDAQ), so this is the money lever.
 *
 * Replays the REAL nightly scores (daily_universe_analysis, since 2026-05-28) on
 * history_bars: buy at the next open in score order (0.1% slippage), equal-weight slots,
 * gap-aware stop, trailing stop off the highest close, take-profit, time exit at the close.
 * Compared with "control" (kmadined today: 6 slots, score ≥ 75, 1 per sector, 5% stop,
 * 5.5% trail, 15% target, ~5-day hold, 5% reserve) and with SPY buy-and-hold.
 *
 * PASS: beats control in BOTH halves of the period with a max drawdown no more than 2pp
 * worse. Only ~5 months of scans exist, so a pass means "try on paper", never "go live".
 * Report only.
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const START_EQUITY = 10000;
const SLIPPAGE = 0.001;
const MIN_SCORE_LOADED = 60;

const CONTROL = { minScore: 75, slots: 6, sectorCap: 1, stopPct: 5, trailPct: 5.5, takeProfitPct: 15, holdDays: 5, reservePct: 5 };
const LIMITS = {
    minScore: [60, 100], slots: [1, 30], sectorCap: [1, 30], stopPct: [1, 30], trailPct: [1, 30],
    takeProfitPct: [2, 100], holdDays: [1, 40], reservePct: [0, 50],
};

/** Fill defaults from control and range-check. Throws on bad input. */
function validateSpec(spec) {
    if (!spec || typeof spec !== 'object') throw new Error('spec must be an object');
    const out = {};
    for (const k of Object.keys(LIMITS)) {
        const v = spec[k] === undefined ? CONTROL[k] : spec[k];
        if (v === null && ['stopPct', 'trailPct', 'takeProfitPct', 'sectorCap'].includes(k)) { out[k] = null; continue; }
        const n = Number(v);
        if (!Number.isFinite(n) || n < LIMITS[k][0] || n > LIMITS[k][1]) throw new Error(`bad ${k}`);
        out[k] = ['slots', 'sectorCap', 'holdDays'].includes(k) ? Math.round(n) : n;
    }
    for (const k of Object.keys(spec)) if (!(k in LIMITS)) throw new Error(`unknown setting ${k}`);
    return out;
}

/** Loads scans + bars once; reused for every spec in a run. */
async function loadData() {
    const scans = (await query(`
        SELECT to_char(analysis_date, 'YYYY-MM-DD') AS d, symbol, ai_score::float AS score, COALESCE(sector, 'Unknown') AS sector
        FROM daily_universe_analysis WHERE ai_score >= $1 ORDER BY analysis_date, ai_score DESC, symbol`, [MIN_SCORE_LOADED])).rows;
    if (!scans.length) return null;
    const symbols = [...new Set(scans.map(s => s.symbol)), 'SPY'];
    const bars = (await query(`
        SELECT symbol, to_char(d, 'YYYY-MM-DD') AS d, o::float o, h::float h, l::float l, c::float c
        FROM history_bars WHERE symbol = ANY($1) AND d >= $2::date ORDER BY d`, [symbols, scans[0].d])).rows;
    const px = new Map(); // `${symbol}|${d}` → bar
    for (const b of bars) px.set(`${b.symbol}|${b.d}`, b);
    const cal = bars.filter(b => b.symbol === 'SPY').map(b => b.d);
    const byNight = new Map();
    for (const s of scans) { if (!byNight.has(s.d)) byNight.set(s.d, []); byNight.get(s.d).push(s); }
    return { cal, px, byNight };
}

/** Run one spec over [fromIdx, toIdx] of the calendar. Pure given data. */
function simulate(spec, data, { fromIdx = 1, toIdx = null } = {}) {
    const { cal, px, byNight } = data;
    const last = toIdx ?? cal.length - 1;
    let cash = START_EQUITY, peak = START_EQUITY, maxDd = 0, investedSum = 0, days = 0;
    let lastScan = null;
    const pos = [];
    const closed = [];
    const equityAt = i => cash + pos.reduce((s, p) => s + p.shares * (px.get(`${p.symbol}|${cal[i]}`)?.c ?? p.lastC), 0);
    let prevEquity = START_EQUITY;

    for (let i = fromIdx; i <= last; i++) {
        const day = cal[i];
        // 1) entries at the open from the most recent scan night before today
        for (const [d] of byNight) if (d < day && (!lastScan || d > lastScan)) lastScan = d;
        const picks = lastScan && lastScan >= cal[i - 1] ? byNight.get(lastScan) : null; // only a fresh scan (last night's)
        if (picks) {
            const slotUsd = prevEquity * (1 - spec.reservePct / 100) / spec.slots;
            for (const s of picks) {
                if (pos.length >= spec.slots) break;
                if (s.score < spec.minScore) break; // picks are sorted by score
                if (pos.some(p => p.symbol === s.symbol)) continue;
                if (spec.sectorCap != null && pos.filter(p => p.sector === s.sector).length >= spec.sectorCap) continue;
                const b = px.get(`${s.symbol}|${day}`);
                if (!b || !(b.o > 0)) continue;
                const fill = b.o * (1 + SLIPPAGE);
                const usd = Math.min(slotUsd, cash);
                if (usd < 50) break;
                const shares = usd / fill;
                cash -= shares * fill;
                pos.push({ symbol: s.symbol, sector: s.sector, shares, entry: fill, entryIdx: i, high: fill, lastC: fill });
            }
        }
        // 2) exits during the day / at the close
        for (let k = pos.length - 1; k >= 0; k--) {
            const p = pos[k];
            const b = px.get(`${p.symbol}|${day}`);
            if (!b) continue; // no bar (halt / missing) — hold
            let exit = null;
            const stop = Math.max(spec.stopPct != null ? p.entry * (1 - spec.stopPct / 100) : 0,
                                  spec.trailPct != null && i > p.entryIdx ? p.high * (1 - spec.trailPct / 100) : 0);
            if (stop > 0 && b.l <= stop) exit = Math.min(b.o, stop);
            else if (spec.takeProfitPct != null && b.h >= p.entry * (1 + spec.takeProfitPct / 100)) exit = Math.max(b.o, p.entry * (1 + spec.takeProfitPct / 100));
            else if (i - p.entryIdx + 1 >= spec.holdDays) exit = b.c;
            p.lastC = b.c;
            p.high = Math.max(p.high, b.c);
            if (exit != null) {
                const out = exit * (1 - SLIPPAGE);
                cash += p.shares * out;
                closed.push((out / p.entry - 1) * 100);
                pos.splice(k, 1);
            }
        }
        const eq = equityAt(i);
        investedSum += (eq - cash) / eq;
        days++;
        peak = Math.max(peak, eq);
        maxDd = Math.max(maxDd, (1 - eq / peak) * 100);
        prevEquity = eq;
    }
    const spy0 = px.get(`SPY|${cal[fromIdx - 1]}`)?.c, spy1 = px.get(`SPY|${cal[last]}`)?.c;
    const r = v => +v.toFixed(2);
    return {
        returnPct: r((prevEquity / START_EQUITY - 1) * 100),
        spyPct: spy0 && spy1 ? r((spy1 / spy0 - 1) * 100) : null,
        maxDrawdownPct: r(maxDd),
        avgInvestedPct: days ? r(investedSum / days * 100) : 0,
        trades: closed.length,
        winPct: closed.length ? r(closed.filter(x => x > 0).length / closed.length * 100) : null,
        avgTradePct: closed.length ? r(closed.reduce((s, x) => s + x, 0) / closed.length) : null,
        from: cal[fromIdx], to: cal[last],
    };
}

/** Full period + each half, and the pass verdict vs control. */
function evaluate(spec, data, controlResult = null) {
    const first = data.cal.findIndex(d => d > [...data.byNight.keys()][0]);
    const startIdx = Math.max(1, first);
    const mid = Math.floor((startIdx + data.cal.length - 1) / 2);
    const full = simulate(spec, data, { fromIdx: startIdx });
    const h1 = simulate(spec, data, { fromIdx: startIdx, toIdx: mid });
    const h2 = simulate(spec, data, { fromIdx: mid + 1 });
    const res = { full, halves: [h1, h2] };
    if (controlResult) {
        const beats = [0, 1].every(i => res.halves[i].returnPct > controlResult.halves[i].returnPct);
        const ddOk = full.maxDrawdownPct <= controlResult.full.maxDrawdownPct + 2;
        res.vsControlPp = +(full.returnPct - controlResult.full.returnPct).toFixed(2);
        res.verdict = beats && ddOk ? 'pass' : 'fail';
        res.why = !beats ? 'did not beat control in both halves' : !ddOk ? 'drawdown more than 2pp worse than control' : 'beat control in both halves';
    }
    return res;
}

/** Grid of starter variants around today's settings: one or two settings changed at a time. */
function starterSpecs() {
    const g = [];
    const add = (name, idea, change) => g.push({ name, idea, spec: { ...CONTROL, ...change } });
    for (const slots of [3, 10, 15, 20]) add(`slots_${slots}`, `${slots} slots instead of 6`, { slots });
    for (const minScore of [70, 80, 85, 90]) add(`minscore_${minScore}`, `buy only score ≥ ${minScore}`, { minScore });
    add('sector_cap_2', 'allow 2 per sector', { sectorCap: 2 });
    add('sector_cap_3', 'allow 3 per sector', { sectorCap: 3 });
    add('no_sector_cap', 'no sector cap', { sectorCap: null });
    add('reserve_0', 'no cash reserve', { reservePct: 0 });
    add('hold_10', 'hold up to 10 days', { holdDays: 10 });
    add('hold_20', 'hold up to 20 days', { holdDays: 20 });
    add('wide_exits', 'wide exit profile: 7% trail, no 5% stop, 10-day hold', { stopPct: null, trailPct: 7, holdDays: 10, takeProfitPct: null });
    add('stop_8', '8% stop', { stopPct: 8 });
    add('no_target', 'no take-profit', { takeProfitPct: null });
    add('slots10_cap2', '10 slots, 2 per sector', { slots: 10, sectorCap: 2 });
    add('slots10_cap2_wide', '10 slots, 2 per sector, wide exits', { slots: 10, sectorCap: 2, stopPct: null, trailPct: 7, holdDays: 10, takeProfitPct: null });
    add('slots15_cap3_min80', '15 slots, 3 per sector, score ≥ 80', { slots: 15, sectorCap: 3, minScore: 80 });
    return g;
}

let _ready = false;
async function ensureTable() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS portfolio_experiments (
            id         SERIAL PRIMARY KEY,
            name       TEXT UNIQUE NOT NULL,
            idea       TEXT,
            spec       JSONB NOT NULL,
            source     TEXT NOT NULL DEFAULT 'starter',
            status     TEXT NOT NULL DEFAULT 'queued',
            result     JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            tested_at  TIMESTAMPTZ
        )`);
    _ready = true;
}

async function addExperiment({ name, idea, spec, source = 'starter' }) {
    await ensureTable();
    await query(`INSERT INTO portfolio_experiments (name, idea, spec, source) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING`,
        [name, idea, JSON.stringify(validateSpec(spec)), source]);
}

/**
 * Weekly: re-test EVERY experiment on the latest data (the period grows each week, so old
 * verdicts can change) and report. Seeds the starter grid on first run.
 */
async function runWeekly({ notify = true } = {}) {
    try {
        await ensureTable();
        for (const s of starterSpecs()) await addExperiment(s);
        const data = await loadData();
        if (!data) return null;
        const control = evaluate(CONTROL, data);
        const exps = (await query(`SELECT * FROM portfolio_experiments ORDER BY id`)).rows;
        const results = [];
        for (const e of exps) {
            let res;
            try { res = evaluate(validateSpec(e.spec), data, control); }
            catch (err) { res = { verdict: 'error', why: err.message }; }
            await query(`UPDATE portfolio_experiments SET status = $2, result = $3, tested_at = NOW() WHERE id = $1`, [e.id, res.verdict, JSON.stringify(res)]);
            results.push({ name: e.name, idea: e.idea, source: e.source, ...res });
        }
        results.sort((a, b) => (b.vsControlPp ?? -1e9) - (a.vsControlPp ?? -1e9));
        const report = { control, results };
        if (notify) {
            const text = formatReport(report);
            await require('./telegramAlertService').sendAdminMessage(text, 'HTML').catch(() => {});
            await require('./reportArchiveService').save({ kind: 'portfolio_lab', title: `Portfolio lab — ${control.full.to}`, body: text, format: 'html', adminOnly: true }).catch(() => {});
        }
        logger.info('[PortfolioLab] Tested', { count: results.length, passed: results.filter(r => r.verdict === 'pass').map(r => r.name) });
        return report;
    } catch (err) {
        logger.warn('[PortfolioLab] Weekly run failed', { error: err.message });
        return null;
    }
}

function formatReport({ control, results }) {
    const c = control.full;
    const L = [`💼 <b>Portfolio lab</b> — real nightly scores ${c.from} → ${c.to}`, '',
        `<b>Control (today's kmadined rules):</b> ${c.returnPct}% vs SPY ${c.spyPct}% · max drawdown ${c.maxDrawdownPct}% · ${c.avgInvestedPct}% invested · ${c.trades} trades, ${c.winPct}% win`, '',
        '<b>Variants (return vs control, both halves must beat it):</b>'];
    for (const r of results.slice(0, 12)) {
        if (!r.full) { L.push(`  ${r.name}: error ${r.why}`); continue; }
        L.push(`  ${r.verdict === 'pass' ? '✅' : '·'} ${r.name}: ${r.full.returnPct}% (${r.vsControlPp >= 0 ? '+' : ''}${r.vsControlPp}pp) · DD ${r.full.maxDrawdownPct}% · ${r.full.avgInvestedPct}% invested`);
    }
    const passed = results.filter(r => r.verdict === 'pass');
    L.push('', passed.length
        ? `<b>${passed.length} passed</b> — paper test candidates only (just ${c.from.slice(0, 7)} onward of data); live changes need your approval.`
        : 'Nothing beat today\'s rules in both halves.');
    return L.join('\n');
}

module.exports = { CONTROL, validateSpec, loadData, simulate, evaluate, starterSpecs, addExperiment, runWeekly, formatReport, ensureTable };
