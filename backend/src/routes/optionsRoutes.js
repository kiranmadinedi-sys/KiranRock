const express = require('express');
const router = express.Router();
const optionsService = require('../services/optionsService');
const optionsScheduler = require('../services/optionsScheduler');
const { protect } = require('../middleware/authMiddleware');
const YahooFinance = require('yahoo-finance2').default;
const dataProvider = require('../services/dataProvider');
const axios = require('axios');
const { logger } = require('../utils/logger');

const ALPACA_DATA = 'https://data.alpaca.markets';
const ALPACA_TRADE = 'https://paper-api.alpaca.markets';   // contracts list is the same on paper
const alpacaHeaders = () => ({ 'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY });
const dateTs = d => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);

/**
 * Chain for one expiration from Alpaca (2026-11-12). Contracts list → expirations + open interest;
 * snapshots → bid/ask/last/volume/IV. `expiration` is unix seconds of the date (UTC midnight).
 */
async function alpacaChain(symbol, expiration) {
    const today = new Date().toISOString().slice(0, 10);
    const contracts = [];
    let page_token;
    for (let i = 0; i < 5; i++) {
        const r = await axios.get(`${ALPACA_TRADE}/v2/options/contracts`, {
            headers: alpacaHeaders(), timeout: 15000,
            params: { underlying_symbols: symbol, expiration_date_gte: today, status: 'active', limit: 10000, page_token } });
        contracts.push(...(r.data?.option_contracts || []));
        page_token = r.data?.next_page_token;
        if (!page_token) break;
    }
    const dates = [...new Set(contracts.map(c => c.expiration_date))].sort();
    if (!dates.length) return null;
    const wanted = expiration ? new Date(expiration * 1000).toISOString().slice(0, 10) : null;
    const sel = dates.includes(wanted) ? wanted : dates[0];

    const snaps = {};
    page_token = undefined;
    for (let i = 0; i < 5; i++) {
        const r = await axios.get(`${ALPACA_DATA}/v1beta1/options/snapshots/${symbol}`, {
            headers: alpacaHeaders(), timeout: 15000,
            params: { feed: 'indicative', expiration_date: sel, limit: 1000, page_token } });
        Object.assign(snaps, r.data?.snapshots || {});
        page_token = r.data?.next_page_token;
        if (!page_token) break;
    }
    const px = await axios.get(`${ALPACA_DATA}/v2/stocks/${symbol}/trades/latest`, { headers: alpacaHeaders(), params: { feed: 'iex' }, timeout: 15000 })
        .then(r => r.data?.trade?.p || null).catch(() => null);

    const calls = [], puts = [];
    for (const c of contracts.filter(x => x.expiration_date === sel)) {
        const s = snaps[c.symbol] || {};
        const strike = Number(c.strike_price);
        const last = s.latestTrade?.p || Number(c.close_price) || 0;
        const prev = s.prevDailyBar?.c;
        const row = {
            strike, bid: s.latestQuote?.bp || 0, ask: s.latestQuote?.ap || 0, lastPrice: last,
            volume: s.dailyBar?.v || 0, openInterest: Number(c.open_interest) || 0,
            impliedVolatility: s.impliedVolatility || 0,
            inTheMoney: px ? (c.type === 'call' ? strike < px : strike > px) : false,
            change: prev && last ? last - prev : 0, percentChange: prev && last ? (last / prev - 1) * 100 : 0,
            type: c.type,
        };
        (c.type === 'call' ? calls : puts).push(row);
    }
    calls.sort((a, b) => a.strike - b.strike); puts.sort((a, b) => a.strike - b.strike);
    return { symbol, stockPrice: px, expirationDates: dates.map(d => ({ timestamp: dateTs(d), date: d })),
             selectedExpiration: dateTs(sel), calls, puts, source: 'live', provider: 'alpaca (indicative)' };
}

// All routes require authentication. Re-enabled 2026-11-12 — it had been commented out "for
// local dev", leaving POST /scan and the rest open to anyone through the public tunnel.
router.use(protect);

/**
 * GET /api/options/chain?symbol=AAPL&expiration=<unix_seconds>
 * Full options chain viewer endpoint — returns expiration dates + calls/puts for one expiration.
 * Tries Yahoo Finance first (single call = no rate limit cascade), falls back to DB cache.
 */
router.get('/chain', async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase().trim();
    const expiration = req.query.expiration ? Number(req.query.expiration) : null;

    if (!symbol) return res.status(400).json({ error: 'symbol query param required' });

    const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

    const toContract = (c, type) => ({
        strike:            Number(c.strike || 0),
        bid:               Number(c.bid || 0),
        ask:               Number(c.ask || 0),
        lastPrice:         Number(c.lastPrice || 0),
        volume:            Number(c.volume || 0),
        openInterest:      Number(c.openInterest || 0),
        impliedVolatility: Number(c.impliedVolatility || 0),
        inTheMoney:        Boolean(c.inTheMoney),
        change:            Number(c.change || 0),
        percentChange:     Number(c.percentChange || 0),
        type
    });

    // 2026-11-12: Alpaca first. Yahoo has been 429-blocked for months, so the page only ever
    // showed "Options data temporarily unavailable". Same indicative feed the put bot uses.
    try {
        const alp = await alpacaChain(symbol, expiration);
        if (alp && (alp.calls.length + alp.puts.length) > 0) return res.json(alp);
    } catch (err) {
        logger.warn('[OptionsChain] Alpaca chain failed — trying Yahoo', { symbol, error: err.response?.data?.message || err.message });
    }

    try {
        // Single initial call — returns expiration list + nearest-expiration contracts
        const base = await yf.options(symbol);
        const expirationDates = (base.expirationDates || []).map(ts => ({
            timestamp: ts,
            date: new Date(ts * 1000).toISOString().split('T')[0]
        }));

        let selectedChain = base;
        let selectedTs = expirationDates[0]?.timestamp;
        if (expiration && expirationDates.some(e => e.timestamp === expiration)) {
            selectedChain = await yf.options(symbol, { date: expiration });
            selectedTs = expiration;
        }

        const stockPrice = base.quote?.regularMarketPrice || null;
        const calls = (selectedChain.calls || []).map(c => toContract(c, 'call'));
        const puts  = (selectedChain.puts  || []).map(c => toContract(c, 'put'));

        // Persist to local history whenever we get live data (user-initiated fetches
        // also build our long-term options dataset)
        const selectedDate = expirationDates.find(e => e.timestamp === selectedTs)?.date;
        if (selectedDate && (calls.length + puts.length > 0)) {
            const histContracts = [
                ...calls.map(c => ({ ...c, optionType: 'call', strikePrice: c.strike, expirationDate: selectedDate, daysToExpiration: Math.max(1, Math.ceil((new Date(selectedDate) - new Date()) / 86400000)) })),
                ...puts.map(c =>  ({ ...c, optionType: 'put',  strikePrice: c.strike, expirationDate: selectedDate, daysToExpiration: Math.max(1, Math.ceil((new Date(selectedDate) - new Date()) / 86400000)) }))
            ];
            optionsService.saveOptionsToDB(symbol, { stockPrice, options: histContracts })
                .catch(() => {}); // fire-and-forget, don't delay the response
        }

        return res.json({
            symbol,
            stockPrice,
            expirationDates,
            selectedExpiration: selectedTs,
            calls,
            puts,
            source: 'live'
        });
    } catch (liveErr) {
        // Fall back to DB cache
        try {
            const cached = await optionsService.getOptionsWithGreeks(symbol);
            if (cached.options && cached.options.length > 0) {
                const byExp = {};
                for (const o of cached.options) {
                    if (!byExp[o.expirationDate]) byExp[o.expirationDate] = { calls: [], puts: [] };
                    byExp[o.expirationDate][o.optionType === 'call' ? 'calls' : 'puts'].push({
                        strike:            o.strikePrice,
                        bid:               o.bid,
                        ask:               o.ask,
                        lastPrice:         o.lastPrice || 0,
                        volume:            o.volume,
                        openInterest:      o.openInterest,
                        impliedVolatility: o.impliedVolatility,
                        inTheMoney:        cached.stockPrice
                            ? (o.optionType === 'call' ? o.strikePrice < cached.stockPrice : o.strikePrice > cached.stockPrice)
                            : false,
                        change: 0, percentChange: 0, type: o.optionType
                    });
                }
                const expDates = Object.keys(byExp).sort().map(d => ({ timestamp: null, date: d }));
                const sel = expDates[0]?.date;
                return res.json({
                    symbol,
                    stockPrice: cached.stockPrice,
                    expirationDates: expDates,
                    selectedExpiration: sel,
                    calls: byExp[sel]?.calls || [],
                    puts:  byExp[sel]?.puts  || [],
                    source: 'cache',
                    warning: 'Live data unavailable — showing cached data'
                });
            }
        } catch (_) { /* ignore cache error */ }

        return res.status(503).json({
            error: 'Options data temporarily unavailable',
            details: liveErr.message,
            suggestion: 'Upgrade Polygon subscription to include Options tier for reliable data'
        });
    }
});

/**
 * GET /api/options/:symbol
 * Get options chain with Greeks for a symbol
 */
router.get('/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const data = await optionsService.getOptionsWithGreeks(symbol.toUpperCase());
        
        // Service now returns graceful errors instead of throwing
        // Always return 200 with the data object (which may contain an error field)
        res.json(data);
    } catch (error) {
        console.error('[Options API] Error:', error);
        res.status(500).json({ 
            symbol: req.params.symbol,
            error: error.message,
            options: []
        });
    }
});

/**
 * POST /api/options/opportunities
 * Find options opportunities based on criteria
 * Body: { symbol, criteria: { minDelta, maxDelta, ... } }
 */
router.post('/opportunities', async (req, res) => {
    try {
        const { symbol, criteria } = req.body;
        
        if (!symbol) {
            return res.status(400).json({ error: 'Symbol is required' });
        }
        
        const opportunities = await optionsService.findOptionsOpportunities(symbol.toUpperCase(), criteria || {});
        res.json({ symbol, count: opportunities.length, opportunities });
    } catch (error) {
        console.error('[Options API] Opportunities error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/options/scan
 * Manual trigger for options scan
 */
router.post('/scan', async (req, res) => {
    try {
        const { scanTime } = req.body;
        const results = await optionsScheduler.manualScan(scanTime || 'manual');
        res.json({ scannedAt: new Date().toISOString(), count: results.length, results });
    } catch (error) {
        console.error('[Options API] Scan error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/options/alerts/list
 * Get options alerts
 */
router.get('/alerts/list', async (req, res) => {
    try {
        const { symbol, severity, unreadOnly, scanTime, limit } = req.query;
        
        const filters = {
            symbol,
            severity,
            unreadOnly: unreadOnly === 'true',
            scanTime,
            limit: limit ? parseInt(limit) : undefined
        };
        
        const alerts = await optionsScheduler.getOptionsAlerts(filters);
        res.json(alerts);
    } catch (error) {
        console.error('[Options API] Alerts error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/options/alerts/:id/read
 * Mark alert as read
 */
router.put('/alerts/:id/read', async (req, res) => {
    try {
        const { id } = req.params;
        const alert = await optionsScheduler.markAlertAsRead(id);
        res.json(alert);
    } catch (error) {
        console.error('[Options API] Mark read error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
