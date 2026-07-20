const axios = require('axios');

const POLYGON_API_KEY = process.env.POLYGON_API_KEY || '';
const POLYGON_NEWS_URL = 'https://api.polygon.io/v2/reference/news';
const POLYGON_TIMEOUT_MS = 8000;

function isPolygonConfigured() {
    return !!POLYGON_API_KEY;
}

/**
 * Fetches recent news for a symbol from Polygon's reference news API.
 * Polygon already includes per-ticker sentiment ("insights") on each article,
 * but the caller runs its own text-based sentiment analysis uniformly across
 * all sources (Yahoo/Alpha Vantage/X) — the insight sentiment is carried
 * through as providedSentiment for parity with the Alpha Vantage source,
 * not treated as authoritative on its own.
 */
async function fetchPolygonNews(symbol, { limit = 10 } = {}) {
    if (!isPolygonConfigured()) return [];

    try {
        const response = await axios.get(POLYGON_NEWS_URL, {
            params: {
                ticker: symbol.toUpperCase(),
                limit,
                apiKey: POLYGON_API_KEY
            },
            timeout: POLYGON_TIMEOUT_MS
        });

        return response.data?.results || [];
    } catch (error) {
        console.warn(`[PolygonNews] Fetch failed for ${symbol}:`, error.message);
        return [];
    }
}

module.exports = { fetchPolygonNews, isPolygonConfigured };
