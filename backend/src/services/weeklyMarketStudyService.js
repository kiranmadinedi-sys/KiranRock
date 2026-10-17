/**
 * Weekly market study (Saturdays, built 2026-10-17).
 *
 * Learns from EVERY stock the nightly scan rated ≥80, not only the handful the bots
 * bought — the user's point: the app can't buy them all, so judge rules against all of
 * them. Each candidate is simulated as "buy the next morning's open, -5% stop, up to 10
 * trading days" on real daily bars; a same-day stop+target touch counts as the stop.
 *
 * Three questions, answered fresh every week on a rolling window:
 *   1. Exits   — does today's trailing stop still beat fixed profit targets?
 *   2. Picking — which ordering of the ≥80 pool does best: current (AI score),
 *                oversold, steady trend? And does the >5% jump guard still pay?
 *   3. Market  — what actually led last week (sectors, top movers) and what did our
 *                scan score them? Finds the next "Visa" case without anyone looking.
 *
 * Report only: nothing here changes trading. Results land in weekly_market_study and in
 * an admin Telegram message.
 *
 * First run (2026-10-17, 8,761 stock-days, 1,398 tickers): trailing 5% −0.28%/trade,
 * fixed targets +3..+15% all worse (−0.36..−0.40%, t ≈ −2), hold-only −0.45%.
 */
const axios = require('axios');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');
const { parseScoringLog } = require('./scoreComponentValidationService');

const HOLD_DAYS = 10;
const STOP_PCT = 5;
const POOL_MIN_SCORE = 80;
const TOP_N = 40;
const JUMP_PCT = 5;

const EXIT_RULES = [
    ['Trailing 5% stop (current)', { trail: 5 }],
    ['Trailing 7% stop', { trail: 7 }],
    ['Target +3%', { target: 3 }],
    ['Target +5%', { target: 5 }],
    ['Target +8%', { target: 8 }],
    ['Target +10%', { target: 10 }],
    ['Target +8% + trailing 5%', { target: 8, trail: 5 }],
    ['No target, hold 10 days', {}],
];

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const se = a => {
    if (a.length < 2) return null;
    const m = avg(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1) / a.length);
};
const r2 = v => (v == null || Number.isNaN(v) ? null : Math.round(v * 100) / 100);

/**
 * One simulated trade. path = daily bars starting the entry day ({o,h,l,c}); entry = path[0].o.
 * Stop is checked before the target on the same bar (conservative).
 */
function simulateExit(path, entry, { target = null, trail = null, stop = STOP_PCT, hold = HOLD_DAYS } = {}) {
    let peak = entry;
    let st = entry * (1 - stop / 100);
    const n = Math.min(hold, path.length);
    for (let k = 0; k < n; k++) {
        const bar = path[k];
        if (bar.o <= st) return (bar.o / entry - 1) * 100;       // gapped through the stop
        if (bar.l <= st) return (st / entry - 1) * 100;
        if (target && bar.h >= entry * (1 + target / 100)) return target;
        peak = Math.max(peak, bar.h);
        if (trail) st = Math.max(st, peak * (1 - trail / 100));
    }
    return (path[n - 1].c / entry - 1) * 100;
}

/** Compare every exit rule on the same trades, each against the current trailing stop. */
function compareExitRules(trades) {
    const base = trades.map(t => simulateExit(t.path, t.entry, EXIT_RULES[0][1]));
    return EXIT_RULES.map(([name, cfg]) => {
        const v = trades.map(t => simulateExit(t.path, t.entry, cfg));
        const d = v.map((x, i) => x - base[i]);
        const s = se(d);
        return {
            rule: name,
            avgPct: r2(avg(v)),
            winPct: r2(v.filter(x => x > 0).length / v.length * 100),
            vsCurrentPp: r2(avg(d)),
            t: s ? r2(avg(d) / s) : null,
        };
    });
}

const MEAN_REVERSION = ['WilliamsR', 'Wyckoff_VDU', 'BB', 'MeanRev'];
const MOMENTUM = ['RelStrength5d', 'RelStrength20d', 'VISION', 'WeeklyAlign', '52wkHigh', 'SmartMoney', 'TrendTemplate', 'DayChange'];
const oversold = p => MEAN_REVERSION.reduce((s, k) => s + (p[k] || 0), 0) - MOMENTUM.reduce((s, k) => s + Math.max(0, p[k] || 0), 0);
const steady = t => (t.parts.TrendTemplate || 0) >= 15 && t.rsi >= 55 && t.rsi <= 70 && t.price >= 50;

/**
 * Per scan day, pick each method's top N from that day's pool and average the simulated
 * (current-exit) result. Returns per-method mean of daily averages + days it beat current.
 */
function compareMethods(trades) {
    const byDay = {};
    for (const t of trades) (byDay[t.d] ||= []).push(t);
    const methods = {
        current: day => [...day].sort((a, b) => b.score - a.score || a.tie - b.tie).slice(0, TOP_N),
        oversold: day => [...day].sort((a, b) => oversold(b.parts) - oversold(a.parts) || b.score - a.score).slice(0, TOP_N),
        steady: day => day.filter(steady).sort((a, b) => b.score - a.score).slice(0, TOP_N),
        jumpGuarded: day => [...day].filter(t => !(t.change > JUMP_PCT)).sort((a, b) => b.score - a.score || a.tie - b.tie).slice(0, TOP_N),
    };
    const daily = {};
    for (const [name, pick] of Object.entries(methods)) {
        daily[name] = {};
        for (const [d, day] of Object.entries(byDay)) {
            const picks = pick(day);
            if (picks.length) daily[name][d] = avg(picks.map(t => t.result));
        }
    }
    const out = {};
    for (const name of Object.keys(methods)) {
        const days = Object.keys(daily[name]);
        const diffs = days.filter(d => daily.current[d] != null).map(d => daily[name][d] - daily.current[d]);
        out[name] = {
            days: days.length,
            avgPct: r2(avg(days.map(d => daily[name][d]))),
            vsCurrentPp: name === 'current' ? 0 : r2(avg(diffs)),
            daysBeatCurrent: name === 'current' ? null : `${diffs.filter(x => x > 0).length}/${diffs.length}`,
        };
    }
    const jumped = trades.filter(t => t.change > JUMP_PCT).map(t => t.result);
    const rest = trades.filter(t => !(t.change > JUMP_PCT)).map(t => t.result);
    out.jumpCheck = { jumpedN: jumped.length, jumpedAvgPct: r2(avg(jumped)), restAvgPct: r2(avg(rest)) };
    return out;
}

async function _fetchDailyBars(symbols, start, end) {
    const headers = { 'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY };
    const bars = {};
    for (let i = 0; i < symbols.length; i += 100) {
        let token = null;
        do {
            const res = await axios.get('https://data.alpaca.markets/v2/stocks/bars', {
                headers, timeout: 30000,
                params: { symbols: symbols.slice(i, i + 100).join(','), timeframe: '1Day', start, end, limit: 10000, feed: 'iex', adjustment: 'all', ...(token ? { page_token: token } : {}) },
            });
            for (const [k, v] of Object.entries(res.data.bars || {})) (bars[k] ||= []).push(...v);
            token = res.data.next_page_token;
        } while (token);
    }
    return bars;
}

let _tableReady = false;
async function ensureTable() {
    if (_tableReady) return;
    await query(`
        CREATE TABLE IF NOT EXISTS weekly_market_study (
            id          SERIAL PRIMARY KEY,
            run_date    DATE        NOT NULL UNIQUE,
            window_from DATE,
            window_to   DATE,
            trades      INT,
            results     JSONB       NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    _tableReady = true;
}

const _isoDate = d => d.toISOString().slice(0, 10);

async function runMarketStudy({ weeks = 8, now = new Date() } = {}) {
    await ensureTable();
    // Scan days whose full 10-trading-day path is already known (~15 calendar days back).
    const to = new Date(now.getTime() - 15 * 86400000);
    const from = new Date(to.getTime() - weeks * 7 * 86400000);

    const res = await query(`
        SELECT analysis_date::text AS d, symbol, ai_score::float AS score, COALESCE(sector, 'Unknown') AS sector,
               (metadata->>'rsi')::float AS rsi, (metadata->>'price')::float AS price,
               (metadata->>'change')::float AS change, metadata->'scoringLog' AS log,
               ('x' || substr(md5(symbol || analysis_date::text), 1, 8))::bit(32)::int AS tie
        FROM daily_universe_analysis
        WHERE passed_prescreen AND ai_score >= $1
          AND analysis_date BETWEEN $2::date AND $3::date
          AND EXTRACT(ISODOW FROM analysis_date) < 6
          AND symbol ~ '^[A-Z.]+$'`,
        [POOL_MIN_SCORE, _isoDate(from), _isoDate(to)]);
    if (res.rows.length < 500) {
        logger.info('[MarketStudy] Too few rows for a reliable read — skipping', { rows: res.rows.length });
        return { skipped: true, rows: res.rows.length };
    }

    const bars = await _fetchDailyBars([...new Set(res.rows.map(r => r.symbol))], _isoDate(from), _isoDate(now));
    const trades = [];
    for (const r of res.rows) {
        const b = bars[r.symbol];
        if (!b) continue;
        const i0 = b.findIndex(z => z.t.slice(0, 10) === r.d);
        if (i0 < 0 || i0 + HOLD_DAYS >= b.length) continue;
        const path = b.slice(i0 + 1, i0 + 1 + HOLD_DAYS);
        const entry = path[0].o;
        if (!(entry > 0)) continue;
        trades.push({
            d: r.d, s: r.symbol, score: r.score, tie: r.tie, sector: r.sector, rsi: r.rsi, price: r.price,
            change: r.change, parts: parseScoringLog(r.log), path, entry,
        });
    }
    for (const t of trades) t.result = simulateExit(t.path, t.entry, EXIT_RULES[0][1]);

    const results = {
        window: { from: _isoDate(from), to: _isoDate(to) },
        trades: trades.length,
        tickers: new Set(trades.map(t => t.s)).size,
        days: new Set(trades.map(t => t.d)).size,
        reachedPlus5Pct: r2(trades.filter(t => Math.max(...t.path.map(b => b.h)) >= t.entry * 1.05).length / trades.length * 100),
        exitRules: compareExitRules(trades),
        methods: compareMethods(trades),
        market: await _lastWeekMarket(now),
    };

    await query(
        `INSERT INTO weekly_market_study (run_date, window_from, window_to, trades, results)
         VALUES ($1::date, $2::date, $3::date, $4, $5)
         ON CONFLICT (run_date) DO UPDATE SET results = EXCLUDED.results, trades = EXCLUDED.trades`,
        [_isoDate(now), results.window.from, results.window.to, results.trades, JSON.stringify(results)]
    );
    logger.info('[MarketStudy] Weekly study stored', { trades: results.trades, tickers: results.tickers, days: results.days });
    return results;
}

/**
 * Last week from the market's side: the 5-trading-day move of EVERY stock in the scan
 * from about a week ago (Alpaca daily bars — market_review_snapshots lags and fills in
 * symbol order), with the score our scan gave each one that day — the "did we see it?"
 * check. Movers are limited to $5+ stocks with some real trading, so micro-cap spikes
 * don't crowd the list.
 */
async function _lastWeekMarket(now = new Date()) {
    try {
        const d = await query(`
            SELECT analysis_date::text AS d FROM daily_universe_analysis
            WHERE analysis_date <= ($1::date - 6) AND EXTRACT(ISODOW FROM analysis_date) < 6
            GROUP BY analysis_date HAVING COUNT(*) >= 1500
            ORDER BY analysis_date DESC LIMIT 1`, [_isoDate(now)]);
        const day = d.rows[0]?.d;
        if (!day) return null;
        const res = await query(`
            SELECT symbol, COALESCE(sector, 'Unknown') AS sector, ai_score::float AS score
            FROM daily_universe_analysis WHERE analysis_date = $1::date AND symbol ~ '^[A-Z.]+$'`, [day]);
        const bars = await _fetchDailyBars(res.rows.map(r => r.symbol), day, _isoDate(now));
        const rows = [];
        for (const r of res.rows) {
            const b = bars[r.symbol];
            if (!b) continue;
            const i0 = b.findIndex(z => z.t.slice(0, 10) === day);
            if (i0 < 0 || i0 + 5 >= b.length) continue;
            const base = b[i0].c, end = b[i0 + 5];
            if (!(base > 0)) continue;
            const dollarVol = avg(b.slice(i0, i0 + 6).map(z => z.c * z.v));
            rows.push({ ...r, ret5: (end.c / base - 1) * 100, liquid: base >= 5 && dollarVol >= 2_000_000 });
        }
        const bySector = {};
        for (const r of rows) if (r.sector !== 'Unknown') (bySector[r.sector] ||= []).push(r.ret5);
        const sectors = Object.entries(bySector).filter(([, v]) => v.length >= 15)
            .map(([sector, v]) => ({ sector, avgPct: r2(avg(v)), n: v.length }))
            .sort((a, b) => b.avgPct - a.avgPct);
        const movers = rows.filter(r => r.liquid).sort((a, b) => b.ret5 - a.ret5).slice(0, 10)
            .map(r => ({ symbol: r.symbol, pct: r2(r.ret5), score: r.score }));
        return {
            fromScanDay: day, stocks: rows.length,
            topSectors: sectors.slice(0, 3), bottomSectors: sectors.slice(-2).reverse(),
            topMovers: movers, topMoversScored80: movers.filter(m => m.score >= POOL_MIN_SCORE).length,
        };
    } catch (err) {
        logger.warn('[MarketStudy] Last-week market summary failed', { error: err.message });
        return null;
    }
}

function formatReport(r) {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const pct = v => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${v}%`);
    const pp = v => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${v}pp`);
    const best = [...r.exitRules].sort((a, b) => b.avgPct - a.avgPct)[0];
    const m = r.methods;
    const lines = [
        `<b>🔬 Weekly market study</b> — all ${r.trades} candidates (score ≥80), ${r.tickers} tickers, ${r.days} scan days`,
        `<i>${r.window.from} → ${r.window.to} · buy next open, −5% stop, ≤10 days · only ${r.reachedPlus5Pct}% ever touched +5%</i>`,
        '',
        '<b>1. Exits</b> (per trade, vs current trailing stop)',
        ...r.exitRules.map(x => `${esc(x.rule)}: ${pct(x.avgPct)} · win ${x.winPct}%${x.rule.includes('current') ? '' : ` · ${pp(x.vsCurrentPp)} (t ${x.t})`}`),
        best.rule.includes('current') ? '✅ Current trailing stop is still the best rule.' : `⚠️ Best this window: <b>${esc(best.rule)}</b> — worth a closer look (check t ≥ 2 and next week).`,
        '',
        `<b>2. Picking</b> (top ${TOP_N}/day, current exit)`,
        `Current: ${pct(m.current.avgPct)} (${m.current.days} days)`,
        `Oversold: ${pct(m.oversold.avgPct)} · ${pp(m.oversold.vsCurrentPp)} · beat current ${m.oversold.daysBeatCurrent} days`,
        `Steady trend: ${pct(m.steady.avgPct)} · ${pp(m.steady.vsCurrentPp)} · beat current ${m.steady.daysBeatCurrent} days (${m.steady.days} days with picks)`,
        `Jump guard: >${JUMP_PCT}% jumpers ${pct(m.jumpCheck.jumpedAvgPct)} (n ${m.jumpCheck.jumpedN}) vs rest ${pct(m.jumpCheck.restAvgPct)}`,
    ];
    if (r.market) {
        const mk = r.market;
        lines.push('', `<b>3. Last week's market</b> (from scan day ${mk.fromScanDay}, ${mk.stocks} stocks, 5-day move)`,
            `Leading: ${mk.topSectors.map(s => `${esc(s.sector)} ${pct(s.avgPct)}`).join(', ')}`,
            `Lagging: ${mk.bottomSectors.map(s => `${esc(s.sector)} ${pct(s.avgPct)}`).join(', ')}`,
            `Top movers (our score): ${mk.topMovers.map(x => `${esc(x.symbol)} ${pct(x.pct)} (${x.score ?? '–'})`).join(', ')}`,
            `${mk.topMoversScored80}/10 top movers were rated ≥80 by our scan that day.`);
    }
    lines.push('', '<i>Report only — trading is unchanged.</i>');
    return lines.join('\n');
}

async function runWeeklyReport() {
    // Grow the multi-year price history first (new week + any new symbols), then re-run
    // the since-2024 rule check on it. Both are best-effort: the 8-week study still sends.
    await require('./historyBarsService').appendRecent();
    let history = null;
    try {
        const hb = require('./historyBacktestService');
        history = hb.formatSection(await hb.runHistoryBacktest());
    } catch (err) {
        logger.warn('[MarketStudy] Multi-year check failed (non-blocking)', { error: err.message });
    }
    const r = await runMarketStudy();
    if (r.skipped) return r;
    const { sendAdminMessage } = require('./telegramAlertService');
    const text = history ? formatReport(r).replace('\n\n<i>Report only', `\n\n${history}\n\n<i>Report only`) : formatReport(r);
    await sendAdminMessage(text, 'HTML').catch(err =>
        logger.warn('[MarketStudy] Telegram send failed', { error: err.message })
    );
    return r;
}

module.exports = { runMarketStudy, runWeeklyReport, formatReport, simulateExit, compareExitRules, compareMethods, EXIT_RULES };
