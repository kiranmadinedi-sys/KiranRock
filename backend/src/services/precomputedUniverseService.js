/**
 * Precomputed Universe Service
 *
 * Reads from `daily_universe_analysis` (written by nightlyUniverseScanService)
 * and returns pre-scored candidates for the market-hours scan.
 *
 * Contract:
 *   - isAvailable()   → true if ≥10 pre-screened records exist within the last 4 days
 *   - loadCandidates() → top N records from the most recent scan date (last 4 days)
 *
 * Using "most recent within 4 days" rather than "today" means:
 *   - Thursday evening scan (stored as 2026-05-29) is used by Friday's (2026-05-30) bot
 *   - Friday's scan is used by Monday's bot (covers the weekend gap)
 *
 * The returned objects are compatible with the stock metadata format expected
 * by scanMarketForOpportunities() — symbol, marketCap, sector are all present.
 */

const { query } = require('../config/database');

/**
 * Most recent date with ≥1 passed record — used by isAvailable() and loadCandidates().
 * Thursday evening scan (stored 2026-05-29) is found by Friday's (2026-05-30) bot.
 * Friday scan is found by Monday's bot (covers the weekend gap).
 */
const LATEST_DATE_SQL = `(
    SELECT MAX(analysis_date)
    FROM   daily_universe_analysis
    WHERE  analysis_date >= CURRENT_DATE - INTERVAL '4 days'
      AND  analysis_date <= CURRENT_DATE
      AND  passed_prescreen = true
)`;

/**
 * Most recent date with ANY scan records — used by analytics (summary, exclusions, new tickers).
 * Shows digest/dashboard data even on nights when all tickers failed (e.g. rate-limit outage).
 */
const LATEST_SCAN_DATE_SQL = `(
    SELECT MAX(analysis_date)
    FROM   daily_universe_analysis
    WHERE  analysis_date >= CURRENT_DATE - INTERVAL '4 days'
      AND  analysis_date <= CURRENT_DATE
)`;

/**
 * Returns true if a recent pre-scored scan (within last 4 days) has at least `minCount` records.
 */
async function isAvailable(minCount = 10) {
    try {
        const res = await query(
            `SELECT COUNT(*) AS n
             FROM daily_universe_analysis
             WHERE analysis_date = ${LATEST_DATE_SQL}
               AND passed_prescreen = true`
        );
        return parseInt(res.rows[0]?.n || 0, 10) >= minCount;
    } catch {
        return false;
    }
}

/**
 * Load top pre-screened candidates from the most recent scan (within last 4 days).
 * Returns objects with at minimum: symbol, marketCap, sector.
 * Full overnight analysis is in the `_precomputed` key for optional downstream use.
 *
 * @param {object} opts
 * @param {number} opts.minScore  — minimum ai_score to include (default 65)
 * @param {number} opts.limit     — max records to return (default 120)
 */
async function loadCandidates({ minScore = 65, limit = 120 } = {}) {
    const res = await query(
        `SELECT symbol, ai_score, recommendation, setup_family, sector, market_cap, metadata
         FROM daily_universe_analysis
         WHERE analysis_date = ${LATEST_DATE_SQL}
           AND passed_prescreen = true
           AND ai_score >= $1
         ORDER BY ai_score DESC
         LIMIT $2`,
        [minScore, limit]
    );

    return res.rows.map(row => ({
        symbol:    row.symbol,
        marketCap: parseFloat(row.market_cap) || 2_000_000_000,
        sector:    row.sector || 'Unknown',
        // Tells the scan loop to skip passesQuickFilter — already applied overnight
        _preScreened: true,
        // overnight score kept for logging/analytics — live analyzeStockWithAI overwrites it
        _precomputedScore:  parseFloat(row.ai_score),
        _precomputedRec:    row.recommendation,
        _precomputedFamily: row.setup_family,
    }));
}

/**
 * Returns a summary of the most recent scan coverage (for the digest / dashboard).
 * Uses the most recent available date within the last 4 days.
 */
async function getDailyScanSummary() {
    try {
        const res = await query(
            `SELECT
                analysis_date,
                COUNT(*)                                              AS total_analyzed,
                COUNT(*) FILTER (WHERE passed_prescreen = true)      AS passed,
                COUNT(*) FILTER (WHERE passed_prescreen = false)     AS filtered,
                ROUND(AVG(ai_score)::numeric, 1)                     AS avg_score,
                MAX(ai_score)                                         AS max_score
             FROM daily_universe_analysis
             WHERE analysis_date = ${LATEST_SCAN_DATE_SQL}
             GROUP BY analysis_date`
        );
        return res.rows[0] || null;
    } catch {
        return null;
    }
}

/**
 * Groups exclusion reasons for today's filtered stocks into readable categories.
 * Helps spot systemic data gaps (e.g., "80% of stocks returned null — provider down").
 *
 * @param {string} [date]  — YYYY-MM-DD, defaults to today ET
 * @returns {{ category: string, count: number }[]}
 */
async function getExclusionSummary(date) {
    try {
        // If no explicit date, use the most recent scan date (any records) within 4 days
        const dateExpr = date ? `$1::date` : LATEST_SCAN_DATE_SQL;
        const params = date ? [date] : [];
        const res = await query(
            `SELECT
                CASE
                    WHEN exclusion_reason ILIKE '%STRONG BUY%' OR exclusion_reason ILIKE '% BUY%'
                        THEN 'score_borderline'
                    WHEN exclusion_reason ILIKE '%HOLD%' OR exclusion_reason ILIKE '%SELL%'
                        THEN 'weak_signal'
                    WHEN exclusion_reason ILIKE '%null%' OR exclusion_reason ILIKE '%returned null%'
                        THEN 'analysis_null'
                    WHEN exclusion_reason ILIKE '%rate limit%' OR exclusion_reason ILIKE '%timeout%'
                        THEN 'api_rate_limit'
                    WHEN exclusion_reason IS NOT NULL
                        THEN 'error'
                    ELSE 'other'
                END                      AS category,
                COUNT(*)::int            AS count
             FROM daily_universe_analysis
             WHERE analysis_date = ${dateExpr} AND passed_prescreen = false
             GROUP BY 1
             ORDER BY 2 DESC`,
            params
        );
        return res.rows;
    } catch {
        return [];
    }
}

/**
 * Detects IPOs or tickers appearing for the first time in daily_universe_analysis.
 * A ticker is "new" if it has no record in the past 14 days (excluding today).
 *
 * @returns {string[]} — array of new symbols found in today's scan
 */
async function getNewTickers() {
    try {
        const res = await query(
            `SELECT d.symbol
             FROM daily_universe_analysis d
             WHERE d.analysis_date = ${LATEST_SCAN_DATE_SQL}
               AND NOT EXISTS (
                   SELECT 1 FROM daily_universe_analysis h
                   WHERE h.symbol = d.symbol
                     AND h.analysis_date >= CURRENT_DATE - INTERVAL '14 days'
                     AND h.analysis_date <  ${LATEST_SCAN_DATE_SQL}
               )
             ORDER BY d.symbol`
        );
        return res.rows.map(r => r.symbol);
    } catch {
        return [];
    }
}

/**
 * Prescreen drift check — compares last week's pre-screened symbols against
 * actual trades executed within 3 days, computing conversion + P&L.
 *
 * Called weekly to validate that prescreen thresholds are still effective.
 * Low conversion rate = threshold too strict or regime blocking entries.
 * Low win rate on traded stocks = overnight scoring is stale / threshold needs raising.
 *
 * @param {number} [lookbackDays=7]
 * @returns {{ prescreenCount, tradedCount, conversionRate, avgPnl, winRate } | null}
 */
async function checkPrescreenDrift(lookbackDays = 7) {
    try {
        const res = await query(
            `SELECT
                COUNT(DISTINCT d.symbol)                                          AS prescreen_count,
                COUNT(DISTINCT t.symbol)                                          AS traded_count,
                ROUND(AVG(t.pnl)::numeric, 2)                                    AS avg_pnl,
                ROUND(
                    100.0 * COUNT(DISTINCT t.symbol) FILTER (WHERE t.pnl > 0)
                    / NULLIF(COUNT(DISTINCT t.symbol), 0)
                , 1)                                                              AS win_rate
             FROM daily_universe_analysis d
             LEFT JOIN trade_decision_journal t
                ON  t.symbol         = d.symbol
                AND t.bot_type       = 'stock'
                AND t.decision_phase = 'CLOSED'
                AND t.pnl IS NOT NULL
                AND t.created_at BETWEEN d.analysis_date::timestamptz
                                     AND d.analysis_date::timestamptz + INTERVAL '3 days'
             WHERE d.analysis_date = CURRENT_DATE - $1::int
               AND d.passed_prescreen = true`,
            [lookbackDays]
        );
        const r = res.rows[0];
        if (!r) return null;
        const prescreenCount = parseInt(r.prescreen_count) || 0;
        const tradedCount    = parseInt(r.traded_count)    || 0;
        return {
            lookbackDays,
            prescreenCount,
            tradedCount,
            conversionRate: prescreenCount > 0
                ? Number(((tradedCount / prescreenCount) * 100).toFixed(1))
                : 0,
            avgPnl:  parseFloat(r.avg_pnl)  || 0,
            winRate: parseFloat(r.win_rate)  || 0,
        };
    } catch {
        return null;
    }
}

/**
 * Look up full scan details for a specific symbol on a given date.
 * Powers the "why was AMD excluded?" operator query.
 *
 * @param {string} symbol
 * @param {string} [date]  — YYYY-MM-DD, defaults to today ET
 */
async function getSymbolScanRecord(symbol, date) {
    try {
        // With explicit date: look up that specific scan. Without: use most recent scan within 4 days.
        const dateExpr = date ? `$2::date` : LATEST_DATE_SQL;
        const params = date
            ? [symbol.toUpperCase().trim(), date]
            : [symbol.toUpperCase().trim()];
        const res = await query(
            `SELECT symbol, analysis_date, ai_score, recommendation, setup_family,
                    sector, market_cap, passed_prescreen, exclusion_reason,
                    created_at, updated_at
             FROM daily_universe_analysis
             WHERE symbol = $1 AND analysis_date = ${dateExpr}`,
            params
        );
        return res.rows[0] || null;
    } catch {
        return null;
    }
}

module.exports = {
    isAvailable,
    loadCandidates,
    getDailyScanSummary,
    getExclusionSummary,
    getNewTickers,
    checkPrescreenDrift,
    getSymbolScanRecord
};
