/**
 * Quality-dip validation backtest (2026-10-26). Answers the review checklist before the strategy
 * is trusted:
 *   - no look-ahead: the 52-week high uses closes up to the signal day only; entry is the NEXT open
 *   - costs: 10 bps on entry and on exit
 *   - campaigns: tranches at -10/-15/-20% from the 52w high, each once per campaign; no new tranche
 *     at -30% or deeper; a campaign resets only when the stock makes a new 52-week closing high
 *   - baselines: same ticker on 30 random days of the same calendar year, and SPY over the same window
 *   - independent counts: campaigns and per-ticker averages reported alongside per-tranche stats
 *   - regimes: results by entry year incl. the 2022 bear market (prices fetched from Alpaca, 2019+)
 *   - survivorship: an out-of-sample list of 2020-era quality names that includes later decliners
 *     (INTC, PYPL, NKE, DIS, BA, MMM, PFE, VZ...). Delisted companies are NOT available — a limitation.
 *   - portfolio sim: $100K, 1/3 of a 4% position per tranche, 252-day hold, 30% sleeve cap → CAGR,
 *     max drawdown, volatility, Sharpe, average exposure, vs SPY and exposure-matched SPY.
 */
const axios = require('axios');

const IN_SAMPLE = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'V', 'MA', 'NVDA', 'AVGO', 'COST', 'JPM', 'LLY'];
const OUT_OF_SAMPLE = ['ADBE', 'CRM', 'NKE', 'INTC', 'DIS', 'PYPL', 'SBUX', 'BA', 'MMM', 'VZ', 'PFE', 'UNH',
                       'HD', 'PG', 'KO', 'PEP', 'WMT', 'ORCL', 'CSCO', 'TXN', 'QCOM', 'INTU', 'NFLX', 'TSLA'];
const TRANCHES = [0.10, 0.15, 0.20];
const PAUSE_DD = 0.30;
const COST = 0.001;
const HORIZONS = [126, 252];

async function fetchBars(symbols, { start = '2019-01-01', keyId, secretKey }) {
    const out = {};
    for (const s of symbols) {
        let token = null; const bars = [];
        do {
            const r = (await axios.get(`https://data.alpaca.markets/v2/stocks/${s}/bars`, {
                params: { timeframe: '1Day', start, adjustment: 'all', limit: 10000, feed: 'sip', page_token: token || undefined },
                headers: { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secretKey }, timeout: 30000,
            })).data;
            for (const b of r.bars || []) bars.push({ d: b.t.slice(0, 10), o: b.o, c: b.c });
            token = r.next_page_token;
        } while (token);
        out[s] = bars;
    }
    return out;
}

// Deterministic PRNG so reruns give identical baselines.
function rng(seed) { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pctl = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };

/** Signals for one ticker: [{ entryIdx, signalIdx, tranche, campaign, dd }] — uses data up to signalIdx only. */
function signalsFor(bars) {
    const sig = [];
    let campaign = 0, active = false, bought = 0;
    for (let i = 251; i < bars.length - 1; i++) {
        let hi = 0;
        for (let j = i - 251; j <= i; j++) hi = Math.max(hi, bars[j].c);
        const dd = 1 - bars[i].c / hi;
        if (bars[i].c >= hi) { active = false; bought = 0; continue; } // new 52w high → campaign reset
        if (!active && dd >= TRANCHES[0]) { active = true; bought = 0; campaign++; }
        if (!active) continue;
        while (bought < TRANCHES.length && dd >= TRANCHES[bought] && dd < PAUSE_DD) {
            sig.push({ signalIdx: i, entryIdx: i + 1, tranche: bought + 1, campaign, dd });
            bought++;
        }
        if (dd >= PAUSE_DD) bought = TRANCHES.length; // paused for manual review in live; no more buys here
    }
    return sig;
}

function fwd(bars, entryIdx, h) {
    const exit = entryIdx + h;
    if (exit >= bars.length) return null;
    return (bars[exit].c * (1 - COST)) / (bars[entryIdx].o * (1 + COST)) - 1;
}

function analyze(data, symbols, spy) {
    const spyIdx = Object.fromEntries(spy.map((b, i) => [b.d, i]));
    const rows = [];
    for (const s of symbols) {
        const bars = data[s];
        if (!bars || bars.length < 300) continue;
        const r = rng(s.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
        for (const g of signalsFor(bars)) {
            const year = bars[g.entryIdx].d.slice(0, 4);
            const row = { symbol: s, year, tranche: g.tranche, campaign: `${s}#${g.campaign}`, entryDate: bars[g.entryIdx].d };
            for (const h of HORIZONS) {
                row[`r${h}`] = fwd(bars, g.entryIdx, h);
                // random-entry baseline: same ticker, same calendar year, 30 draws
                const pool = bars.map((b, i) => i).filter(i => i >= 252 && bars[i].d.startsWith(year) && i + h < bars.length);
                const draws = [];
                for (let k = 0; k < 30 && pool.length; k++) { const i = pool[Math.floor(r() * pool.length)]; draws.push(fwd(bars, i, h)); }
                row[`rand${h}`] = mean(draws.filter(v => v != null));
                const si = spyIdx[bars[g.entryIdx].d];
                row[`spy${h}`] = si != null && si + h < spy.length ? spy[si + h].c / spy[si].o - 1 : null;
            }
            rows.push(row);
        }
    }
    return rows;
}

/**
 * 95% bootstrap interval for mean(dip − random same-year) at horizon h, resampling whole
 * CAMPAIGNS (not tranches) so overlapping tranches of one campaign aren't counted as independent.
 */
function bootstrapEdge(rows, h, iters = 2000) {
    const byCampaign = {};
    for (const r of rows) {
        if (r[`r${h}`] == null || r[`rand${h}`] == null) continue;
        (byCampaign[r.campaign] ||= []).push(r[`r${h}`] - r[`rand${h}`]);
    }
    const camps = Object.values(byCampaign);
    if (camps.length < 10) return null;
    const r = rng(12345); const means = [];
    for (let k = 0; k < iters; k++) {
        let s = 0, n = 0;
        for (let i = 0; i < camps.length; i++) { const c = camps[Math.floor(r() * camps.length)]; for (const v of c) { s += v; n++; } }
        means.push(s / n);
    }
    means.sort((a, b) => a - b);
    const all = camps.flat();
    const pct = v => Math.round(v * 1000) / 10;
    return { campaigns: camps.length, edgePp: pct(mean(all)), ci95: [pct(means[Math.floor(iters * 0.025)]), pct(means[Math.floor(iters * 0.975)])] };
}

function summarize(rows, h) {
    const x = rows.filter(r => r[`r${h}`] != null);
    const pct = v => (v == null ? null : Math.round(v * 1000) / 10);
    const byTicker = {};
    for (const r of x) (byTicker[r.symbol] ||= []).push(r[`r${h}`]);
    const campaigns = new Set(x.map(r => r.campaign));
    return {
        tranches: x.length, campaigns: campaigns.size, tickers: Object.keys(byTicker).length,
        avg: pct(mean(x.map(r => r[`r${h}`]))), median: pct(median(x.map(r => r[`r${h}`]))),
        win: x.length ? Math.round(x.filter(r => r[`r${h}`] > 0).length / x.length * 100) : null,
        worst10: pct(pctl(x.map(r => r[`r${h}`]), 0.1)),
        randomSameYear: pct(mean(x.map(r => r[`rand${h}`]).filter(v => v != null))),
        spySameWindow: pct(mean(x.map(r => r[`spy${h}`]).filter(v => v != null))),
        tickerEqualWeightAvg: pct(mean(Object.values(byTicker).map(mean))),
        beatRandomPct: x.length ? Math.round(x.filter(r => r[`rand${h}`] != null && r[`r${h}`] > r[`rand${h}`]).length / x.length * 100) : null,
    };
}

/** Portfolio simulation: tranche = 4%/3 of current equity, 252-day hold, sleeve capped at 30%. */
function portfolioSim(data, symbols, spy) {
    const dates = spy.map(b => b.d).filter(d => d >= '2020-01-01');
    const idx = Object.fromEntries(symbols.map(s => [s, Object.fromEntries((data[s] || []).map((b, i) => [b.d, i]))]));
    const pending = {};
    for (const s of symbols) for (const g of signalsFor(data[s] || [])) (pending[data[s][g.entryIdx].d] ||= []).push({ s, g });
    let cash = 100000; const pos = []; const eq = []; const expo = [];
    for (const d of dates) {
        const price = (s, f = 'c') => { const i = idx[s][d]; return i != null ? data[s][i][f] : null; };
        for (let k = pos.length - 1; k >= 0; k--) {
            const p = pos[k];
            if (idx[p.s][d] != null && idx[p.s][d] >= p.exitIdx) { cash += p.qty * price(p.s) * (1 - COST); pos.splice(k, 1); }
        }
        const mv = () => pos.reduce((a, p) => a + p.qty * (price(p.s) ?? p.last), 0);
        for (const { s, g } of pending[d] || []) {
            const equity = cash + mv();
            const size = equity * 0.04 / 3;
            if (mv() + size > equity * 0.30 || cash < size) continue;
            const o = price(s, 'o'); if (!o) continue;
            const qty = size / (o * (1 + COST));
            cash -= size; pos.push({ s, qty, exitIdx: g.entryIdx + 252, last: o });
        }
        for (const p of pos) { const c = price(p.s); if (c) p.last = c; }
        const m = mv(); eq.push(cash + m); expo.push(m / (cash + m));
    }
    const rets = eq.slice(1).map((v, i) => v / eq[i] - 1);
    const years = dates.length / 252;
    const maxDD = (series) => { let pk = series[0], dd = 0; for (const v of series) { pk = Math.max(pk, v); dd = Math.max(dd, 1 - v / pk); } return dd; };
    const spySeries = dates.map(d => spy.find(b => b.d === d).c);
    const avgExpo = mean(expo);
    const spyRets = spySeries.slice(1).map((v, i) => v / spySeries[i] - 1);
    const matched = [100000]; for (const r of spyRets) matched.push(matched[matched.length - 1] * (1 + r * avgExpo));
    const stats = (series, r) => ({
        cagrPct: Math.round(((series[series.length - 1] / series[0]) ** (1 / years) - 1) * 1000) / 10,
        maxDrawdownPct: Math.round(maxDD(series) * 1000) / 10,
        volPct: Math.round(Math.sqrt(252) * Math.sqrt(mean(r.map(v => (v - mean(r)) ** 2))) * 1000) / 10,
        sharpe: Math.round(mean(r) / Math.sqrt(mean(r.map(v => (v - mean(r)) ** 2))) * Math.sqrt(252) * 100) / 100,
    });
    return {
        from: dates[0], to: dates[dates.length - 1], avgExposurePct: Math.round(avgExpo * 1000) / 10,
        dipSleeveOnlyAccount: stats(eq, rets), spy: stats(spySeries, spyRets), spyExposureMatched: stats(matched, matched.slice(1).map((v, i) => v / matched[i] - 1)),
    };
}

async function runValidation({ keyId, secretKey }) {
    const data = await fetchBars([...IN_SAMPLE, ...OUT_OF_SAMPLE, 'SPY'], { keyId, secretKey });
    const spy = data.SPY;
    const out = {};
    for (const [name, list] of [['inSample', IN_SAMPLE], ['outOfSample', OUT_OF_SAMPLE]]) {
        const rows = analyze(data, list, spy);
        const years = [...new Set(rows.map(r => r.year))].sort();
        out[name] = {
            overall: Object.fromEntries(HORIZONS.map(h => [`${h}d`, summarize(rows, h)])),
            edgeVsRandom: Object.fromEntries(HORIZONS.map(h => [`${h}d`, bootstrapEdge(rows, h)])),
            byYear: Object.fromEntries(years.map(y => [y, summarize(rows.filter(r => r.year === y), 252)])),
            byTranche: Object.fromEntries([1, 2, 3].map(t => [`t${t}`, summarize(rows.filter(r => r.tranche === t), 252)])),
            portfolio: portfolioSim(data, list, spy),
        };
    }
    return out;
}

module.exports = { IN_SAMPLE, OUT_OF_SAMPLE, signalsFor, analyze, summarize, bootstrapEdge, portfolioSim, runValidation };
