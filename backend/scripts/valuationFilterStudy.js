/**
 * Valuation filter study (2026-11-11). Would operating margin, P/S or P/B have improved the
 * swing picks? Read-only research: nothing here touches trading.
 *   node scripts/valuationFilterStudy.js fetch    — cache Finnhub quarterly series (resumable, ~1.5 s/symbol)
 *   node scripts/valuationFilterStudy.js analyze  — bucket the ≥80 pool and closed trades by each metric
 *
 * Point-in-time: a quarter's value counts only from 45 days after the quarter ends (roughly when
 * the 10-Q is out), so no pick sees numbers that weren't public yet. Excess return = the pick's
 * 5-day return minus the average of all ≥80 picks that same day, so market moves cancel out.
 * Don't run `fetch` during the nightly scan — it shares the Finnhub 60/min key.
 */
require('dotenv').config({ quiet: true });
const axios = require('axios');
const { query } = require('../src/config/database');

const METRICS = { operatingMargin: 'opMargin', psTTM: 'ps', pb: 'pb' };
const REPORT_LAG_DAYS = 45;
const HOLD = 5;
const SPACING_MS = 1500;
const BUCKETS = {
    opMargin: [['< 0% (losing money)', v => v < 0], ['0–10%', v => v < 0.10], ['10–20%', v => v < 0.20], ['> 20%', () => true]],
    ps:       [['< 2', v => v < 2], ['2–5', v => v < 5], ['5–10', v => v < 10], ['> 10', () => true]],
    pb:       [['< 1', v => v < 1], ['1–3', v => v < 3], ['3–10', v => v < 10], ['> 10', () => true]],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ensureTable() {
    await query(`CREATE TABLE IF NOT EXISTS fundamentals_history (
        symbol TEXT NOT NULL, metric TEXT NOT NULL, period DATE NOT NULL, v DOUBLE PRECISION,
        fetched_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (symbol, metric, period))`);
    await query(`CREATE TABLE IF NOT EXISTS fundamentals_history_fetched (
        symbol TEXT PRIMARY KEY, fetched_at TIMESTAMPTZ DEFAULT NOW(), ok BOOLEAN)`);
}

async function studySymbols() {
    const r = await query(`
        SELECT DISTINCT symbol FROM daily_universe_analysis WHERE ai_score >= 80
        UNION
        SELECT DISTINCT symbol FROM trade_decision_journal WHERE decision_phase = 'CLOSED' AND pnl_percent IS NOT NULL`);
    return r.rows.map(x => x.symbol).filter(s => /^[A-Z][A-Z.]{0,5}$/.test(s));
}

async function fetchAll() {
    await ensureTable();
    const done = new Set((await query(`SELECT symbol FROM fundamentals_history_fetched WHERE fetched_at > NOW() - INTERVAL '7 days'`)).rows.map(r => r.symbol));
    const todo = (await studySymbols()).filter(s => !done.has(s));
    console.log(`fetch: ${todo.length} symbols to go (${done.size} cached), ~${Math.ceil(todo.length * SPACING_MS / 60000)} min`);
    let n = 0;
    for (const symbol of todo) {
        let ok = false;
        try {
            const resp = await axios.get('https://finnhub.io/api/v1/stock/metric', {
                params: { symbol, metric: 'all', token: process.env.FINNHUB_KEY }, timeout: 15000 });
            const q = resp.data?.series?.quarterly || {};
            for (const key of Object.keys(METRICS)) {
                for (const p of q[key] || []) {
                    if (p?.period == null || p.v == null) continue;
                    await query(`INSERT INTO fundamentals_history (symbol, metric, period, v) VALUES ($1,$2,$3,$4)
                                 ON CONFLICT (symbol, metric, period) DO UPDATE SET v = EXCLUDED.v, fetched_at = NOW()`,
                        [symbol, METRICS[key], p.period, p.v]);
                }
            }
            ok = true;
        } catch (err) {
            if (err.response?.status === 429) { console.log('429 — backing off 60 s'); await sleep(60000); }
        }
        await query(`INSERT INTO fundamentals_history_fetched (symbol, ok) VALUES ($1,$2)
                     ON CONFLICT (symbol) DO UPDATE SET fetched_at = NOW(), ok = EXCLUDED.ok`, [symbol, ok]);
        if (++n % 100 === 0) console.log(`  ${n}/${todo.length}`);
        await sleep(SPACING_MS);
    }
    console.log('fetch done');
}

// Point-in-time lookup: latest quarter whose results were public on `date`.
function valueAt(series, date) {
    if (!series) return null;
    const cutoff = new Date(date.getTime() - REPORT_LAG_DAYS * 86400000);
    for (const p of series) if (p.period <= cutoff) return p.v;   // series sorted newest first
    return null;
}

function bucketOf(metric, v) {
    if (v == null || !Number.isFinite(v)) return 'no data';
    if (metric !== 'opMargin' && v <= 0) return 'no data';         // negative P/S or P/B isn't meaningful
    return BUCKETS[metric].find(([, test]) => test(v))[0];
}

function stats(xs) {
    const n = xs.length;
    if (!n) return { n: 0 };
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
    return { n, mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
}

async function analyze() {
    await ensureTable();
    const hist = {};
    for (const r of (await query(`SELECT symbol, metric, period, v FROM fundamentals_history ORDER BY period DESC`)).rows) {
        ((hist[r.symbol] ||= {})[r.metric] ||= []).push({ period: new Date(r.period), v: r.v });
    }
    const covered = (await query(`SELECT count(*) FILTER (WHERE ok) ok, count(*) n FROM fundamentals_history_fetched`)).rows[0];
    console.log(`Finnhub history cached for ${covered.ok}/${covered.n} symbols\n`);

    // ≥80 pool: one row per symbol-day, 5-day forward close-to-close return from history_bars.
    const pool = (await query(`
        WITH picks AS (
            SELECT DISTINCT ON (symbol, analysis_date::date) symbol, analysis_date::date AS d
            FROM daily_universe_analysis WHERE ai_score >= 80 ORDER BY symbol, analysis_date::date),
        fwd AS (
            SELECT p.symbol, p.d, b0.c AS c0,
                   (SELECT b.c FROM history_bars b WHERE b.symbol = p.symbol AND b.d > p.d ORDER BY b.d OFFSET ${HOLD - 1} LIMIT 1) AS c5
            FROM picks p JOIN history_bars b0 ON b0.symbol = p.symbol AND b0.d = p.d)
        SELECT symbol, d, (c5 / c0 - 1) * 100 AS ret FROM fwd WHERE c5 IS NOT NULL AND c0 > 0`)).rows;
    const dayMean = {};
    for (const r of pool) { const k = r.d.toISOString().slice(0, 10); (dayMean[k] ||= []).push(r.ret); }
    for (const k of Object.keys(dayMean)) dayMean[k] = dayMean[k].reduce((a, b) => a + b, 0) / dayMean[k].length;
    const days = Object.keys(dayMean).sort();
    const midDay = days[Math.floor(days.length / 2)];
    console.log(`≥80 pool: ${pool.length} picks with a ${HOLD}-day outcome, ${days[0]} → ${days[days.length - 1]} (halves split at ${midDay})`);
    console.log(`Excess = 5-day return minus that day's ≥80-pool average. t uses per-day averages, so crowded days don't inflate it.\n`);

    const trades = (await query(`
        SELECT symbol, opened_at, pnl_percent::float AS ret FROM trade_decision_journal
        WHERE decision_phase = 'CLOSED' AND pnl_percent IS NOT NULL AND opened_at IS NOT NULL`)).rows;

    for (const metric of Object.values(METRICS)) {
        console.log(`── ${metric} ──`);
        const rows = {};
        for (const r of pool) {
            const k = r.d.toISOString().slice(0, 10);
            const b = bucketOf(metric, valueAt(hist[r.symbol]?.[metric], r.d));
            const byDay = ((rows[b] ||= { all: {}, first: {}, second: {}, rets: [] }));
            const ex = r.ret - dayMean[k];
            (byDay.all[k] ||= []).push(ex);
            ((k < midDay ? byDay.first : byDay.second)[k] ||= []).push(ex);
            byDay.rets.push(ex);
        }
        const tradeRows = {};
        for (const t of trades) {
            const b = bucketOf(metric, valueAt(hist[t.symbol]?.[metric], new Date(t.opened_at)));
            (tradeRows[b] ||= []).push(t.ret);
        }
        const order = [...BUCKETS[metric].map(x => x[0]), 'no data'];
        console.log('bucket'.padEnd(22) + 'picks'.padStart(7) + 'excess'.padStart(9) + 't'.padStart(7) + '1st half'.padStart(10) + '2nd half'.padStart(10) + '  | trades  avg P&L  win%');
        for (const b of order) {
            const g = rows[b];
            const perDay = o => stats(Object.values(o || {}).map(xs => xs.reduce((a, c) => a + c, 0) / xs.length));
            const all = perDay(g?.all), h1 = perDay(g?.first), h2 = perDay(g?.second);
            const tr = tradeRows[b] || [];
            const tm = tr.length ? tr.reduce((a, c) => a + c, 0) / tr.length : null;
            const win = tr.length ? (tr.filter(x => x > 0).length / tr.length) * 100 : null;
            const f = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d));
            console.log(b.padEnd(22) + String(g?.rets.length || 0).padStart(7) + f(all.mean).padStart(9) + f(all.t, 1).padStart(7)
                + f(h1.mean).padStart(10) + f(h2.mean).padStart(10)
                + `  | ${String(tr.length).padStart(6)}  ${f(tm).padStart(7)}  ${win == null ? '—' : win.toFixed(0) + '%'}`);
        }
        console.log('');
    }
    console.log('Bar to act on a filter (same as the research lab): a bucket we would skip must trail by ≤ −0.3 pp with t ≤ −2.5,');
    console.log('the same sign in both halves, and enough picks that dropping them does not starve the bot.');
}

(async () => {
    const cmd = process.argv[2];
    if (cmd === 'fetch') await fetchAll();
    else if (cmd === 'analyze') await analyze();
    else console.log('usage: node scripts/valuationFilterStudy.js fetch|analyze');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
