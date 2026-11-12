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

router.get('/summary', async (req, res) => {
    const [ideas, shadowDaily, shadowByVerdict, shadowMatrix, newsTypes, newsRange, spendDaily, spendByService, subs] = await Promise.all([
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
        // Which model was right: 5-trading-day return after the check, by each model's verdict.
        safe(query(`WITH s AS (SELECT symbol, at::date AS d, local_verdict AS lv, gemini_verdict AS gv FROM oracle_shadow),
                    f AS (SELECT s.*,
                        (SELECT b.c FROM history_bars b WHERE b.symbol = s.symbol AND b.d <= s.d ORDER BY b.d DESC LIMIT 1) AS c0,
                        (SELECT b.c FROM history_bars b WHERE b.symbol = s.symbol AND b.d > s.d ORDER BY b.d OFFSET 4 LIMIT 1) AS c5
                      FROM s)
                    SELECT model, verdict, count(*)::int AS n, count(ret)::int AS n_with_outcome,
                           round(avg(ret)::numeric, 2)::float AS avg_5d_pct,
                           round((100.0 * count(*) FILTER (WHERE ret > 0) / NULLIF(count(ret), 0))::numeric, 0)::float AS up_pct
                    FROM (SELECT 'local' AS model, COALESCE(lv, 'no answer') AS verdict, (c5 / NULLIF(c0, 0) - 1) * 100 AS ret FROM f
                          UNION ALL
                          SELECT 'gemini', COALESCE(gv, 'no answer'), (c5 / NULLIF(c0, 0) - 1) * 100 FROM f) x
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
    ]);
    res.json({ ideas, shadow: { daily: shadowDaily, byVerdict: shadowByVerdict, matrix: shadowMatrix },
               news: { types: newsTypes, range: newsRange[0] || {} }, spend: { daily: spendDaily, byService: spendByService, subscriptions: subs } });
});

module.exports = router;
