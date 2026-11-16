/**
 * Core vs SPY vs T-bills (2026-11-16). Answers "does the core allocation add anything over just buying SPY?"
 *
 * Once per trading day (from core guidance, ~10:20 AM ET) we snapshot each core position's quantity and
 * price plus SPY, all from the same moment. The daily core return removes new money:
 *     flow_t   = Σ (qty_t − qty_{t−1}) × price_t         (core buys that day, at today's price)
 *     r_core_t = (value_t − flow_t) / value_{t−1} − 1
 * so buying more shares is not counted as "performance". SPY uses its own price change; T-bills use
 * RISK_FREE_PCT (default 4%/yr) per calendar day. Returns are chained (time-weighted), so the result is
 * "what each dollar in core did" — directly comparable with SPY. Cash-sweep SGOV is excluded (not core).
 * Read-only: nothing here trades.
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const riskFreePct = () => parseFloat(process.env.RISK_FREE_PCT || '4');

let _ready = false;
async function ensureTable() {
    if (_ready) return;
    await query(`CREATE TABLE IF NOT EXISTS core_perf_daily (
        user_id TEXT NOT NULL, day DATE NOT NULL, core_value NUMERIC NOT NULL, positions JSONB NOT NULL,
        spy NUMERIC, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_id, day))`);
    _ready = true;
}

/** Snapshot from getStatus() output. positions: {SYM: {qty, px}} for core holdings with qty > 0. */
async function recordDaily(userId, status, day) {
    await ensureTable();
    const sweep = status.addons?.sweep;
    const positions = {};
    for (const h of status.holdings || []) {
        let qty = Number(h.qty) || 0;
        if (sweep?.qty > 0 && h.symbol === sweep.symbol) qty = Math.max(0, qty - sweep.qty);
        if (qty > 0 && Number(h.price) > 0) positions[h.symbol] = { qty, px: Number(h.price) };
    }
    if (!Object.keys(positions).length) return null;
    const value = Object.values(positions).reduce((s, p) => s + p.qty * p.px, 0);
    const q = await require('./dataProvider').getQuote('SPY').catch(() => null);
    await query(`INSERT INTO core_perf_daily (user_id, day, core_value, positions, spy) VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (user_id, day) DO UPDATE SET core_value = EXCLUDED.core_value, positions = EXCLUDED.positions, spy = EXCLUDED.spy`,
        [String(userId), day, value, JSON.stringify(positions), q?.price || null]);
    return { value, positions };
}

/**
 * Pure (unit-tested). snaps: [{day, value, positions, spy}] oldest first.
 * Returns chained core / SPY / T-bill returns in % and the per-day series.
 */
function compare(snaps, rfPct = riskFreePct()) {
    let core = 1, spy = 1, tbill = 1, days = 0;
    const series = [];
    for (let i = 1; i < snaps.length; i++) {
        const a = snaps[i - 1], b = snaps[i];
        if (!(a.value > 0) || !(a.spy > 0) || !(b.spy > 0)) continue;
        let flow = 0;
        for (const [sym, p] of Object.entries(b.positions || {})) {
            const prevQty = a.positions?.[sym]?.qty || 0;
            flow += (p.qty - prevQty) * p.px;
        }
        for (const [sym, p] of Object.entries(a.positions || {})) {
            if (!b.positions?.[sym]) flow -= p.qty * p.px; // fully removed (manual sale) — use last known price
        }
        const rc = (b.value - flow) / a.value - 1;
        const rs = b.spy / a.spy - 1;
        const cal = Math.max(1, Math.round((new Date(b.day) - new Date(a.day)) / 86400000));
        core *= 1 + rc; spy *= 1 + rs; tbill *= Math.pow(1 + rfPct / 100, cal / 365);
        days++;
        series.push({ day: b.day, corePct: +((core - 1) * 100).toFixed(2), spyPct: +((spy - 1) * 100).toFixed(2), tbillPct: +((tbill - 1) * 100).toFixed(2) });
    }
    const pct = x => +((x - 1) * 100).toFixed(2);
    return {
        since: snaps[0]?.day || null, through: snaps[snaps.length - 1]?.day || null, tradingDays: days,
        corePct: pct(core), spyPct: pct(spy), tbillPct: pct(tbill),
        vsSpyPp: +((core - spy) * 100).toFixed(2), vsTbillPp: +((core - tbill) * 100).toFixed(2), rfPct, series,
    };
}

async function getComparison(userId) {
    await ensureTable();
    const r = await query(`SELECT day::text AS day, core_value::float AS value, positions, spy::float AS spy
                           FROM core_perf_daily WHERE user_id = $1 ORDER BY day`, [String(userId)]);
    if (r.rows.length < 2) return { since: r.rows[0]?.day || null, tradingDays: 0, note: 'Needs at least two trading days of snapshots.' };
    return compare(r.rows);
}

/** Friday: save a plain-English weekly line per user into the reports archive. */
async function weeklyReport(userId) {
    const c = await getComparison(userId).catch(err => { logger.warn('[CoreBenchmark] compare failed', { userId, error: err.message }); return null; });
    if (!c || !c.tradingDays) return null;
    const verdict = c.vsSpyPp > 0 ? 'ahead of' : c.vsSpyPp < 0 ? 'behind' : 'level with';
    const body = `Since ${c.since} (${c.tradingDays} trading days), each dollar in core returned ${c.corePct}% vs SPY ${c.spyPct}% and T-bills ${c.tbillPct}% (${c.rfPct}%/yr).\n` +
        `Core is ${verdict} SPY by ${Math.abs(c.vsSpyPp)} points. New buys are not counted as gains. Weeks are noisy — judge this over many months, not one week.`;
    await require('./reportArchiveService').save({ kind: 'core_benchmark', title: `Core vs SPY — ${c.through}`, body, userId: String(userId) }).catch(() => {});
    return c;
}

module.exports = { ensureTable, recordDaily, compare, getComparison, weeklyReport, riskFreePct };
