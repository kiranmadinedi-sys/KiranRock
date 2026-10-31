/**
 * Kronos shadow test (agreed 2026-10-31) — LOG ONLY, never trades.
 *
 * The 20-sample offline test (C:\MyProject\Kronos\results_run3) found that ranking the bot's
 * top-40 candidates by Kronos's 5-day forecast beat the current AI-score order by +0.93% per
 * trade, but only narrowly (CI +0.05%..+1.77%) and not clearly better than random. This
 * records, every trading morning, Kronos's ranking of the exact list the live bot loads, so the
 * question is answered on data that didn't exist when the test was designed.
 *
 *   node scripts/kronosShadow.js export   writes C:\MyProject\Kronos\shadow\<date>\ (candidates + bars)
 *   node scripts/kronosShadow.js import   reads that folder's forecasts.csv into kronos_shadow_picks
 *   node scripts/kronosShadow.js report   Kronos top 5 vs AI top 5 vs all 40, after costs
 *
 * Run by C:\MyProject\Kronos\scripts\run_shadow.ps1 (Task Scheduler, weekday mornings).
 * Outcome (same as the offline test): buy at the open of run_date, sell at the close 5 trading
 * days after as_of_date (the last bar Kronos saw).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const { query } = require('../src/config/database');
const { isTradingHoliday } = require('../src/utils/marketCalendar');

const SHADOW_DIR = process.env.KRONOS_SHADOW_DIR || 'C:/MyProject/Kronos/shadow';
const TOP_N = 5;
const COST = 0.001;      // round-trip per trade, same as the offline test
const HORIZON = 5;
const BAR_DAYS = 150;    // calendar days of bars to export (≥ 60 trading days for the lookback)

const chicagoDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d);
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function ensureTable() {
    await query(`
        CREATE TABLE IF NOT EXISTS kronos_shadow_picks (
            run_date    DATE    NOT NULL,
            as_of_date  DATE    NOT NULL,
            scan_date   DATE,
            symbol      TEXT    NOT NULL,
            ai_rank     INT     NOT NULL,
            ai_score    NUMERIC,
            forecast    NUMERIC,
            kronos_rank INT,
            created_at  TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (run_date, symbol)
        )`);
}

async function exportDay(runDate) {
    const day = new Date(`${runDate}T12:00:00Z`).getUTCDay();
    if (day === 0 || day === 6 || isTradingHoliday(new Date(`${runDate}T16:00:00Z`))) {
        console.log(`SKIP ${runDate} is not a trading day`);
        return false;
    }
    await ensureTable();
    const done = await query('SELECT 1 FROM kronos_shadow_picks WHERE run_date = $1 LIMIT 1', [runDate]);
    if (done.rows.length) { console.log(`SKIP ${runDate} already recorded`); return false; }

    // The same call and arguments the live bot uses (enhancedAITradingBot, control ordering).
    const pre = require('../src/services/precomputedUniverseService');
    const cands = await pre.loadCandidates({ minScore: 80, limit: 40 });
    if (cands.length < TOP_N * 2) { console.log(`SKIP only ${cands.length} candidates`); return false; }
    const scanDate = (await query(`SELECT (${pre.buildLatestTradingScanDateSql()})::text d`)).rows[0]?.d || null;
    const symbols = cands.map(c => c.symbol);

    // history_bars is only topped up on Saturdays — refresh just these symbols.
    await require('../src/services/historyBarsService').backfill(symbols, { start: daysAgo(BAR_DAYS), end: runDate });
    const bars = (await query(
        `SELECT symbol, d::text d, o, h, l, c, v FROM history_bars
          WHERE symbol = ANY($1) AND d >= $2 AND d < $3 ORDER BY symbol, d`,
        [symbols, daysAgo(BAR_DAYS), runDate])).rows;

    const dir = path.join(SHADOW_DIR, runDate);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'candidates.csv'), 'symbol,ai_rank,ai_score\n' +
        cands.map((c, i) => `${c.symbol},${i + 1},${c._precomputedScore}`).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'bars.csv'), 'symbol,date,open,high,low,close,volume\n' +
        bars.map(b => `${b.symbol},${b.d},${b.o},${b.h},${b.l},${b.c},${b.v}`).join('\n') + '\n');
    if (scanDate) fs.writeFileSync(path.join(dir, 'scan_date.txt'), scanDate);
    console.log(`EXPORTED ${runDate}: ${cands.length} candidates, ${bars.length} bars -> ${dir}`);
    return true;
}

function readCsv(file) {
    const [head, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    const cols = head.split(',');
    return lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
}

async function importDay(runDate) {
    const dir = path.join(SHADOW_DIR, runDate);
    const fc = path.join(dir, 'forecasts.csv');
    if (!fs.existsSync(fc)) throw new Error(`no forecasts at ${fc}`);
    await ensureTable();
    const cands = readCsv(path.join(dir, 'candidates.csv'));
    const f = new Map(readCsv(fc).map(r => [r.symbol, r]));
    const asOf = [...f.values()][0]?.as_of_date;
    if (!asOf) throw new Error('forecasts.csv is empty');
    const scanFile = path.join(dir, 'scan_date.txt');
    const scanDate = fs.existsSync(scanFile) ? fs.readFileSync(scanFile, 'utf8').trim() : null;
    const ranked = [...f.values()].sort((a, b) => b.forecast - a.forecast).map(r => r.symbol);
    let n = 0;
    for (const c of cands) {
        const r = f.get(c.symbol);
        await query(
            `INSERT INTO kronos_shadow_picks (run_date, as_of_date, scan_date, symbol, ai_rank, ai_score, forecast, kronos_rank)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (run_date, symbol) DO NOTHING`,
            [runDate, asOf, scanDate, c.symbol, parseInt(c.ai_rank, 10), parseFloat(c.ai_score) || null,
             r ? parseFloat(r.forecast) : null, r ? ranked.indexOf(c.symbol) + 1 : null]);
        n++;
    }
    console.log(`IMPORTED ${runDate}: ${n} rows (${f.size} with a forecast), as of ${asOf}`);
}

async function report() {
    await ensureTable();
    const rows = (await query(`SELECT run_date::text run_date, as_of_date::text as_of, symbol, ai_rank, kronos_rank
                                 FROM kronos_shadow_picks WHERE kronos_rank IS NOT NULL ORDER BY run_date`)).rows;
    if (!rows.length) { console.log('No shadow days recorded yet.'); return; }
    const symbols = [...new Set(rows.map(r => r.symbol))];
    await require('../src/services/historyBarsService').backfill(symbols, { start: rows[0].as_of });
    const bars = (await query(`SELECT symbol, d::text d, o, c FROM history_bars WHERE symbol = ANY($1) AND d >= $2 ORDER BY symbol, d`,
        [symbols, rows[0].as_of])).rows;
    const bySym = new Map();
    for (const b of bars) { if (!bySym.has(b.symbol)) bySym.set(b.symbol, []); bySym.get(b.symbol).push(b); }
    const realized = (sym, asOf) => {
        const g = bySym.get(sym) || [];
        const i = g.findIndex(b => b.d === asOf);
        if (i < 0 || i + HORIZON >= g.length) return null;
        return g[i + HORIZON].c / g[i + 1].o - 1;
    };

    const byDay = new Map();
    for (const r of rows) { if (!byDay.has(r.run_date)) byDay.set(r.run_date, []); byDay.get(r.run_date).push({ ...r, ret: realized(r.symbol, r.as_of) }); }
    const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
    const daily = [];
    let pending = 0;
    for (const [d, g] of byDay) {
        const ok = g.filter(x => x.ret != null);
        if (ok.length < TOP_N * 2) { pending++; continue; }
        const top = key => mean([...ok].sort((a, b) => a[key] - b[key]).slice(0, TOP_N).map(x => x.ret)) - COST;
        daily.push({ d, kronos: top('kronos_rank'), ai: top('ai_rank'), all: mean(ok.map(x => x.ret)) - COST });
    }
    const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
    console.log(`Kronos shadow test — ${byDay.size} days recorded, ${daily.length} with 5-day outcomes (${pending} still open)`);
    if (!daily.length) return;
    const boot = xs => {
        const m = [];
        for (let k = 0; k < 2000; k++) m.push(mean(xs.map(() => xs[Math.floor(Math.random() * xs.length)])));
        m.sort((a, b) => a - b);
        return [m[50], m[1949]];
    };
    const dk = daily.map(x => x.kronos - x.ai), dr = daily.map(x => x.kronos - x.all);
    const [lo, hi] = boot(dk), [lo2, hi2] = boot(dr);
    console.log(`Average 5-day return per trade   Kronos ${pct(mean(daily.map(x => x.kronos)))}   AI order ${pct(mean(daily.map(x => x.ai)))}   all 40 ${pct(mean(daily.map(x => x.all)))}`);
    console.log(`Kronos − AI order per trade      ${pct(mean(dk))}  (95% CI ${pct(lo)} to ${pct(hi)})  Kronos better on ${Math.round(100 * dk.filter(x => x > 0).length / dk.length)}% of days`);
    console.log(`Kronos − all 40 per trade        ${pct(mean(dr))}  (95% CI ${pct(lo2)} to ${pct(hi2)})`);
    console.log('Decision rule: ~20+ days with outcomes, and both CIs above zero, before any paper trading arm.');
}

(async () => {
    const mode = process.argv[2];
    const runDate = process.argv[3] || chicagoDate();
    if (mode === 'export') process.exitCode = (await exportDay(runDate)) ? 0 : 3; // 3 = nothing to do
    else if (mode === 'import') await importDay(runDate);
    else if (mode === 'report') await report();
    else { console.log('usage: node scripts/kronosShadow.js export|import|report [YYYY-MM-DD]'); process.exitCode = 1; }
})().catch(err => { console.error('FAILED', err.message); process.exitCode = 1; })
    .finally(() => setTimeout(() => process.exit(), 100));
