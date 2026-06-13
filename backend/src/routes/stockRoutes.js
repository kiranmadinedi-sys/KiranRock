const express = require('express');
const { getStockData, getAvailableStocks, searchStocks, addStockSymbol, getStockPrice } = require('../controllers/stockController');
const { protect } = require('../middleware/authMiddleware');
const router = express.Router();

// Middleware to disable caching
const noCache = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
};


// router.get('/symbols', protect, getAvailableStocks);
// router.post('/symbols', protect, addStockSymbol);
// router.get('/search', protect, searchStocks);
// router.get('/:symbol', protect, getStockData);
// router.get('/price/:symbol', protect, getStockPrice);

const { removeStockSymbol } = require('../controllers/stockController');
router.delete('/symbols/:symbol', removeStockSymbol);

// Real-time quote endpoint — routes through active dataProvider (Alpaca/Yahoo)
// Index symbols (^GSPC etc.) use ETF proxies with 15-min cache + stale-while-revalidate
const _indexCache      = new Map();
const ETF_MAP          = { '^GSPC': 'SPY', '^IXIC': 'QQQ', '^DJI': 'DIA' };
const INDEX_MULTIPLIER = { '^GSPC': 10,   '^IXIC': 40,    '^DJI': 76   }; // DIA ≈ DJIA/76
const INDEX_CACHE_MS   = 15 * 60 * 1000; // 15-min TTL — index values don't need real-time freshness
const INDEX_FAIL_MS    =  2 * 60 * 1000; // on fetch failure, retry after 2 min to prevent hammering

router.get('/quote/:symbol', noCache, async (req, res) => {
    try {
        const dataProvider = require('../services/dataProvider');
        const yfClient     = require('../utils/yfClient');
        const symbol = decodeURIComponent(req.params.symbol); // handles %5E → ^
        const isIndex = symbol.startsWith('^') || symbol.startsWith('=');

        let quote;
        if (isIndex) {
            const cached = _indexCache.get(symbol);
            const cacheTTL = cached?.isFail ? INDEX_FAIL_MS : INDEX_CACHE_MS;
            if (cached && (Date.now() - cached.ts) < cacheTTL) {
                return res.json(cached.data);
            }

            const etfSymbol = ETF_MAP[symbol];
            let data;
            let fetchFailed = false;

            if (etfSymbol) {
                // Fetch ETF proxy with a hard 5-second timeout.
                // Without this, a failing Polygon/Yahoo call hangs for 11+ seconds (3-retry backoff).
                try {
                    const mult = INDEX_MULTIPLIER[symbol] || 1;
                    const q = await Promise.race([
                        dataProvider.getQuote(etfSymbol),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('index-timeout')), 5000))
                    ]);
                    data = {
                        symbol,
                        regularMarketPrice:         q.price           * mult,
                        regularMarketChange:        q.change          * mult,
                        regularMarketChangePercent: q.changePercent,
                        regularMarketVolume:        q.volume,
                        marketCap:                  0,
                        provider:                   `etf-proxy-${etfSymbol}`
                    };
                } catch {
                    fetchFailed = true;
                    // Serve stale cache on failure rather than a blank 500
                    if (cached) return res.json(cached.data);
                    data = { symbol, regularMarketPrice: 0, regularMarketChange: 0, regularMarketChangePercent: 0, provider: 'unavailable' };
                }
            } else {
                // Unknown index — try Yahoo with a 3-second timeout (single attempt, no retry cascade)
                try {
                    const yq = await Promise.race([
                        yfClient._raw.quote(symbol),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('index-timeout')), 3000))
                    ]);
                    data = {
                        symbol,
                        regularMarketPrice:         yq.regularMarketPrice         || 0,
                        regularMarketChange:        yq.regularMarketChange        || 0,
                        regularMarketChangePercent: yq.regularMarketChangePercent || 0,
                        regularMarketVolume:        yq.regularMarketVolume        || 0,
                        marketCap:                  0,
                        provider:                   'yahoo'
                    };
                } catch {
                    fetchFailed = true;
                    if (cached) return res.json(cached.data);
                    data = { symbol, regularMarketPrice: 0, regularMarketChange: 0, regularMarketChangePercent: 0, provider: 'unavailable' };
                }
            }
            // isFail=true uses INDEX_FAIL_MS TTL (2 min) to retry sooner; success uses INDEX_CACHE_MS (15 min)
            _indexCache.set(symbol, { data, ts: Date.now(), isFail: fetchFailed });
            return res.json(data);
        }

        quote = await dataProvider.getQuote(symbol);
        res.json({
            symbol:                     quote.symbol,
            regularMarketPrice:         quote.price,
            regularMarketChange:        quote.change,
            regularMarketChangePercent: quote.changePercent,
            regularMarketVolume:        quote.volume,
            marketCap:                  quote.marketCap,
            provider:                   dataProvider.providerKey
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Temporarily disable auth for testing
router.get('/symbols', noCache, getAvailableStocks);
router.post('/symbols', addStockSymbol);
router.get('/search', noCache, searchStocks);
router.get('/:symbol', noCache, getStockData);
router.get('/price/:symbol', noCache, getStockPrice);

module.exports = router;
