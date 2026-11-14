/**
 * Lab page data (2026-11-12) — admin only, read-only. One place for the research lab ideas,
 * the ORACLE shadow test (Gemini vs local model), the Gemini news-event archive and AI spend.
 * Nothing here touches trading.
 */
const express = require('express');
const router = express.Router();
const { protect, adminOnly } = require('../middleware/authMiddleware');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

router.use(protect, adminOnly);

const safe = (p, fallback) => p.then(r => r.rows).catch(err => {
    logger.warn('[Lab] query failed', { error: err.message });
    return fallback;
});

/**
 * Per symbol: latest IV, change vs the previous snapshot, and where today sits in its own range
 * (IV rank, 0 = lowest seen, 100 = highest). Rank needs 20+ days of history to mean anything.
 */
const IV_RANK_MIN_DAYS = 20;
/**
 * rvBy: symbol → 20-day realised volatility (annualised, same units as IV). IV vs RV says whether
 * option premium is rich (IV well above what the stock actually moves) or cheap (2026-11-14).
 */
function ivSummary(rows, rvBy = new Map()) {
    const by = new Map();
    for (const r of rows) { if (!by.has(r.symbol)) by.set(r.symbol, []); by.get(r.symbol).push(r); }
    const latest = [];
    for (const [symbol, hist] of by) {
        const last = hist[hist.length - 1], prev = hist.length > 1 ? hist[hist.length - 2] : null;
        const ivs = hist.map(h => h.iv).filter(v => v != null);
        const lo = Math.min(...ivs), hi = Math.max(...ivs);
        const enough = hist.length >= IV_RANK_MIN_DAYS && last.iv != null;
        const rv = rvBy.get(symbol) ?? null;
        latest.push({
            symbol, d: last.d, price: last.price, iv: last.iv, dte: last.dte, days: hist.length,
            change: prev && prev.iv != null && last.iv != null ? last.iv - prev.iv : null,
            lo, hi, rank: enough && hi > lo ? Math.round((last.iv - lo) / (hi - lo) * 100) : null,
            // share of past days with lower IV than today (less thrown off by one spike than rank)
            percentile: enough ? Math.round(ivs.slice(0, -1).filter(v => v < last.iv).length / Math.max(1, ivs.length - 1) * 100) : null,
            rv20: rv, ivVsRv: rv > 0 && last.iv != null ? +(last.iv / rv).toFixed(2) : null,
            history: hist.map(h => ({ d: h.d, iv: h.iv, price: h.price })),
        });
    }
    latest.sort((a, b) => (b.iv ?? 0) - (a.iv ?? 0));
    const days = [...new Set(rows.map(r => r.d))].sort();
    return { latest, days: days.length, first: days[0] || null, last: days[days.length - 1] || null, rankMinDays: IV_RANK_MIN_DAYS };
}

router.get('/summary', async (req, res) => {
    const [ideas, shadowDaily, shadowByVerdict, shadowMatrix, newsTypes, newsRange, spendDaily, spendByService, subs, ivRows, tips, rvRows, optionsRuns] = await Promise.all([
        safe(query(`SELECT id, name, family, idea, source, status, result, created_at, tested_at
                    FROM research_hypotheses ORDER BY COALESCE(tested_at, created_at) DESC, id DESC`), []),
        // Per day: checks, how many each model answered, agreement where both answered.
        safe(query(`SELECT at::date AS day, count(*)::int AS checks,
                           count(local_verdict)::int AS local_answered, count(gemini_verdict)::int AS gemini_answered,
                           count(*) FILTER (WHERE local_verdict IS NOT NULL AND gemini_verdict IS NOT NULL)::int AS both,
                           count(*) FILTER (WHERE local_verdict = gemini_verdict)::int AS agree,
                           round(COALESCE(sum(gemini_cost), 0)::numeric, 3)::float AS gemini_usd,
                           round(avg(local_ms))::int AS local_ms, round(avg(gemini_ms))::int AS gemini_ms
                    FROM oracle_shadow GROUP BY 1 ORDER BY 1 DESC`), []),
        // Which model was right, by each model's verdict (2026-11-14: 5/10/20-day returns vs SPY,
        // plus the best (MFE) and worst (MAE) move within 10 days — the risk after a "TRADE" call).
        // One row per symbol per day so a stock checked many times in a day doesn't count extra.
        safe(query(`WITH s AS (SELECT DISTINCT ON (symbol, at::date) symbol, at::date AS d, local_verdict AS lv, gemini_verdict AS gv
                               FROM oracle_shadow ORDER BY symbol, at::date, at DESC),
                    f AS (SELECT s.*,
                        (SELECT b.c FROM history_bars b WHERE b.symbol = s.symbol AND b.d <= s.d ORDER BY b.d DESC LIMIT 1) AS c0,
                        (SELECT b.c FROM history_bars b WHERE b.symbol = s.symbol AND b.d > s.d ORDER BY b.d OFFSET 4 LIMIT 1) AS c5,
                        (SELECT b.c FROM history_bars b WHERE b.symbol = s.symbol AND b.d > s.d ORDER BY b.d OFFSET 9 LIMIT 1) AS c10,
                        (SELECT b.c FROM history_bars b WHERE b.symbol = s.symbol AND b.d > s.d ORDER BY b.d OFFSET 19 LIMIT 1) AS c20,
                        (SELECT b.c FROM history_bars b WHERE b.symbol = 'SPY' AND b.d <= s.d ORDER BY b.d DESC LIMIT 1) AS s0,
                        (SELECT b.c FROM history_bars b WHERE b.symbol = 'SPY' AND b.d > s.d ORDER BY b.d OFFSET 4 LIMIT 1) AS s5,
                        (SELECT b.c FROM history_bars b WHERE b.symbol = 'SPY' AND b.d > s.d ORDER BY b.d OFFSET 9 LIMIT 1) AS s10,
                        (SELECT b.c FROM history_bars b WHERE b.symbol = 'SPY' AND b.d > s.d ORDER BY b.d OFFSET 19 LIMIT 1) AS s20,
                        (SELECT max(h) FROM (SELECT b.h FROM history_bars b WHERE b.symbol = s.symbol AND b.d > s.d ORDER BY b.d LIMIT 10) x) AS hi10,
                        (SELECT min(l) FROM (SELECT b.l FROM history_bars b WHERE b.symbol = s.symbol AND b.d > s.d ORDER BY b.d LIMIT 10) x) AS lo10
                      FROM s),
                    -- GREATEST/LEAST skip NULLs (they'd turn "no outcome yet" into -30), so cap only real values
                    r AS (SELECT lv, gv,
                        CASE WHEN c5 IS NOT NULL AND s5 IS NOT NULL THEN least(30, greatest(-30, (c5 / NULLIF(c0, 0) - s5 / NULLIF(s0, 0)) * 100)) END AS x5,
                        CASE WHEN c10 IS NOT NULL AND s10 IS NOT NULL THEN least(30, greatest(-30, (c10 / NULLIF(c0, 0) - s10 / NULLIF(s0, 0)) * 100)) END AS x10,
                        CASE WHEN c20 IS NOT NULL AND s20 IS NOT NULL THEN least(30, greatest(-30, (c20 / NULLIF(c0, 0) - s20 / NULLIF(s0, 0)) * 100)) END AS x20,
                        (c5 / NULLIF(c0, 0) - 1) * 100 AS ret,
                        CASE WHEN c10 IS NOT NULL THEN (hi10 / NULLIF(c0, 0) - 1) * 100 END AS mfe,
                        CASE WHEN c10 IS NOT NULL THEN (lo10 / NULLIF(c0, 0) - 1) * 100 END AS mae FROM f)
                    SELECT model, verdict, count(*)::int AS n, count(ret)::int AS n_with_outcome,
                           round(avg(ret)::numeric, 2)::float AS avg_5d_pct,
                           round((100.0 * count(*) FILTER (WHERE ret > 0) / NULLIF(count(ret), 0))::numeric, 0)::float AS up_pct,
                           round(avg(x5)::numeric, 2)::float AS vs_spy_5d, round(avg(x10)::numeric, 2)::float AS vs_spy_10d,
                           round(avg(x20)::numeric, 2)::float AS vs_spy_20d, count(x20)::int AS n_20d,
                           round(avg(mfe)::numeric, 2)::float AS best_10d, round(avg(mae)::numeric, 2)::float AS worst_10d
                    FROM (SELECT 'local' AS model, COALESCE(lv, 'no answer') AS verdict, x5, x10, x20, ret, mfe, mae FROM r
                          UNION ALL
                          SELECT 'gemini', COALESCE(gv, 'no answer'), x5, x10, x20, ret, mfe, mae FROM r) x
                    GROUP BY 1, 2 ORDER BY 1, 2`), []),
        safe(query(`SELECT COALESCE(local_verdict, 'no answer') AS local, COALESCE(gemini_verdict, 'no answer') AS gemini, count(*)::int AS n
                    FROM oracle_shadow GROUP BY 1, 2 ORDER BY 3 DESC`), []),
        safe(query(`SELECT event_type, count(*)::int AS n, count(DISTINCT symbol)::int AS symbols
                    FROM news_events GROUP BY 1 ORDER BY 2 DESC`), []),
        safe(query(`SELECT count(*)::int AS n, min(created_at) AS first, max(created_at) AS last,
                           count(*) FILTER (WHERE method ILIKE '%gemini%')::int AS by_gemini
                    FROM news_events`), [{}]),
        safe(query(`SELECT day, service, calls::int, round(usd::numeric, 3)::float AS usd
                    FROM api_costs WHERE day > CURRENT_DATE - 60 ORDER BY day DESC, usd DESC`), []),
        safe(query(`SELECT service, sum(calls)::int AS calls, round(sum(usd)::numeric, 2)::float AS usd, min(day) AS since
                    FROM api_costs GROUP BY 1 ORDER BY 3 DESC`), []),
        safe(query(`SELECT service, monthly_usd, notes, active FROM service_subscriptions ORDER BY service`), []),
        // Options IV: last 180 days of the daily ATM implied-volatility snapshot (optionsIncomeService).
        safe(query(`SELECT symbol, d::text AS d, stock_price::float AS price, atm_iv::float AS iv, dte
                    FROM options_iv_history WHERE d > CURRENT_DATE - 180 ORDER BY symbol, d`), []),
        // Daily plain-English tips (labTipsService), newest first.
        safe(query(`SELECT day::text AS day, tips, created_at FROM lab_tips ORDER BY day DESC LIMIT 7`), []),
        // 20-day realised volatility for the IV symbols (log returns, annualised).
        safe(query(`WITH s AS (SELECT DISTINCT symbol FROM options_iv_history),
                    b AS (SELECT h.symbol, h.c, row_number() OVER (PARTITION BY h.symbol ORDER BY h.d DESC) AS rn
                          FROM history_bars h JOIN s USING (symbol) WHERE h.d > CURRENT_DATE - 45),
                    r AS (SELECT a.symbol, ln(a.c / NULLIF(p.c, 0)) AS lr FROM b a JOIN b p ON p.symbol = a.symbol AND p.rn = a.rn + 1 WHERE a.rn <= 20)
                    SELECT symbol, sqrt(avg(lr * lr) * 252)::float AS rv20, count(*)::int AS n FROM r GROUP BY 1`), []),
        // Latest options-lab results (own-trade replay, CSP backtest).
        safe(query(`SELECT DISTINCT ON (kind) kind, created_at, result FROM options_lab_runs ORDER BY kind, created_at DESC`), []),
    ]);
    const rvBy = new Map(rvRows.filter(r => r.n >= 15).map(r => [r.symbol, r.rv20]));
    const optionsLab = Object.fromEntries(optionsRuns.map(r => [r.kind, { at: r.created_at, ...r.result }]));
    res.json({ ideas, shadow: { daily: shadowDaily, byVerdict: shadowByVerdict, matrix: shadowMatrix },
               news: { types: newsTypes, range: newsRange[0] || {} }, spend: { daily: spendDaily, byService: spendByService, subscriptions: subs },
               iv: ivSummary(ivRows, rvBy), tips, optionsLab });
});

module.exports = router;
