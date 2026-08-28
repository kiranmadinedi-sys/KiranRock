/**
 * Dynamic Universe Service — Pre-Market Universe Builder
 *
 * Builds a fresh stock universe BEFORE market open (8:45 AM ET) from 4 sources:
 *   1. Static 244-symbol list     — always included, zero API calls
 *   2. DB-backed asset universe   — Alpaca-sourced, zero API calls
 *   3. Velocity: trending/gainers — Yahoo screeners (pre-market only)
 *   4. Gap scan: pre-mkt movers   — Yahoo pre_market_gainers (pre-market only)
 *
 * During market hours getScanUniverse() returns the cached stock objects with
 * zero API calls. The trading bot reads this instead of calling HERMES
 * (getStockUniverse), which queries Yahoo for 500+ symbols per scan cycle —
 * the root cause of OOM errors and rate-limit storms during market hours.
 *
 * Cache: in-memory, expires at midnight ET (one build per trading day).
 */

const { logger } = require('../utils/logger');
const fs         = require('fs');
const path       = require('path');

const STATIC_SYMBOLS = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, '../../static-major-us-tickers.json'), 'utf8'));
    } catch {
        return [];
    }
})();

const TIER1_ETFS = new Set([
    'SPY','QQQ','IWM','DIA','MDY',
    'XLK','XLF','XLE','XLV','XLI','XLB','XLU','XLP','XLY',
    'SMH','SOXX','ARKK','ARKG','ARKF',
    'GLD','TLT','HYG','LQD','TQQQ','SOXL',
]);

// ── Cache ─────────────────────────────────────────────────────────────────────
let _universeCache   = null;
let _cacheDate       = null;   // YYYY-MM-DD string — one build per calendar day
let _buildInProgress = false;

// ── Intraday refresh state ────────────────────────────────────────────────────
const INTRADAY_COOLDOWN_MS = 75 * 60 * 1000; // 75 min between refreshes
const INTRADAY_MAX_ADDS    = 20;              // max new symbols per refresh cycle
let   _lastIntradayRefresh = 0;

function _isMarketHours() {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const t  = et.getHours() * 60 + et.getMinutes();
    const d  = et.getDay();
    return d >= 1 && d <= 5 && t >= 9 * 60 + 30 && t < 16 * 60;
}

function _todayET() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ── DB quote cache ────────────────────────────────────────────────────────────

/**
 * Load yesterday's (and today's partial) asset_universe_daily into a Map.
 * Used to skip Yahoo quote calls for symbols whose marketCap is already known.
 * Only symbols with a real marketCap are included — stale/null rows are excluded.
 */
async function _loadDbQuoteCache() {
    try {
        const { query } = require('../config/database');
        const today     = _todayET();
        const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

        const result = await query(`
            SELECT symbol, price, market_cap, avg_volume, rs_score, universe_date
            FROM asset_universe_daily
            WHERE universe_date IN ($1, $2)
              AND market_cap IS NOT NULL AND market_cap > 0
            ORDER BY universe_date DESC
        `, [today, yesterday]);

        const map = new Map();
        for (const row of result.rows) {
            if (!map.has(row.symbol)) {
                map.set(row.symbol, {
                    price:     parseFloat(row.price     || 0) || null,
                    marketCap: parseInt(row.market_cap  || 0) || 0,
                    avgVolume: parseInt(row.avg_volume  || 0) || 0,
                    rsScore:   parseFloat(row.rs_score  || 0.5),
                });
            }
        }
        logger.info('[DynamicUniverse] DB quote cache loaded', { symbols: map.size });
        return map;
    } catch (err) {
        logger.warn('[DynamicUniverse] DB quote cache load failed', { error: err.message });
        return new Map();
    }
}

/**
 * One-shot Alpaca batch snapshot for a list of symbols.
 * Returns a Map of symbol → { price, volume, change, changePercent }.
 * Falls back to empty Map if Alpaca keys are missing or the call fails.
 * Used to enrich DB-cached symbols with live market data without any Yahoo calls.
 */
async function _batchAlpacaSnapshots(symbols) {
    const map = new Map();
    if (!symbols || symbols.length === 0) return map;

    const KEY_ID = process.env.ALPACA_KEY_ID;
    const SECRET = process.env.ALPACA_SECRET_KEY;
    if (!KEY_ID || !SECRET) return map;

    try {
        const Alpaca = require('@alpacahq/alpaca-trade-api');
        const client = new Alpaca({
            keyId:     KEY_ID,
            secretKey: SECRET,
            paper:     process.env.ALPACA_PAPER !== 'false',
            feed:      'iex',
        });

        const CHUNK = 500;
        for (let i = 0; i < symbols.length; i += CHUNK) {
            const chunk = symbols.slice(i, i + CHUNK);
            const snaps = await client.getSnapshots(chunk);
            for (const snap of (Array.isArray(snaps) ? snaps : [])) {
                const s = snap.symbol || snap.Symbol;
                if (!s) continue;
                const t = snap.latestTrade  || snap.LatestTrade  || {};
                const d = snap.dailyBar     || snap.DailyBar     || {};
                const p = snap.prevDailyBar || snap.PrevDailyBar || {};
                const price    = t.Price || d.ClosePrice || 0;
                const prevClose = p.ClosePrice || d.OpenPrice || price;
                map.set(s, {
                    price:         price || null,
                    volume:        d.Volume || 0,
                    change:        price && prevClose ? price - prevClose : 0,
                    changePercent: price && prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
                });
            }
        }
        logger.info('[DynamicUniverse] Alpaca batch snapshot complete', { requested: symbols.length, received: map.size });
    } catch (err) {
        logger.warn('[DynamicUniverse] Alpaca batch snapshot failed — DB-cache symbols will use stale price/volume', { error: err.message });
    }
    return map;
}

/**
 * Persist the built universe to asset_universe_daily so tomorrow's build can
 * skip Yahoo calls for these symbols (warm-start pattern).
 */
async function _persistBuiltUniverse(stocks) {
    if (!stocks || stocks.length === 0) return;
    try {
        const { addDynamicSymbol } = require('./assetUniverseService');
        await Promise.allSettled(stocks.map(s =>
            addDynamicSymbol(s.symbol,
                s.isVelocity ? 'velocity' : (s.isETF ? 'etf' : 'master'),
                { price: s.price, marketCap: s.marketCap, avgVolume: s.avgVolume, rsScore: s.rsScore, volume: s.volume }
            )
        ));
        logger.info('[DynamicUniverse] Universe persisted to asset_universe_daily', { count: stocks.length });
    } catch (err) {
        logger.warn('[DynamicUniverse] Persist to DB failed', { error: err.message });
    }
}

// ── Symbol collection ─────────────────────────────────────────────────────────

async function _getDbSymbols() {
    try {
        const assetUniverseService = require('./assetUniverseService');
        return await assetUniverseService.getDailyUniverseSymbols();
    } catch {
        return [];
    }
}

async function _getVelocityAndGapSymbols() {
    const symbols = new Set();
    try {
        const YahooFinance = require('yahoo-finance2').default;
        const yf           = new YahooFinance();
        const rateLimiter  = require('../utils/yahooFinanceRateLimiter');

        const screeners = [
            { id: 'day_gainers',          count: 40 },
            { id: 'most_actives',         count: 40 },
            { id: 'pre_market_gainers',   count: 30 },
        ];

        const trendingP = rateLimiter.execute(() =>
            yf.trendingSymbols('US', { count: 40 })
        ).catch(() => ({ quotes: [] }));

        const screenerPs = screeners.map(s =>
            rateLimiter.execute(() =>
                yf.screener({ scrIds: s.id, count: s.count })
            ).catch(() => ({ quotes: [] }))
        );

        const [trending, ...screenerResults] = await Promise.all([trendingP, ...screenerPs]);

        const addBatch = (result) => {
            (result?.quotes || []).forEach(q => {
                const s = (q.symbol || '').toUpperCase();
                if (s && /^[A-Z]{1,5}$/.test(s)) symbols.add(s);
            });
        };
        addBatch(trending);
        screenerResults.forEach(addBatch);

        logger.info('[DynamicUniverse] Velocity+gap symbols fetched', { count: symbols.size });
    } catch (err) {
        logger.warn('[DynamicUniverse] Velocity fetch error', { error: err.message });
    }
    return symbols;
}

// ── Main build ─────────────────────────────────────────────────────────────────

/**
 * Build the pre-market universe cache.
 * Should be called once at 8:45 AM ET from the scheduler.
 * Safe to call manually (e.g., after a server restart during pre-market hours).
 */
async function buildPreMarketCache() {
    if (_buildInProgress) {
        logger.info('[DynamicUniverse] Build already in progress — skipping duplicate call');
        return;
    }
    _buildInProgress = true;
    const t0 = Date.now();

    try {
        logger.info('[DynamicUniverse] Pre-market universe build starting');

        // Phase 1: Gather all candidate symbols (mostly zero API calls)
        const [dbSymbols, velocitySymbols, dbQuoteCache] = await Promise.all([
            _getDbSymbols(),
            _getVelocityAndGapSymbols(),
            _loadDbQuoteCache(),
        ]);

        const symbolSet = new Set([
            ...STATIC_SYMBOLS,
            ...dbSymbols,
            ...velocitySymbols,
        ]);
        const allSymbols = [...symbolSet].filter(s => /^[A-Z]{1,6}$/.test(s));

        logger.info('[DynamicUniverse] Symbol pool assembled', {
            static:   STATIC_SYMBOLS.length,
            db:       dbSymbols.length,
            velocity: velocitySymbols.size,
            combined: allSymbols.length,
        });

        // Phase 2: Fetch quotes for all symbols in batches (pre-market — no market-hours load)
        const YahooFinance = require('yahoo-finance2').default;
        const yf           = new YahooFinance();
        const rateLimiter  = require('../utils/yahooFinanceRateLimiter');
        const { passesQuickFilter, computeRS } = require('./marketScreenerService');

        const MIN_MARKET_CAP = parseInt(process.env.HERMES_MIN_MARKET_CAP   || '2000000000', 10);
        const MIN_AVG_VOLUME = parseInt(process.env.HERMES_MIN_AVG_VOLUME   || '300000',     10);
        const MAX_STOCKS     = parseInt(process.env.DYNAMIC_UNIVERSE_MAX    || '400',        10);
        const FALLBACK_CAP   = 10_000_000_000;
        const BATCH_SIZE     = 5;
        const BATCH_DELAY_MS = 2000;

        // Phase 2a: Batch-fetch live price/volume from Alpaca for all DB-cache candidates.
        // One HTTP call instead of N Yahoo calls — DB provides marketCap, Alpaca provides
        // live price and today's volume so the quality filters see current data.
        const dbCandidates  = allSymbols.filter(s =>
            !TIER1_ETFS.has(s) && !velocitySymbols.has(s) &&
            dbQuoteCache.has(s) && (dbQuoteCache.get(s).marketCap || 0) > 0
        );
        const alpacaSnapMap = await _batchAlpacaSnapshots(dbCandidates);

        const qualified = [];
        let dbHits = 0, yahooFetches = 0;

        for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
            const batch = allSymbols.slice(i, i + BATCH_SIZE);
            let batchYahooCalls = 0;
            const results = await Promise.allSettled(
                batch.map(async (symbol) => {
                    const isETF  = TIER1_ETFS.has(symbol);
                    const isVel  = velocitySymbols.has(symbol);
                    const tier   = isETF ? 1 : (isVel ? 3 : 2);

                    // DB cache hit: use yesterday's data for non-velocity static symbols.
                    // Velocity symbols always get a fresh Yahoo call — they're new discoveries
                    // and their momentum metrics must be current.
                    if (!isETF && !isVel && dbQuoteCache.has(symbol)) {
                        const cached = dbQuoteCache.get(symbol);
                        if (cached.marketCap > 0) {
                            dbHits++;
                            if (cached.marketCap < MIN_MARKET_CAP) return null;
                            if (cached.avgVolume < MIN_AVG_VOLUME) return null;
                            // Enrich with live Alpaca data — live price + today's volume
                            const live   = alpacaSnapMap.get(symbol) || {};
                            const price  = live.price  != null ? live.price  : cached.price;
                            const volume = live.volume != null ? live.volume : 0;
                            const stock = {
                                symbol,
                                marketCap:           cached.marketCap,
                                marketCapFormatted:  String(cached.marketCap),
                                price,
                                volume,
                                avgVolume:           cached.avgVolume,
                                week52High:          null,
                                week52Low:           null,
                                sma50:               null,
                                sma200:              null,
                                sector:              'Unknown',
                                industry:            'Unknown',
                                rsScore:             cached.rsScore,
                                isVelocity:          false,
                                isETF:               false,
                                isSpeculative:       false,
                                daysToEarnings:      null,
                                tier,
                            };
                            if (!passesQuickFilter(stock)) return null;
                            return stock;
                        }
                    }

                    // Live Yahoo fetch — ETFs, velocity stocks, or DB-cache misses
                    try {
                        yahooFetches++;
                        batchYahooCalls++;
                        const quote      = await rateLimiter.execute(() => yf.quote(symbol));
                        const marketCap  = quote.marketCap || 0;
                        const avgVol     = quote.averageDailyVolume3Month || quote.regularMarketVolume || 0;
                        const price      = quote.regularMarketPrice || null;

                        if (!isETF) {
                            const capFloor = isVel ? 300_000_000 : MIN_MARKET_CAP;
                            if (marketCap > 0 && marketCap < capFloor) return null;
                            const volFloor = isVel ? 100_000 : MIN_AVG_VOLUME;
                            if (avgVol < volFloor) return null;
                        }

                        const stock = {
                            symbol,
                            marketCap:           marketCap  || (isETF ? 1e12 : FALLBACK_CAP),
                            marketCapFormatted:  String(marketCap || ''),
                            price,
                            volume:              quote.regularMarketVolume || 0,
                            avgVolume:           avgVol,
                            week52High:          quote.fiftyTwoWeekHigh   || null,
                            week52Low:           quote.fiftyTwoWeekLow    || null,
                            sma50:               quote.fiftyDayAverage    || null,
                            sma200:              quote.twoHundredDayAverage || null,
                            sector:              quote.sector   || 'Unknown',
                            industry:            quote.industry || 'Unknown',
                            rsScore:             computeRS(quote),
                            isVelocity:          isVel,
                            isETF,
                            isSpeculative:       false,
                            daysToEarnings:      null,
                            tier,
                        };

                        if (!passesQuickFilter(stock)) return null;
                        return stock;
                    } catch {
                        // For static symbols, return a minimal placeholder so they aren't silently lost
                        if (STATIC_SYMBOLS.includes(symbol)) {
                            return {
                                symbol,
                                marketCap:          FALLBACK_CAP,
                                marketCapFormatted: '',
                                price: null, volume: 0, avgVolume: 0,
                                week52High: null, week52Low: null,
                                sma50: null, sma200: null,
                                sector: 'Unknown', industry: 'Unknown',
                                rsScore: 0.5,
                                isVelocity: false, isETF, isSpeculative: false,
                                daysToEarnings: null, tier,
                            };
                        }
                        return null;
                    }
                })
            );

            results.forEach(r => {
                if (r.status === 'fulfilled' && r.value) qualified.push(r.value);
            });

            // Only delay when this batch had actual Yahoo fetches (DB-only batches need no rate-limit pause)
            if (i + BATCH_SIZE < allSymbols.length && batchYahooCalls > 0) {
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
            }
        }

        logger.info('[DynamicUniverse] Quote resolution complete', { dbHits, yahooFetches });

        // Sort: tier first (ETFs → mega-caps → velocity), then RS score
        qualified.sort((a, b) => {
            if (a.tier !== b.tier) return a.tier - b.tier;
            return b.rsScore - a.rsScore;
        });

        const capped = qualified.slice(0, MAX_STOCKS);

        _universeCache = capped;
        _cacheDate     = _todayET();

        logger.info('[DynamicUniverse] Pre-market cache ready', {
            candidates:   allSymbols.length,
            qualified:    qualified.length,
            cached:       capped.length,
            velocity:     capped.filter(s => s.isVelocity).length,
            etfs:         capped.filter(s => s.isETF).length,
            dbHits,
            yahooFetches,
            ms:           Date.now() - t0,
        });

        // Persist to asset_universe_daily so tomorrow's build uses DB data
        // (fire-and-forget — don't block cache readiness)
        _persistBuiltUniverse(capped).catch(() => {});

    } catch (err) {
        logger.error('[DynamicUniverse] Build failed', { error: err.message });
    } finally {
        _buildInProgress = false;
    }
}

/**
 * Lightweight intraday refresh — merges ≤20 top movers/unusual-volume symbols
 * into the live in-memory cache. Only fires during market hours, max once per 75 min.
 * Called by the scheduler (not the hot scan path).
 */
async function refreshIntradayMovers() {
    if (!isCacheReady())    return { skipped: 'no_cache' };
    if (!_isMarketHours())  return { skipped: 'outside_market_hours' };

    const now = Date.now();
    if (now - _lastIntradayRefresh < INTRADAY_COOLDOWN_MS) {
        return { skipped: 'cooldown', nextRefreshInMin: Math.ceil((INTRADAY_COOLDOWN_MS - (now - _lastIntradayRefresh)) / 60000) };
    }

    try {
        const YahooFinance = require('yahoo-finance2').default;
        const yf           = new YahooFinance();
        const rateLimiter  = require('../utils/yahooFinanceRateLimiter');

        // Polygon-first, Yahoo screener only as fallback — added 2026-08-28, same
        // pattern already proven in marketScreenerService.js's getVelocitySymbols()
        // (verified live 2026-08-23). This was a genuine Yahoo-only single point of
        // failure before: on a rate-limited night both screener calls would silently
        // degrade to empty via the .catch() below, and this function would report
        // 'no_new_symbols' for a reason unrelated to the actual dedup bug fixed
        // earlier tonight. Wrapped into the same {quotes:[{symbol}]} shape Yahoo
        // returns so the merge logic below doesn't need to change.
        const dataProvider = require('./dataProvider');
        const [gainers, actives] = await Promise.all([
            dataProvider.getGainers(25)
                .then(symbols => ({ quotes: symbols.map(symbol => ({ symbol })) }))
                .catch(() => rateLimiter.execute(() => yf.screener({ scrIds: 'day_gainers', count: 25 })).catch(() => ({ quotes: [] }))),
            dataProvider.getMostActive(25)
                .then(symbols => ({ quotes: symbols.map(symbol => ({ symbol })) }))
                .catch(() => rateLimiter.execute(() => yf.screener({ scrIds: 'most_actives', count: 25 })).catch(() => ({ quotes: [] }))),
        ]);

        // Was a plain Set + skip-if-present check. Broke silently 2026-08-2x once
        // _universeCache grew from a few hundred curated names to the ~13,000-symbol
        // DB-backed pool (source #2 above): virtually every real day-gainer is already
        // *somewhere* in that huge cache (just never tagged isVelocity), so this filter
        // excluded almost every real candidate, every refresh, every day -- confirmed
        // live 2026-08-28: '{"added":0,"reason":"no_new_symbols"}' on every single
        // refresh, which meant getIntradayMovers() (filters isVelocity===true) always
        // returned empty, and Blitz never saw a single one of today's actual movers,
        // only its fixed 18-symbol core list. The original intent was "don't duplicate
        // an entry already in the cache" -- that's still correct and still needed. What
        // was missing: an existing entry should still get *tagged* as a mover instead of
        // being silently dropped. Now a Map (symbol -> cache index) so an already-present
        // symbol can be flagged in place; only genuinely absent symbols go through a
        // fresh quote fetch below.
        const existingIndex = new Map(_universeCache.map((s, i) => [s.symbol, i]));
        const candidates       = [];
        const alreadyCachedNew = new Set(); // dedupe within this one refresh's gainers+actives merge

        [...(gainers?.quotes || []), ...(actives?.quotes || [])].forEach(q => {
            const s = (q.symbol || '').toUpperCase();
            if (!s || !/^[A-Z]{1,5}$/.test(s)) return;
            if (existingIndex.has(s)) {
                const idx = existingIndex.get(s);
                if (!_universeCache[idx].isVelocity) _universeCache[idx].isVelocity = true;
            } else if (!alreadyCachedNew.has(s)) {
                alreadyCachedNew.add(s);
                candidates.push(s);
            }
        });

        if (candidates.length === 0) {
            _lastIntradayRefresh = now;
            return { added: 0, reason: 'no_new_symbols' };
        }

        const { passesQuickFilter, computeRS } = require('./marketScreenerService');
        const MIN_MARKET_CAP = parseInt(process.env.HERMES_MIN_MARKET_CAP || '2000000000', 10);
        const toAdd          = [];

        for (const symbol of [...new Set(candidates)].slice(0, INTRADAY_MAX_ADDS)) {
            try {
                const quote   = await rateLimiter.execute(() => yf.quote(symbol));
                const cap     = quote.marketCap || 0;
                const avgVol  = quote.averageDailyVolume3Month || quote.regularMarketVolume || 0;

                // Intraday movers are by definition velocity plays — use lower cap floor
                if (cap > 0 && cap < 300_000_000) continue;
                if (avgVol < 100_000) continue;

                const stock = {
                    symbol,
                    marketCap:          cap || 1e10,
                    marketCapFormatted: String(cap || ''),
                    price:              quote.regularMarketPrice || null,
                    volume:             quote.regularMarketVolume || 0,
                    avgVolume:          avgVol,
                    week52High:         quote.fiftyTwoWeekHigh    || null,
                    week52Low:          quote.fiftyTwoWeekLow     || null,
                    sma50:              quote.fiftyDayAverage     || null,
                    sma200:             quote.twoHundredDayAverage || null,
                    sector:             quote.sector   || 'Unknown',
                    industry:           quote.industry || 'Unknown',
                    rsScore:            computeRS(quote),
                    isVelocity:         true,
                    isETF:              TIER1_ETFS.has(symbol),
                    isSpeculative:      false,
                    daysToEarnings:     null,
                    tier:               3,
                };

                if (!passesQuickFilter(stock)) continue;
                toAdd.push(stock);
            } catch { /* skip symbols that fail quote fetch */ }
        }

        if (toAdd.length > 0) {
            _universeCache = [..._universeCache, ...toAdd];
            logger.info('[DynamicUniverse] Intraday movers merged into cache', {
                candidates: candidates.length,
                added:      toAdd.length,
                universeSize: _universeCache.length,
            });
        }

        _lastIntradayRefresh = now;
        return { added: toAdd.length, universeSize: _universeCache.length };

    } catch (err) {
        logger.warn('[DynamicUniverse] Intraday refresh failed', { error: err.message });
        return { error: err.message };
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the cached universe (array of stock objects).
 * Returns null if no cache is available for today — caller should fallback.
 */
function getScanUniverse() {
    if (_universeCache && _cacheDate === _todayET()) return _universeCache;
    return null;
}

function isCacheReady() {
    return _universeCache !== null && _cacheDate === _todayET();
}

function getCacheStats() {
    return {
        ready:   isCacheReady(),
        count:   _universeCache?.length || 0,
        date:    _cacheDate || null,
        building: _buildInProgress,
    };
}

function clearCache() {
    _universeCache   = null;
    _cacheDate       = null;
}

/**
 * Returns today's velocity/mover stocks (day_gainers + most_actives, added by
 * refreshIntradayMovers) from the existing cache -- no new API calls. Empty
 * array if the cache isn't ready or nothing's been added yet today.
 */
function getIntradayMovers() {
    if (!isCacheReady()) return [];
    return _universeCache.filter(s => s.isVelocity === true);
}

module.exports = { buildPreMarketCache, getScanUniverse, isCacheReady, getCacheStats, clearCache, refreshIntradayMovers, getIntradayMovers };
