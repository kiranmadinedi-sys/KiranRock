/**
 * Core vs SPY vs T-bills (2026-11-16). Answers "does the core allocation add anything over just buying SPY?"
 *
 * Once per trading day (from core guidance, ~10:20 AM ET) we snapshot each core position's quantity and
 * price plus SPY, all from the same moment. The daily core return removes new money:
 *     flow_t   = Σ (qty_t − qty_{t−1}) × price_t         (core buys that day, at today's price)
 *     div_t    = Σ qty_{t−1} × dividend/share with ex-date in (t−1, t]
 *     r_core_t = (value_t + div_t − flow_t) / value_{t−1} − 1
 * so buying more shares is never counted as profit. SPY gets the same treatment (price + its own
 * dividends); T-bills use RISK_FREE_PCT (default 4%/yr) per calendar day. All three start on the same
 * snapshot day and are chained (time-weighted): "what each dollar did".
 * Also reported: a money-weighted check — the same dollars put into SPY on the same days ("same deposits
 * into SPY") — and the worst drop from a high for core and SPY.
 * Dividends: Alpaca corporate actions (free data API). Fees: core buys are commission-free and core never
 * sells; fills slightly above the snapshot price are the only cost not captured (cents).
 * Cash-sweep SGOV is excluded (not core). Read-only: nothing here trades.
 */
const axios = require('axios');
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

// ── dividends (per share, by ex-date) ────────────────────────────────────────
const _divCache = new Map(); // key → { at, data }
async function fetchDividends(symbols, start, end) {
    const key = `${[...symbols].sort().join(',')}|${start}|${end}`;
    const hit = _divCache.get(key);
    if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.data;
    const out = {};
    const r = await axios.get('https://data.alpaca.markets/v1/corporate-actions', {
        params: { symbols: [...symbols].join(','), types: 'cash_dividend', start, end, limit: 1000 },
        headers: { 'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY },
        timeout: 20000,
    });
    for (const d of r.data?.corporate_actions?.cash_dividends || []) {
        (out[d.symbol] ||= []).push({ ex: String(d.ex_date).slice(0, 10), rate: Number(d.rate) || 0 });
    }
    _divCache.set(key, { at: Date.now(), data: out });
    return out;
}

const divBetween = (list, after, upTo) => (list || []).filter(d => d.ex > after && d.ex <= upTo).reduce((s, d) => s + d.rate, 0);

/** Largest fall from a running high, in % (negative or 0). levels: growth factors starting at 1. */
function maxDrawdown(levels) {
    let peak = -Infinity, worst = 0;
    for (const l of levels) { peak = Math.max(peak, l); worst = Math.min(worst, l / peak - 1); }
    return +(worst * 100).toFixed(2);
}

/**
 * Pure (unit-tested). snaps: [{day, value, positions, spy}] oldest first; divs: {SYM: [{ex, rate}]}.
 */
function compare(snaps, rfPct = riskFreePct(), divs = {}) {
    let core = 1, spy = 1, tbill = 1, days = 0, dividendsUsd = 0, depositsUsd = 0;
    const coreLv = [1], spyLv = [1], series = [];
    // money-weighted check: SPY units bought with the same dollars on the same days
    let spyUnits = snaps[0]?.spy > 0 ? (snaps[0].value || 0) / snaps[0].spy : 0;
    for (let i = 1; i < snaps.length; i++) {
        const a = snaps[i - 1], b = snaps[i];
        if (!(a.value > 0) || !(a.spy > 0) || !(b.spy > 0)) continue;
        let flow = 0, div = 0;
        for (const [sym, p] of Object.entries(b.positions || {})) flow += (p.qty - (a.positions?.[sym]?.qty || 0)) * p.px;
        for (const [sym, p] of Object.entries(a.positions || {})) {
            if (!b.positions?.[sym]) flow -= p.qty * p.px; // fully removed (manual sale) — money leaving, not a loss
            div += p.qty * divBetween(divs[sym], a.day, b.day);
        }
        const spyDiv = divBetween(divs.SPY, a.day, b.day);
        const rc = (b.value + div - flow) / a.value - 1;
        const rs = (b.spy + spyDiv) / a.spy - 1;
        const cal = Math.max(1, Math.round((new Date(b.day) - new Date(a.day)) / 86400000));
        core *= 1 + rc; spy *= 1 + rs; tbill *= Math.pow(1 + rfPct / 100, cal / 365);
        dividendsUsd += div; depositsUsd += flow;
        spyUnits = spyUnits * (1 + spyDiv / b.spy) + flow / b.spy; // reinvest SPY dividend, then buy with the same new money
        coreLv.push(core); spyLv.push(spy); days++;
        series.push({ day: b.day, corePct: +((core - 1) * 100).toFixed(2), spyPct: +((spy - 1) * 100).toFixed(2), tbillPct: +((tbill - 1) * 100).toFixed(2) });
    }
    const pct = x => +((x - 1) * 100).toFixed(2);
    const last = snaps[snaps.length - 1];
    const coreNowUsd = last ? (last.value || 0) + dividendsUsd : 0;
    return {
        since: snaps[0]?.day || null, through: last?.day || null, tradingDays: days,
        corePct: pct(core), spyPct: pct(spy), tbillPct: pct(tbill),
        vsSpyPp: +((core - spy) * 100).toFixed(2), vsTbillPp: +((core - tbill) * 100).toFixed(2), rfPct,
        coreMaxDrawdownPct: maxDrawdown(coreLv), spyMaxDrawdownPct: maxDrawdown(spyLv),
        dividendsUsd: +dividendsUsd.toFixed(2), newMoneyUsd: +depositsUsd.toFixed(2),
        sameDepositsInSpy: last?.spy > 0 ? { coreUsd: +coreNowUsd.toFixed(2), spyUsd: +(spyUnits * last.spy).toFixed(2), diffUsd: +(coreNowUsd - spyUnits * last.spy).toFixed(2) } : null,
        series,
    };
}

async function getComparison(userId) {
    await ensureTable();
    const r = await query(`SELECT day::text AS day, core_value::float AS value, positions, spy::float AS spy
                           FROM core_perf_daily WHERE user_id = $1 ORDER BY day`, [String(userId)]);
    if (r.rows.length < 2) return { since: r.rows[0]?.day || null, tradingDays: 0, note: 'Needs at least two trading days of snapshots.' };
    const syms = new Set(['SPY']);
    for (const s of r.rows) for (const k of Object.keys(s.positions || {})) syms.add(k);
    let divs = {}, dividendsKnown = true;
    try { divs = await fetchDividends(syms, r.rows[0].day, r.rows[r.rows.length - 1].day); }
    catch (err) { dividendsKnown = false; logger.warn('[CoreBenchmark] dividends unavailable — price-only this time', { error: err.message }); }
    return { ...compare(r.rows, riskFreePct(), divs), dividendsKnown };
}

/** Friday: save a plain-English weekly report per user into the reports archive. */
async function weeklyReport(userId, status = null) {
    const c = await getComparison(userId).catch(err => { logger.warn('[CoreBenchmark] compare failed', { userId, error: err.message }); return null; });
    if (!c || !c.tradingDays) return null;
    const pp = v => `${v >= 0 ? '+' : ''}${v}%`;
    const lines = [
        `Measured since ${c.since}: ${c.tradingDays} trading days. Each dollar in core: ${pp(c.corePct)} · SPY ${pp(c.spyPct)} · T-bills ${pp(c.tbillPct)} (${c.rfPct}%/yr).`,
        `Core vs SPY: ${c.vsSpyPp >= 0 ? 'ahead' : 'behind'} by ${Math.abs(c.vsSpyPp)} pts · vs T-bills: ${c.vsTbillPp >= 0 ? 'ahead' : 'behind'} by ${Math.abs(c.vsTbillPp)} pts.`,
        `Worst drop from a high: core ${c.coreMaxDrawdownPct}% · SPY ${c.spyMaxDrawdownPct}%.`,
        `Dividends received by core: $${c.dividendsUsd}${c.dividendsKnown ? '' : ' (dividend data unavailable this week — returns are price-only)'} · new money added: $${c.newMoneyUsd} (not counted as gains).`,
    ];
    if (c.sameDepositsInSpy) lines.push(`Same deposits into SPY on the same days would be worth $${c.sameDepositsInSpy.spyUsd} vs core $${c.sameDepositsInSpy.coreUsd} (${c.sameDepositsInSpy.diffUsd >= 0 ? '+' : ''}$${c.sameDepositsInSpy.diffUsd}).`);
    const b = status?.breakdown;
    if (b) lines.push(`Account: core ${b.core.pct}% · swing ${b.swing.pct}% · cash ${b.cash.pct}%${b.sweep.usd ? ` · sweep ${b.sweep.pct}%` : ''}.`);
    const conc = await query(`SELECT title FROM core_guidance_alerts WHERE user_id = $1 AND rule IN ('single_stock','concentration') AND created_at > NOW() - INTERVAL '14 days' ORDER BY created_at DESC`, [String(userId)]).catch(() => ({ rows: [] }));
    if (conc.rows.length) lines.push(`Concentration: ${conc.rows.map(x => x.title).join('; ')}.`);
    lines.push('Judge this over months, not weeks: about 3 months for a first read, 6–12 months before changing allocations. Core is judged on long-term growth; swing is reported separately.');
    await require('./reportArchiveService').save({ kind: 'core_benchmark', title: `Core vs SPY — ${c.through}`, body: lines.join('\n'), userId: String(userId) }).catch(() => {});
    return c;
}

module.exports = { ensureTable, recordDaily, compare, maxDrawdown, fetchDividends, getComparison, weeklyReport, riskFreePct };
