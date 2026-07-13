const express = require('express');
const router = express.Router();
const axios = require('axios');
const marketScreenerService = require('../services/marketScreenerService');
const { protect } = require('../middleware/authMiddleware');
const { query } = require('../config/database');
const { getCompanyNames, getCompanyInfoBatch } = require('../services/companyNameService');
const { getMarketStats } = require('../services/marketStatsService');

// All routes require authentication
router.use(protect);

// In-memory cache for /recent-earnings — Finnhub free tier is 60 calls/min, no need
// to hit it on every page load since earnings dates don't change intra-day (2026-07-13).
let _earningsCache = { data: null, fetchedAt: 0 };
const EARNINGS_CACHE_MS = 60 * 60 * 1000;

/** Adds name, marketCap, avgVolume3M, 52-week range/change, and a price sparkline to each row. */
async function enrichStocks(rows) {
    const symbols = rows.map(r => r.symbol);
    const [infoMap, statsMap] = await Promise.all([
        getCompanyInfoBatch(symbols),
        getMarketStats(symbols)
    ]);
    return rows.map(r => {
        const info = infoMap[r.symbol.toUpperCase()];
        const stats = statsMap[r.symbol] || {};
        return {
            ...r,
            // Not every ticker has a name/market cap in Polygon's reference data (a
            // handful of gaps found even for real, actively-traded stocks) — falls back
            // to the symbol / null rather than showing a blank or a wrong figure.
            name: info?.name || r.symbol,
            marketCap: info?.marketCap ?? null,
            avgVolume3M: stats.avgVolume3M ?? null,
            week52Low: stats.week52Low ?? null,
            week52High: stats.week52High ?? null,
            week52ChangePercent: stats.week52ChangePercent ?? null,
            sparkline: stats.sparkline || []
        };
    });
}

/**
 * GET /api/screener/most-active
 * Most-active-by-volume, from the same nightly universe scan the rest of the app already
 * uses (~556 tracked tickers) — not a separate external "most active" API, so this is
 * "most active among what we track," not literally the whole market. marketCap,
 * avgVolume3M, and 52-week stats are enriched in via enrichStocks() (Polygon reference +
 * daily_bars); AI score/recommendation are unique to this app. P/E ratio is deliberately
 * omitted — reconstructing it from Polygon's quarterly/annual EPS gave a value ~44% off
 * a known-good reference, and Yahoo's own pre-computed P/E hit 429s in testing, so
 * showing a P/E here would risk misleading a real trading decision (2026-07-13).
 */
router.get('/most-active', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
        const latestDate = await query(`SELECT MAX(analysis_date::date) AS d FROM daily_universe_analysis`);
        const scanDate = latestDate.rows[0]?.d;
        if (!scanDate) return res.json({ scanDate: null, stocks: [] });

        const result = await query(`
            SELECT symbol, sector, ai_score, recommendation,
                   (metadata->>'price')::numeric  AS price,
                   (metadata->>'change')::numeric  AS change_percent,
                   (metadata->>'volume')::numeric  AS volume
            FROM daily_universe_analysis
            WHERE analysis_date::date = $1
              AND metadata->>'volume' IS NOT NULL
              AND (metadata->>'volume')::numeric > 0
            ORDER BY (metadata->>'volume')::numeric DESC
            LIMIT $2
        `, [scanDate, limit]);

        const baseRows = result.rows.map(r => {
            const price = parseFloat(r.price) || 0;
            const changePercent = parseFloat(r.change_percent) || 0;
            const prevClose = changePercent !== -100 ? price / (1 + changePercent / 100) : price;
            const changeAmount = price - prevClose;
            return {
                symbol: r.symbol,
                sector: r.sector,
                aiScore: r.ai_score != null ? parseFloat(r.ai_score) : null,
                recommendation: r.recommendation,
                price,
                changeAmount: Number(changeAmount.toFixed(2)),
                changePercent: Number(changePercent.toFixed(2)),
                volume: parseInt(r.volume) || 0
            };
        });

        const stocks = await enrichStocks(baseRows);
        res.json({ scanDate, stocks });
    } catch (error) {
        console.error('[Screener API] most-active error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/screener/movers?type=top-gainers|top-losers|52w-gainers|52w-losers
 * Same tracked universe as /most-active, sorted a different way. The 52-week variants
 * join daily_bars for a ~year-ago close since daily_universe_analysis only carries the
 * latest scan's daily change — 539/556 tracked tickers have enough daily_bars history
 * for this (verified 2026-07-13); tickers without a year-old bar are simply excluded
 * rather than shown with a wrong/zero change.
 */
router.get('/movers', async (req, res) => {
    try {
        const type = req.query.type || 'top-gainers';
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
        const latestDate = await query(`SELECT MAX(analysis_date::date) AS d FROM daily_universe_analysis`);
        const scanDate = latestDate.rows[0]?.d;
        if (!scanDate) return res.json({ scanDate: null, type, stocks: [] });

        let rows;
        if (type === '52w-gainers' || type === '52w-losers') {
            const order = type === '52w-gainers' ? 'DESC' : 'ASC';
            const result = await query(`
                WITH latest_bar AS (
                    SELECT DISTINCT ON (symbol) symbol, close AS latest_close
                    FROM daily_bars
                    ORDER BY symbol, timestamp DESC
                ),
                year_ago_bar AS (
                    SELECT DISTINCT ON (symbol) symbol, close AS year_ago_close
                    FROM daily_bars
                    WHERE timestamp <= NOW() - INTERVAL '350 days'
                    ORDER BY symbol, timestamp DESC
                )
                SELECT u.symbol, u.sector, u.ai_score, u.recommendation,
                       (u.metadata->>'volume')::numeric AS volume,
                       lb.latest_close AS price, ya.year_ago_close,
                       ((lb.latest_close - ya.year_ago_close) / NULLIF(ya.year_ago_close, 0) * 100) AS change_52w
                FROM daily_universe_analysis u
                JOIN latest_bar lb ON lb.symbol = u.symbol
                JOIN year_ago_bar ya ON ya.symbol = u.symbol
                WHERE u.analysis_date::date = $1 AND ya.year_ago_close > 0
                ORDER BY change_52w ${order}
                LIMIT $2
            `, [scanDate, limit]);
            rows = result.rows.map(r => {
                const price = parseFloat(r.price) || 0;
                const yearAgoClose = parseFloat(r.year_ago_close) || 0;
                return {
                    symbol: r.symbol,
                    sector: r.sector,
                    aiScore: r.ai_score != null ? parseFloat(r.ai_score) : null,
                    recommendation: r.recommendation,
                    price,
                    changeAmount: Number((price - yearAgoClose).toFixed(2)),
                    changePercent: Number(parseFloat(r.change_52w).toFixed(2)),
                    volume: parseInt(r.volume) || 0
                };
            });
        } else {
            const order = type === 'top-losers' ? 'ASC' : 'DESC';
            const result = await query(`
                SELECT symbol, sector, ai_score, recommendation,
                       (metadata->>'price')::numeric  AS price,
                       (metadata->>'change')::numeric  AS change_percent,
                       (metadata->>'volume')::numeric  AS volume
                FROM daily_universe_analysis
                WHERE analysis_date::date = $1
                  AND metadata->>'change' IS NOT NULL
                ORDER BY (metadata->>'change')::numeric ${order}
                LIMIT $2
            `, [scanDate, limit]);
            rows = result.rows.map(r => {
                const price = parseFloat(r.price) || 0;
                const changePercent = parseFloat(r.change_percent) || 0;
                const prevClose = changePercent !== -100 ? price / (1 + changePercent / 100) : price;
                return {
                    symbol: r.symbol,
                    sector: r.sector,
                    aiScore: r.ai_score != null ? parseFloat(r.ai_score) : null,
                    recommendation: r.recommendation,
                    price,
                    changeAmount: Number((price - prevClose).toFixed(2)),
                    changePercent: Number(changePercent.toFixed(2)),
                    volume: parseInt(r.volume) || 0
                };
            });
        }

        const stocks = await enrichStocks(rows);
        res.json({ scanDate, type, stocks });
    } catch (error) {
        console.error('[Screener API] movers error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/screener/recent-earnings
 * Quarterly results reported in the last ~14 days for tickers in our tracked universe,
 * with actual-vs-estimate so a beat/miss is computable. Uses Finnhub's earnings calendar
 * (one date-range call covers everything) rather than the older per-symbol Yahoo
 * quoteSummary approach in earningsService.js, which is prone to 429 rate limits when
 * called across many tickers (2026-07-13).
 */
router.get('/recent-earnings', async (req, res) => {
    try {
        const now = Date.now();
        let calendar;
        if (_earningsCache.data && (now - _earningsCache.fetchedAt) < EARNINGS_CACHE_MS) {
            calendar = _earningsCache.data;
        } else {
            const key = process.env.FINNHUB_KEY;
            const to = new Date().toISOString().slice(0, 10);
            const from = new Date(now - 14 * 86400000).toISOString().slice(0, 10);
            const resp = await axios.get('https://finnhub.io/api/v1/calendar/earnings', {
                params: { from, to, token: key },
                timeout: 8000
            });
            calendar = resp.data?.earningsCalendar || [];
            _earningsCache = { data: calendar, fetchedAt: now };
        }

        const universeResult = await query(`
            SELECT DISTINCT symbol FROM daily_universe_analysis
            WHERE analysis_date::date = (SELECT MAX(analysis_date::date) FROM daily_universe_analysis)
        `);
        const universeSet = new Set(universeResult.rows.map(r => r.symbol));

        const reported = calendar
            .filter(e => e.epsActual !== null && e.epsActual !== undefined && universeSet.has(e.symbol))
            .sort((a, b) => new Date(b.date) - new Date(a.date));

        const names = await getCompanyNames(reported.map(e => e.symbol));

        const results = reported.map(e => {
            const epsSurprisePercent = e.epsEstimate ? ((e.epsActual - e.epsEstimate) / Math.abs(e.epsEstimate)) * 100 : null;
            return {
                symbol: e.symbol,
                name: names[e.symbol.toUpperCase()] || e.symbol,
                date: e.date,
                quarter: e.quarter,
                year: e.year,
                epsActual: e.epsActual,
                epsEstimate: e.epsEstimate,
                epsSurprisePercent: epsSurprisePercent != null ? Number(epsSurprisePercent.toFixed(1)) : null,
                revenueActual: e.revenueActual,
                revenueEstimate: e.revenueEstimate,
                beat: epsSurprisePercent != null ? epsSurprisePercent > 0 : null
            };
        });

        res.json({ results });
    } catch (error) {
        console.error('[Screener API] recent-earnings error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/screener/universe
 * Get all stocks with market cap > $2B
 */
router.get('/universe', async (req, res) => {
    try {
        const universe = await marketScreenerService.getStockUniverse();
        res.json({
            count: universe.length,
            stocks: universe,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('[Screener API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/screener/sector/:sector
 * Get stocks by sector
 */
router.get('/sector/:sector', async (req, res) => {
    try {
        const { sector } = req.params;
        const stocks = await marketScreenerService.getStocksBySector(sector);
        res.json({
            sector,
            count: stocks.length,
            stocks
        });
    } catch (error) {
        console.error('[Screener API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/screener/liquid
 * Get top liquid stocks for options trading
 */
router.get('/liquid', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const stocks = await marketScreenerService.getTopLiquidStocks(limit);
        res.json({
            count: stocks.length,
            stocks
        });
    } catch (error) {
        console.error('[Screener API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/screener/refresh
 * Manually refresh stock universe cache
 */
router.post('/refresh', async (req, res) => {
    try {
        marketScreenerService.refreshCache();
        res.json({ 
            success: true, 
            message: 'Cache cleared, will refresh on next request' 
        });
    } catch (error) {
        console.error('[Screener API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
