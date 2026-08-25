const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const rateLimiter = require('../utils/yahooFinanceRateLimiter');

/**
 * Market Screener Service
 * Scans ALL US stocks with market cap > $2B
 * Uses free Yahoo Finance API
 */


// ─── 5-TIER UNIVERSE CONSTANTS ──────────────────────────────
const TIER1_ETFS = [
    'SPY','QQQ','IWM','DIA','MDY',
    'XLK','XLF','XLE','XLV','XLI','XLB','XLU','XLP','XLY',
    'SMH','SOXX',
    'ARKK','ARKG','ARKF',
    'GLD','TLT','HYG','LQD',
    'TQQQ','SOXL',
];
const TIER5_SPECULATIVE = [
    'CRSP','BEAM','EDIT','NTLA','RXRX','RKLB','ACHR','ASTS',
    'JOBY','ARM','ALAB','SMCI','COIN','APP','TTD','SPCX'
];

// Cache for screened stocks (refresh daily)
let cachedStockUniverse = null;
let lastScreenTime = null;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
// In-flight build, shared by every concurrent caller instead of each starting its own.
// Without this, a build slower than the calling interval (istPipelineScheduler alone
// calls getStockUniverse() from 3 places inside its own 60-second loop) means every
// caller during that window sees no valid cache yet and kicks off its own independent
// full rebuild — a classic cache stampede. Harmless when a rebuild was fast (small
// candidate pool), but the DB-driven pool now correctly resolves to ~13,000 symbols
// (fixed 2026-08-24 asset-universe date bug) instead of an ~800-symbol fallback, so a
// single build now takes many minutes — long enough for dozens of redundant concurrent
// rebuilds to pile up over a day, each competing for the same Yahoo/Alpaca/Polygon
// throughput as the nightly AI scan. Found 2026-08-25 diagnosing why the nightly scan's
// per-symbol rate degraded from ~4 min to ~50+ min over its run: 43 full rebuilds fired
// in one day (should be ~1 per 24h) with zero "Returning cached universe" hits between
// them — the cache was never once winning the race before another rebuild started.
let _buildingPromise = null;

// ── Relative Strength Score ───────────────────────────────────────────────────
// IBD-style RS proxy using live quote fields only (no extra API calls).
// Stocks in Stage 2 uptrends naturally score highest:
//   close to 52wk high + above 200MA + above 50MA + elevated volume
//
// Range: ~0.3 (beaten-down) → ~1.3 (at new highs with 3× volume)
// Used to sort the universe so breakout stocks rank above flat mega-caps.
function computeRS(quote) {
    const price  = quote.regularMarketPrice         || 0;
    const high52 = quote.fiftyTwoWeekHigh            || price || 1;
    const low52  = quote.fiftyTwoWeekLow             || 0;
    const ma200  = quote.twoHundredDayAverage        || price || 1;
    const ma50   = quote.fiftyDayAverage             || price || 1;
    const vol    = quote.regularMarketVolume         || 0;
    const avgVol = quote.averageDailyVolume3Month    || 1;

    // Proximity to 52wk high (0–1.15; >1 = new high territory)
    const prox52H  = Math.min(1.15, price / high52);
    // Recovery from 52wk low (0–1) — catches stocks recovering off the bottom
    const recovery = high52 > low52
        ? Math.min(1, (price - low52) / (high52 - low52))
        : 0.5;
    // Trend alignment
    const vs200MA  = Math.min(1.4, price / ma200);
    const vs50MA   = Math.min(1.25, price / ma50);
    // Volume interest (capped at 3× average to avoid distortion)
    const volScore = Math.min(1, (vol / avgVol) / 3);

    return (
        prox52H  * 0.35 +   // Stage 2 proximity — most important
        recovery * 0.20 +   // How far off the bottom (catches "SanDisk" scenario)
        vs200MA  * 0.25 +   // Long-term trend
        vs50MA   * 0.10 +   // Medium-term trend
        volScore * 0.10     // Institutional interest
    );
}

// ── Velocity Discovery — live breakout/trending symbols ───────────────────────
// Supplements the static S&P500/NASDAQ list with stocks Yahoo Finance flags as
// trending or making significant moves today. This catches stocks not on any
// static list that are suddenly active (earnings breakouts, FDA approvals, etc.)
//
// Returns a Set of uppercase symbols. Failures are silently ignored — the static
// list remains the stable backbone; velocity adds opportunistic coverage.
async function getVelocitySymbols() {
    const symbols = new Set();

    // 1. Yahoo trending symbols — real-time market buzz
    try {
        const res = await rateLimiter.execute(() =>
            yahooFinance.trendingSymbols('US', { count: 40 })
        );
        (res?.quotes || []).forEach(q => {
            const s = (q.symbol || '').toUpperCase();
            // Exclude options, forex, futures (contain -, =, ^, /)
            if (s && /^[A-Z]{1,5}$/.test(s)) symbols.add(s);
        });
        console.log(`[HERMES:Velocity] trendingSymbols: ${symbols.size} symbols`);
    } catch (e) {
        console.log(`[HERMES:Velocity] trendingSymbols unavailable: ${e.message}`);
    }

    // 2. Day gainers — stocks making the biggest % moves today.
    // Polygon first (verified live 2026-08-23, no crumb/rate-limit dependency),
    // Yahoo screener only as fallback if Polygon has no key or fails.
    try {
        const dataProvider = require('./dataProvider');
        const before = symbols.size;
        const gainers = await dataProvider.getGainers(30);
        gainers.forEach(s => { if (/^[A-Z]{1,5}$/.test(s)) symbols.add(s); });
        console.log(`[HERMES:Velocity] day_gainers (polygon): +${symbols.size - before} new symbols`);
    } catch (polyErr) {
        try {
            const res = await rateLimiter.execute(() =>
                yahooFinance.screener({ scrIds: 'day_gainers', count: 30 })
            );
            const before = symbols.size;
            (res?.quotes || []).forEach(q => {
                const s = (q.symbol || '').toUpperCase();
                if (s && /^[A-Z]{1,5}$/.test(s)) symbols.add(s);
            });
            console.log(`[HERMES:Velocity] day_gainers (yahoo fallback): +${symbols.size - before} new symbols`);
        } catch (e) {
            console.log(`[HERMES:Velocity] day_gainers unavailable: ${e.message}`);
        }
    }

    // 3. Most actives — highest volume today (institutional accumulation signal).
    // Polygon first, Yahoo screener only as fallback.
    try {
        const dataProvider = require('./dataProvider');
        const before = symbols.size;
        const mostActive = await dataProvider.getMostActive(30);
        mostActive.forEach(s => { if (/^[A-Z]{1,5}$/.test(s)) symbols.add(s); });
        console.log(`[HERMES:Velocity] most_actives (polygon): +${symbols.size - before} new symbols`);
    } catch (polyErr) {
        try {
            const res = await rateLimiter.execute(() =>
                yahooFinance.screener({ scrIds: 'most_actives', count: 30 })
            );
            const before = symbols.size;
            (res?.quotes || []).forEach(q => {
                const s = (q.symbol || '').toUpperCase();
                if (s && /^[A-Z]{1,5}$/.test(s)) symbols.add(s);
            });
            console.log(`[HERMES:Velocity] most_actives (yahoo fallback): +${symbols.size - before} new symbols`);
        } catch (e) {
            console.log(`[HERMES:Velocity] most_actives unavailable: ${e.message}`);
        }
    }

    return symbols;
}

/**
 * Get all US stocks with market cap > $2B
 * @returns {Promise<Array>} Array of stock symbols with metadata
 */
async function getStockUniverse() {
    // Return cache if still valid
    if (cachedStockUniverse && lastScreenTime && (Date.now() - lastScreenTime < CACHE_DURATION)) {
        console.log(`[Market Screener] Returning cached universe (${cachedStockUniverse.length} stocks)`);
        return cachedStockUniverse;
    }

    // A build is already in flight — share it instead of starting a redundant one.
    // See the _buildingPromise declaration above for why this matters now.
    if (_buildingPromise) {
        return _buildingPromise;
    }

    console.log('[Market Screener] Fetching fresh stock universe...');
    _buildingPromise = _buildStockUniverse().finally(() => { _buildingPromise = null; });
    return _buildingPromise;
}

async function _buildStockUniverse() {
    try {
        const desired = (process.env.STOCK_UNIVERSE || 'ALL').toUpperCase();
        let staticSymbols = [];
        let tierMap = new Map();

        // --- Tier 1: ETFs ---
        const etfSymbols = TIER1_ETFS.slice();
        etfSymbols.forEach(sym => tierMap.set(sym, 1));

        // --- Tier 2: Mega-cap (S&P500 + NASDAQ) ---
        let sp500Symbols = await getSP500Symbols();
        let nasdaqTop = await getTopNasdaqSymbols();
        sp500Symbols.forEach(sym => tierMap.set(sym, 2));
        nasdaqTop.forEach(sym => tierMap.set(sym, 2));

        // --- Tier 4: Mid-cap ---
        let midCapSymbols = getMidCapSymbols();
        midCapSymbols.forEach(sym => tierMap.set(sym, 4));

        // --- Tier 5: Speculative ---
        TIER5_SPECULATIVE.forEach(sym => tierMap.set(sym, 5));

        // --- Tier 3: Earnings watch (tagged later) ---

        // Build static symbol list
        staticSymbols = [...new Set([...etfSymbols, ...sp500Symbols, ...nasdaqTop, ...midCapSymbols, ...TIER5_SPECULATIVE])];

        // ── DB-driven universe (opt-in, graceful fallback) ────────────────────
        // Merges Alpaca-sourced symbols from asset_universe_daily into the pool.
        // If the table is empty (service never ran yet), this is a silent no-op
        // and the static lists above remain the sole input.
        let dbUniverseSymbols = [];
        try {
            const assetUniverseService = require('./assetUniverseService');
            dbUniverseSymbols = await assetUniverseService.getDailyUniverseSymbols();
            if (dbUniverseSymbols.length > 0) {
                // Tier 6, not 3 — deliberately distinct from the curated "Tier 3: earnings
                // watch" bucket below. This pool is now Alpaca's full ~13,000-symbol active
                // list (fixed 2026-08-24), and the earnings-check block a few lines down
                // does a per-symbol Yahoo quoteSummary call for every tier that isn't 2/4/
                // ETF/speculative — at ~12,400 DB-driven symbols against the shared 30/min
                // Yahoo throttle, that alone is 400+ minutes per build even with zero
                // failures, which is what actually made a single getStockUniverse() build
                // take many hours (found 2026-08-25, right after fixing the cache-stampede
                // that was compounding it). Tier 6 is still scored by HERMES like any other —
                // it just skips the earnings-proximity refinement, which was only ever a
                // meaningful signal for the small curated list, not a 12k-symbol bulk pool.
                dbUniverseSymbols.forEach(sym => { if (!tierMap.has(sym)) tierMap.set(sym, 6); });
                staticSymbols = [...new Set([...staticSymbols, ...dbUniverseSymbols])];
                console.log(`[HERMES] DB universe: +${dbUniverseSymbols.length} Alpaca symbols merged (total static: ${staticSymbols.length})`);
            }
        } catch (_) {
            // Always optional — never block the pipeline
        }

        // Velocity Discovery
        const velocitySymbols = await getVelocitySymbols();
        const allSymbols = [...new Set([...staticSymbols, ...velocitySymbols])];
        console.log(`[HERMES] Symbol pool: ${staticSymbols.length} static + ${velocitySymbols.size} velocity = ${allSymbols.length} unique`);

        // HERMES filters
        const qualified  = [];
        const batchSize  = 10;
        const minCap     = parseInt(process.env.HERMES_MIN_MARKET_CAP  || '2000000000', 10);
        const minCapVel  = parseInt(process.env.HERMES_MIN_CAP_VELOCITY|| '1000000000', 10);
        const minVolume  = parseInt(process.env.HERMES_MIN_AVG_VOLUME  || '300000',     10);
        const maxStocks  = parseInt(process.env.HERMES_MAX_STOCKS      || '500',        10); // raised to 500
        const fallbackCap = 10000000000;

        for (let i = 0; i < allSymbols.length; i += batchSize) {
            const batch = allSymbols.slice(i, i + batchSize);
            const results = await Promise.allSettled(
                batch.map(async symbol => {
                    const isVelocity = velocitySymbols.has(symbol);
                    const capFloor   = isVelocity ? minCapVel : minCap;
                    const isETF = TIER1_ETFS.includes(symbol);
                    const isSpec = TIER5_SPECULATIVE.includes(symbol);
                    let tier = tierMap.get(symbol) || 3; // default to 3 (earnings watch, tagged below)
                    try {
                        const quote = await rateLimiter.execute(() => yahooFinance.quote(symbol));
                        const rawCap   = quote.marketCap || quote?.price?.marketCap || 0;
                        const marketCap = rawCap > 0 ? rawCap : (isVelocity ? 0 : fallbackCap);
                        const avgVol = quote.averageDailyVolume3Month || quote.regularMarketVolume || 0;
                        let week52High = quote.fiftyTwoWeekHigh || null;
                        let week52Low = quote.fiftyTwoWeekLow || null;
                        let price = quote.regularMarketPrice || null;
                        let rsScore = computeRS(quote);
                        let sector = quote.sector || 'Unknown';
                        let industry = quote.industry || 'Unknown';

                        // --- Tier 3: Earnings watch (within 20 days) ---
                        // Excludes tier 6 (bulk DB-driven pool, ~12,400 symbols) — see the
                        // tier-6 assignment comment above for why this one check alone made
                        // a full build take 400+ minutes against the shared Yahoo throttle.
                        let daysToEarnings = null;
                        if (!isETF && !isSpec && tier !== 4 && tier !== 2 && tier !== 6) {
                            try {
                                // Only check for non-ETF, non-speculative, non-midcap, non-megacap, non-bulk-DB
                                const summary = await yahooFinance.quoteSummary(symbol, { modules: ['calendarEvents'] });
                                const earningsDate = summary?.calendarEvents?.earnings?.earningsDate?.[0];
                                if (earningsDate) {
                                    daysToEarnings = Math.ceil((new Date(earningsDate) - new Date()) / (1000 * 60 * 60 * 24));
                                    if (daysToEarnings >= 5 && daysToEarnings <= 20) {
                                        tier = 3;
                                    }
                                }
                            } catch {}
                        }

                        if (marketCap >= capFloor && avgVol >= minVolume) {
                            return {
                                symbol,
                                marketCap,
                                marketCapFormatted: formatMarketCap(marketCap),
                                price,
                                volume: quote.regularMarketVolume || 0,
                                avgVolume: avgVol,
                                week52High,
                                week52Low,
                                sma50: quote.fiftyDayAverage || null,
                                sma200: quote.twoHundredDayAverage || null,
                                sector,
                                industry,
                                rsScore,
                                isVelocity,
                                tier,
                                isETF,
                                isSpeculative: isSpec,
                                daysToEarnings,
                            };
                        }
                        return null;
                    } catch (error) {
                        console.log(`[Market Screener] Error fetching ${symbol}: ${error.message}`);
                        if (!isVelocity) {
                            return {
                                symbol,
                                marketCap: fallbackCap,
                                marketCapFormatted: formatMarketCap(fallbackCap),
                                price: null, volume: 0, avgVolume: 0,
                                week52High: null, week52Low: null,
                                sma50: null, sma200: null,
                                sector: 'Unknown', industry: 'Unknown',
                                rsScore: 0.5,
                                isVelocity: false,
                                tier,
                                isETF,
                                isSpeculative: isSpec,
                                daysToEarnings: null,
                            };
                        }
                        return null;
                    }
                })
            );
            results.forEach(r => {
                if (r.status === 'fulfilled' && r.value) qualified.push(r.value);
            });
            if (i + batchSize < allSymbols.length) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // --- Sort: tier priority, then rsScore ---
        qualified.sort((a, b) => {
            if ((a.tier || 3) !== (b.tier || 3)) return (a.tier || 3) - (b.tier || 3);
            return b.rsScore - a.rsScore;
        });
        const selected = qualified.slice(0, maxStocks);
        const velocityCount = selected.filter(s => s.isVelocity).length;
        cachedStockUniverse = selected;
        lastScreenTime = Date.now();
        console.log(
            `[HERMES] ✓ Universe: ${selected.length} stocks | ` +
            `${selected.length - velocityCount} static + ${velocityCount} velocity breakouts | ` +
            `sorted by Tier + Relative Strength`
        );
        return selected;
    } catch (error) {
        console.error('[Market Screener] Error:', error);
        return cachedStockUniverse || [];
    }
}

/**
 * Quality mid-cap symbols ($2B–$15B) not covered by the S&P500/NASDAQ-100 lists.
 * Organised by sector so each cycle has broad diversification.
 */
function getMidCapSymbols() {
    return [
        // Technology — SaaS / Cloud
        'APPN', 'PCOR', 'DOMO', 'ZUO', 'SPT', 'NCNO', 'BRZE', 'NTNX', 'JAMF', 'TOST',
        'GLOB', 'DOCN', 'WK', 'CWAN', 'RDWR', 'TASK', 'AZEK', 'KD', 'PAR', 'ALTR',
        // Semiconductors (mid-tier)
        'ACLS', 'ONTO', 'COHU', 'UCTT', 'AMBA', 'ACMR', 'LSCC', 'WOLF', 'PI', 'FORM',
        // Healthcare & Biotech
        'ACAD', 'PTCT', 'ALKS', 'ITCI', 'ARVN', 'AUPH', 'PRAX', 'ARQT', 'IMVT', 'ENSG',
        'LNTH', 'IONS', 'KROS', 'MDXG', 'PRTA', 'RXDX', 'ACRS', 'NKTR', 'INVA', 'TMDX',
        // Financials — Insurance, specialty finance, regional banks
        'PIPR', 'SF', 'ESNT', 'NMIH', 'PFSI', 'AGO', 'RDN', 'WTFC', 'CATY', 'FNB',
        'TFIN', 'BANF', 'CVBF', 'PPBI', 'WSBC', 'HMN', 'UWMC', 'GHLD', 'AMSF', 'IBCP',
        // Consumer — Restaurants, apparel, specialty retail
        'WING', 'TXRH', 'SFM', 'CAVA', 'SHAK', 'BROS', 'LEVI', 'CROX', 'SKX', 'BOOT',
        'EAT', 'BJ', 'ARMK', 'UNFI', 'CHUY', 'CAKE', 'BJRI', 'PLAY', 'USFD', 'PFGC',
        // Industrials, defense, construction
        'DRS', 'TRMB', 'MYRG', 'IESC', 'AWI', 'ATKR', 'BECN', 'IBP', 'CSWI', 'TREX',
        'UFPI', 'NWPX', 'HXL', 'TDG', 'KFRC', 'RXO', 'GXO', 'XPO', 'SAIA', 'ARCB',
        // Energy — oil & gas, clean energy
        'ENPH', 'SEDG', 'ARRY', 'BE', 'PLUG', 'RUN', 'CEIX', 'CHRD', 'CIVI', 'SM',
        'MTDR', 'CRGY', 'VTLE', 'GPRE', 'RES', 'NGL', 'PUMP', 'PTEN', 'NINE', 'KOS',
        // REITs — specialty mid-cap
        'COLD', 'IIPR', 'STAG', 'EGP', 'REXR', 'NNN', 'RHP', 'DEA', 'PLYM', 'ROIC',
        // Materials — gold/silver/precious-metals miners, industrial metals (not S&P 500,
        // so absent from getSP500Symbols' Materials section above — added here specifically
        // for gold-sector exposure, since GLD/GDX (the ETF route) never scored, ever).
        // 'GOLD' was a mistake here (2026-08-24): Barrick Gold renamed to "Barrick Mining
        // Corporation" and moved to ticker B ($78B market cap) — the vacated GOLD ticker
        // was picked up by an unrelated $1.3B company, "Gold.com, Inc.". Found and fixed
        // 2026-08-25 auditing for other misses like CBRS. VALE (Vale SA, major iron-ore
        // miner) added alongside — same category, was also missing.
        'B', 'AEM', 'KGC', 'AU', 'HL', 'CDE', 'PAAS', 'SSRM', 'RGLD', 'WPM',
        'AA', 'CLF', 'X', 'CMC', 'RS', 'SCCO', 'TECK', 'MP', 'VALE',
        // Uranium/nuclear — zero prior coverage despite being one of the more actively
        // trending momentum themes (AI datacenter power demand), and crypto miners as
        // their own high-beta category distinct from COIN (found 2026-08-24).
        'CCJ', 'SMR', 'OKLO', 'NNE', 'LEU', 'UUUU', 'DNN', 'UEC',
        'MARA', 'RIOT', 'CLSK', 'CIFR',
        // AI-datacenter power & cooling infrastructure — a whole theme with zero prior
        // coverage despite being directly adjacent to the uranium/nuclear one above (that's
        // power generation; this is delivery, grid buildout, and cooling). Found 2026-08-25
        // ranking the full market by dollar volume and diffing against this list — GEV, VRT,
        // and CEG all placed in the top ~150 most actively-traded US stocks that day.
        'GEV', 'VRT', 'CEG', 'VST', 'PWR', 'FIX', 'TT', 'CMI', 'HWM',
        // AI-optical-networking hardware — extends the ANET/CIEN/FFIV coverage already in
        // the S&P 500 list above with names not yet index-eligible.
        'LITE', 'COHR', 'CRDO', 'AAOI', 'APH',
        // Major global ADRs — not S&P 500 eligible (foreign-domiciled) but among the most
        // heavily-traded US-listed names, full stop. SHOP (Canada) and SPOT (Luxembourg)
        // grouped here too for the same reason, despite being large/well-known.
        'TSM', 'BABA', 'PDD', 'SHOP', 'SPOT',
        // Crypto-finance ecosystem — extends the crypto-miner coverage above with the
        // adjacent categories (Bitcoin-treasury proxy, stablecoin issuer, mining/AI pivot).
        'MSTR', 'CRCL', 'IREN', 'BMNR',
        // AI infrastructure / compute — cloud GPU, AI inference, quantum, automation.
        'NBIS', 'CRWV', 'IONQ', 'TEM', 'PATH',
        // Memory — SanDisk, spun off from Western Digital in 2025; WDC/STX/MU already
        // covered memory/storage broadly, this was the one clear remaining gap.
        'SNDK',
        // Individually notable large caps that turned up missing in the same dollar-volume
        // sweep — no unifying theme, just real gaps (Carvana, SoFi, AXT).
        'CVNA', 'SOFI', 'AXTI',
        // Smaller airlines (majors DAL/UAL/AAL/LUV are in the S&P 500 list above)
        'ALK', 'JBLU',
    ];
}

/**
 * Get S&P 500 symbols
 */
async function getSP500Symbols() {
    return [
        // Technology (60)
        'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'NVDA', 'META', 'TSLA', 'AVGO', 'ORCL',
        'ADBE', 'CRM', 'CSCO', 'ACN', 'AMD', 'INTC', 'IBM', 'QCOM', 'TXN', 'INTU',
        'NOW', 'AMAT', 'MU', 'ADI', 'LRCX', 'KLAC', 'SNPS', 'CDNS', 'MCHP', 'FTNT',
        'PANW', 'CRWD', 'DDOG', 'NET', 'ZS', 'OKTA', 'PLTR', 'SNOW', 'MDB', 'TEAM',
        'WDAY', 'VEEV', 'ANSS', 'ADSK', 'ROP', 'KEYS', 'PTC', 'GDDY', 'VRSN', 'AKAM',
        'GLW', 'JNPR', 'HPQ', 'HPE', 'WDC', 'STX', 'NTAP', 'PSTG', 'DELL', 'SMCI',
        // Financials (40)
        'JPM', 'V', 'MA', 'BAC', 'WFC', 'MS', 'GS', 'BLK', 'SPGI', 'C',
        'AXP', 'SCHW', 'CB', 'MMC', 'PGR', 'AON', 'TFC', 'USB', 'PNC', 'BK',
        'MCO', 'ICE', 'CME', 'NDAQ', 'CBOE', 'FIS', 'FI', 'PYPL', 'SQ', 'HOOD',
        'COF', 'DFS', 'ALLY', 'SYF', 'MTB', 'HBAN', 'RF', 'CFG', 'KEY', 'FITB',
        // Healthcare (40)
        'UNH', 'JNJ', 'LLY', 'ABBV', 'MRK', 'TMO', 'ABT', 'DHR', 'PFE', 'AMGN',
        'BMY', 'ISRG', 'VRTX', 'GILD', 'CVS', 'CI', 'ELV', 'HCA', 'BSX', 'MDT',
        'REGN', 'ZBH', 'EW', 'DXCM', 'IDXX', 'MTD', 'WAT', 'A', 'IQV', 'CRL',
        'BIO', 'HOLX', 'PODD', 'INSP', 'ALGN', 'NVCR', 'EXAS', 'NVST', 'TNDM', 'IRTC',
        // Consumer Discretionary + Staples (40)
        'WMT', 'HD', 'MCD', 'NKE', 'COST', 'SBUX', 'TGT', 'LOW', 'TJX', 'BKNG',
        'CMG', 'MAR', 'ABNB', 'DIS', 'NFLX', 'PG', 'KO', 'PEP', 'PM', 'MO',
        'CL', 'MDLZ', 'GIS', 'K', 'SYY', 'ADM', 'MNST', 'ORLY', 'AZO', 'ULTA',
        'LULU', 'YUM', 'DPZ', 'EL', 'KMB', 'CHD', 'CLX', 'HRL', 'CAG', 'MKC',
        // Industrials (30)
        'UNP', 'CAT', 'HON', 'UPS', 'RTX', 'BA', 'GE', 'LMT', 'DE', 'MMM',
        'EMR', 'ETN', 'PH', 'ROK', 'AME', 'FDX', 'FAST', 'CTAS', 'PCAR', 'ODFL',
        'NSC', 'CSX', 'WAB', 'GWW', 'MSI', 'XYL', 'GNRC', 'CPRT', 'VRSK', 'CARR',
        // Energy (20)
        'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PSX', 'VLO', 'OXY', 'HES',
        'DVN', 'FANG', 'PXD', 'APA', 'MRO', 'HAL', 'BKR', 'NOV', 'LNG', 'WMB',
        // Communication (15)
        'CMCSA', 'T', 'VZ', 'TMUS', 'CHTR', 'FOX', 'FOXA', 'PARA', 'WBD', 'OMC',
        'IPG', 'TTWO', 'EA', 'MTCH', 'ZG',
        // Utilities + REITs (15)
        'NEE', 'DUK', 'SO', 'AEP', 'EXC', 'SRE', 'PEG', 'AMT', 'PLD', 'CCI',
        'EQIX', 'PSA', 'WELL', 'SPG', 'O',
        // Materials — chemicals, industrial metals, gold miners (S&P 500 constituents).
        // Previously the ONLY sector with no dedicated names at all: the sole coverage was
        // GLD/XLB (ETFs, not individual stocks), and both scored ai_score=NULL every single
        // day going back to at least May and dropped out of the scan universe entirely after
        // 2026-06-01 — Materials/Gold had effectively zero working coverage (found 2026-08-24).
        'LIN', 'SHW', 'ECL', 'APD', 'FCX', 'NEM', 'NUE', 'DOW', 'DD', 'PPG',
        'VMC', 'MLM', 'ALB', 'CTVA', 'IFF', 'CF', 'MOS', 'AVY', 'PKG', 'IP',
        'BALL', 'STLD', 'AMCR', 'LYB', 'CE', 'EMN',
        // Airlines, homebuilders, defense, insurance, gaming, AI-networking hardware —
        // each had zero dedicated coverage (found auditing sector gaps 2026-08-24, same
        // sweep that found Materials/Gold). LMT/RTX/BA already covered defense partially;
        // this fills in the rest of that sector plus five others with none at all.
        'DAL', 'UAL', 'AAL', 'LUV',
        'DHI', 'LEN', 'PHM', 'NVR',
        'GD', 'NOC', 'LHX', 'LDOS', 'HII', 'TXT',
        'TRV', 'MET', 'PRU', 'AFL', 'HIG',
        'LVS', 'WYNN', 'MGM', 'CZR', 'DKNG',
        'ANET', 'CIEN', 'FFIV', 'DLR',
        // True S&P 500 constituents that turned up missing in the same dollar-volume sweep
        // (2026-08-25) — Berkshire Hathaway is a top-10 index weight, this was a notable gap.
        'BRK.B', 'F', 'SYK', 'HUM', 'DKS',
    ];
}

/**
 * Get top NASDAQ + growth stocks
 */
async function getTopNasdaqSymbols() {
    return [
        // NASDAQ-100 core
        'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'AVGO', 'COST', 'ASML',
        'PEP', 'AZN', 'CSCO', 'TMUS', 'AMD', 'ADBE', 'NFLX', 'INTU', 'HON', 'AMGN',
        'AMAT', 'ISRG', 'BKNG', 'SBUX', 'ADI', 'GILD', 'VRTX', 'MDLZ', 'REGN', 'ADP',
        'MU', 'LRCX', 'PANW', 'MELI', 'SNPS', 'KLAC', 'CDNS', 'MNST', 'ORLY', 'CRWD',
        'MAR', 'CTAS', 'MRVL', 'FTNT', 'ADSK', 'ABNB', 'WDAY', 'NXPI', 'DASH', 'TEAM',
        'PCAR', 'PAYX', 'ROST', 'MCHP', 'QCOM', 'TXN', 'INTC',
        // High-growth / breakout candidates
        'COIN', 'PLTR', 'SNOW', 'DDOG', 'ZS', 'OKTA', 'NET', 'RBLX', 'UBER', 'APP',
        'TTD', 'TWLO', 'HUBS', 'BILL', 'ZI', 'SMAR', 'ESTC', 'MDB', 'GTLB', 'CFLT',
        'IOT', 'AEHR', 'ASTS', 'RKLB', 'ACHR', 'JOBY', 'EVTL', 'LIDR', 'LUNR', 'RDW',
        // AI / Semiconductor cycle
        // CBRS (Cerebras Systems, $46.6B mkt cap, IPO'd 2026-05-14, AI training/inference
        // hardware) was missing — the recent-IPO auto-catch (getRecentIPOSymbols) exists
        // and does fire, but 95% of asset_universe's rows carry a placeholder
        // first_added_at (2000-01-01) instead of a real date, so it can never match the
        // 90-day window. That's a real, systemic bug (found 2026-08-25) — flagged, not
        // fixed here: a blanket "set every placeholder to NOW()" would make it worse,
        // flooding the recent-IPO list with thousands of unrelated old symbols all tied
        // for "most recent" instead of surfacing genuinely new ones. Added CBRS directly.
        'ARM', 'SMCI', 'ALAB', 'NVDA', 'AMD', 'AVGO', 'QCOM', 'MRVL', 'MCHP', 'ON',
        'TER', 'MKSI', 'ENTG', 'IPGP', 'CEVA', 'SLAB', 'DIOD', 'SITM', 'ALGM', 'MPWR', 'CBRS',
        // Biotech momentum
        'MRNA', 'BNTX', 'RXRX', 'SANA', 'BEAM', 'EDIT', 'CRSP', 'NTLA', 'FATE', 'KYMR',
    ];
}

/**
 * Format market cap for display
 */
function formatMarketCap(marketCap) {
    if (marketCap >= 1e12) {
        return `$${(marketCap / 1e12).toFixed(2)}T`;
    } else if (marketCap >= 1e9) {
        return `$${(marketCap / 1e9).toFixed(2)}B`;
    } else if (marketCap >= 1e6) {
        return `$${(marketCap / 1e6).toFixed(2)}M`;
    }
    return `$${marketCap}`;
}

/**
 * Get stocks by sector
 */
async function getStocksBySector(sector) {
    const universe = await getStockUniverse();
    return universe.filter(stock => stock.sector === sector);
}

/**
 * Get top liquid stocks for options trading
 */
async function getTopLiquidStocks(limit = 50) {
    const universe = await getStockUniverse();
    return universe
        .sort((a, b) => b.volume - a.volume)
        .slice(0, limit);
}

/**
 * Minervini Trend Template quick pre-filter.
 *
 * Eliminates stocks that clearly don't meet swing-trade setup criteria
 * BEFORE expensive full AI analysis runs on them.
 * Returns true if the stock passes (should be analyzed further).
 *
 * Criteria (relaxed vs strict SEPA — designed for pre-screening):
 *   1. Price > 50-day SMA proxy (regularMarketPrice > 50-day estimate)
 *   2. Price within 25% of 52-week high (not deep in base)
 *   3. Volume ratio ≥ 0.8 (not dead/thin)
 *   4. Price > $5 (avoid penny stocks)
 *   5. Average daily volume ≥ 200k (minimum liquidity)
 */
function passesQuickFilter(stock) {
    if (!stock) return false;
    // Minimum price guard
    if (stock.price && stock.price < 5) return false;
    // Minimum liquidity
    const avgVol = stock.avgVolume || stock.volume || 0;
    if (avgVol < 200000) return false;
    // Volume ratio — not completely dead
    if (stock.volume && stock.avgVolume && stock.avgVolume > 0) {
        const volRatio = stock.volume / stock.avgVolume;
        if (volRatio < 0.3) return false;
    }
    // ETFs (tier 1) do NOT need to be near 52wk high — they track indices
    if (!stock.isETF && stock.week52High && stock.price) {
        const prox = stock.price / stock.week52High;
        if (prox < 0.60) return false;
    }
    return true;
}

/**
 * Manual refresh of stock universe
 */
function refreshCache() {
    cachedStockUniverse = null;
    lastScreenTime = null;
    console.log('[Market Screener] Cache cleared, will refresh on next request');
}

/**
 * Returns stocks that appeared in the Alpaca asset universe within the last 90 days.
 * The asset_universe table is refreshed nightly from Alpaca — any new IPO that
 * Alpaca makes tradable will have first_added_at set to the night it was discovered.
 * Returns [] silently if the column doesn't exist yet (pre-migration fallback).
 *
 * shortable=true is the filter that actually matters here (2026-07-20 fix): Alpaca's
 * asset-listing endpoint marks tons of SPAC-unit/thinly-traded recent listings as
 * "tradable"/"active" even though its IEX market-data feed has no real snapshot for
 * them (guaranteed 404 on every quote call). Every junk ticker checked from a scan
 * that fell over on this (RECI, PTACW, RNMN, NTAL, DRMY, QJL, SCJL, SHOTR, CTJL, CJUL,
 * NQLT, IDJL, HJLY, EMFI, DVVY, ZCBB) had shortable=false — real, liquid recent IPOs
 * get marked shortable quickly once there's actual trading interest. This filter alone
 * cut the recent-IPO pool from 368 candidates to 13 on the current asset_universe data.
 */
async function getRecentIPOSymbols() {
    try {
        const { query } = require('../config/database');
        const result = await query(`
            SELECT symbol FROM asset_universe
            WHERE tradable = true
              AND status = 'active'
              AND shortable = true
              AND exchange IN ('NYSE', 'NASDAQ', 'ARCA', 'BATS', 'AMEX')
              AND first_added_at > NOW() - INTERVAL '90 days'
              AND symbol ~ '^[A-Z]{1,5}$'
            ORDER BY first_added_at DESC
            LIMIT 100
        `);
        const symbols = result.rows.map(r => r.symbol);
        if (symbols.length > 0) {
            console.log(`[HERMES:IPO] New listings last 90d (Alpaca): ${symbols.length} — ${symbols.slice(0, 8).join(', ')}${symbols.length > 8 ? '…' : ''}`);
        }
        return symbols;
    } catch {
        return []; // column not yet added — graceful no-op
    }
}

/**
 * Returns the full curated symbol list (ETFs + S&P500 + NASDAQ + midcap + speculative)
 * with NO Yahoo Finance calls — safe to use during off-hours batch jobs.
 * The nightly universe scan uses this instead of getStockUniverse() to avoid
 * hammering Yahoo before the AI analysis phase.
 */
async function getStaticSymbolList() {
    const [sp500, nasdaq, midcap, recentIPOs] = await Promise.all([
        getSP500Symbols(),
        getTopNasdaqSymbols(),
        Promise.resolve(getMidCapSymbols()),
        getRecentIPOSymbols(),
    ]);
    const all = [
        ...TIER1_ETFS,
        ...sp500,
        ...nasdaq,
        ...midcap,
        ...TIER5_SPECULATIVE,
        ...recentIPOs,
    ];
    return [...new Set(all)];
}

/**
 * Same as getStaticSymbolList but excludes ETFs.
 * ETFs have no earnings/fundamentals so analyzeStockWithAI always returns null for them.
 * Use this for the nightly AI scan to avoid wasting slots.
 */
async function getStockOnlySymbolList() {
    const etfSet = new Set(TIER1_ETFS);
    const all = await getStaticSymbolList();
    return all.filter(sym => !etfSet.has(sym));
}

module.exports = {
    getStockUniverse,
    getStaticSymbolList,
    getStockOnlySymbolList,
    getStocksBySector,
    getTopLiquidStocks,
    passesQuickFilter,
    refreshCache,
    formatMarketCap,
    computeRS,
};
