/**
 * Multi-year rule tests on history_bars (built 2026-10-17).
 *
 * The live score can't be rebuilt for the past (news / Gemini / ORACLE / SEC), so this
 * tests the PRICE-BASED rules we actually decide on, year by year, across every stock in
 * the scan universe:
 *   - jump guard      — buying after a >5% up-day
 *   - steady trend    — trend template 5/5, RSI 55-70, $50+ (the Visa/MA/oil profile)
 *   - oversold dip    — Williams %R ≤ −80 or %B ≤ 0.2 while above the 200-day average
 *   - chasing         — RSI > 70 and 10-day gain > 10%
 *   - exits           — trailing 5% stop vs fixed targets, on every candidate
 *
 * Candidates = liquid $5+ stocks above their 50-day average (a proxy for the bullish ≥80
 * pool), sampled every 5th trading day so samples don't overlap much. Trades are
 * simulated with simulateExit from the weekly study: buy next open, −5% stop, ≤10 days.
 * Results are reported as excess vs that day's candidate average, so market-wide moves
 * cancel out. Survivorship bias (today's symbol list) affects all groups alike.
 */
const { query } = require('../config/database');
const { simulateExit } = require('./weeklyMarketStudyService');

const HOLD = 10;
const MIN_PRICE = 5;
const MIN_IEX_DOLLAR_VOL = 250_000; // IEX is ~2-3% of US volume → roughly $10M/day overall

const sma = (a, i, n) => { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; };

function rsiSeries(c, n = 14) {
    const out = new Array(c.length).fill(null);
    let g = 0, l = 0;
    for (let i = 1; i < c.length; i++) {
        const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
        if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } continue; }
        g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n;
        out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
}

/**
 * Feature + outcome samples for one symbol. bars sorted by date: {d,o,h,l,c,v}.
 * sampleDates: Set of dates to sample (every 5th market day).
 */
function samplesForSymbol(symbol, bars, sampleDates) {
    const n = bars.length;
    if (n < 270) return [];
    const c = bars.map(b => b.c), h = bars.map(b => b.h), l = bars.map(b => b.l);
    const rsi = rsiSeries(c);
    const out = [];
    for (let i = 252; i < n - HOLD - 1; i++) {
        if (!sampleDates.has(bars[i].d)) continue;
        const price = c[i];
        if (price < MIN_PRICE) continue;
        let dv = 0; for (let k = i - 19; k <= i; k++) dv += bars[k].c * bars[k].v; dv /= 20;
        if (dv < MIN_IEX_DOLLAR_VOL) continue;
        const s50 = sma(c, i, 50), s150 = sma(c, i, 150), s200 = sma(c, i, 200), s200ago = sma(c, i - 20, 200);
        if (!(price > s50)) continue; // candidate pool proxy: in an uptrend
        let hi52 = -Infinity, lo52 = Infinity; for (let k = i - 251; k <= i; k++) { hi52 = Math.max(hi52, h[k]); lo52 = Math.min(lo52, l[k]); }
        let hh = -Infinity, ll = Infinity; for (let k = i - 13; k <= i; k++) { hh = Math.max(hh, h[k]); ll = Math.min(ll, l[k]); }
        const willR = hh > ll ? (hh - price) / (hh - ll) * -100 : -50;
        let sd = 0; const m20 = sma(c, i, 20); for (let k = i - 19; k <= i; k++) sd += (c[k] - m20) ** 2; sd = Math.sqrt(sd / 20);
        const pctB = sd > 0 ? (price - (m20 - 2 * sd)) / (4 * sd) : 0.5;
        const roc10 = (price / c[i - 10] - 1) * 100;
        const dayChg = (price / c[i - 1] - 1) * 100;
        const trend5of5 = price > s50 && s50 > s150 && s150 > s200 && s200 > s200ago && price >= hi52 * 0.75 && price >= lo52 * 1.3;

        const path = bars.slice(i + 1, i + 1 + HOLD);
        const entry = path[0].o;
        if (!(entry > 0)) continue;
        out.push({
            d: bars[i].d, y: bars[i].d.slice(0, 4), s: symbol,
            jump: dayChg > 5,
            steady: trend5of5 && rsi[i] >= 55 && rsi[i] <= 70 && price >= 50,
            oversold: price > s200 && (willR <= -80 || pctB <= 0.2),
            chase: rsi[i] > 70 && roc10 > 10,
            trail5: simulateExit(path, entry, { trail: 5 }),
            t5: simulateExit(path, entry, { target: 5 }),
            t10: simulateExit(path, entry, { target: 10 }),
            hold: simulateExit(path, entry, {}),
            trail7: simulateExit(path, entry, { trail: 7 }),
            stop7hold: simulateExit(path, entry, { stop: 7 }),
        });
    }
    return out;
}

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const se = a => { if (a.length < 2) return null; const m = avg(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1) / a.length); };
const r2 = v => (v == null ? null : Math.round(v * 100) / 100);

/** Group-vs-rest (excess vs the day's candidate average) and exit rules, per year + overall. */
function summarize(samples) {
    const dayMean = {};
    const byDay = {};
    for (const x of samples) (byDay[x.d] ||= []).push(x.trail5);
    for (const [d, v] of Object.entries(byDay)) dayMean[d] = avg(v);
    for (const x of samples) x.ex = x.trail5 - dayMean[x.d];

    const years = [...new Set(samples.map(x => x.y))].sort();
    const groups = ['jump', 'steady', 'oversold', 'chase'];
    const result = { samples: samples.length, symbols: new Set(samples.map(x => x.s)).size, years: {} };
    for (const y of [...years, 'all']) {
        const g = y === 'all' ? samples : samples.filter(x => x.y === y);
        const row = { n: g.length, avgTrail5: r2(avg(g.map(x => x.trail5))) };
        for (const k of groups) {
            const inG = g.filter(x => x[k]).map(x => x.ex), out = g.filter(x => !x[k]).map(x => x.ex);
            const s = se(inG);
            row[k] = { n: inG.length, excessPp: r2(avg(inG)), restPp: r2(avg(out)), t: s ? r2(avg(inG) / s) : null };
        }
        const exits = {};
        for (const k of ['t5', 't10', 'trail7', 'hold', 'stop7hold']) {
            const d = g.map(x => x[k] - x.trail5); const s = se(d);
            exits[k] = { avg: r2(avg(g.map(x => x[k]))), vsTrailPp: r2(avg(d)), t: s ? r2(avg(d) / s) : null };
        }
        row.exits = exits;
        result.years[y] = row;
    }
    return result;
}

/** Run over history_bars in symbol batches (keeps memory bounded). */
async function runHistoryBacktest({ batch = 300, onProgress } = {}) {
    // Sample every 5th trading day on the market calendar (SPY's days).
    const cal = (await query(`SELECT d::text AS d FROM history_bars WHERE symbol = 'SPY' ORDER BY d`)).rows.map(r => r.d);
    const sampleDates = new Set(cal.filter((_, i) => i % 5 === 0));
    const syms = (await query(`SELECT DISTINCT symbol FROM history_bars ORDER BY symbol`)).rows.map(r => r.symbol);
    const samples = [];
    for (let i = 0; i < syms.length; i += batch) {
        const part = syms.slice(i, i + batch);
        const r = await query(`SELECT symbol, d::text AS d, o, h, l, c, v FROM history_bars WHERE symbol = ANY($1) ORDER BY symbol, d`, [part]);
        const bySym = {};
        for (const b of r.rows) (bySym[b.symbol] ||= []).push({ d: b.d, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v });
        for (const [s, bars] of Object.entries(bySym)) samples.push(...samplesForSymbol(s, bars, sampleDates));
        if (onProgress) onProgress(Math.min(i + batch, syms.length), syms.length, samples.length);
    }
    return summarize(samples);
}

function formatSection(r) {
    const a = r.years.all;
    const pp = v => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${v}pp`);
    const yearly = k => Object.entries(r.years).filter(([y]) => y !== 'all').map(([y, v]) => `${y} ${pp(v[k].excessPp)}`).join(', ');
    const exitY = k => Object.entries(r.years).filter(([y]) => y !== 'all').map(([y, v]) => `${y} ${pp(v.exits[k].vsTrailPp)}`).join(', ');
    return [
        `<b>4. Since 2024</b> (${r.samples.toLocaleString()} weekly samples, ${r.symbols} stocks, price rules only)`,
        `Jump >5%: ${pp(a.jump.excessPp)} (t ${a.jump.t}) — ${yearly('jump')}`,
        `Steady trend: ${pp(a.steady.excessPp)} (t ${a.steady.t}) — ${yearly('steady')}`,
        `Oversold dip: ${pp(a.oversold.excessPp)} (t ${a.oversold.t}) — ${yearly('oversold')}`,
        `Chasing (RSI>70, +10%/10d): ${pp(a.chase.excessPp)} (t ${a.chase.t})`,
        `Exits vs trailing 5%: target +5% ${pp(a.exits.t5.vsTrailPp)}, +10% ${pp(a.exits.t10.vsTrailPp)}, trailing 7% ${pp(a.exits.trail7.vsTrailPp)} (${exitY('trail7')}), −7% stop+hold ${pp(a.exits.stop7hold.vsTrailPp)}`,
    ].join('\n');
}

module.exports = { runHistoryBacktest, samplesForSymbol, summarize, rsiSeries, formatSection };
