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
// Index symbols (^GSPC etc.) always fall back to Yahoo with 5-min in-memory cache
const _indexCache = new Map();
router.get('/quote/:symbol', noCache, async (req, res) => {
    try {
        const dataProvider = require('../services/dataProvider');
        const yfClient     = require('../utils/yfClient');
        const symbol = decodeURIComponent(req.params.symbol); // handles %5E → ^
        const isIndex = symbol.startsWith('^') || symbol.startsWith('=');

        let quote;
        if (isIndex) {
            // Use cached result for indices (5-min TTL) to avoid Yahoo 429s
            const cached = _indexCache.get(symbol);
            if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
                return res.json(cached.data);
            }

            // Map index symbols to Alpaca-tradeable ETF proxies for price data
            // ^GSPC → SPY, ^IXIC → QQQ, ^DJI → DIA
            const ETF_MAP = { '^GSPC': 'SPY', '^IXIC': 'QQQ', '^DJI': 'DIA' };
            const etfSymbol = ETF_MAP[symbol];

            let data;
            if (etfSymbol) {
                // Fetch ETF price from Alpaca (real-time) and scale to index level
                const INDEX_MULTIPLIER = { '^GSPC': 10, '^IXIC': 40, '^DJI': 76 }; // DIA ≈ DJIA/76
                const mult = INDEX_MULTIPLIER[symbol] || 1;
                const q = await dataProvider.getQuote(etfSymbol);
                data = {
                    symbol,
                    regularMarketPrice:         q.price           * mult,
                    regularMarketChange:        q.change          * mult,
                    regularMarketChangePercent: q.changePercent,
                    regularMarketVolume:        q.volume,
                    marketCap:                  0,
                    provider:                   `alpaca-via-${etfSymbol}`
                };
            } else {
                // Unknown index — try Yahoo with timeout
                try {
                    const yq = await Promise.race([
                        yfClient._raw.quote(symbol),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
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
                    data = { symbol, regularMarketPrice: 0, regularMarketChange: 0, regularMarketChangePercent: 0, provider: 'unavailable' };
                }
            }
            _indexCache.set(symbol, { data, ts: Date.now() });
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
