/**
 * Weekly strategy review (2026-10-24) — one strategy per Saturday on a fixed rotation, with
 * the numbers needed for its decision pulled into the Saturday market-study report.
 * Report only: any real-money change still goes through approvalService.
 */
const { query } = require('../config/database');

const PAPER = '83f08677-e55a-48d1-bd31-f5b56fa79c23';
const KMADINED = 'ca632c53-8798-46f4-be94-29be0fede7f2';
const ROTATION_START = '2026-10-31'; // Saturday of the first review

const r2 = v => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
const pct = v => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${r2(v)}%`);
const usd = v => (v == null ? 'n/a' : `${v < 0 ? '−' : '+'}$${Math.abs(v).toFixed(2)}`);

async function _spyPct(fromDate) {
    const r = await query(
        `SELECT (SELECT close FROM daily_bars WHERE symbol = 'SPY' AND timestamp >= $1::date ORDER BY timestamp LIMIT 1)::float AS a,
                (SELECT close FROM daily_bars WHERE symbol = 'SPY' ORDER BY timestamp DESC LIMIT 1)::float AS b`, [fromDate]);
    const { a, b } = r.rows[0] || {};
    return a && b ? (b / a - 1) * 100 : null;
}

async function _sells(userId, since) {
    const r = await query(
        `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE pnl > 0)::int AS wins,
                COALESCE(SUM(pnl), 0)::float AS pnl, AVG(pnl_percent)::float AS avg_pct
         FROM trades WHERE user_id::text = $1 AND action = 'SELL' AND trade_date >= $2::date`, [userId, since]);
    return r.rows[0];
}

const since28 = now => new Date(now.getTime() - 28 * 86400000).toISOString().slice(0, 10);

const REVIEWS = [
    {
        key: 'core', title: 'Core holdings on kmadined',
        question: 'Did paper core track SPY cleanly? → approve a small live core allocation (30–50%).',
        async data() {
            const c = await query(
                `SELECT h.symbol, h.market_value::float AS v, h.gain_loss::float AS pl FROM holdings h
                 JOIN core_holdings c ON c.user_id = h.user_id AND c.symbol = h.symbol
                 WHERE h.user_id = $1 AND c.sleeve = 'core' AND c.active AND h.quantity > 0`, [PAPER]);
            const v = c.rows.reduce((s, x) => s + x.v, 0), pl = c.rows.reduce((s, x) => s + x.pl, 0);
            const first = (await query(`SELECT MIN(created_at)::date::text AS d FROM core_holdings WHERE user_id = $1 AND sleeve = 'core'`, [PAPER])).rows[0]?.d;
            // Watchlist prospective record (2026-10-26): per status, stock vs SPY over the same window.
            const o = await require('./coreWatchlistService').getOutcomes().catch(() => ({}));
            const wl = Object.entries(o).flatMap(([h, rows]) => rows.map(x =>
                `Watchlist ${h} — ${x.status}: ${pct(x.avg_pct)} vs SPY ${pct(x.spy_pct)} (${x.symbols} stocks, beat SPY ${Math.round(x.beat_spy_pct)}%)`));
            // Core guidance scorecard (2026-10-26): decisions and outcomes by rule, all accounts.
            const sc = await require('./coreGuidanceService').getScorecard().catch(() => null);
            if (sc) {
                for (const x of sc.counts) wl.push(`Guidance ${x.rule} — ${x.status}: ${x.n}`);
                for (const [h, rows] of Object.entries(sc.outcomes)) for (const x of rows)
                    wl.push(`Guidance ${h} ${x.rule}/${x.status}: ${pct(x.avg_pct)} vs SPY ${pct(x.spy_pct)} (${x.n})`);
            }
            return [`Paper core: ${c.rows.map(x => x.symbol).join(', ')} · $${Math.round(v).toLocaleString()} · ${usd(pl)} (${pct(v - pl > 0 ? pl / (v - pl) * 100 : null)})`,
                    `SPY since ${first}: ${pct(first ? await _spyPct(first) : null)}`,
                    ...(wl.length ? wl : ['Watchlist record: no signal is a month old yet']) ];
        },
    },
    {
        key: 'selection', title: 'Selection experiment',
        question: 'Does any method beat control by ≥1pp with a win rate not lower? → promote it, or keep control.',
        async data() {
            const rep = await require('./selectionExperimentService').getExperimentReport();
            const t = rep.top40 || {};
            return [`Since ${rep.sinceDate}, ${rep.daysWithReturns} days with 5-day returns`,
                    ...Object.entries(t).filter(([k]) => k !== 'edgePp').map(([k, a]) =>
                        `${k}: ${pct(a.avgReturn5dPct)} avg 5d · win ${a.winRatePct ?? 'n/a'}% · ${a.picks} picks${t.edgePp?.[k] != null ? ` · edge ${t.edgePp[k] >= 0 ? '+' : ''}${t.edgePp[k]}pp` : ''}`)];
        },
    },
    {
        key: 'size', title: 'Swing bot position size (kmadined)',
        question: 'Is idle cash the bottleneck? → propose a larger per-trade size (needs your approval).',
        async data(now) {
            const s = await _sells(KMADINED, since28(now));
            const h = await query(`SELECT COUNT(*)::int AS n, AVG(quantity * average_price)::float AS avg_cost FROM holdings WHERE user_id = $1 AND quantity > 0`, [KMADINED]);
            const sum = await require('./dailyPnlTargetService').buildAccountSummary(KMADINED).catch(() => null);
            return [`Last 4 weeks: ${s.n} exits, ${s.wins} won, ${usd(s.pnl)}`,
                    `Open: ${h.rows[0].n} positions, avg $${Math.round(h.rows[0].avg_cost || 0)} each · idle cash ${sum?.cashPct ?? '?'}%`];
        },
    },
    {
        key: 'options', title: 'Options income (paper puts)',
        question: 'Are closed puts profitable, and did earnings-crossing ones do worse? → keep, change the 3× stop, or stop.',
        async data() {
            const r = await query(
                `SELECT status, pnl::float AS pnl, (next_earnings IS NOT NULL AND next_earnings <= expiry) AS crossed
                 FROM options_income_trades WHERE status NOT IN ('not_filled', 'pending_open')`);
            const closed = r.rows.filter(x => ['closed', 'expired', 'assigned'].includes(x.status));
            const grp = f => { const g = closed.filter(f); return `${g.length} closed, ${g.filter(x => x.pnl > 0).length} won, ${usd(g.reduce((s, x) => s + (x.pnl || 0), 0))}`; };
            const s = await require('./optionsIncomeService').summary().catch(() => null);
            return [`Open: ${r.rows.length - closed.length} · Closed: ${grp(() => true)}`,
                    `Held through earnings: ${grp(x => x.crossed)} · Earnings-free: ${grp(x => !x.crossed)}`,
                    ...(s ? [`Same collateral in T-bills (${s.riskFreePct}%/yr): ${usd(s.tbill_benchmark)} — the puts must clearly beat this to be worth the risk${s.assigned ? ` · ${s.assigned} assigned` : ''}`] : [])];
        },
    },
    {
        key: 'satellite', title: 'Momentum satellite (paper)',
        question: 'A month or more vs SPY → continue another month, or drop it.',
        async data() {
            const s = await require('./satelliteService').performance();
            const h = await query(
                `SELECT COALESCE(SUM(h.gain_loss), 0)::float AS pl, COALESCE(SUM(h.market_value), 0)::float AS v FROM holdings h
                 JOIN core_holdings c ON c.user_id = h.user_id AND c.symbol = h.symbol
                 WHERE h.user_id = $1 AND c.sleeve = 'satellite' AND c.active AND h.quantity > 0`, [PAPER]);
            return [`Since ${s?.since}: basket ${pct(s?.basketPct)} vs SPY ${pct(s?.spyPct)}`,
                    `Open P&L ${usd(h.rows[0].pl)} on $${Math.round(h.rows[0].v).toLocaleString()}`];
        },
    },
    {
        key: 'exit', title: "Exit profile ('wide' on paper vs standard on live)",
        question: 'Has the wider exit held up on real trades? → propose it for live, or not.',
        async data(now) {
            const p = await _sells(PAPER, since28(now)), k = await _sells(KMADINED, since28(now));
            const line = (n, s) => `${n}: ${s.n} exits, win ${s.n ? Math.round(s.wins / s.n * 100) : 0}%, avg ${pct(s.avg_pct)} per trade, ${usd(s.pnl)}`;
            return [line('Paper (wide)', p), line('kmadined (standard)', k)];
        },
    },
    {
        key: 'crypto', title: 'Crypto (paper)',
        question: 'Is the win rate improving from ~28%? → stop it, or keep it as paper only.',
        async data(now) {
            const r = await query(
                `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE pnl > 0)::int AS wins, COALESCE(SUM(pnl), 0)::float AS pnl,
                        COUNT(*) FILTER (WHERE exit_time >= $1::date)::int AS n4, COALESCE(SUM(pnl) FILTER (WHERE exit_time >= $1::date), 0)::float AS pnl4
                 FROM crypto_trades WHERE exit_time IS NOT NULL`, [since28(now)]);
            const x = r.rows[0];
            return [`All time: ${x.n} trades, win ${x.n ? Math.round(x.wins / x.n * 100) : 0}%, ${usd(x.pnl)} · last 4 weeks: ${x.n4} trades, ${usd(x.pnl4)}`];
        },
    },
    {
        key: 'swing_vs_spy', title: 'Swing bot vs SPY (kmadined)',
        question: 'Did the swing bot beat SPY on the same capital since the 10-24 fixes? → keep live, shrink, or move the money to core.',
        async data() {
            const s = await _sells(KMADINED, '2026-10-24');
            const sum = await require('./dailyPnlTargetService').buildAccountSummary(KMADINED).catch(() => null);
            const spy = await _spyPct('2026-10-24');
            return [`Since 2026-10-24: ${s.n} exits, ${s.wins} won, realized ${usd(s.pnl)}`,
                    `Same capital in SPY: ${spy != null && sum?.equity ? usd(sum.equity * spy / 100) : 'n/a'} (SPY ${pct(spy)})`];
        },
    },
];

function reviewForDate(now = new Date()) {
    const weeks = Math.floor((now.getTime() - new Date(`${ROTATION_START}T00:00:00Z`).getTime()) / (7 * 86400000));
    const idx = ((weeks % REVIEWS.length) + REVIEWS.length) % REVIEWS.length;
    return { review: REVIEWS[idx], next: REVIEWS[(idx + 1) % REVIEWS.length] };
}

/** HTML section for the Saturday Telegram report. Never throws. */
async function buildSection(now = new Date()) {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const { review, next } = reviewForDate(now);
    let lines;
    try { lines = await review.data(now); } catch (err) { lines = [`(data unavailable: ${err.message})`]; }
    return [`<b>📋 This week's strategy review: ${esc(review.title)}</b>`, `<i>${esc(review.question)}</i>`,
            ...lines.map(esc), `Next week: ${esc(next.title)}`].join('\n');
}

module.exports = { REVIEWS, reviewForDate, buildSection };
