/**
 * Correlation-cluster study (2026-11-21, research only — places no orders, changes nothing).
 *
 * Question: did holding swing positions that move together (e.g. the AI trade across sectors) cost us?
 *   1. Correlation: average pairwise return correlation (20 / 60 / 90 trading days, measured up to the
 *      day before — no look-ahead) of the swing positions held each day.
 *   2. Theme concentration: positions grouped into clusters (60-day correlation ≥ 0.6, linked); the
 *      largest cluster's share of the swing book each day.
 *   3. Impact: daily swing P&L (% of the swing book) on high- vs low-correlation days and on
 *      concentrated vs spread-out days; and the counterfactual "same positions, same weights, but
 *      moving independently" — how much extra day-to-day swing came from co-movement.
 *
 * Positions are rebuilt from the trades table (BUY/SELL by trade date) and valued at daily closes;
 * same-day round trips and intraday moves on entry/exit days are ignored (overnight holdings only).
 * Core-holding sleeves (core / satellite / options / bear) are excluded — they are not swing trades.
 *
 * Usage: node scripts/correlationClusterStudy.js   (prints a report; read-only)
 */
const { query } = require('../src/config/database');

const ACCOUNTS = { user: '83f08677-e55a-48d1-bd31-f5b56fa79c23', kmadined: 'ca632c53-8798-46f4-be94-29be0fede7f2' };
const r2 = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const sd = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)) : NaN; };
function corr(a, b) {
    const n = Math.min(a.length, b.length); if (n < 10) return null;
    const x = a.slice(-n), y = b.slice(-n), mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

async function studyAccount(name, userId) {
    const core = new Set((await query(`SELECT UPPER(symbol) s FROM core_holdings WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] }))).rows.map(r => r.s));
    const trades = (await query(`SELECT UPPER(symbol) s, action, quantity::float q, (trade_date)::date d FROM trades
                                 WHERE user_id = $1 AND action IN ('BUY','SELL') ORDER BY trade_date, id`, [userId])).rows
        .filter(t => !core.has(t.s) && !/\d{6}[CP]\d{8}$/.test(t.s) && !/USD$/.test(t.s));
    if (!trades.length) return null;
    const syms = [...new Set(trades.map(t => t.s))];
    const first = trades[0].d;
    const bars = (await query(`SELECT symbol, (timestamp AT TIME ZONE 'UTC')::date d, close::float c FROM daily_bars
                               WHERE symbol = ANY($1) AND timestamp >= $2::date - INTERVAL '150 days' ORDER BY timestamp`, [syms, first])).rows;
    const px = {}; for (const b of bars) (px[b.symbol] = px[b.symbol] || new Map()).set(String(b.d.toISOString().slice(0, 10)), b.c);
    const days = [...new Set(bars.map(b => b.d.toISOString().slice(0, 10)))].sort();
    // daily returns per symbol aligned on the calendar of days
    const ret = {};
    for (const s of syms) {
        const m = px[s]; if (!m) continue;
        ret[s] = days.map((d, i) => (i && m.get(d) && m.get(days[i - 1]) ? m.get(d) / m.get(days[i - 1]) - 1 : null));
    }
    // holdings after each day's trades
    const qty = {}; let ti = 0;
    const held = {};
    for (const d of days) {
        while (ti < trades.length && trades[ti].d.toISOString().slice(0, 10) <= d) {
            const t = trades[ti++]; qty[t.s] = (qty[t.s] || 0) + (t.action === 'BUY' ? t.q : -t.q);
            if (Math.abs(qty[t.s]) < 1e-6) delete qty[t.s];
        }
        held[d] = Object.fromEntries(Object.entries(qty).filter(([, q]) => q > 0));
    }
    const rows = [];
    const startIdx = days.findIndex(d => d >= first.toISOString().slice(0, 10));
    for (let i = Math.max(startIdx, 91); i < days.length; i++) {
        const d = days[i], prev = days[i - 1];
        const book = Object.entries(held[prev] || {}).filter(([s]) => px[s]?.get(prev) && px[s]?.get(d));
        if (book.length < 2) continue;
        const vals = book.map(([s, q]) => q * px[s].get(prev)), tot = vals.reduce((a, v) => a + v, 0);
        const w = vals.map(v => v / tot);
        const dayRet = book.reduce((a, [s], k) => a + w[k] * (px[s].get(d) / px[s].get(prev) - 1), 0);
        const win = (s, n) => ret[s].slice(i - n, i).filter(v => v != null); // up to the day before
        const pair = n => {
            const cs = [], wcs = [];
            for (let a = 0; a < book.length; a++) for (let b = a + 1; b < book.length; b++) {
                const c = corr(win(book[a][0], n), win(book[b][0], n)); if (c == null) continue;
                cs.push(c); wcs.push([c, w[a] * w[b]]);
            }
            const ws = wcs.reduce((a, [, x]) => a + x, 0);
            return { avg: mean(cs), wavg: ws ? wcs.reduce((a, [c, x]) => a + c * x, 0) / ws : NaN };
        };
        const p20 = pair(20), p60 = pair(60), p90 = pair(90);
        // clusters: link pairs with 60-day correlation >= 0.6
        const parent = book.map((_, k) => k); const find = k => (parent[k] === k ? k : (parent[k] = find(parent[k])));
        for (let a = 0; a < book.length; a++) for (let b = a + 1; b < book.length; b++) {
            const c = corr(win(book[a][0], 60), win(book[b][0], 60)); if (c != null && c >= 0.6) parent[find(a)] = find(b);
        }
        const cl = {}; book.forEach((_, k) => { cl[find(k)] = (cl[find(k)] || 0) + w[k]; });
        const topShare = Math.max(...Object.values(cl));
        // counterfactual: same weights, independent moves → variance Σ w² σ² (60-day σ)
        const indepVar = book.reduce((a, [s], k) => a + (w[k] ** 2) * (sd(win(s, 60)) ** 2 || 0), 0);
        rows.push({ d, n: book.length, tot, dayRet, c20: p20.avg, c60: p60.avg, c90: p90.avg, wc60: p60.wavg, topShare, indepVar });
    }
    return { name, rows };
}

function report({ name, rows }) {
    const out = [];
    out.push(`\n=== ${name}: ${rows.length} days with 2+ swing positions held overnight (${rows[0]?.d} → ${rows[rows.length - 1]?.d}) ===`);
    if (rows.length < 20) { out.push('Too few days to say anything.'); return out.join('\n'); }
    const pct = v => `${r2(v * 100)}%`;
    out.push(`Positions held: avg ${r2(mean(rows.map(r => r.n)))}, max ${Math.max(...rows.map(r => r.n))}`);
    for (const k of ['c20', 'c60', 'c90', 'wc60']) {
        const v = rows.map(r => r[k]).filter(Number.isFinite);
        out.push(`Avg pairwise correlation ${k === 'wc60' ? '60d (value-weighted)' : k.slice(1) + 'd'}: mean ${r2(mean(v))}, median ${r2(v.sort((a, b) => a - b)[Math.floor(v.length / 2)])}`);
    }
    const ts = rows.map(r => r.topShare);
    out.push(`Largest correlated cluster (60d corr ≥ 0.6): avg ${pct(mean(ts))} of the swing book; > 50% on ${rows.filter(r => r.topShare > 0.5).length} of ${rows.length} days`);
    // terciles by 60d correlation
    const sorted = rows.filter(r => Number.isFinite(r.c60)).sort((a, b) => a.c60 - b.c60);
    const t = Math.floor(sorted.length / 3);
    const groups = [['low corr', sorted.slice(0, t)], ['mid corr', sorted.slice(t, 2 * t)], ['high corr', sorted.slice(2 * t)]];
    out.push('Daily swing-book return by 60-day correlation (tercile: corr range | avg day | day-to-day swing (sd) | worst day | days worse than −1%):');
    for (const [g, rs] of groups) {
        const r = rs.map(x => x.dayRet);
        out.push(`  ${g.padEnd(9)} ${r2(rs[0].c60)}–${r2(rs[rs.length - 1].c60)} | ${pct(mean(r))} | ${pct(sd(r))} | ${pct(Math.min(...r))} | ${rs.filter(x => x.dayRet < -0.01).length}/${rs.length}`);
    }
    const conc = rows.filter(r => r.topShare > 0.5), spread = rows.filter(r => r.topShare <= 0.5);
    if (conc.length >= 5 && spread.length >= 5) {
        out.push(`Concentrated days (one cluster > 50%): ${conc.length} days, avg ${pct(mean(conc.map(r => r.dayRet)))}, sd ${pct(sd(conc.map(r => r.dayRet)))}, worst ${pct(Math.min(...conc.map(r => r.dayRet)))}`);
        out.push(`Spread-out days:                    ${spread.length} days, avg ${pct(mean(spread.map(r => r.dayRet)))}, sd ${pct(sd(spread.map(r => r.dayRet)))}, worst ${pct(Math.min(...spread.map(r => r.dayRet)))}`);
    }
    const worst = [...rows].sort((a, b) => a.dayRet - b.dayRet).slice(0, 10);
    const medC = sorted[Math.floor(sorted.length / 2)].c60;
    out.push(`10 worst days: avg 60d corr ${r2(mean(worst.map(r => r.c60).filter(Number.isFinite)))} vs median day ${r2(medC)}; largest cluster ${pct(mean(worst.map(r => r.topShare)))} vs avg ${pct(mean(ts))}`);
    out.push('  ' + worst.map(r => `${r.d} ${pct(r.dayRet)} (n=${r.n}, corr ${r2(r.c60)})`).join(' · '));
    // counterfactual: actual day-to-day swing vs the same book moving independently
    const actualVar = sd(rows.map(r => r.dayRet)) ** 2, indep = mean(rows.map(r => r.indepVar));
    out.push(`Counterfactual — same positions and weights, moving independently: day-to-day swing ${pct(Math.sqrt(indep))} vs actual ${pct(Math.sqrt(actualVar))} → co-movement multiplied risk ×${r2(Math.sqrt(actualVar / indep))}`);
    return out.join('\n');
}

(async () => {
    for (const [name, id] of Object.entries(ACCOUNTS)) {
        const res = await studyAccount(name, id);
        console.log(res ? report(res) : `\n=== ${name}: no trades ===`);
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
