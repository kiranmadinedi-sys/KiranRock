/**
 * Mega-cap reversal → long puts — SHADOW LOG ONLY (built 2026-11-21 at the user's request, from a social
 * post of GOOGL put fills that were checked against real prices: GOOGL opened ~$294 on 11-19, closed $272,
 * low $264 on 11-20). This module NEVER places an order. It records when the pattern appears and what
 * nearby puts cost at that moment, then grades the same contracts later with real quotes.
 *
 * Why shadow-only and forward-only: Alpaca's historical option bars need an OPRA agreement we don't have
 * (403), so this can't be backtested — only observed going forward. The options-income replay found
 * BUYING options lost 66-100% in flat months; this measures whether this specific setup is different.
 *
 * Signal (checked every 5-min tick, 10:00-15:30 ET, once per symbol per day), all must hold:
 *   - weak market: SPY down ≥ 0.5% on the day
 *   - the stock opened higher (open ≥ +0.5% vs prior close) or traded ≥ +1.5% above the prior close
 *   - then reversed: price ≥ 3% below the day's high AND below the prior close (the gain fully given back)
 * Universe: 25 large, very liquid, optionable stocks (CFG.universe).
 *
 * At a signal it records 4 puts (indicative quotes): at-the-money and ~5% out-of-the-money, for the nearest
 * expiry ≥ 5 days out ("near") and one 21-45 days out ("month"). Graded at ~15:50 ET the same day ("close"),
 * the next trading day ("d1") and 3 trading days later ("d3"): buy at the ask → sell at the bid
 * (realistic) and mid → mid, plus the stock's move.
 *
 * Data only: the paper account's keys are used to read quotes (REVERSAL_SHADOW_USER_ID, else the first
 * BEAR_SIDE_USER_IDS entry; refuses a non-paper account anyway). Separate from the bear side (frozen).
 */
const axios = require('axios');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const CFG = {
    universe: ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'AVGO', 'TSLA', 'LLY', 'JPM', 'V', 'MA', 'NFLX',
               'COST', 'WMT', 'ORCL', 'AMD', 'PLTR', 'UNH', 'XOM', 'HD', 'CRM', 'ADBE', 'MU', 'QCOM'],
    spyMaxDayPct: -0.5,       // SPY down at least 0.5% today
    gapUpPct: 0.5,            // opened ≥ +0.5% vs prior close …
    highUpPct: 1.5,           // … or traded ≥ +1.5% above it
    reversalFromHighPct: 3,   // now ≥ 3% below the day's high
    nearMinDte: 5, monthMinDte: 21, monthMaxDte: 45,
    otmPct: 5,
    gradeEtMin: 15 * 60 + 50, // grade at/after 15:50 ET
    horizons: { close: 0, d1: 1, d3: 3 },
};
const DATA = 'https://data.alpaca.markets';
const r2 = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r4 = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const etDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const etMinutes = (d = new Date()) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(d);
    return parseInt(p.find(x => x.type === 'hour').value, 10) % 24 * 60 + parseInt(p.find(x => x.type === 'minute').value, 10);
};
const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);

/** Pure: the trading day n sessions after dateStr (YYYY-MM-DD), skipping weekends and listed holidays. */
function addTradingDays(dateStr, n, holidays = require('../utils/marketCalendar').NYSE_HOLIDAYS) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    let left = n;
    while (left > 0) {
        d.setUTCDate(d.getUTCDate() + 1);
        if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !holidays.has(d.toISOString().slice(0, 10))) left--;
    }
    return d.toISOString().slice(0, 10);
}

/** Pure: does a snapshot show the reversal setup? spyDayPct = SPY's % change today. */
function reversalSignal(snap, spyDayPct, c = CFG) {
    const prev = snap?.prevDailyBar?.c, open = snap?.dailyBar?.o, high = snap?.dailyBar?.h;
    const px = snap?.latestTrade?.p || snap?.dailyBar?.c;
    if (!(prev > 0 && open > 0 && high > 0 && px > 0) || !(spyDayPct <= c.spyMaxDayPct)) return null;
    const openPct = (open / prev - 1) * 100, highPct = (high / prev - 1) * 100, offHigh = (1 - px / high) * 100;
    const openedHigh = openPct >= c.gapUpPct || highPct >= c.highUpPct;
    if (!openedHigh || offHigh < c.reversalFromHighPct || !(px < prev)) return null;
    return { price: px, prevClose: prev, open, high, openPct: r2(openPct), highPct: r2(highPct), offHighPct: r2(offHigh), dayPct: r2((px / prev - 1) * 100) };
}

/** Pure: pick the 4 puts to track from a chain snapshot map (OCC symbol → snapshot). */
function pickPuts(snapshots, price, today, c = CFG) {
    const legs = [];
    for (const [sym, s] of Object.entries(snapshots || {})) {
        const m = String(sym).match(/^([A-Z.]+)(\d{2})(\d{2})(\d{2})P(\d{8})$/);
        const q = s?.latestQuote;
        if (!m || !(q?.bp > 0 && q?.ap > 0)) continue;
        const expiry = `20${m[2]}-${m[3]}-${m[4]}`;
        legs.push({ contract: sym, expiry, dte: dayDiff(expiry, today), strike: parseInt(m[5], 10) / 1000, bid: q.bp, ask: q.ap,
                    iv: s.impliedVolatility ?? null, delta: s.greeks?.delta ?? null });
    }
    const out = [];
    const nearExp = legs.filter(l => l.dte >= c.nearMinDte).map(l => l.expiry).sort()[0];
    const monthExp = legs.filter(l => l.dte >= c.monthMinDte && l.dte <= c.monthMaxDte).map(l => l.expiry).sort()[0];
    for (const [tenor, exp] of [['near', nearExp], ['month', monthExp]]) {
        if (!exp) continue;
        const chain = legs.filter(l => l.expiry === exp);
        const atm = chain.filter(l => l.strike <= price).sort((a, b) => b.strike - a.strike)[0];
        const otmTarget = price * (1 - c.otmPct / 100);
        const otm = chain.filter(l => l.strike < (atm?.strike ?? price)).sort((a, b) => Math.abs(a.strike - otmTarget) - Math.abs(b.strike - otmTarget))[0];
        if (atm) out.push({ kind: `${tenor}_atm`, ...atm, mid: r4((atm.bid + atm.ask) / 2) });
        if (otm) out.push({ kind: `${tenor}_otm5`, ...otm, mid: r4((otm.bid + otm.ask) / 2) });
    }
    return out;
}

/** Pure: returns for one graded contract — buy at the ask, sell at the bid (realistic), and mid → mid. */
function gradeLeg(entry, now) {
    if (!entry || !now || !(entry.ask > 0)) return null;
    const exitBid = now.bid ?? 0, exitMid = now.mid ?? ((now.bid ?? 0) + (now.ask ?? 0)) / 2;
    return { askToBidPct: r2((exitBid / entry.ask - 1) * 100), midToMidPct: entry.mid > 0 ? r2((exitMid / entry.mid - 1) * 100) : null };
}

let _ready = false;
async function ensureTables() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS reversal_put_shadow (
            id          SERIAL      PRIMARY KEY,
            d           DATE        NOT NULL,
            symbol      TEXT        NOT NULL,
            signal_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            spy_day_pct NUMERIC,
            signal      JSONB       NOT NULL,         -- price, prevClose, open, high, openPct, offHighPct, dayPct
            contracts   JSONB       NOT NULL DEFAULT '[]', -- the puts and their quotes at the signal
            grades      JSONB       NOT NULL DEFAULT '{}', -- { close|d1|d3: { at, price, legs: { contract: {bid,ask,mid} } } }
            UNIQUE (d, symbol)
        )`);
    _ready = true;
}

async function _headers() {
    const id = process.env.REVERSAL_SHADOW_USER_ID || (process.env.BEAR_SIDE_USER_IDS || '').split(',')[0].trim();
    if (!id) return null;
    const c = await require('./userDatabaseService').getUserAlpacaCredentials(id);
    if (c.isPaper !== true) throw new Error('reversal shadow reads data with paper keys only');
    return { 'APCA-API-KEY-ID': c.keyId, 'APCA-API-SECRET-KEY': c.secretKey };
}

async function _putChain(headers, symbol, price, today) {
    const to = new Date(new Date(today).getTime() + (CFG.monthMaxDte + 2) * 86400000).toISOString().slice(0, 10);
    const from = new Date(new Date(today).getTime() + CFG.nearMinDte * 86400000).toISOString().slice(0, 10);
    const r = await axios.get(`${DATA}/v1beta1/options/snapshots/${symbol}`, { headers, timeout: 15000,
        params: { feed: 'indicative', type: 'put', expiration_date_gte: from, expiration_date_lte: to,
                  strike_price_gte: (price * 0.9).toFixed(2), strike_price_lte: (price * 1.01).toFixed(2), limit: 1000 } });
    return r.data?.snapshots || {};
}

async function _detect(headers, now) {
    const today = etDate(now);
    const snaps = (await axios.get(`${DATA}/v2/stocks/snapshots`, { headers, timeout: 15000,
        params: { symbols: ['SPY', ...CFG.universe].join(','), feed: 'iex' } })).data || {};
    const spy = snaps.SPY;
    const spyDayPct = spy?.prevDailyBar?.c > 0 ? ((spy.latestTrade?.p || spy.dailyBar?.c) / spy.prevDailyBar.c - 1) * 100 : null;
    if (!(spyDayPct <= CFG.spyMaxDayPct)) return [];
    const seen = new Set((await query(`SELECT symbol FROM reversal_put_shadow WHERE d = $1`, [today])).rows.map(r => r.symbol));
    const found = [];
    for (const sym of CFG.universe) {
        if (seen.has(sym)) continue;
        const sig = reversalSignal(snaps[sym], spyDayPct);
        if (!sig) continue;
        let contracts = [];
        try { contracts = pickPuts(await _putChain(headers, sym, sig.price, today), sig.price, today); } catch (err) {
            logger.warn('[ReversalShadow] Put chain read failed — logging the signal without quotes', { sym, error: err.message });
        }
        await query(`INSERT INTO reversal_put_shadow (d, symbol, spy_day_pct, signal, contracts) VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (d, symbol) DO NOTHING`, [today, sym, r2(spyDayPct), JSON.stringify(sig), JSON.stringify(contracts)]);
        logger.info('[ReversalShadow] Signal logged (shadow only, no order)', { sym, ...sig, spyDayPct: r2(spyDayPct), puts: contracts.length });
        found.push(sym);
    }
    return found;
}

async function _grade(headers, now) {
    const today = etDate(now), etMin = etMinutes(now);
    const rows = (await query(`SELECT id, d::text AS d, symbol, contracts, grades FROM reversal_put_shadow
                               WHERE d >= $1::date - INTERVAL '14 days' ORDER BY id`, [today])).rows;
    for (const r of rows) {
        for (const [h, n] of Object.entries(CFG.horizons)) {
            if (r.grades?.[h]) continue;
            const target = addTradingDays(r.d, n);
            if (today < target || (today === target && etMin < CFG.gradeEtMin)) continue;
            const legs = {};
            const syms = (r.contracts || []).map(c => c.contract);
            if (syms.length) {
                const q = (await axios.get(`${DATA}/v1beta1/options/snapshots`, { headers, timeout: 15000,
                    params: { symbols: syms.join(','), feed: 'indicative' } })).data?.snapshots || {};
                for (const s of syms) { const lq = q[s]?.latestQuote; legs[s] = lq ? { bid: lq.bp, ask: lq.ap, mid: r4((lq.bp + lq.ap) / 2) } : null; }
            }
            const st = (await axios.get(`${DATA}/v2/stocks/snapshots`, { headers, timeout: 15000, params: { symbols: r.symbol, feed: 'iex' } })).data?.[r.symbol];
            const grade = { at: now.toISOString(), late: today !== target, price: st?.latestTrade?.p ?? null, legs };
            await query(`UPDATE reversal_put_shadow SET grades = grades || jsonb_build_object($2::text, $3::jsonb) WHERE id = $1`, [r.id, h, JSON.stringify(grade)]);
        }
    }
}

/** Scheduler tick (every 5 min). Market hours only; detection 10:00-15:30 ET; grading from 15:50 ET. */
async function runTick(now = new Date()) {
    const { isMarketOpen } = require('../utils/marketCalendar');
    if (!isMarketOpen(now)) return;
    await ensureTables();
    const headers = await _headers();
    if (!headers) return;
    const m = etMinutes(now);
    if (m >= 10 * 60 && m <= 15 * 60 + 30) await _detect(headers, now).catch(err => logger.warn('[ReversalShadow] Detect failed', { error: err.message }));
    await _grade(headers, now).catch(err => logger.warn('[ReversalShadow] Grade failed', { error: err.message }));
}

/** Report: per horizon and put type — n, average return (ask→bid and mid→mid), share that made money; stock move. */
async function summary() {
    await ensureTables();
    const rows = (await query(`SELECT d::text AS d, symbol, signal, contracts, grades FROM reversal_put_shadow ORDER BY d`)).rows;
    const out = { signals: rows.length, days: new Set(rows.map(r => r.d)).size, byHorizon: {} };
    for (const h of Object.keys(CFG.horizons)) {
        const kinds = {}; const stock = [];
        for (const r of rows) {
            const g = r.grades?.[h]; if (!g) continue;
            if (g.price && r.signal?.price) stock.push((g.price / r.signal.price - 1) * 100);
            for (const c of r.contracts || []) {
                const res = gradeLeg(c, g.legs?.[c.contract]); if (!res) continue;
                (kinds[c.kind] = kinds[c.kind] || []).push(res);
            }
        }
        const agg = a => ({ n: a.length, avgAskToBidPct: r2(a.reduce((s, x) => s + x.askToBidPct, 0) / a.length),
                            avgMidPct: r2(a.filter(x => x.midToMidPct != null).reduce((s, x) => s + x.midToMidPct, 0) / Math.max(1, a.filter(x => x.midToMidPct != null).length)),
                            wonPct: r2(a.filter(x => x.askToBidPct > 0).length / a.length * 100) });
        // Per DAY as well: a market-wide reversal fires many symbols at once (11-19: 15 of 25), which is one
        // event, not 15 — so each day's signals are averaged first and the days are what get counted.
        const byDay = {};
        for (const r of rows) {
            const g = r.grades?.[h]; if (!g) continue;
            const rs = (r.contracts || []).filter(c => c.kind === 'near_atm').map(c => gradeLeg(c, g.legs?.[c.contract])).filter(Boolean);
            for (const x of rs) (byDay[r.d] = byDay[r.d] || []).push(x.askToBidPct);
        }
        const dayAvgs = Object.values(byDay).map(a => a.reduce((s, v) => s + v, 0) / a.length);
        out.byHorizon[h] = { graded: stock.length, avgStockMovePct: stock.length ? r2(stock.reduce((s, v) => s + v, 0) / stock.length) : null,
                             puts: Object.fromEntries(Object.entries(kinds).map(([k, a]) => [k, agg(a)])),
                             nearAtmByDay: { days: dayAvgs.length, avgAskToBidPct: dayAvgs.length ? r2(dayAvgs.reduce((s, v) => s + v, 0) / dayAvgs.length) : null,
                                             daysWonPct: dayAvgs.length ? r2(dayAvgs.filter(v => v > 0).length / dayAvgs.length * 100) : null } };
    }
    return out;
}

module.exports = { CFG, reversalSignal, pickPuts, gradeLeg, addTradingDays, runTick, summary, ensureTables };
