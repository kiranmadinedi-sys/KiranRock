const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const marketScreenerService  = require('./marketScreenerService');
const dynamicUniverseService = require('./dynamicUniverseService');
const sectorMetadata         = require('./sectorMetadataService');
const tradingServiceDB = require('./tradingServiceDB');
const userDb = require('./userDatabaseService');
const accountDb = require('./tradingAccountDatabaseService');
const holdingsDb = require('./holdingsDatabaseService');
const tradesDb = require('./tradesDatabaseService');
const { query } = require('../config/database');
const { logger, aiTradingLogger } = require('../utils/logger');

// Persist live PANTHEON scores to live_score_cache after each scan cycle.
// Signals page reads these and overlays them on the nightly scan scores during market hours.
async function _saveLiveScores(analyzed) {
    if (!analyzed.length) return;
    const today = new Date().toISOString().slice(0, 10);
    // Bulk upsert — one query per stock but runs async after trading logic completes
    await Promise.all(analyzed.map(s =>
        query(
            `INSERT INTO live_score_cache (symbol, scan_date, ai_score, recommendation, live_scored_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (symbol, scan_date) DO UPDATE
             SET ai_score = EXCLUDED.ai_score,
                 recommendation = EXCLUDED.recommendation,
                 live_scored_at = NOW()`,
            [s.symbol, today, s.aiScore ?? null, s.recommendation ?? null]
        ).catch(() => {})
    ));
}
const alertService = require('./telegramAlertService');
const performanceService = require('./performanceMetricsService');
const indicators = require('./technicalIndicators');
const marketRegimeService = require('./marketRegimeService');
const newsSentimentService = require('./newsSentimentService');
const tradeIntelligenceService = require('./tradeIntelligenceService');
const cacheService = require('./cacheService');
// Broker + data abstraction — switch provider/broker via .env without code changes
const brokerService = require('./brokerService');
const dataProvider  = require('./dataProvider');
const { ensurePhase0Schema, getGlobalTradingControl, getUserTradingControls } = require('./tradingControlService');
const { evaluateGates }   = require('./activationGateService');
const compassService      = require('./compassService');

const precomputedUniverseService = require('./precomputedUniverseService');
const sonarService              = require('./sonarService');
const positionSizingService     = require('./positionSizingService');
const geminiPulseService        = require('./geminiPulseService');
const fredMacroService          = require('./fredMacroService');
const redditAltDataService      = require('./redditAltDataService');
const prophetService            = require('./prophetService');
const { detectOraclePatterns }  = require('./patternDetectionService');
const sageService               = require('./sageService');
const vixMonitor                = require('./vixSpikeMonitorService');
const scoreCalibratorService    = require('./scoreCalibratorService');
const oracleService             = require('./oracleService');
const visionService             = require('./visionService');
const agentHealth               = require('./agentHealthService');
const localBrain                = require('./localBrainService');
const evolveService             = require('./evolveService');
const globalSentimentService    = require('./globalSentimentService');

const AI_NEWS_SCORING_ENABLED = (process.env.AI_NEWS_SCORING_ENABLED || 'true').toLowerCase() === 'true';
const AI_NEWS_SCORE_WEIGHT = Math.max(0, Math.min(1, parseFloat(process.env.AI_NEWS_SCORE_WEIGHT || '1')));
const AI_NEWS_MAX_IMPACT = Math.max(0, parseFloat(process.env.AI_NEWS_MAX_IMPACT || '8'));

// ─── REGIME SHIFT TRACKER ─────────────────────────────────────────────────────
// Tracks the last known regime per user so we can detect and alert on transitions.
// key: userId → { regime, regimeType, seenAt }
const _lastRegimePerUser = new Map();

// On a regime downgrade, holds userId → timestamp until which extra defensive
// measures apply (temporary trailing-stop tightening beyond the standard regime scaling,
// which already recomputes every cycle from the *current* regime).
const _regimeDowngradeUntil = new Map();

// Ordinal rank used to detect regime *downgrades* (not just any change).
// Higher = more bullish/risk-on. Ties (e.g. unrecognized labels) default to NEUTRAL.
function _regimeRank(regimeType) {
    const t = (regimeType || '').toUpperCase();
    if (t.includes('BULL_STRONG')) return 4;
    if (t.includes('BULL') || t === 'RISK_ON' || t === 'TRENDING_UP') return 3;
    if (t.includes('BEAR_MILD') || t.includes('BEAR_QUIET')) return 1;
    if (t.includes('BEAR') || t === 'RISK_OFF' || t === 'PANIC') return 0;
    return 2; // NEUTRAL / CHOPPY / unrecognized
}

// ─── SECTOR ROTATION CACHE ────────────────────────────────────────────────────
// Built after each market scan; applied as a score modifier in the next cycle.
// hot  = sectors whose average AI score ≥ 62 (rotating in — tailwind)
// cold = sectors whose average AI score ≤ 42 (rotating out — headwind)
let _sectorRotation = { hot: new Set(), cold: new Set(), scores: {}, updatedAt: 0 };

function refreshSectorRotationCache(allAnalyzed) {
    const buckets = {};
    for (const s of allAnalyzed) {
        const sec = s.sector || 'Unknown';
        if (sec === 'Unknown') continue;
        if (!buckets[sec]) buckets[sec] = [];
        buckets[sec].push(s.aiScore || 50);
    }
    const avgScores = {};
    for (const [sec, scores] of Object.entries(buckets)) {
        avgScores[sec] = scores.reduce((a, b) => a + b, 0) / scores.length;
    }
    const hot  = new Set(Object.entries(avgScores).filter(([, avg]) => avg >= 62).map(([s]) => s));
    const cold = new Set(Object.entries(avgScores).filter(([, avg]) => avg <= 42).map(([s]) => s));
    _sectorRotation = { hot, cold, scores: avgScores, updatedAt: Date.now() };
    if (hot.size > 0 || cold.size > 0) {
        logger.info('[SectorRotation] Cache refreshed', {
            rotating_in:  [...hot],
            rotating_out: [...cold],
            sectorAvg: Object.fromEntries(Object.entries(avgScores).map(([s, v]) => [s, Math.round(v)]))
        });
    }
}

// ─── WEINSTEIN STAGE HELPERS ─────────────────────────────────────────────────
function computeSMA(prices, period) {
    if (!prices || prices.length < period) return null;
    return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/**
 * Determine Weinstein stage from moving averages.
 * Stage 2 = Uptrend (tradeable). Stage 3/4 = Topping/Downtrend (skip).
 * Stage 1 = Basing (watch but no entry).
 */
function deriveWeinSteinStage(price, sma50, sma150, sma200, sma200Rising) {
    if (!sma200) return 1; // insufficient history — treat as neutral
    if (price > sma200 && sma200Rising && (!sma50 || sma50 > sma200)) return 2;
    if (price < sma200 && !sma200Rising) return 4;
    if (sma50 && price < sma50 && price > sma200 && sma200Rising) return 3;
    return 1;
}

/**
 * Enhanced AI Trading Bot Service - PostgreSQL Version
 * Automatically analyzes ALL available stocks and trades autonomously
 */

// Per-cycle ORACLE budget — limits Claude API calls per scan to control cost.
// HERMES RS sort guarantees only the highest-momentum stocks use these slots.
// Cached results (1-hour window per symbol) don't count toward the cap.
const ORACLE_MAX_PER_CYCLE = Math.max(5, parseInt(process.env.ORACLE_MAX_PER_CYCLE || '25', 10));
let _oracleCycleCount = 0;

// ─── FOMC CALENDAR ────────────────────────────────────────────────────────────
// Fed decision days (the second day of each 2-day meeting, ~2 PM ET announcement).
// Update this list each January when the Fed publishes the new year's schedule.
// Source: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
const FOMC_DECISION_DATES = new Set([
    // 2025
    '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18',
    '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
    // 2026
    '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
    '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
]);

/**
 * Returns whether today is a Fed decision day or the eve of one.
 * Fed announcements land ~2 PM ET and cause unpredictable whipsaws —
 * raise minBuyScore on decision day (+10) and the day before (+5).
 */
function checkFomcWindow() {
    const toKey = (d) => d.toISOString().slice(0, 10);
    const today    = new Date();
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);

    const todayKey    = toKey(today);
    const tomorrowKey = toKey(tomorrow);

    if (FOMC_DECISION_DATES.has(todayKey)) {
        return { isFomcDay: true, isFomcEve: false, date: todayKey };
    }
    if (FOMC_DECISION_DATES.has(tomorrowKey)) {
        return { isFomcDay: false, isFomcEve: true, nextDate: tomorrowKey };
    }
    return { isFomcDay: false, isFomcEve: false };
}

// ─── MACRO RELEASE CALENDAR (CPI + NFP) ──────────────────────────────────────
// CPI release dates (BLS publishes ~8:30 AM ET, 2nd or 3rd Tuesday/Wednesday of month).
// NFP / Jobs Report dates (BLS publishes ~8:30 AM ET, first Friday of each month).
// Both cause immediate directionally-ambiguous volatility spikes — raise bar for new entries.
// Update each January. Source: https://www.bls.gov/schedule/news_release/cpi.htm
//                              https://www.bls.gov/schedule/news_release/empsit.htm
const CPI_RELEASE_DATES = new Set([
    // 2025
    '2025-01-15', '2025-02-12', '2025-03-12', '2025-04-10',
    '2025-05-13', '2025-06-11', '2025-07-15', '2025-08-12',
    '2025-09-10', '2025-10-15', '2025-11-13', '2025-12-10',
    // 2026
    '2026-01-14', '2026-02-11', '2026-03-11', '2026-04-09',
    '2026-05-13', '2026-06-10', '2026-07-14', '2026-08-12',
    '2026-09-09', '2026-10-14', '2026-11-12', '2026-12-09',
]);

const NFP_RELEASE_DATES = new Set([
    // 2025
    '2025-01-10', '2025-02-07', '2025-03-07', '2025-04-04',
    '2025-05-02', '2025-06-06', '2025-07-03', '2025-08-01',
    '2025-09-05', '2025-10-03', '2025-11-07', '2025-12-05',
    // 2026
    '2026-01-09', '2026-02-06', '2026-03-06', '2026-04-03',
    '2026-05-01', '2026-06-05', '2026-07-02', '2026-08-07',
    '2026-09-04', '2026-10-02', '2026-11-06', '2026-12-04',
]);

// ─── US MARKET HOLIDAY CALENDAR ───────────────────────────────────────────────
// Days when NYSE is fully closed. First trading day AFTER a holiday has lower
// liquidity, wider spreads, and gap-fill volatility — raise minBuyScore by +5.
// Update each January. Source: https://www.nyse.com/markets/hours-calendars
const NYSE_HOLIDAYS = new Set([
    // 2025
    '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18',
    '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01',
    '2025-11-27', '2025-12-25',
    // 2026
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
    '2026-05-25', '2026-06-19',
    '2026-07-03', '2026-07-04', // July 4 falls on Sat → NYSE observes on Fri July 3
    '2026-09-07', '2026-11-26', '2026-12-25',
]);

/**
 * Returns true if today is the first trading day back after a market holiday.
 * Checks the 4 previous calendar days for a holiday (covers Fri holiday → Mon return).
 */
function isPostHolidayReturnDay() {
    const toKey = (d) => d.toISOString().slice(0, 10);
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon ... 6=Sat
    // Only relevant on Monday (return from Fri holiday + weekend) or Tuesday (Mon holiday)
    if (dayOfWeek !== 1 && dayOfWeek !== 2) return false;
    // Check the 4 preceding calendar days for a holiday
    for (let i = 1; i <= 4; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        if (NYSE_HOLIDAYS.has(toKey(d))) return true;
    }
    return false;
}

/** Returns the macro release event for today/tomorrow, or null. */
function checkMacroReleaseWindow() {
    const toKey = (d) => d.toISOString().slice(0, 10);
    const today    = new Date();
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const todayKey    = toKey(today);
    const tomorrowKey = toKey(tomorrow);

    const events = [];
    if (CPI_RELEASE_DATES.has(todayKey))    events.push({ type: 'CPI',  timing: 'today',    date: todayKey });
    if (NFP_RELEASE_DATES.has(todayKey))    events.push({ type: 'NFP',  timing: 'today',    date: todayKey });
    if (CPI_RELEASE_DATES.has(tomorrowKey)) events.push({ type: 'CPI',  timing: 'tomorrow', date: tomorrowKey });
    if (NFP_RELEASE_DATES.has(tomorrowKey)) events.push({ type: 'NFP',  timing: 'tomorrow', date: tomorrowKey });
    return events; // empty array = no event
}

/**
 * Options Expiration (OPEX) — 3rd Friday of each month.
 * Gamma unwinding causes violent intraday reversals; swing setups unreliable.
 * Returns { isOpex, isOpexEve, date }.
 */
function checkOpexWindow() {
    const toKey = (d) => d.toISOString().slice(0, 10);

    function thirdFriday(year, month) {
        // month is 0-indexed (JS Date)
        const d = new Date(year, month, 1);
        const firstFriday = ((5 - d.getDay() + 7) % 7) + 1; // day-of-month for first Friday
        return new Date(year, month, firstFriday + 14);       // +14 = third Friday
    }

    const today    = new Date();
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);

    // Check current month and next (handles month boundaries)
    const candidates = [
        thirdFriday(today.getFullYear(), today.getMonth()),
        thirdFriday(today.getFullYear(), today.getMonth() + 1),
    ];

    const todayKey    = toKey(today);
    const tomorrowKey = toKey(tomorrow);

    for (const opexDate of candidates) {
        const opexKey = toKey(opexDate);
        if (opexKey === todayKey)    return { isOpex: true,  isOpexEve: false, date: opexKey };
        if (opexKey === tomorrowKey) return { isOpex: false, isOpexEve: true,  date: opexKey };
    }
    return { isOpex: false, isOpexEve: false, date: null };
}

// ─── GEOPOLITICAL RISK KEYWORDS ──────────────────────────────────────────────
// Matched against individual stock headlines. Keywords indicate macro-level
// shock events that render technical signals unreliable for that symbol.
const GEO_RISK_KEYWORDS = [
    'war', 'invasion', 'military strike', 'sanctions', 'tariff', 'trade war',
    'default', 'debt ceiling', 'government shutdown', 'martial law',
    'terrorist', 'assassination', 'nuclear', 'embargo', 'nationali',
];

// Default risk management configuration
const DEFAULT_RISK_CONFIG = {
    // Position sizing
    maxPositionSize: 0.10,        // Max 10% per stock (was 15% — reduced after June 16 over-deployment)
    minPositionSize: 0.02,        // Min 2% per position
    maxPortfolioRisk: 0.60,       // Max 60% invested (40% cash reserve)

    // Entry/Exit rules
    minBuyScore: 88,              // Quality floor: 88+ required; DB per-user value overrides this default
    stopLoss: -0.05,              // Hard stop at -5% from entry (was -7% — tightened 2026-07-02)
    trailingStopPercent: 0.06,    // Base trailing stop — overridden dynamically by getDynamicTrailingStop()
    takeProfitPercent: 0.20,      // Swing: full exit at 20% gain
    partialTakeProfitPercent: 0.08, // Swing: first 50% exit at 8% gain (reverted — 12% threshold never fired)
    earlyPartialProfitPercent: 0.05, // Swing: early 25% exit at 5% gain (aligns with 1:1 R:R at typical stop distances)

    // Risk limits
    maxOpenPositions: 4,          // Max 4 concurrent positions (was 8 — scale-appropriate for <$10K account)
    minMarketCap: 2000000000,     // Min $2B — covers mega cap + mid cap
    maxDailyTrades: 5,            // Max 5 trades per day (was 10)

    // Volatility management
    maxVix: 30,                   // Don't buy if VIX > 30
    reducePositionsVix: 25,       // Reduce exposure if VIX > 25

    // Diversification
    maxSectorAllocation: 0.20,    // Default fallback cap for unlisted sectors
    maxPositionsPerSector: 1,     // PANTHEON: max 1 position per sector — prevents mass stop-outs when one sector pulls back
    maxGrossExposurePct: 0.75,    // PANTHEON: max 75% of portfolio in open positions
    maxPortfolioBeta: 1.5,        // PANTHEON: halt new buys if weighted beta > 1.5
    dailyLossLimit: -300,         // Stop automation after $300 daily loss (was $1,000 — scale-appropriate)
    maxOrderNotional: 500,        // Hard cap per order: $500 (was $5,000 — prevents runaway buys)
    maxRiskPerTrade: 15,          // Risk-based sizing: cap so no trade risks more than $15 (0.3% of $5K)
    emergencyStopEnabled: false,
    preferredSectors: ['Technology', 'Healthcare', 'Financials', 'Consumer']
};

// ─── SECTOR TRADE PROFILES ────────────────────────────────────────────────────
// Each profile controls stop/target ATR multipliers and the minimum aiScore a stock
// in that sector must reach before it's promoted to a trade opportunity.
//
// AGGRESSIVE — tech/growth names move fast and far; wider stop geometry prevents
//              being shaken out on normal intraday noise, bigger targets capture the move.
// DEFENSIVE  — utilities, staples, REITs are slow-moving, rate-sensitive, and rarely
//              produce Weinstein Stage-2 / momentum signals. minScore of 78 means they
//              almost never pass — eliminating wasted ORACLE budget — without hard-coding
//              any symbol exclusion list that would need manual maintenance.
// STANDARD   — everything else uses the default ATR×1.5/×3 geometry.
const SECTOR_TRADE_PROFILES = {
    AGGRESSIVE: {
        name: 'AGGRESSIVE',
        sectors: new Set(['Technology', 'Information Technology', 'Consumer Discretionary', 'Communication Services']),
        stopMult:   2.0,    // ATR × 2.0 — high-beta stocks need breathing room
        targetMult: 4.0,    // ATR × 4.0 — big momentum moves justify wider targets
        minScore:   65,
        minVolume:  500000, // liquid names only (high-beta micro-caps are noise)
        maxStopPct: 0.075   // cap: 7.5% max stop — ATR×2.0 on a 3.5% ATR stock = 7%, must allow this room
    },
    DEFENSIVE: {
        name: 'DEFENSIVE',
        sectors: new Set(['Utilities', 'Consumer Staples', 'Consumer Defensive', 'Real Estate']),
        stopMult:   1.2,    // ATR × 1.2 — tight, small ATR stocks
        targetMult: 2.0,    // ATR × 2.0 — limited momentum upside
        minScore:   78,     // high bar → effectively opt-out of momentum scanner
        minVolume:  150000, // utilities naturally trade lower volume
        maxStopPct: 0.04    // 4% max — low-vol defensive; more than enough for ATR×1.2
    },
    STANDARD: {
        name: 'STANDARD',
        sectors: null,      // fallback for all other sectors
        stopMult:   1.5,
        targetMult: 3.0,
        minScore:   65,
        minVolume:  200000,
        maxStopPct: 0.06    // 6% max — ATR×1.5 on a 3.5% ATR stock = 5.25%, need some headroom
    }
};

function getSectorTradeProfile(sector) {
    if (!sector || sector === 'Unknown') return SECTOR_TRADE_PROFILES.STANDARD;
    if (SECTOR_TRADE_PROFILES.AGGRESSIVE.sectors.has(sector)) return SECTOR_TRADE_PROFILES.AGGRESSIVE;
    if (SECTOR_TRADE_PROFILES.DEFENSIVE.sectors.has(sector))  return SECTOR_TRADE_PROFILES.DEFENSIVE;
    return SECTOR_TRADE_PROFILES.STANDARD;
}

// Per-sector max portfolio allocation (fraction of total portfolio value).
// Tech capped tighter because AAPL/MSFT/NVDA/AMD/AVGO move together — 1 rally = 5 "signals".
// Utilities capped tightest — single macro driver (rates), no diversification benefit within sector.
// Falls back to DEFAULT_RISK_CONFIG.maxSectorAllocation for any sector not listed here.
const SECTOR_MAX_ALLOCATION = {
    'Technology':             0.25,
    'Information Technology': 0.25,
    'Utilities':              0.10,
    'Healthcare':             0.15,
    'Health Care':            0.15,
    'Financials':             0.15,
    'Financial Services':     0.15,
    'Energy':                 0.15,
    'Consumer Discretionary': 0.20,
    'Consumer Staples':       0.20,
    'Consumer':               0.20,
    'Industrials':            0.20,
    'Communication Services': 0.20,
    'Real Estate':            0.15,
    'Materials':              0.15,
    'Basic Materials':        0.15,
};

/**
 * Get user's risk configuration from database
 */
async function getUserRiskConfig(userId) {
    try {
        await ensurePhase0Schema();
        const result = await query(
            'SELECT * FROM risk_configs WHERE user_id = $1',
            [userId]
        );
        
        if (result.rows[0]) {
            const dbConfig = result.rows[0];
            return {
                maxPositionSize: parseFloat(dbConfig.max_position_size),
                minPositionSize: parseFloat(dbConfig.min_position_size),
                maxPortfolioRisk: parseFloat(dbConfig.max_portfolio_risk),
                minBuyScore: dbConfig.min_buy_score,
                stopLoss: parseFloat(dbConfig.stop_loss),
                trailingStopPercent: parseFloat(dbConfig.trailing_stop_percent),
                takeProfitPercent: parseFloat(dbConfig.take_profit_percent),
                partialTakeProfitPercent: parseFloat(dbConfig.partial_take_profit_percent),
                maxOpenPositions: dbConfig.max_open_positions,
                minMarketCap: dbConfig.min_market_cap,
                maxDailyTrades: dbConfig.max_daily_trades,
                maxVix: parseFloat(dbConfig.max_vix),
                reducePositionsVix: parseFloat(dbConfig.reduce_positions_vix),
                maxSectorAllocation: parseFloat(dbConfig.max_sector_allocation),
                dailyLossLimit: parseFloat(dbConfig.daily_loss_limit),
                maxOrderNotional: parseFloat(dbConfig.max_order_notional),
                maxRiskPerTrade: dbConfig.max_risk_per_trade != null ? parseFloat(dbConfig.max_risk_per_trade) : DEFAULT_RISK_CONFIG.maxRiskPerTrade,
                maxGrossExposurePct: parseFloat(dbConfig.max_gross_exposure_pct ?? 0.75),
                emergencyStopEnabled: dbConfig.emergency_stop_enabled === true,
                extendedHoursEnabled: dbConfig.extended_hours_enabled === true
            };
        }

        return DEFAULT_RISK_CONFIG;
    } catch (err) {
        logger.error('Error getting risk config', { error: err.message, userId });
        return DEFAULT_RISK_CONFIG;
    }
}

// ─── BLEEDING SYMBOL GATE ─────────────────────────────────────────────────────
/**
 * Returns the set of symbols that are consistently losing for this user
 * over the last 30 days. A symbol is "bleeding" when:
 *   - It has ≥ 3 completed sell trades in 30 days, AND
 *   - Its loss rate is ≥ 60%  (more than 3 losses per 5 trades)
 *
 * Cached per-user for 4 hours so this doesn't hit DB on every scan cycle.
 * @param {string} userId
 * @returns {Set<string>} — set of blocked symbol strings (uppercase)
 */
const _bleedingSymbolsCache = new Map(); // userId → { symbols: Set, fetchedAt: Date }
// Prevents duplicate sell executions when position manager runs concurrently.
// Key format: `${userId}:${symbol}`
const _sellInProgress = new Set();

// ─── ORDER RATE LIMITER ───────────────────────────────────────────────────────
// Tracks how many buy orders have been submitted today per symbol and per account.
// Resets automatically when the calendar date changes (checked on each access).
// Configurable via .env:
//   MAX_ORDERS_PER_SYMBOL_PER_DAY=1   (default: 1 — one entry attempt per ticker per day)
//   MAX_ORDERS_PER_ACCOUNT_PER_DAY=20 (default: 20 — caps total daily order volume)
const _orderCountBySymbol  = new Map(); // `${userId}:${symbol}` → { date, count }
const _orderCountByAccount = new Map(); // userId → { date, count }

function _getRateLimitDate() { return new Date().toISOString().slice(0, 10); }

function _incrementOrderCount(userId, symbol) {
    const today = _getRateLimitDate();
    const symKey = `${userId}:${symbol}`;
    const symEntry = _orderCountBySymbol.get(symKey);
    _orderCountBySymbol.set(symKey, {
        date: today,
        count: (symEntry?.date === today ? symEntry.count : 0) + 1
    });
    const accEntry = _orderCountByAccount.get(userId);
    _orderCountByAccount.set(userId, {
        date: today,
        count: (accEntry?.date === today ? accEntry.count : 0) + 1
    });
}

function _checkOrderRateLimit(userId, symbol) {
    const today = _getRateLimitDate();
    const maxPerSymbol  = parseInt(process.env.MAX_ORDERS_PER_SYMBOL_PER_DAY  || '1',  10);
    const maxPerAccount = parseInt(process.env.MAX_ORDERS_PER_ACCOUNT_PER_DAY || '20', 10);

    const symEntry = _orderCountBySymbol.get(`${userId}:${symbol}`);
    if (symEntry?.date === today && symEntry.count >= maxPerSymbol) {
        return { allowed: false, reason: `symbol daily limit (${maxPerSymbol})`, count: symEntry.count };
    }
    const accEntry = _orderCountByAccount.get(userId);
    if (accEntry?.date === today && accEntry.count >= maxPerAccount) {
        return { allowed: false, reason: `account daily limit (${maxPerAccount})`, count: accEntry.count };
    }
    return { allowed: true };
}
// Rate-limits "AI TRADING STARTED" Telegram alert to once per hour per user.
// Key: userId, value: timestamp of last send
const _tradingStartedLastSent = new Map();
// Persists exit-pending state ACROSS cycles so that a position that was just
// sold (but may still appear in DB while broker settles) doesn't re-trigger.
// Key: `${userId}:${symbol}`, Value: expiry timestamp (ms)
const _exitPending = new Map();

// ─── SYSTEM HEALTH MULTIPLIER CACHE ──────────────────────────────────────────
// 30-min TTL; aggregates win-rate trend + alpha decay signal into a size multiplier.
// userId → { multiplier: number, fetchedAt: number }
const _systemHealthCache = new Map();

// ─── DISTRESS MODE TRACKER ────────────────────────────────────────────────────
// Tracks whether distress mode was active last cycle so we can alert on recovery.
// userId → boolean
const _distressActiveCache = new Map();

// ─── GATE TRIGGER STATS ───────────────────────────────────────────────────────
// Per-user daily counters for each gate — reset when the date changes.
// Used by EOD digest to report how often each gate blocked trading.
// userId → { date: string, edgeGate: number, volumeGate: number, regimeCap: number, distressMode: number }
const _gateStats = new Map();

function _bumpGateStat(userId, gate) {
    const today = new Date().toDateString();
    let s = _gateStats.get(userId);
    if (!s || s.date !== today) {
        s = { date: today, edgeGate: 0, volumeGate: 0, regimeCap: 0, distressMode: 0 };
        _gateStats.set(userId, s);
    }
    s[gate] = (s[gate] || 0) + 1;
}

/** Returns today's gate trigger counts for a user (null if no data yet). */
function getGateStats(userId) {
    const s = _gateStats.get(userId);
    if (!s) return null;
    const today = new Date().toDateString();
    return s.date === today ? { ...s } : null;
}

// ─── TRADE REJECTION LOG — shadow-portfolio groundwork ────────────────────────
// Records which gate blocked a candidate that had already cleared the score
// threshold (a real opportunity, not just noise). Global (not per-user) — last
// gate to reject a symbol on a given day wins via upsert. Fire-and-forget: never
// let logging a rejection reason block or slow down the buy loop itself.
function _recordRejection(symbol, reason, detail) {
    const today = new Date().toISOString().slice(0, 10);
    query(`
        INSERT INTO trade_rejection_log (rejection_date, symbol, reason, detail)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (rejection_date, symbol) DO UPDATE SET
            reason     = EXCLUDED.reason,
            detail     = EXCLUDED.detail,
            updated_at = NOW()
    `, [today, symbol, reason, detail || null]).catch(err => {
        logger.debug('[RejectionLog] Failed to record rejection', { symbol, reason, error: err.message });
    });
}

async function getBleedingSymbols(userId) {
    const cached = _bleedingSymbolsCache.get(userId);
    if (cached && (Date.now() - cached.fetchedAt) < 4 * 60 * 60 * 1000) {
        return cached.symbols;
    }
    try {
        const since = new Date();
        since.setDate(since.getDate() - 30);
        const res = await query(`
            WITH buy_avg AS (
                SELECT user_id, symbol, AVG(price) AS avg_buy_price
                FROM trades WHERE action = 'BUY' AND trade_date >= $2
                GROUP BY user_id, symbol
            ),
            pnl_trades AS (
                SELECT s.symbol,
                       CASE WHEN (s.total - b.avg_buy_price * s.quantity) > 0 THEN 1 ELSE 0 END AS win,
                       CASE WHEN (s.total - b.avg_buy_price * s.quantity) <= 0 THEN 1 ELSE 0 END AS loss
                FROM trades s
                JOIN buy_avg b ON s.user_id = b.user_id AND s.symbol = b.symbol
                WHERE s.action = 'SELL' AND s.user_id = $1 AND s.trade_date >= $2
            )
            SELECT symbol,
                   SUM(win)  AS wins,
                   SUM(loss) AS losses,
                   COUNT(*)  AS total
            FROM pnl_trades
            GROUP BY symbol
            HAVING COUNT(*) >= 3 AND SUM(loss)::float / COUNT(*) >= 0.6
        `, [userId, since.toISOString().split('T')[0]]);

        const blocked = new Set(res.rows.map(r => r.symbol.toUpperCase()));
        _bleedingSymbolsCache.set(userId, { symbols: blocked, fetchedAt: Date.now() });
        if (blocked.size > 0) {
            logger.warn('[BleedingGate] Blocking chronically losing symbols', {
                userId, symbols: [...blocked]
            });
        }
        return blocked;
    } catch (err) {
        logger.error('[BleedingGate] Error fetching bleeding symbols', { error: err.message });
        return new Set();
    }
}

/**
 * Meta-strategy health multiplier (30-min cache).
 *
 * Reads recent trade outcomes and alpha-decay signals to produce a position-size
 * multiplier between 0.5 (system under stress) and 1.0 (fully healthy).
 *
 * Signal scoring:
 *   -0.15  recent 7-day WR < 40% AND prior 7-day WR >= 50%   (short-term decline)
 *   -0.15  overall 14-day WR < 35%                            (prolonged weakness)
 *   -0.20  ≥2 setup families with alpha decay (30d WR drops >15 pts vs prior 60d)
 *
 * Scores sum; multiplier = max(0.5, 1.0 + total_penalty).
 */
async function getSystemHealthMultiplier(userId) {
    const cached = _systemHealthCache.get(userId);
    if (cached && (Date.now() - cached.fetchedAt) < 30 * 60 * 1000) {
        return cached.multiplier;
    }

    let multiplier = 1.0;
    try {
        const { query } = require('../config/database');

        // Recent win-rate trend: last 7 days vs prior 7 days
        const wrRes = await query(`
            SELECT
                ROUND(AVG(CASE WHEN created_at >= NOW() - INTERVAL '7 days'  AND pnl IS NOT NULL
                               THEN CASE WHEN pnl > 0 THEN 100.0 ELSE 0 END END)::numeric, 1) AS wr_recent,
                ROUND(AVG(CASE WHEN created_at <  NOW() - INTERVAL '7 days'
                               AND  created_at >= NOW() - INTERVAL '14 days' AND pnl IS NOT NULL
                               THEN CASE WHEN pnl > 0 THEN 100.0 ELSE 0 END END)::numeric, 1) AS wr_prior,
                ROUND(AVG(CASE WHEN created_at >= NOW() - INTERVAL '14 days' AND pnl IS NOT NULL
                               THEN CASE WHEN pnl > 0 THEN 100.0 ELSE 0 END END)::numeric, 1) AS wr_14d,
                COUNT(CASE WHEN created_at >= NOW() - INTERVAL '7 days' AND pnl IS NOT NULL THEN 1 END) AS n_recent
            FROM trade_decision_journal
            WHERE user_id = $1 AND decision_phase = 'EXIT'
        `, [userId]);

        const { wr_recent, wr_prior, wr_14d, n_recent } = wrRes.rows[0] || {};
        const wrRecent = parseFloat(wr_recent);
        const wrPrior  = parseFloat(wr_prior);
        const wr14d    = parseFloat(wr_14d);
        const nRecent  = parseInt(n_recent) || 0;

        if (nRecent >= 3 && !isNaN(wrRecent) && !isNaN(wrPrior) && wrPrior >= 50 && wrRecent < 40) {
            multiplier -= 0.15; // short-term decline
        }
        if (nRecent >= 3 && !isNaN(wr14d) && wr14d < 35) {
            multiplier -= 0.15; // prolonged weakness
        }

        // Alpha decay across setup families (30d vs prior 60d)
        const decayRes = await query(`
            SELECT
                COALESCE(setup_family, 'unknown') AS setup_family,
                SUM(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END)               AS n_30d,
                SUM(CASE WHEN created_at >= NOW() - INTERVAL '30 days' AND pnl > 0 THEN 1 ELSE 0 END)   AS w_30d,
                SUM(CASE WHEN created_at <  NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END)               AS n_prior,
                SUM(CASE WHEN created_at <  NOW() - INTERVAL '30 days' AND pnl > 0 THEN 1 ELSE 0 END)   AS w_prior
            FROM trade_decision_journal
            WHERE user_id = $1 AND decision_phase = 'EXIT' AND pnl IS NOT NULL
              AND created_at >= NOW() - INTERVAL '90 days'
            GROUP BY 1
        `, [userId]);

        let decayingFamilies = 0;
        for (const r of decayRes.rows) {
            const n30 = parseInt(r.n_30d) || 0;
            const nPr = parseInt(r.n_prior) || 0;
            if (n30 < 3 || nPr < 3) continue;
            const wr30 = Math.round(parseInt(r.w_30d) / n30 * 100);
            const wrPr = Math.round(parseInt(r.w_prior) / nPr * 100);
            if (wr30 < wrPr - 15) decayingFamilies++;
        }
        if (decayingFamilies >= 2) {
            multiplier -= 0.20; // broad alpha decay
        }

        multiplier = Math.max(0.5, multiplier);
        if (multiplier < 1.0) {
            logger.warn('[HealthMultiplier] System under stress — reducing position size', {
                userId, multiplier, wrRecent, wrPrior, wr14d, decayingFamilies
            });
        }
    } catch (err) {
        logger.warn('[HealthMultiplier] Error computing multiplier — defaulting to 1.0', { error: err.message });
        multiplier = 1.0;
    }

    _systemHealthCache.set(userId, { multiplier, fetchedAt: Date.now() });
    return multiplier;
}

// ─── KELLY CRITERION POSITION SIZING ─────────────────────────────────────────
/**
 * Calculate optimal position size using half-Kelly Criterion.
 *
 * Kelly fraction  = W - (1-W)/R   where W = win rate, R = avg win / avg loss
 * Half-Kelly      = Kelly * 0.5   (standard safety factor)
 * Result is capped at maxPct of bankroll (default 20%).
 *
 * Returns null if insufficient data — caller should fall back to default sizing.
 *
 * @param {number} winRate    — historical win rate as percentage (e.g. 55)
 * @param {number} avgWin     — average dollar gain per winning trade (positive)
 * @param {number} avgLoss    — average dollar loss per losing trade  (negative)
 * @param {number} bankroll   — total account value in dollars
 * @param {number} maxPct     — hard cap on position as fraction of bankroll
 * @returns {number|null}     — position size in dollars, or null
 */
function kellyPositionSize(winRate, avgWin, avgLoss, bankroll, maxPct = 0.20) {
    if (winRate == null || avgWin == null || avgLoss == null || bankroll <= 0) return null;
    const W = winRate / 100;
    const absLoss = Math.abs(avgLoss);
    if (absLoss === 0) return null;
    const R = avgWin / absLoss;           // reward-to-risk ratio
    const kelly = W - (1 - W) / R;       // Kelly fraction
    const halfKelly = kelly * 0.5;        // half-Kelly for robustness
    const fraction = Math.max(0, Math.min(halfKelly, maxPct));
    return bankroll * fraction;
}

function deriveStockSetupFamily({ momentum, relativeStrength, highProximity, rsi, stochRSI, macdSignal, newsSentiment, distFromSma20Pct }) {
    if (relativeStrength > 8 && highProximity >= 0.95) {
        return 'breakout_leader';
    }

    if (rsi < 35 || (stochRSI !== null && stochRSI < 20)) {
        // Oversold AND pulled back to SMA20 zone → cleaner mean reversion setup
        if (distFromSma20Pct !== undefined && distFromSma20Pct <= -3 && distFromSma20Pct >= -15) {
            return 'mean_reversion_bounce';
        }
        return 'oversold_reversal';
    }

    if (momentum > 0.01 && macdSignal === 'Bullish') {
        return 'trend_following';
    }

    if (newsSentiment >= 35 && momentum > 0) {
        return 'news_momentum';
    }

    return 'quality_continuation';
}

// ─── CONSECUTIVE LOSS CIRCUIT BREAKER ────────────────────────────────────────
/**
 * Check for consecutive losses and return a size multiplier and halt flag.
 * Rules (env-configurable fallbacks):
 *   streak >= CIRCUIT_HALT_STREAK (default 5) → halt new buys
 *   streak >= CIRCUIT_REDUCE_STREAK (default 3) → halve position sizes
 *
 * @returns {{ multiplier: number, halt: boolean, streak: number }}
 */
async function checkLossStreakBreaker(userId) {
    const haltAt   = parseInt(process.env.CIRCUIT_HALT_STREAK   || '5');
    const reduceAt = parseInt(process.env.CIRCUIT_REDUCE_STREAK || '3');

    const streak = await performanceService.getConsecutiveLosses(userId);

    if (streak >= haltAt) {
        logger.warn('[CircuitBreaker] HALT — consecutive losses reached halt threshold', {
            userId, streak, haltAt
        });
        return { multiplier: 0, halt: true, streak };
    }
    if (streak >= reduceAt) {
        logger.warn('[CircuitBreaker] REDUCE — consecutive losses, halving position sizes', {
            userId, streak, reduceAt
        });
        return { multiplier: 0.5, halt: false, streak };
    }
    return { multiplier: 1.0, halt: false, streak };
}

// ─── CORRELATION RISK MATRIX ──────────────────────────────────────────────────
/**
 * Compute Pearson correlation between two return series of equal length.
 */
function pearsonCorrelation(a, b) {
    const n = a.length;
    if (n < 10) return 0;
    const meanA = a.reduce((s, v) => s + v, 0) / n;
    const meanB = b.reduce((s, v) => s + v, 0) / n;
    let num = 0, denomA = 0, denomB = 0;
    for (let i = 0; i < n; i++) {
        const da = a[i] - meanA;
        const db = b[i] - meanB;
        num    += da * db;
        denomA += da * da;
        denomB += db * db;
    }
    const denom = Math.sqrt(denomA * denomB);
    return denom === 0 ? 0 : num / denom;
}

/**
 * Fetch 60-day daily returns for a symbol (cached 4 hours).
 * Returns array of log-returns or empty array on failure.
 */
async function getReturns60d(symbol) {
    const cacheKey = `returns60d_${symbol}`;
    const cached = cacheService.get(cacheKey);
    if (cached) return cached;

    try {
        const bars = await dataProvider.getBars(symbol, '1d', 70);
        const closes = bars.map(b => b.close).filter(Boolean);
        const returns = [];
        for (let i = 1; i < closes.length; i++) {
            returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
        }
        cacheService.set(cacheKey, returns, 4 * 60 * 60 * 1000);
        return returns;
    } catch {
        return [];
    }
}

/**
 * Fetch 60-day SPY return series (cached 15 min — shared with beta computations).
 */
async function getSPYReturns60d() {
    const cacheKey = 'spy_returns_60d';
    const cached = cacheService.get(cacheKey);
    if (cached) return cached;

    try {
        const bars = await dataProvider.getBars('SPY', '1d', 70);
        const closes = bars.map(b => b.close).filter(Boolean);
        const returns = [];
        for (let i = 1; i < closes.length; i++) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
        cacheService.set(cacheKey, returns, 15 * 60 * 1000);
        return returns;
    } catch {
        return [];
    }
}

/** Compute beta of stock returns relative to market returns. Returns 1.0 on insufficient data. */
function computeBeta(stockReturns, marketReturns) {
    const len = Math.min(stockReturns.length, marketReturns.length);
    if (len < 10) return 1.0;

    const s = stockReturns.slice(-len);
    const m = marketReturns.slice(-len);
    const meanS = s.reduce((a, b) => a + b, 0) / len;
    const meanM = m.reduce((a, b) => a + b, 0) / len;

    let cov = 0, varM = 0;
    for (let i = 0; i < len; i++) {
        cov  += (s[i] - meanS) * (m[i] - meanM);
        varM += (m[i] - meanM) * (m[i] - meanM);
    }
    return varM === 0 ? 1.0 : Math.max(0, Math.min(4, cov / varM)); // clamp 0-4
}

/**
 * Compute portfolio-level beta (weighted by market value) relative to SPY.
 * Caps at 10 holdings to avoid excessive API calls.
 */
async function computePortfolioBeta(holdings, totalPortfolioValue) {
    if (holdings.length === 0 || totalPortfolioValue <= 0) return 0;

    const spyReturns = await getSPYReturns60d().catch(() => []);
    if (spyReturns.length < 10) return 1.0;

    const tracked = holdings.slice(0, 10);
    const stockReturnsList = await Promise.all(tracked.map(h => getReturns60d(h.symbol)));

    let weightedBeta = 0;
    tracked.forEach((h, i) => {
        const weight = (h.marketValue || 0) / totalPortfolioValue;
        const beta   = computeBeta(stockReturnsList[i], spyReturns);
        weightedBeta += weight * beta;
    });
    return Number(weightedBeta.toFixed(2));
}

/**
 * Returns true if newSymbol is correlated (> threshold) with too many existing holdings.
 * Prevents over-concentration in stocks that move together.
 *
 * @param {string[]} heldSymbols    — symbols currently in portfolio
 * @param {string}   newSymbol      — candidate to buy
 * @param {number}   threshold      — correlation threshold (default 0.70)
 * @param {number}   maxCorrelated  — max holdings that can be correlated with new (default 3)
 */
async function isTooCorrelated(heldSymbols, newSymbol, threshold = 0.70, maxCorrelated = 3) {
    if (heldSymbols.length === 0) return false;

    try {
        const [newReturns, ...heldReturns] = await Promise.all([
            getReturns60d(newSymbol),
            ...heldSymbols.slice(0, 15).map(s => getReturns60d(s)) // cap at 15 to limit calls
        ]);

        if (newReturns.length < 10) return false;

        let correlatedCount = 0;
        for (let i = 0; i < heldReturns.length; i++) {
            const h = heldReturns[i];
            if (h.length < 10) continue;
            // Align lengths
            const len = Math.min(newReturns.length, h.length);
            const corr = pearsonCorrelation(
                newReturns.slice(-len),
                h.slice(-len)
            );
            if (corr > threshold) correlatedCount++;
            if (correlatedCount >= maxCorrelated) return true;
        }
        return false;
    } catch {
        return false; // don't block on error
    }
}

// High-water mark per userId — reset on process restart (safe: resets protection to current value)
const _portfolioPeaks = new Map();

/**
 * 3-level portfolio drawdown circuit breaker (PANTHEON RISK_POLICY).
 *
 * Level 1 — REDUCE  (drawdown_reduce_pct,  default  5%): halve new position sizes.
 * Level 2 — PAPER   (drawdown_paper_pct,   default 10%): block live new buys; manage exits only.
 * Level 3 — HALT    (drawdown_halt_pct,    default 15%): stop ALL new buy activity.
 *
 * Returns { halt, paperOnly, reduceSizing, drawdownPct }
 * Callers check halt/paperOnly before placing any new buy; reduceSizing before sizing.
 */
async function checkMaxDrawdown(userId, currentPortfolioValue) {
    try {
        const REDUCE_PCT = parseFloat(process.env.DRAWDOWN_REDUCE_PCT || '5');
        const PAPER_PCT  = parseFloat(process.env.DRAWDOWN_PAPER_PCT  || '10');
        const HALT_PCT   = parseFloat(process.env.MAX_DRAWDOWN_PCT    || '15');

        const peak = _portfolioPeaks.get(userId) || currentPortfolioValue;

        if (currentPortfolioValue > peak) {
            _portfolioPeaks.set(userId, currentPortfolioValue);
            return { halt: false, paperOnly: false, reduceSizing: false, drawdownPct: 0 };
        }

        const drawdownPct = peak > 0 ? ((peak - currentPortfolioValue) / peak) * 100 : 0;
        _portfolioPeaks.set(userId, peak);

        // Level 3 — HALT
        if (drawdownPct >= HALT_PCT) {
            logger.error('[DrawdownBreaker] HALT — max drawdown exceeded', {
                userId, drawdownPct: drawdownPct.toFixed(2), limit: HALT_PCT
            });
            alertService.sendMessage(userId,
                `🚨 *DRAWDOWN HALT (Level 3)*\n` +
                `Portfolio dropped ${drawdownPct.toFixed(1)}% from peak ($${peak.toFixed(0)} → $${currentPortfolioValue.toFixed(0)})\n` +
                `Limit: ${HALT_PCT}% — *All new buys halted. Manage exits only.*`
            ).catch(() => {});
            return { halt: true, paperOnly: true, reduceSizing: true, drawdownPct };
        }

        // Level 2 — PAPER only (block live buys)
        if (drawdownPct >= PAPER_PCT) {
            logger.warn('[DrawdownBreaker] PAPER — drawdown exceeds reduce threshold, live buys blocked', {
                userId, drawdownPct: drawdownPct.toFixed(2), limit: PAPER_PCT
            });
            alertService.sendMessage(userId,
                `⚠️ *DRAWDOWN PAPER MODE (Level 2)*\n` +
                `Portfolio dropped ${drawdownPct.toFixed(1)}% from peak.\n` +
                `Live new buys blocked until recovery above ${PAPER_PCT}%.`
            ).catch(() => {});
            return { halt: false, paperOnly: true, reduceSizing: true, drawdownPct };
        }

        // Level 1 — REDUCE position sizes by 50%
        if (drawdownPct >= REDUCE_PCT) {
            logger.warn('[DrawdownBreaker] REDUCE — position sizes halved', {
                userId, drawdownPct: drawdownPct.toFixed(2), limit: REDUCE_PCT
            });
            return { halt: false, paperOnly: false, reduceSizing: true, drawdownPct };
        }

        return { halt: false, paperOnly: false, reduceSizing: false, drawdownPct };
    } catch (error) {
        logger.error('[DrawdownBreaker] Error checking drawdown', { error: error.message, userId });
        return { halt: false, paperOnly: false, reduceSizing: false, drawdownPct: 0 };
    }
}

/**
 * Check daily loss limit (circuit breaker)
 */
async function checkDailyLossLimit(userId, riskConfig, totalPortfolioValue = 0) {
    try {
        const dailyLoss = await performanceService.getTodayLoss(userId);

        // Dynamic limit: 1% of current account value, minimum $15 floor.
        // This scales correctly as the account grows — a fixed $25 stops trading
        // after a single bad fill on a small account, while 1% scales proportionally.
        const onePct   = totalPortfolioValue * 0.01;
        const lossLimit = -(Math.max(15, onePct));

        if (dailyLoss <= lossLimit) {
            logger.error('Daily loss limit reached', { userId, dailyLoss, lossLimit, accountValue: totalPortfolioValue });
            alertService.alertDailyLossLimitReached(userId, dailyLoss).catch(() => {});
            return true;
        }
        if (dailyLoss <= lossLimit * 0.75) {
            alertService.alertDailyLossWarning(userId, dailyLoss, lossLimit).catch(() => {});
        }
        return false;
    } catch (error) {
        logger.error('Error checking daily loss limit', { error: error.message, userId });
        return false;
    }
}

async function checkWeeklyLossLimit(userId, totalPortfolioValue, sessionRiskConfig = {}) {
    try {
        const weeklyPnl  = await performanceService.getWeeklyLoss(userId);
        const weeklyLimit = -(totalPortfolioValue * (sessionRiskConfig?.weeklyLossLimit || 0.10)); // PANTHEON: 10% weekly max loss
        if (weeklyPnl <= weeklyLimit) {
            logger.error('[SHIELD] Weekly loss limit hit — halting trading until Monday', {
                userId, weeklyPnl: weeklyPnl.toFixed(2), limit: weeklyLimit.toFixed(2)
            });
            alertService.sendMessage(userId,
                `🚨 *WEEKLY LOSS LIMIT REACHED*\n` +
                `Week P&L: $${weeklyPnl.toFixed(0)} (limit: $${weeklyLimit.toFixed(0)})\n` +
                `Portfolio: $${totalPortfolioValue.toFixed(0)}\n` +
                `*All new trades halted until Monday.*`
            ).catch(() => {});
            return true;
        }
        if (weeklyPnl <= weeklyLimit * 0.75) {
            logger.warn('[SHIELD] Weekly loss at 75% of limit', {
                userId, weeklyPnl: weeklyPnl.toFixed(2), limit: weeklyLimit.toFixed(2)
            });
        }
        return false;
    } catch (error) {
        logger.error('[SHIELD] Error checking weekly loss limit', { error: error.message, userId });
        return false;
    }
}

/**
 * Check if market is open (NYSE hours: 9:30 AM - 4:00 PM ET, Mon-Fri)
 * Uses Intl.DateTimeFormat to handle DST (EDT=UTC-4, EST=UTC-5) automatically.
 */
function isMarketOpen() {
    const now = new Date();

    // Get day-of-week in ET to correctly detect weekends in ET
    const etDayFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short'
    });
    const dayStr = etDayFormatter.format(now);
    if (dayStr === 'Sat' || dayStr === 'Sun') return false;

    // Get hour + minute in ET (handles EDT and EST automatically)
    const etTimeFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
    });
    const parts = etTimeFormatter.formatToParts(now);
    const etHour = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const etMinute = parseInt(parts.find(p => p.type === 'minute').value, 10);
    const etTime = etHour + etMinute / 60;

    // NYSE regular session: 9:30 AM – 4:00 PM ET
    return etTime >= 9.5 && etTime < 16;
}

/**
 * Get current VIX level
 */
async function getVixLevel() {
    try {
        const quote = await dataProvider.getQuote('^VIX');
        const vixLevel = quote.price || 15;
        logger.info('VIX level fetched', { vixLevel, provider: dataProvider.providerKey });
        return vixLevel;
    } catch (error) {
        logger.warn('Could not fetch VIX, assuming normal level', { error: error.message });
        return 15;
    }
}

/**
 * Get SPY's 20-day return for Relative Strength calculation.
 * Cached for 15 minutes so we only fetch once per scan cycle.
 */
async function getSPY20DayReturn() {
    const cached = cacheService.get('spy_20d_return');
    if (cached !== null) return cached;

    try {
        const bars = await dataProvider.getBars('SPY', '1d', 30);
        const closes = bars.map(b => b.close).filter(Boolean);
        if (closes.length < 20) return 0;
        const ret = ((closes[closes.length - 1] - closes[closes.length - 20]) / closes[closes.length - 20]) * 100;
        cacheService.set('spy_20d_return', ret, 15 * 60 * 1000);
        return ret;
    } catch {
        return 0;
    }
}

async function getSPY5DayReturn() {
    const cached = cacheService.get('spy_5d_return');
    if (cached !== null) return cached;
    try {
        const bars = await dataProvider.getBars('SPY', '1d', 10);
        const closes = bars.map(b => b.close).filter(Boolean);
        if (closes.length < 5) return 0;
        const ret = ((closes[closes.length - 1] - closes[closes.length - 5]) / closes[closes.length - 5]) * 100;
        cacheService.set('spy_5d_return', ret, 15 * 60 * 1000);
        return ret;
    } catch {
        return 0;
    }
}

/**
 * Fetch short interest data for squeeze potential scoring.
 * Yahoo's defaultKeyStatistics returns shortRatio (days-to-cover)
 * and shortPercentOfFloat. Data updates bi-weekly; 4-hour in-process
 * cache means one fetch per stock per scan window.
 */
async function getShortInterestData(symbol) {
    const cacheKey = `short_int_${symbol}`;
    const cached = cacheService.get(cacheKey);
    if (cached !== null) return cached;
    try {
        // Route through yfClient (not the raw yahoo-finance2 instance at the top of this
        // file) so this joins the shared rate-limit circuit breaker like getDaysToEarnings
        // already does. Found 2026-07-29: this was the one per-symbol nightly-scan call
        // still hitting Yahoo directly and unconditionally on every one of 479 symbols,
        // with no awareness of (or contribution to) the shared breaker — it kept hammering
        // Yahoo through an active rate-limit block that every other call was correctly
        // backing off from, and its own 429s never tripped the breaker for anyone else.
        const summary = await require('../utils/yfClient').quoteSummary(symbol, { modules: ['defaultKeyStatistics'] });
        const ks = summary?.defaultKeyStatistics || {};
        const result = {
            shortRatio:          typeof ks.shortRatio          === 'number' ? ks.shortRatio          : null,
            shortPercentOfFloat: typeof ks.shortPercentOfFloat === 'number' ? ks.shortPercentOfFloat : null,
        };
        cacheService.set(cacheKey, result, 4 * 60 * 60 * 1000);
        return result;
    } catch {
        cacheService.set(cacheKey, null, 60 * 60 * 1000); // 1-hour miss cache
        return null;
    }
}

/**
 * Get days until the stock's next earnings report.
 * Returns null if unavailable, positive number = days until earnings,
 * 0 or negative = earnings passed or today.
 */
async function getDaysToEarnings(symbol, yahooFinanceInstance = null) {
    const cacheKey = `earnings_days_${symbol}`;
    const cached = cacheService.get(cacheKey);
    if (cached !== null) return cached;

    try {
        // Route through yfClient (not the raw yahoo-finance2 instance) unless an
        // explicit override is passed — gets its own caching plus the shared
        // rate-limit circuit breaker, instead of hitting Yahoo directly and
        // unconditionally on every single call with neither.
        const summary = yahooFinanceInstance
            ? await yahooFinanceInstance.quoteSummary(symbol, { modules: ['calendarEvents'] })
            : await require('../utils/yfClient').quoteSummary(symbol, { modules: ['calendarEvents'] });
        const earningsDate = summary?.calendarEvents?.earnings?.earningsDate?.[0];
        if (!earningsDate) {
            cacheService.set(cacheKey, null, 60 * 60 * 1000); // cache miss for 1hr
            return null;
        }
        const days = Math.ceil((new Date(earningsDate) - new Date()) / (1000 * 60 * 60 * 24));
        cacheService.set(cacheKey, days, 60 * 60 * 1000);
        return days;
    } catch {
        return null;
    }
}

/**
 * Fetch CANSLIM-relevant fundamentals (EPS & revenue growth).
 *
 * Cache hierarchy (fastest → most expensive):
 *   1. In-process memory (cacheService)  — 4-hour TTL, zero latency
 *   2. PostgreSQL fundamentals_cache     — 7-day TTL, survives restarts
 *   3. Yahoo Finance quoteSummary        — live fetch, writes back to both caches
 *
 * Fundamentals change quarterly; 7 days is safe and eliminates most API calls.
 */
async function getFundamentalsQuick(symbol) {
    const memKey = `fundamentals_quick_${symbol}`;
    const memHit = cacheService.get(memKey);
    if (memHit !== null) return memHit;

    // DB cache — check if fresh (< 7 days old)
    try {
        const { query: dbQuery } = require('../config/database');
        const dbRes = await dbQuery(
            `SELECT earnings_growth, revenue_growth, gross_margins, fetched_at
             FROM fundamentals_cache
             WHERE symbol = $1 AND fetched_at > NOW() - INTERVAL '7 days'`,
            [symbol]
        );
        if (dbRes.rows.length > 0) {
            const r = dbRes.rows[0];
            const result = {
                earningsGrowth: r.earnings_growth != null ? parseFloat(r.earnings_growth) : null,
                revenueGrowth:  r.revenue_growth  != null ? parseFloat(r.revenue_growth)  : null,
                grossMargins:   r.gross_margins   != null ? parseFloat(r.gross_margins)   : null,
            };
            cacheService.set(memKey, result, 4 * 60 * 60 * 1000);
            return result;
        }
    } catch { /* non-fatal — proceed to live fetch */ }

    // Live fetch from Yahoo Finance
    try {
        const summary = await yahooFinance.quoteSummary(symbol, { modules: ['financialData'] });
        const fd      = summary?.financialData || {};
        const result  = {
            earningsGrowth: typeof fd.earningsGrowth === 'number' ? fd.earningsGrowth : null,
            revenueGrowth:  typeof fd.revenueGrowth  === 'number' ? fd.revenueGrowth  : null,
            grossMargins:   typeof fd.grossMargins   === 'number' ? fd.grossMargins   : null,
        };
        cacheService.set(memKey, result, 4 * 60 * 60 * 1000);
        // Write-through to DB (fire-and-forget)
        setImmediate(async () => {
            try {
                const { query: dbQuery } = require('../config/database');
                await dbQuery(
                    `INSERT INTO fundamentals_cache
                         (symbol, fetched_at, earnings_growth, revenue_growth, gross_margins)
                     VALUES ($1, NOW(), $2, $3, $4)
                     ON CONFLICT (symbol) DO UPDATE SET
                         fetched_at      = NOW(),
                         earnings_growth = EXCLUDED.earnings_growth,
                         revenue_growth  = EXCLUDED.revenue_growth,
                         gross_margins   = EXCLUDED.gross_margins`,
                    [symbol, result.earningsGrowth, result.revenueGrowth, result.grossMargins]
                );
            } catch { /* non-fatal */ }
        });
        return result;
    } catch {
        return null;
    }
}

/**
 * Analyze a single stock with AI scoring
 *
 * Scoring breakdown (max ±points from base 50):
 *   Momentum        ±10  (today's % change)
 *   Volume          ±10  (vs 10-day avg volume)
 *   RSI             ±15  (via interpretRSI)
 *   Stochastic RSI  ±8   (RSI extreme confirmation)
 *   Williams %R     ±7   (momentum reversal early signal)
 *   MACD            ±10  (via interpretMACD)
 *   Bollinger Bands ±12  (via interpretBollingerBands)
 *   Relative Strength ±8 (stock vs SPY 20-day return)
 *   52-Week High    ±7   (proximity to yearly high)
 *   Earnings Risk   -15  (within 5 days of earnings)
 *   News Sentiment  ±8   (headline sentiment, configurable)
 *   VIX             ±10  (market volatility)
 *   Market Cap      ±5   (size quality)
 *   Weekly Align    ±8   (daily vs weekly trend agreement)
 *   Regime Align    ±8   (regime type confirmation)
 */

/**
 * Derive a weekly-timeframe signal from already-fetched daily bars.
 * Groups daily bars into calendar weeks (using bar.time), falls back to
 * every-5th-bar approximation when timestamps are absent.
 * Returns null if fewer than 5 weekly closes are available.
 *
 * Zero extra API calls — pure computation over existing data.
 */
function getWeeklySignalFromDailyBars(bars) {
    if (!bars || bars.length < 10) return null;

    // Group into calendar weeks — keep the LAST close of each week
    const weekMap = new Map();
    for (const bar of bars) {
        const ts = bar.time || bar.date;
        if (ts) {
            const d   = new Date(ts);
            const day = d.getDay() || 7;       // Sun=0 → 7, Mon=1 … Sat=6
            const mon = new Date(d);
            mon.setDate(d.getDate() - day + 1); // rewind to Monday
            const key = mon.toISOString().slice(0, 10);
            weekMap.set(key, bar.close);        // overwrite → last close of that week
        }
    }

    let weeklyCloses;
    if (weekMap.size >= 10) {
        weeklyCloses = Array.from(weekMap.values()).filter(c => c > 0);
    } else {
        // Fallback: sample every 5th daily close
        weeklyCloses = [];
        for (let i = 4; i < bars.length; i += 5) {
            if (bars[i].close > 0) weeklyCloses.push(bars[i].close);
        }
    }

    if (weeklyCloses.length < 5) return null;

    const latest   = weeklyCloses[weeklyCloses.length - 1];
    const wk4ago   = weeklyCloses[Math.max(0, weeklyCloses.length - 4)];
    const wma20    = weeklyCloses.length >= 20
        ? weeklyCloses.slice(-20).reduce((a, b) => a + b, 0) / 20
        : weeklyCloses.slice(-Math.floor(weeklyCloses.length / 2))
              .reduce((a, b) => a + b, 0) / Math.floor(weeklyCloses.length / 2);

    const return4w    = ((latest - wk4ago) / wk4ago) * 100;
    const aboveWma20  = latest > wma20;
    const bullish     = aboveWma20 && return4w > 0;
    const bearish     = !aboveWma20 && return4w < 0;

    return { latest, wma20, return4w, aboveWma20, bullish, bearish };
}

// Hard timeout for any single dataProvider call — Yahoo 429 retry loops can otherwise hang forever.
const _withQuoteTimeout = (promise, fallback, ms = 10000) =>
    Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(fallback), ms))]);

async function analyzeStockWithAI(symbol, vixLevel, yahooFinanceInstance = null, regime = null) {
    try {
        // Fetch core market data through provider abstraction to avoid Yahoo-specific 429 failures.
        // Each external call has a 10s hard timeout so a single stalled Yahoo request cannot
        // block the entire scan batch (and starve the DB connection pool).
        const [quote, historicalData, spyReturn, spyReturn5d, daysToEarnings, newsData, smartMoneyScore, fundamentals, redditData, globalSentiment, shortInterestData] = await Promise.all([
            _withQuoteTimeout(dataProvider.getQuote(symbol), null).catch(() => null),
            _withQuoteTimeout(dataProvider.getBars(symbol, '1d', 220), []).catch(() => []), // 220 days needed for 200-day SMA (Weinstein)
            getSPY20DayReturn(),
            getSPY5DayReturn(),
            getDaysToEarnings(symbol, yahooFinanceInstance),
            AI_NEWS_SCORING_ENABLED
                ? newsSentimentService.getNewsSentiment(symbol).catch(() => null)
                : Promise.resolve(null),
            sonarService.getSmartMoneyScore(symbol).catch(() => 0.5),
            getFundamentalsQuick(symbol).catch(() => null),        // CANSLIM — 4hr cache
            redditAltDataService.getMentionScore(symbol).catch(() => null), // alt data — 15min cache
            globalSentimentService.getGlobalSentiment().catch(() => null),  // ATLAS — 15min cache
            getShortInterestData(symbol).catch(() => null),        // squeeze potential — 4hr cache
        ]);

        if (!quote || !quote.price) {
            return null;
        }

        const price = quote.price;
        const change = quote.changePercent || 0;
        const volume = quote.volume || 0;
        const avgVolume = quote.avgVolume || volume;
        const marketCap = quote.marketCap || 0;
        const sector = sectorMetadata.resolveSector(symbol, quote.sector);
        const tradeProfile = getSectorTradeProfile(sector);

        const quotes = (historicalData || []).filter(q => q.close != null);
        const closes = quotes.map(q => q.close).filter(Boolean);
        const highs  = quotes.map(q => q.high).filter(Boolean);
        const lows   = quotes.map(q => q.low).filter(Boolean);

        if (closes.length < 50) return null; // require ~10 weeks of history; rejects micro-caps with 1-7 bars

        // 52-week high: prefer pre-baked field (Yahoo), otherwise compute from up to 252 trading
        // days of bar data (already loaded). Alpaca and Polygon snapshots return null for high52w.
        // Falling back to `price` caused every stock to score highProximity=1.0 (+7 pts inflation).
        const week52High = quote.high52w ||
            (highs.length > 0 ? Math.max(...highs.slice(-252)) : price);

        // PULSE — Gemini headline analysis (cached 30 min; returns null instantly when key absent)
        const headlines    = (newsData?.articles || []).map(a => a.title || a.headline || '').filter(Boolean);
        const geminiResult = await geminiPulseService.analyzeHeadlines(symbol, headlines).catch(() => null);

        // PROPHET — earnings direction forecast (only fires 15-45 days before earnings)
        const prophetResult = await prophetService.forecastEarnings(symbol, daysToEarnings, headlines, fundamentals).catch(() => null);

        // ORACLE patterns — synchronous, uses already-fetched OHLCV
        const oraclePattern = detectOraclePatterns(quotes);

        // ─── WEINSTEIN STAGE GATE ─────────────────────────────────────────────
        // Requires 220 days of history for reliable 200-day SMA.
        const sma50  = computeSMA(closes, 50);
        const sma150 = computeSMA(closes, 150);
        const sma200 = computeSMA(closes, 200);
        // 200-SMA rising = current 200-SMA > 200-SMA from 30 bars ago
        const sma200_30ago = closes.length >= 230
            ? computeSMA(closes.slice(0, closes.length - 30), 200)
            : null;
        const sma200Rising = sma200 !== null && sma200_30ago !== null && sma200 > sma200_30ago;

        const weinSteinStage = deriveWeinSteinStage(price, sma50, sma150, sma200, sma200Rising);
        if (weinSteinStage >= 3) {
            // Stage 3 = topping, Stage 4 = downtrend — PANTHEON hard skip
            logger.debug(`[Weinstein] Skipping ${symbol} — Stage ${weinSteinStage}`);
            return null;
        }

        // --- Core technical indicators (scalar / current-value versions) ---
        const rsi      = indicators.calculateSimpleRSI(closes);            // → number
        const macd     = indicators.calculateSimpleMACD(closes);           // → { macdLine, signalLine, histogram }
        const bb       = indicators.calculateBollingerBands(closes);       // → { upper, middle, lower, width, percentB }
        const stochRSI = indicators.calculateStochasticRSI(closes, 14, 14); // → number | null
        const williamsR = indicators.calculateWilliamsR(closes, highs, lows, 14); // → number | null
        const atr      = indicators.calculateSimpleATR(highs, lows, closes, 14); // → number

        // --- Interpretations & Signals ---
        const rsiInterpretation = indicators.interpretRSI(rsi);
        const macdInterpretation = indicators.interpretMACD(macd);
        const bbInterpretation = indicators.interpretBollingerBands(bb, quote.price);

        // 20-day & 5-day stock return for multi-timeframe Relative Strength vs SPY
        const price20dAgo    = closes[Math.max(0, closes.length - 20)];
        const price5dAgo     = closes[Math.max(0, closes.length - 5)];
        const stockReturn20d = price20dAgo > 0 ? ((price - price20dAgo) / price20dAgo) * 100 : 0;
        const stockReturn5d  = price5dAgo  > 0 ? ((price - price5dAgo)  / price5dAgo)  * 100 : 0;
        const relativeStrength   = stockReturn20d - spyReturn;    // 20-day RS
        const relativeStrength5d = stockReturn5d  - spyReturn5d;  // 5-day RS (short-term momentum check)

        // 52-week high proximity (how close price is to 52wk high)
        const highProximity = week52High > 0 ? price / week52High : 1;

        // ===================== SCORING =====================
        let aiScore = 50; // Base score
        const scoringLog = [];

        // 0. Trend Template — PANTHEON STEP 2: 5 MA conditions × 3 pts = max +15
        // Penalise -5 if no MA conditions met (sub-Stage-1 weakness).
        // ttScore hoisted so the ensemble gate below can read it.
        let ttScore = 0;
        {
            if (sma50  && price > sma50)            ttScore += 3;
            if (sma150 && price > sma150)            ttScore += 3;
            if (sma200 && price > sma200)            ttScore += 3;
            if (sma50  && sma200 && sma50 > sma200)  ttScore += 3;
            if (sma200Rising)                        ttScore += 3;
            if (ttScore > 0) {
                aiScore += ttScore;
                scoringLog.push(`TrendTemplate: +${ttScore} (${ttScore / 3}/5 MA conditions)`);
            } else {
                aiScore -= 5;
                scoringLog.push('TrendTemplate: -5 (no MA conditions met)');
            }
        }

        // 1. Momentum (±10) — 10-day Rate of Change, aligned with MACD/RSI timeframe
        // Single-day change caused false "strong down momentum" when a bullish stock pulled back
        // 1% on the scan day. 10-day ROC is consistent with the 12/26/9 MACD and RSI(14) windows.
        const price10dAgo = closes.length >= 10 ? closes[closes.length - 10] : closes[0];
        const momentum10d = price10dAgo > 0 ? (price - price10dAgo) / price10dAgo : 0;
        const momentum = momentum10d; // alias used by deriveStockSetupFamily, ensemble gate, and return object
        if      (momentum10d >  0.06)  { aiScore += 10; scoringLog.push(`Momentum: +10 (10d ROC +${(momentum10d*100).toFixed(1)}%, strong up)`); }
        else if (momentum10d >  0.02)  { aiScore += 6;  scoringLog.push(`Momentum: +6 (10d ROC +${(momentum10d*100).toFixed(1)}%)`); }
        else if (momentum10d >  0)     { aiScore += 2;  scoringLog.push(`Momentum: +2 (10d ROC +${(momentum10d*100).toFixed(1)}%)`); }
        else if (momentum10d < -0.06)  { aiScore -= 10; scoringLog.push(`Momentum: -10 (10d ROC ${(momentum10d*100).toFixed(1)}%, strong down)`); }
        else if (momentum10d < -0.02)  { aiScore -= 6;  scoringLog.push(`Momentum: -6 (10d ROC ${(momentum10d*100).toFixed(1)}%)`); }
        else                           { aiScore -= 2;  scoringLog.push(`Momentum: -2 (10d ROC ${(momentum10d*100).toFixed(1)}%)`); }

        // 1a. DayChange (±3) — today's intraday move; secondary signal, lower weight than trend
        const dayChange = quote.changePercent / 100;
        if      (dayChange >  0.03)  { aiScore += 3; scoringLog.push(`DayChange: +3 (today +${(dayChange*100).toFixed(1)}%)`); }
        else if (dayChange >  0.01)  { aiScore += 1; scoringLog.push(`DayChange: +1 (today +${(dayChange*100).toFixed(1)}%)`); }
        else if (dayChange < -0.03)  { aiScore -= 3; scoringLog.push(`DayChange: -3 (today ${(dayChange*100).toFixed(1)}%)`); }
        else if (dayChange < -0.01)  { aiScore -= 1; scoringLog.push(`DayChange: -1 (today ${(dayChange*100).toFixed(1)}%)`); }


        // 2. Volume (±10) — vs avg volume from the quote
        const volumeRatio = quote.avgVolume > 0 ? quote.volume / quote.avgVolume : 1;
        if (volumeRatio > 2.0)      { aiScore += 10; scoringLog.push('Volume: +10 (2x avg)'); }
        else if (volumeRatio > 1.5) { aiScore += 6;  scoringLog.push('Volume: +6'); }
        else if (volumeRatio > 1.0) { aiScore += 3;  scoringLog.push('Volume: +3'); }
        else if (volumeRatio < 0.5) { aiScore -= 6;  scoringLog.push('Volume: -6 (very low)'); }

        // 3. RSI
        if (rsiInterpretation && rsiInterpretation.scoreAdjustment) {
            aiScore += rsiInterpretation.scoreAdjustment;
            scoringLog.push(`RSI: ${rsiInterpretation.scoreAdjustment > 0 ? '+' : ''}${rsiInterpretation.scoreAdjustment} (${rsiInterpretation.signal})`);
        }

        // 3a. Stochastic RSI (±8) — confirms RSI extremes with higher sensitivity
        if (stochRSI !== null) {
            let stochAdj = 0;
            if (stochRSI < 20)       { stochAdj = +8;  scoringLog.push(`StochRSI: +8 (oversold ${stochRSI.toFixed(1)})`); }
            else if (stochRSI < 35)  { stochAdj = +4;  scoringLog.push(`StochRSI: +4 (near oversold ${stochRSI.toFixed(1)})`); }
            else if (stochRSI > 80)  { stochAdj = -8;  scoringLog.push(`StochRSI: -8 (overbought ${stochRSI.toFixed(1)})`); }
            else if (stochRSI > 65)  { stochAdj = -4;  scoringLog.push(`StochRSI: -4 (near overbought ${stochRSI.toFixed(1)})`); }
            aiScore += stochAdj;
        }

        // 3b. Williams %R (±7) — momentum confirmation; catches reversals early
        if (williamsR !== null) {
            let wrAdj = 0;
            if (williamsR < -80)      { wrAdj = +7;  scoringLog.push(`WilliamsR: +7 (oversold ${williamsR.toFixed(1)})`); }
            else if (williamsR < -65) { wrAdj = +3;  scoringLog.push(`WilliamsR: +3 (near oversold ${williamsR.toFixed(1)})`); }
            else if (williamsR > -20) { wrAdj = -7;  scoringLog.push(`WilliamsR: -7 (overbought ${williamsR.toFixed(1)})`); }
            else if (williamsR > -35) { wrAdj = -3;  scoringLog.push(`WilliamsR: -3 (near overbought ${williamsR.toFixed(1)})`); }
            aiScore += wrAdj;
        }

        // 4. MACD
        if (macdInterpretation && macdInterpretation.scoreAdjustment) {
            aiScore += macdInterpretation.scoreAdjustment;
            scoringLog.push(`MACD: ${macdInterpretation.scoreAdjustment > 0 ? '+' : ''}${macdInterpretation.scoreAdjustment} (${macdInterpretation.signal})`);
        }

        // 5. Bollinger Bands
        if (bbInterpretation && bbInterpretation.scoreAdjustment) {
            aiScore += bbInterpretation.scoreAdjustment;
            scoringLog.push(`BB: ${bbInterpretation.scoreAdjustment > 0 ? '+' : ''}${bbInterpretation.scoreAdjustment} (${bbInterpretation.signal})`);
        }

        // 5a. Mean Reversion: price vs 20-day SMA (±10)
        // Healthy pullback (3-15% below SMA20) = bounce candidate; overextended (>8% above) = fade
        const sma20 = closes.slice(-20).reduce((sum, c) => sum + c, 0) / Math.min(closes.length, 20);
        const distFromSma20Pct = sma20 > 0 ? ((price - sma20) / sma20) * 100 : 0;
        // 50-day extension: penalise stocks that have already run far from their base.
        // VCP-confirmed stocks get a pass — they're pulling back INTO the base near SMA50.
        // ARM-style: bought at SMA50, not 40% above it.
        const distFromSma50Pct = sma50 ? ((price - sma50) / sma50) * 100 : 0;
        if (sma50) {
            if (distFromSma50Pct > 30) {
                aiScore -= 8;
                scoringLog.push(`Ext50: -8 (${distFromSma50Pct.toFixed(1)}% above SMA50 — severely extended, high reversion risk)`);
            } else if (distFromSma50Pct > 20) {
                aiScore -= 4;
                scoringLog.push(`Ext50: -4 (${distFromSma50Pct.toFixed(1)}% above SMA50 — extended from base)`);
            }
        }
        if (distFromSma20Pct <= -3 && distFromSma20Pct >= -15) {
            const mrAdj = Math.round(Math.min(10, Math.abs(distFromSma20Pct) * 0.75));
            aiScore += mrAdj;
            scoringLog.push(`MeanRev: +${mrAdj} (${distFromSma20Pct.toFixed(1)}% below SMA20)`);
        } else if (distFromSma20Pct > 8 && distFromSma20Pct <= 15) {
            aiScore -= 5;
            scoringLog.push(`MeanRev: -5 (${distFromSma20Pct.toFixed(1)}% above SMA20, overextended)`);
        } else if (distFromSma20Pct > 15) {
            // Severely overbought — data shows high-score entries at this extension lose money
            // (BKNG +15% above SMA scored 95 but was the worst trade). Hard penalise.
            aiScore -= 12;
            scoringLog.push(`MeanRev: -12 (${distFromSma20Pct.toFixed(1)}% above SMA20, severely overbought — high reversal risk)`);
        }

        // 5b. 5-day momentum overbought guard: if price up >8% in 5 days AND already above SMA20,
        // apply an additional penalty. This catches the "chasing a breakout" pattern that produces
        // high AI scores but buys at the top (the BKNG / high-score loss pattern in our data).
        if (closes.length >= 5 && price5dAgo > 0) {
            const gain5d = ((price - price5dAgo) / price5dAgo) * 100;
            if (gain5d > 8 && distFromSma20Pct > 3) {
                const momentumPenalty = Math.round(Math.min(10, gain5d * 0.6));
                aiScore -= momentumPenalty;
                scoringLog.push(`OverboughtGuard: -${momentumPenalty} (up ${gain5d.toFixed(1)}% in 5d while extended — buying-at-top risk)`);
            }
        }

        // 6. Relative Strength vs SPY — multi-timeframe (±8 base, ±3 confirmation)
        // Primary: 20-day RS tells us the medium-term trend vs index.
        // Confirmation: 5-day RS adds/removes 3 pts based on whether recent momentum agrees.
        {
            let rsAdj = 0;
            if      (relativeStrength > 8)  { rsAdj = 8;  scoringLog.push(`RelStrength20d: +8 (${relativeStrength.toFixed(1)}pp vs SPY)`); }
            else if (relativeStrength > 3)  { rsAdj = 4;  scoringLog.push(`RelStrength20d: +4 (${relativeStrength.toFixed(1)}pp vs SPY)`); }
            else if (relativeStrength > -3) { rsAdj = 0;  scoringLog.push(`RelStrength20d: 0 (in-line with SPY)`); }
            else if (relativeStrength > -8) { rsAdj = -4; scoringLog.push(`RelStrength20d: -4 (${relativeStrength.toFixed(1)}pp vs SPY)`); }
            else                            { rsAdj = -8; scoringLog.push(`RelStrength20d: -8 (${relativeStrength.toFixed(1)}pp vs SPY)`); }

            // 5-day confirmation: +3 if both timeframes agree bullish, -3 if 5d diverging bearish
            if (relativeStrength > 3 && relativeStrength5d > 2) {
                rsAdj += 3;
                scoringLog.push(`RelStrength5d: +3 (momentum confirming, 5d RS +${relativeStrength5d.toFixed(1)}pp)`);
            } else if (relativeStrength > 0 && relativeStrength5d < -3) {
                rsAdj -= 3;
                scoringLog.push(`RelStrength5d: -3 (momentum decelerating, 5d RS ${relativeStrength5d.toFixed(1)}pp)`);
            }
            aiScore += rsAdj;
        }

        // 7. 52-Week High Proximity (±7) — NEW
        // Stocks near/at 52wk highs have momentum; far below shows weakness
        if (highProximity >= 0.97)      { aiScore += 7;  scoringLog.push('52wkHigh: +7 (within 3% of 52wk high)'); }
        else if (highProximity >= 0.90) { aiScore += 3;  scoringLog.push('52wkHigh: +3 (within 10% of 52wk high)'); }
        else if (highProximity < 0.60)  { aiScore -= 7;  scoringLog.push('52wkHigh: -7 (>40% below 52wk high)'); }
        else if (highProximity < 0.75)  { aiScore -= 3;  scoringLog.push('52wkHigh: -3 (>25% below 52wk high)'); }

        // 8. Earnings Risk / Pre-Earnings Setup
        // 0-4 days: hard block (IV crush, gap risk)
        // 5-15 days: pre-earnings setup window — score neutral; PROPHET bullish adds +5
        let earningsFlag = false;
        let earningsSetup = false;
        if (daysToEarnings !== null && daysToEarnings >= 0 && daysToEarnings <= 4) {
            aiScore -= 15;
            earningsFlag = true;
            scoringLog.push(`Earnings: -15 (${daysToEarnings}d to earnings — too close, hard block)`);
        } else if (daysToEarnings !== null && daysToEarnings >= 5 && daysToEarnings <= 15) {
            earningsSetup = true; // pre-earnings momentum window
            const prophetBonus = prophetResult?.verdict === 'BULLISH' ? 5 : 0;
            if (prophetBonus > 0) {
                aiScore += prophetBonus;
                scoringLog.push(`Earnings: +${prophetBonus} (${daysToEarnings}d — PROPHET bullish pre-earnings setup)`);
            } else {
                scoringLog.push(`Earnings: +0 (${daysToEarnings}d — pre-earnings setup window, score neutral)`);
            }
        }

        // 9. VIX (±10)
        if (vixLevel < 15)      { aiScore += 5;  scoringLog.push('VIX: +5 (calm market)'); }
        else if (vixLevel < 20) { aiScore += 2; }
        else if (vixLevel > 30) { aiScore -= 10; scoringLog.push('VIX: -10 (extreme fear)'); }
        else if (vixLevel > 25) { aiScore -= 5;  scoringLog.push('VIX: -5 (elevated fear)'); }

        // 9.5 News Sentiment (configurable ±AI_NEWS_MAX_IMPACT)
        let newsSentiment = 0;
        let newsScoreAdjustment = 0;
        const xPostCount = newsData?.meta?.xPostCount || 0;
        const newsSourceCount = newsData?.sentiment?.sourceCount || Object.keys(newsData?.meta?.sourceBreakdown || {}).length;
        if (AI_NEWS_SCORING_ENABLED && newsData?.sentiment?.score !== undefined) {
            const parsedSentiment = parseFloat(newsData.sentiment.score);
            if (Number.isFinite(parsedSentiment)) {
                newsSentiment = Math.max(-100, Math.min(100, parsedSentiment));
                newsScoreAdjustment = (newsSentiment / 100) * AI_NEWS_MAX_IMPACT * AI_NEWS_SCORE_WEIGHT;
                aiScore += newsScoreAdjustment;
                scoringLog.push(`News: ${newsScoreAdjustment >= 0 ? '+' : ''}${newsScoreAdjustment.toFixed(2)} (sentiment ${newsSentiment.toFixed(1)}, sources ${newsSourceCount}${xPostCount ? `, X ${xPostCount}` : ''})`);
            }
        }

        // 9.6 Geopolitical Risk Detector (−10) — macro shock keywords in headlines
        if (headlines.length > 0) {
            const lowerHeadlines = headlines.join(' ').toLowerCase();
            const geoHit = GEO_RISK_KEYWORDS.find(kw => lowerHeadlines.includes(kw));
            if (geoHit) {
                aiScore -= 10;
                scoringLog.push(`GeoRisk: -10 (keyword: "${geoHit}" in headlines)`);
            }
        }

        // 9.7 VCP — Volatility Contraction Pattern (Minervini SEPA)
        // Detects shrinking weekly price ranges = institutional base forming before breakout.
        // Range measured as (weekHigh - weekLow) / midClose × 100 so it's price-scale neutral.
        let vcpPattern = 'none';
        if (highs.length >= 15 && lows.length >= 15 && closes.length >= 15) {
            const weekRangePct = (weekAgo) => {
                const len   = closes.length;
                const end   = len - (weekAgo - 1) * 5;
                const start = Math.max(0, end - 5);
                if (end <= start) return null;
                const wh  = highs.slice(start, end);
                const wl  = lows.slice(start, end);
                const wc  = closes.slice(start, end);
                const mid = wc.reduce((a, b) => a + b, 0) / wc.length;
                return mid > 0 ? (Math.max(...wh) - Math.min(...wl)) / mid * 100 : null;
            };
            const r1 = weekRangePct(1); // most recent week
            const r2 = weekRangePct(2); // week before
            const r3 = weekRangePct(3); // week before that
            // Require ≥5% genuine contraction per week (r1 ≤ r2 * 0.95).
            // Old check was r1 < r2 (strict) — a 0.01% difference scored +8,
            // causing 8-point swings when a single bar shifted the weekly window.
            if (r1 !== null && r2 !== null && r3 !== null && r1 <= r2 * 0.95 && r2 <= r3 * 0.95) {
                // 3-week contraction with meaningful tightening each week
                vcpPattern = 'confirmed';
                aiScore += 8;
                scoringLog.push(`VCP: +8 (3-wk contraction ${r3.toFixed(1)}%→${r2.toFixed(1)}%→${r1.toFixed(1)}% — Minervini base forming)`);
            } else if (r1 !== null && r2 !== null && r1 <= r2 * 0.80) {
                // Strong 2-week contraction (≥20% tighter — already a meaningful threshold)
                vcpPattern = 'forming';
                aiScore += 4;
                scoringLog.push(`VCP: +4 (2-wk contraction ${r2.toFixed(1)}%→${r1.toFixed(1)}% — base compressing)`);
            }
        }

        // 9.8 Volume Dry-Up (Minervini base confirmation)
        // During a proper base, volume declines = no distribution (institutions holding).
        // Expansion on breakout day = institutional entry confirmation.
        {
            const vols = quotes.map(q => q.volume).filter(v => v > 0);
            if (vols.length >= 30) {
                const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
                const recentVol = avg(vols.slice(-10));      // last 2 weeks
                const priorVol  = avg(vols.slice(-30, -20)); // 4–6 weeks ago (baseline)
                if (priorVol > 0) {
                    const volRatio = recentVol / priorVol;
                    // Graduated tiers — max 1-point step between adjacent tiers so a
                    // 0.01 ratio wiggle at a boundary only moves the score by 1, not 2-4.
                    let vduPoints = 0;
                    if      (volRatio < 0.55) { vduPoints = 5; }
                    else if (volRatio < 0.70) { vduPoints = 4; }
                    else if (volRatio < 0.80) { vduPoints = 3; }
                    else if (volRatio < 0.90) { vduPoints = 2; }
                    else if (volRatio < 0.95) { vduPoints = 1; }
                    if (vduPoints > 0) {
                        aiScore += vduPoints;
                        scoringLog.push(`VolDryUp: +${vduPoints} (volume at ${(volRatio * 100).toFixed(0)}% of prior — ${volRatio < 0.70 ? 'strong dry-up' : 'base forming'})`);
                    }
                }
            }
        }

        // 10. Market Cap Quality (±5)
        if (marketCap > 100e9)      { aiScore += 3; }
        else if (marketCap > 10e9)  { aiScore += 2; }
        else if (marketCap < 5e9)   { aiScore -= 5; }

        // 11. Sector Rotation (±8) — COMPASS ETF-based RS ranking (primary)
        // Falls back to the post-scan intra-bot cache when COMPASS data is unavailable.
        {
            let sectorLabel = null;
            try {
                sectorLabel = await compassService.getSectorLabel(sector);
            } catch { /* non-blocking */ }

            if (!sectorLabel && _sectorRotation.updatedAt > 0) {
                sectorLabel = _sectorRotation.hot.has(sector)  ? 'rotating_in'
                            : _sectorRotation.cold.has(sector) ? 'rotating_out'
                            : 'neutral';
            }

            if (sectorLabel === 'rotating_in')  {
                aiScore += 8;
                scoringLog.push(`SectorRotation: +8 (${sector} rotating in — COMPASS)`);
            } else if (sectorLabel === 'rotating_out') {
                aiScore -= 8;
                scoringLog.push(`SectorRotation: -8 (${sector} rotating out — COMPASS)`);
            }
        }

        // 12. SONAR Smart Money (±8) — PANTHEON STEP 8
        // smartMoneyScore is 0–1 from institutionalOwnership + insider transactions.
        {
            let smAdj = 0;
            if (smartMoneyScore > 0.70)      { smAdj = +8; scoringLog.push(`SmartMoney: +8 (strong institutional ${(smartMoneyScore * 100).toFixed(0)}%)`); }
            else if (smartMoneyScore > 0.55) { smAdj = +4; scoringLog.push(`SmartMoney: +4 (moderate institutional)`); }
            else if (smartMoneyScore < 0.35) { smAdj = -4; scoringLog.push(`SmartMoney: -4 (low institutional interest)`); }
            aiScore += smAdj;
        }

        // 12b. SHORT FLOAT / SQUEEZE POTENTIAL (±8)
        // High short float + uptrend = squeeze fuel (short-covering amplifies the move).
        // Very low short float = clean institutional setup (no trapped-short overhead).
        // High short float + downtrend = shorts are right → penalise.
        if (shortInterestData) {
            const { shortRatio, shortPercentOfFloat } = shortInterestData;
            if (shortPercentOfFloat !== null) {
                // Is the stock in a short-term uptrend? Use 5-day and 1-day change.
                const inUptrend = change > 0 && (closes.length >= 5 ? price > price5dAgo : true);

                if (shortPercentOfFloat >= 0.20 && inUptrend) {
                    // Heavy short + price moving up = explosive squeeze setup
                    const ratioNote = shortRatio ? `, ${shortRatio.toFixed(1)}d DTC` : '';
                    aiScore += 8;
                    scoringLog.push(`Squeeze: +8 (${(shortPercentOfFloat * 100).toFixed(0)}% float short${ratioNote} — squeeze fuel)`);
                } else if (shortPercentOfFloat >= 0.10 && inUptrend) {
                    aiScore += 4;
                    scoringLog.push(`Squeeze: +4 (${(shortPercentOfFloat * 100).toFixed(0)}% float short + uptrend)`);
                } else if (shortPercentOfFloat < 0.02) {
                    // Very low short = "clean" — institutions aren't fighting this
                    aiScore += 3;
                    scoringLog.push(`ShortFloat: +3 (only ${(shortPercentOfFloat * 100).toFixed(1)}% short — clean setup)`);
                } else if (shortPercentOfFloat >= 0.20 && !inUptrend) {
                    // Heavily shorted and falling → shorts are right, stay away
                    aiScore -= 5;
                    scoringLog.push(`Squeeze: -5 (${(shortPercentOfFloat * 100).toFixed(0)}% float short but downtrend — avoid)`);
                }
            }
        }

        // 13. CANSLIM (±14) — PANTHEON STEP 4: EPS growth + Revenue growth
        if (fundamentals) {
            const eg = fundamentals.earningsGrowth;
            const rg = fundamentals.revenueGrowth;
            if (eg !== null) {
                if      (eg >= 0.25) { aiScore += 8; scoringLog.push(`CANSLIM_EPS: +8 (${(eg*100).toFixed(0)}% growth)`); }
                else if (eg >= 0.10) { aiScore += 4; scoringLog.push(`CANSLIM_EPS: +4 (${(eg*100).toFixed(0)}% growth)`); }
                else if (eg < 0)     { aiScore -= 5; scoringLog.push(`CANSLIM_EPS: -5 (negative earnings growth)`); }
            }
            if (rg !== null) {
                if      (rg >= 0.20) { aiScore += 6; scoringLog.push(`CANSLIM_Rev: +6 (${(rg*100).toFixed(0)}% growth)`); }
                else if (rg >= 0.10) { aiScore += 3; scoringLog.push(`CANSLIM_Rev: +3 (${(rg*100).toFixed(0)}% growth)`); }
            }
        }

        // 14. Reddit Alt Data (±6) — retail crowd signal
        if (redditData && redditData.scoreAdj !== 0) {
            aiScore += redditData.scoreAdj;
            scoringLog.push(`Reddit: ${redditData.scoreAdj >= 0 ? '+' : ''}${redditData.scoreAdj} (${redditData.mentions} mentions)`);
        }

        // 15. PULSE Gemini (±5) — AI-powered news sentiment bonus
        if (geminiResult) {
            const gemAdj = Math.round((geminiResult.score - 50) / 10); // maps 0-100 → -5..+5
            if (gemAdj !== 0) {
                aiScore += gemAdj;
                scoringLog.push(`Gemini: ${gemAdj >= 0 ? '+' : ''}${gemAdj} (${geminiResult.label})`);
            }
        }

        // 16. Wyckoff Volume Analysis (0 to +15) — PANTHEON STEP 5
        {
            const vols    = quotes.map(q => q.volume).filter(v => v > 0);
            if (vols.length >= 20) {
                const avgVol20   = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
                const vol5d      = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
                const latestVol  = vols[vols.length - 1];
                let wyckoffScore = 0;

                // VDU: recent 5-bar avg < 50% of 20-bar avg (consolidation drying up)
                if (avgVol20 > 0 && vol5d < avgVol20 * 0.5) {
                    wyckoffScore += 5;
                    scoringLog.push('Wyckoff_VDU: +5 (volume drying up)');
                }
                // Up-days vol > Down-days vol (demand > supply over last 20 bars)
                let upVol = 0, downVol = 0;
                for (const bar of quotes.slice(-20)) {
                    if ((bar.close || 0) >= (bar.open || 0)) upVol += (bar.volume || 0);
                    else downVol += (bar.volume || 0);
                }
                if (upVol > downVol * 1.1) {
                    wyckoffScore += 5;
                    scoringLog.push(`Wyckoff_UvD: +5 (up-vol ${((upVol / (upVol + downVol || 1)) * 100).toFixed(0)}%)`);
                }
                // Breakout volume: latest bar > 2× 20-bar avg
                if (avgVol20 > 0 && latestVol > avgVol20 * 2) {
                    wyckoffScore += 5;
                    scoringLog.push(`Wyckoff_BRK: +5 (${(latestVol / avgVol20).toFixed(1)}× avg vol)`);
                }
                if (wyckoffScore > 0) aiScore += wyckoffScore;
            }
        }

        // 17. ORACLE Pattern (0 to +10) — PANTHEON STEP 3: VCP/Cup&Handle/Darvas
        if (oraclePattern.score > 0) {
            aiScore += oraclePattern.score;
            scoringLog.push(`Pattern: +${oraclePattern.score} (${oraclePattern.pattern})`);
        }

        // 18. PROPHET Earnings Forecast (±8) — pre-earnings direction signal (15-45d window)
        if (prophetResult && prophetResult.scoreAdj !== 0) {
            aiScore += prophetResult.scoreAdj;
            scoringLog.push(`Prophet: ${prophetResult.scoreAdj >= 0 ? '+' : ''}${prophetResult.scoreAdj} (${prophetResult.verdict}/${prophetResult.confidence})`);
        }

        // 19. VISION Directional Signal (±8) — rule-based directional classifier
        agentHealth.recordHeartbeat('VISION', 'OK', { symbol });
        const visionSignal = visionService.computeSignal(symbol, quotes, {
            sma50, sma150, sma200, sma200Rising, rsi, week52High
        });
        if (visionSignal.scoreAdj !== 0) {
            aiScore += visionSignal.scoreAdj;
            scoringLog.push(`VISION: ${visionSignal.scoreAdj >= 0 ? '+' : ''}${visionSignal.scoreAdj} (${visionSignal.direction}/${visionSignal.confidence})`);
        }

        // 20. SAGE Learned Adjustments (±5) — ORACLE self-improvement from validated trade history
        // Compute setupFamily inline here so SAGE can use it before the main const declaration below
        {
            const _sf = deriveStockSetupFamily({
                momentum, relativeStrength, highProximity, rsi, stochRSI,
                macdSignal: macdInterpretation?.signal || 'NEUTRAL',
                newsSentiment, distFromSma20Pct
            });
            const sageAdj = sageService.applySageAdj(_sf, sector, oraclePattern.pattern);
            if (sageAdj !== 0) {
                aiScore += sageAdj;
                scoringLog.push(`SAGE: ${sageAdj >= 0 ? '+' : ''}${sageAdj} (learned adj for ${_sf}/${sector})`);
            }
        }

        // 21. LOCAL BRAIN — Historical win-rate boost from closed trade history (±6)
        // Uses this account's own trade data: sector × pattern × regime win rates.
        // Refreshes every 4 hours. No external API. No model. Pure statistics.
        {
            const brainResult = await localBrain.getScoreBoost({
                sector:    sector || 'Unknown',
                pattern:   oraclePattern.pattern || 'None',
                regime:    regime?.regime || 'UNKNOWN',
                entryHour: new Date().getHours(), // local hour — brain converts to ET via SQL
            });
            if (brainResult.boost !== 0) {
                aiScore += brainResult.boost;
                scoringLog.push(`LOCAL_BRAIN: ${brainResult.boost >= 0 ? '+' : ''}${brainResult.boost} (${brainResult.reason})`);
            }
        }

        // 22. EVOLVE Lite — Decision-table ML signal from 2Y OHLCV history (±8)
        // Trained on cached ohlcv_cache data: RSI×MACD×volume×52wk-proximity×trend.
        // Labels: 5-day forward return > 2% = WIN. No GPU, no library — pure stats.
        {
            const evolveResult = await evolveService.getScoreBoost(symbol);
            if (evolveResult.boost !== 0) {
                aiScore += evolveResult.boost;
                scoringLog.push(`EVOLVE: ${evolveResult.boost >= 0 ? '+' : ''}${evolveResult.boost} (${evolveResult.reason})`);
            }
        }

        // 22.5. Regime Alignment (±8) — rewards momentum longs that align with the market regime.
        // This bot is long-only, so every entry is a bullish bet. A BULL_STRONG regime confirms
        // the macro tailwind; BEAR means we are fighting the tape and need a discount on conviction.
        // PANIC and CHOPPY are blocked at session level before any stock is ever analyzed.
        {
            const rt = regime?.regimeType || 'UNKNOWN';
            let regAdj = 0;
            if      (rt === 'BULL_STRONG') { regAdj = +8; scoringLog.push('RegimeAlignment: +8 (BULL_STRONG — tailwind confirmed)'); }
            else if (rt === 'BULL_MILD')   { regAdj = +4; scoringLog.push('RegimeAlignment: +4 (BULL_MILD — aligned with headwinds)'); }
            else if (rt === 'BEAR')        { regAdj = -8; scoringLog.push('RegimeAlignment: -8 (BEAR — fighting the tape)'); }
            // NEUTRAL → 0 (no log entry, no bonus or penalty)
            if (regAdj !== 0) aiScore += regAdj;
        }

        // 22.7. Weekly Timeframe Alignment (±8) — swing trades need the weekly trend to agree
        // with the daily signal. Derived from already-fetched daily bars, zero extra API calls.
        // Bullish weekly = close above WMA20 + positive 4-week return.
        // Bearish weekly = close below WMA20 + negative 4-week return.
        // Mixed (one of the two) applies a smaller penalty rather than the full -8.
        {
            const ws = getWeeklySignalFromDailyBars(quotes);
            if (ws) {
                let wtAdj = 0;
                if (ws.bullish) {
                    wtAdj = +8;
                    scoringLog.push(`WeeklyAlign: +8 (above WMA20, 4w return +${ws.return4w.toFixed(1)}%)`);
                } else if (ws.bearish) {
                    wtAdj = -8;
                    scoringLog.push(`WeeklyAlign: -8 (below WMA20, 4w return ${ws.return4w.toFixed(1)}% — higher TF bearish)`);
                } else if (!ws.aboveWma20) {
                    wtAdj = -4;
                    scoringLog.push(`WeeklyAlign: -4 (below WMA20 — weekly mixed)`);
                } else if (ws.return4w < 0) {
                    wtAdj = -2;
                    scoringLog.push(`WeeklyAlign: -2 (above WMA20 but 4w return ${ws.return4w.toFixed(1)}% — weakening)`);
                }
                aiScore += wtAdj;
            }
        }

        // 22.9. ATLAS Global Market Intelligence (±10) — PANTHEON STEP 8.5
        // Synthesises international indices, futures, DXY, commodities, and VIX
        // into a single macro environment score.  Sector-specific overlay adds ±2
        // on top (e.g. tech penalised on strong dollar, energy boosted on oil surge).
        // Cache is 15 min — single HTTP call per window regardless of stock count.
        {
            let atlasAdj = 0;
            let atlasReason = '';
            try {
                // sector is already resolved above via sectorMetadata
                const atlasResult = await globalSentimentService.getScoreAdjustment(sector);
                atlasAdj    = atlasResult.adj;
                atlasReason = atlasResult.reason;
            } catch {
                // non-blocking — leave atlasAdj = 0 if ATLAS unavailable
                atlasReason = 'unavailable';
            }
            // Also check the pre-fetched globalSentiment (fallback if getScoreAdjustment fails)
            if (atlasAdj === 0 && globalSentiment && globalSentiment.baseAdj !== 0) {
                atlasAdj    = globalSentiment.baseAdj;
                atlasReason = globalSentiment.label ?? 'cached';
            }
            if (atlasAdj !== 0) {
                aiScore += atlasAdj;
                scoringLog.push(`ATLAS: ${atlasAdj >= 0 ? '+' : ''}${atlasAdj} (${atlasReason})`);
            }
        }

        // Signal Conflict Detector (±6) — penalises mixed conviction
        {
            const votes = [];
            if (rsi < 45)                                                votes.push('bull');
            else if (rsi > 60)                                           votes.push('bear');
            const macdDir = macdInterpretation?.signal || '';
            if (macdDir.includes('BULLISH'))                             votes.push('bull');
            else if (macdDir.includes('BEARISH'))                        votes.push('bear');
            if (momentum > 0.003)                                        votes.push('bull');
            else if (momentum < -0.003)                                  votes.push('bear');
            if (relativeStrength > 2)                                    votes.push('bull');
            else if (relativeStrength < -2)                              votes.push('bear');
            if (sma50 && price > sma50)                                  votes.push('bull');
            else if (sma50 && price < sma50)                             votes.push('bear');
            if (bb?.percentB < 0.3)                                      votes.push('bull');
            else if (bb?.percentB > 0.8)                                 votes.push('bear');
            const bullVotes = votes.filter(v => v === 'bull').length;
            const bearVotes = votes.filter(v => v === 'bear').length;
            if (bullVotes >= 2 && bearVotes >= 2) {
                const conflictPenalty = bullVotes === bearVotes ? -6 : -3;
                aiScore += conflictPenalty;
                scoringLog.push(`SignalConflict: ${conflictPenalty} (${bullVotes} bull vs ${bearVotes} bear)`);
            }
        }

        // ── Local 5-Model Ensemble Gate ──────────────────────────────────────────
        // Each "model" votes bullish/bearish/neutral from already-computed signals.
        // Zero new API calls — pure in-memory computation. No market-hours load added.
        //
        //   1. Trend     — MA alignment + momentum direction
        //   2. Volatility— VIX level + ATR expansion (from regime context)
        //   3. Sentiment — news score + Reddit/X signal
        //   4. Macro     — market regime type + rising rates flag
        //   5. MeanRev   — RSI + Bollinger %B + distance from SMA20
        //
        // Scoring: 4-5 bullish = +5 | 3 = 0 | 2 = -5 | 0-1 = -10
        {
            const rt = regime?.regimeType || 'NEUTRAL';

            // 1. Trend model
            const trendBull = (ttScore >= 6) && momentum > 0 && (sma50 ? price > sma50 : true);
            const trendBear = (ttScore <= 0) && momentum < 0;

            // 2. Volatility model (lower VIX + expanding ATR = favourable for momentum entries)
            const regimeVix  = typeof vixLevel === 'number' ? vixLevel : (regime?.vixLevel ?? 20);
            const atrExp     = regime?.atrExpansion ?? 1.0;
            const volBull    = regimeVix < 22 && atrExp >= 0.90;
            const volBear    = regimeVix > 30 || atrExp < 0.70;

            // 3. Sentiment model
            const sentBull   = newsSentiment > 15;
            const sentBear   = newsSentiment < -15;

            // 4. Macro model (regime type + rates)
            const risingRatesFlag = regime?.risingRates || false;
            const macroBull  = (rt === 'BULL_STRONG' || rt === 'BULL_MILD') && !risingRatesFlag;
            const macroBear  = rt === 'BEAR' || rt === 'PANIC';

            // 5. Mean-reversion model (not overbought, has room to run)
            const mrBull     = rsi < 55 && (bb?.percentB ?? 0.5) < 0.65 && distFromSma20Pct > -20;
            const mrBear     = rsi > 72 || (bb?.percentB ?? 0.5) > 0.90;

            const modelVotes = [
                trendBull && !trendBear,
                volBull   && !volBear,
                sentBull  && !sentBear,
                macroBull && !macroBear,
                mrBull    && !mrBear,
            ];
            const bullishCount = modelVotes.filter(Boolean).length;

            let ensembleAdj = 0;
            if      (bullishCount >= 4) { ensembleAdj = +5; }
            else if (bullishCount === 3) { ensembleAdj =  0; }
            else if (bullishCount === 2) { ensembleAdj = -5; }
            else                        { ensembleAdj = -10; }

            if (ensembleAdj !== 0) {
                aiScore += ensembleAdj;
                scoringLog.push(`Ensemble: ${ensembleAdj >= 0 ? '+' : ''}${ensembleAdj} (${bullishCount}/5 models bullish — trend:${modelVotes[0]?1:0} vol:${modelVotes[1]?1:0} sent:${modelVotes[2]?1:0} macro:${modelVotes[3]?1:0} mr:${modelVotes[4]?1:0})`);
            }
        }

        // 22.95. INTRADAY DIRECTION BIAS (0 / -4 / -8)
        // Compares current price to today's opening price (regularMarketOpen from Yahoo).
        // Buying a stock that is already 2%+ below its open means entering into intraday selling
        // pressure — the market is rejecting this stock today even if the daily setup looks good.
        // Avoids "knife catches" on otherwise high-scoring setups.
        // No API calls — quote.open is already fetched with the quote.
        {
            const todayOpen = quote.open;
            if (todayOpen && todayOpen > 0) {
                const intradayBias = (price - todayOpen) / todayOpen; // negative = trading below open
                if (intradayBias <= -0.02) {
                    aiScore -= 8;
                    scoringLog.push(`IntradayBias: -8 (${(intradayBias * 100).toFixed(1)}% below open — intraday selling)`);
                } else if (intradayBias <= -0.005) {
                    aiScore -= 4;
                    scoringLog.push(`IntradayBias: -4 (${(intradayBias * 100).toFixed(1)}% below open — mild weakness)`);
                } else if (intradayBias >= 0.02) {
                    aiScore += 2;
                    scoringLog.push(`IntradayBias: +2 (${(intradayBias * 100).toFixed(1)}% above open — intraday strength)`);
                }
            }
        }

        // Normalize score to 0-100 (pre-ORACLE)
        aiScore = Math.max(0, Math.min(100, aiScore));

        // Preliminary R/R for ORACLE context (1.5× stop, 3× target baseline).
        // The VIX-scaled final value is computed below after the oracle block.
        let riskReward = (atr > 0 && price > 0)
            ? (atr * 3.0) / (atr * 1.5)
            : 2.0;

        // 23. ORACLE Verdict (±15) — AI final judge on pre-scored candidates
        // Budget-gated: at most ORACLE_MAX_PER_CYCLE fresh Claude calls per scan.
        // Cached results (1-hour window per symbol) are free and don't count.
        // HERMES RS sort means the best momentum stocks consume the budget first.
        let oracleVerdict = null;
        if (aiScore >= 55 && oracleService.isEnabled() && _oracleCycleCount < ORACLE_MAX_PER_CYCLE) {
            _oracleCycleCount++;
            agentHealth.recordHeartbeat('ORACLE', 'START', { symbol });
            oracleVerdict = await oracleService.getVerdict({
                symbol, price,
                stage:          weinSteinStage,
                pattern:        oraclePattern.pattern,
                rsi:            rsi?.toFixed(1),
                macd:           macdInterpretation?.signal || 'NEUTRAL',
                atr:            atr?.toFixed(2),
                sma50, sma150, sma200,
                volume:         quote.volume,
                avgVolume:      quote.avgVolume,
                earningsGrowth: fundamentals?.earningsGrowth,
                revenueGrowth:  fundamentals?.revenueGrowth,
                daysToEarnings,
                geminiLabel:    geminiResult?.label || null,
                smartMoneyScore,
                sectorRank:     await compassService.getSectorLabel(sector).catch(() => null),
                riskReward,
                entry:          price,
                stop:           price - (atr * 1.5),
                target:         price + Math.max(week52High > price ? week52High - price : atr * 3, atr * 3),
                regime:         regime?.regime || 'UNKNOWN'
            }).catch(() => null);

            agentHealth.recordHeartbeat('ORACLE', oracleVerdict ? 'OK' : 'ERROR', { symbol });
            if (oracleVerdict) {
                const oAdj = oracleService.verdictToAdj(oracleVerdict.verdict, oracleVerdict.confidence);
                if (oAdj !== 0) {
                    aiScore = Math.max(0, Math.min(100, aiScore + oAdj));
                    scoringLog.push(`ORACLE: ${oAdj >= 0 ? '+' : ''}${oAdj} (${oracleVerdict.verdict}/${oracleVerdict.confidence} — ${oracleVerdict.thesis?.slice(0, 60)}...)`);
                }
                // ORACLE may supply better entry/stop/target — prefer Claude's values if present
                if (oracleVerdict.entry > 0) riskReward = parseFloat(oracleVerdict.riskReward?.split(':')[0] || riskReward);
            }
        }

        const setupFamily = deriveStockSetupFamily({
            momentum,
            relativeStrength,
            highProximity,
            rsi,
            stochRSI,
            macdSignal: macdInterpretation?.signal || 'NEUTRAL',
            newsSentiment,
            distFromSma20Pct
        });

        // Generate recommendation
        let recommendation = 'HOLD';
        if (aiScore >= 75) recommendation = 'STRONG BUY';
        else if (aiScore >= 65) recommendation = 'BUY';
        else if (aiScore <= 25) recommendation = 'STRONG SELL';
        else if (aiScore <= 35) recommendation = 'SELL';

        // ─── Jones R/R (PANTHEON STEP 6) ─────────────────────────────────────
        // Base multipliers from the sector trade profile:
        //   AGGRESSIVE (tech/growth): ATR×2.0 stop, ATR×4.0 target
        //   DEFENSIVE  (utils/staples/REITs): ATR×1.2 stop, ATR×2.0 target
        //   STANDARD   (default): ATR×1.5 stop, ATR×3.0 target
        //
        // VIX scaling: widens stops when the market is noisy, tightens when calm.
        //   VIX <15  → ×0.90 (tight market, stop-hunts rare)
        //   VIX <20  → ×1.00 (normal)
        //   VIX <25  → ×1.25 (elevated noise, give more room)
        //   VIX ≥25  → ×1.55 (high volatility, very wide stops needed)
        const _vix = typeof vixLevel === 'number' ? vixLevel : 20;
        const vixAtrScale = _vix < 15 ? 0.90
                          : _vix < 20 ? 1.00
                          : _vix < 25 ? 1.25
                          :             1.55;
        const stopMult   = tradeProfile.stopMult   * vixAtrScale;
        const targetMult = tradeProfile.targetMult * vixAtrScale;
        const rawStop      = price - (atr * stopMult);
        // ATR-adjusted stop cap: low-vol stocks (ATR% < 1%) don't need 5% breathing room —
        // holding a financial to -5% is dead money when its daily range is only 0.5%.
        // Cap their stop at 2×ATR% (min 2%). High-vol stocks keep the configured 5% max;
        // their position size is already smaller via the Kelly+ATR sizing formula.
        const _atrPct      = price > 0 ? atr / price : 0;
        const maxStopPct   = (_atrPct > 0 && _atrPct < 0.01)
            ? Math.max(_atrPct * 2.0, 0.02)
            : (tradeProfile.maxStopPct || 0.05);
        const stopFloor    = price * (1 - maxStopPct);
        const stopPrice    = Math.max(rawStop, stopFloor);
        const distToHigh   = week52High > price ? week52High - price : atr * targetMult;
        const targetPrice  = price + Math.max(distToHigh, atr * targetMult);
        // Refine riskReward with VIX-scaled stops (declared as let before oracle block above)
        riskReward         = (price - stopPrice) > 0
            ? (targetPrice - price) / (price - stopPrice)
            : 0;

        const analysis = {
            symbol,
            price,
            week52High,
            change,
            volume,
            volumeRatio: volumeRatio.toFixed(2),
            marketCap,
            sector,
            tradeProfile: tradeProfile.name,
            sectorMinScore: tradeProfile.minScore,
            strategyFamily: 'equity_long',
            setupFamily,
            weinSteinStage,
            aiScore: Math.round(aiScore),
            recommendation,
            // Confidence: score above 50 scaled to 0-100, capped honestly.
            // Score 82 (min gate) → 64%; 90 → 80%; 95 → 90%; 100 → 100%.
            // This spreads calibration across the real signal range rather than
            // compressing everything into 78-82% (the old formula artifact).
            confidence: Math.min(100, Math.max(0, (aiScore - 50) / 50 * 100)),
            vixLevel,
            entry:      Number(price.toFixed(2)),
            stop:       Number(stopPrice.toFixed(2)),
            target:     Number(targetPrice.toFixed(2)),
            riskReward: Number(riskReward.toFixed(2)),
            smartMoneyScore: Number(smartMoneyScore.toFixed(2)),
            // Technical indicators
            rsi: rsi.toFixed(2),
            bbPercentB: bb.percentB.toFixed(3),
            bbSignal: bbInterpretation?.signal || 'NEUTRAL',
            relativeStrength: relativeStrength.toFixed(2),
            week52HighProximity: (highProximity * 100).toFixed(1) + '%',
            // Relative strength fields — used by entry gate in runTradingSession
            ma50:        sma50  != null ? Number(sma50.toFixed(2))  : null,
            ma200:       sma200 != null ? Number(sma200.toFixed(2)) : null,
            aboveMa50:   sma50  != null ? price >= sma50  : null,
            aboveMa200:  sma200 != null ? price >= sma200 : null,
            goldenCross: (sma50 != null && sma200 != null) ? sma50 >= sma200 : null,
            earningsFlag,
            earningsSetup,
            daysToEarnings,
            newsSentiment: Number(newsSentiment.toFixed(1)),
            newsScoreAdjustment: Number(newsScoreAdjustment.toFixed(2)),
            newsSourceCount,
            xPostCount,
            scoringLog,
            rsiInterpretation: rsiInterpretation.signal,
            macd: macd.histogram.toFixed(4),
            macdSignal: macdInterpretation?.signal || 'NEUTRAL',
            atr: atr.toFixed(2),
            atrPct: price > 0 ? Number((atr / price * 100).toFixed(3)) : 0, // ATR as % of price — use this for cross-stock vol comparison
            distFromSma20Pct: Number(distFromSma20Pct.toFixed(2)),
            distFromSma50Pct: Number(distFromSma50Pct.toFixed(2)),
            vcpPattern,
            sectorRotationTag: await compassService.getSectorLabel(sector).catch(() =>
                _sectorRotation.hot.has(sector)  ? 'rotating_in'  :
                _sectorRotation.cold.has(sector) ? 'rotating_out' : 'neutral'
            ),
            oraclePattern:    oraclePattern.pattern,
            patternScore:     oraclePattern.score,
            prophetVerdict:   prophetResult?.verdict   || null,
            prophetAdj:       prophetResult?.scoreAdj  || 0,
            visionDirection:  visionSignal.direction,
            visionProbability: visionSignal.probability,
            oracleVerdict:    oracleVerdict?.verdict   || null,
            oracleThesis:     oracleVerdict?.thesis    || null,
            oracleBearCase:   oracleVerdict?.bearCase  || null,
            masterAlignment:  oracleVerdict?.masterAlignment || [],
            // ATLAS — global macro context at time of scoring
            atlasLabel:       globalSentiment?.label      || null,
            atlasScore:       globalSentiment?.globalScore ?? null,
            atlasRawData:     globalSentiment?.rawData     || null,
            timestamp: new Date()
        };

        // Log AI decision with structured data
        logger.aiDecision(symbol, Math.round(aiScore), recommendation, {
            rsi: rsiInterpretation.signal,
            macd: macdInterpretation?.signal || 'NEUTRAL',
            volumeRatio: volumeRatio.toFixed(2),
            momentum: (momentum10d * 100).toFixed(2) + '%',
            newsSentiment: newsSentiment.toFixed(1),
            newsAdjustment: newsScoreAdjustment.toFixed(2),
            newsSources: String(newsSourceCount || 0),
            xPosts: String(xPostCount || 0)
        });

        return analysis;
    } catch (error) {
        logger.error('Error analyzing stock', { symbol, error: error.message });
        return null;
    }
}

// Cross-user analysis cache — analyzeStockWithAI() takes no userId; it's purely a
// function of (symbol, vixLevel, regime), the same for every account. With multiple
// users enrolled and their scan cycles now running in parallel, each one was calling
// it fresh for the same candidates, multiplying external API load (Yahoo/Gemini/SEC)
// by the number of concurrent users for identical data — directly worsening the rate
// limiting that was already making cycles slow enough to hit the scheduler's 4-minute
// timeout (see enhancedAIScheduler.js's per-user cycle lock, added alongside this the
// same day, 2026-07-17). Single-flight: the first caller for a symbol triggers the
// real fetch; every other caller for that same symbol within the TTL awaits the same
// in-flight (or already-resolved) promise instead of re-fetching.
const _analysisCache = new Map(); // symbol -> { promise, expiresAt }
const ANALYSIS_CACHE_TTL_MS = 4 * 60 * 1000; // just under the 5-min scheduler interval

function analyzeStockWithAICached(symbol, vixLevel, regime) {
    const cached = _analysisCache.get(symbol);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.promise;
    }
    const promise = analyzeStockWithAI(symbol, vixLevel, null, regime);
    _analysisCache.set(symbol, { promise, expiresAt: Date.now() + ANALYSIS_CACHE_TTL_MS });
    // A failed analysis shouldn't poison the cache for the full TTL — let the next caller retry fresh.
    promise.catch(() => { _analysisCache.delete(symbol); });
    return promise;
}

/**
 * Scan entire market universe and find best opportunities
 * @param {string} userId
 * @param {number} limit - max results to return
 * @param {number} [overrideMinScore] - optional regime-adjusted min score
 */
async function scanMarketForOpportunities(userId, limit = 50, overrideMinScore = null) {
    _oracleCycleCount = 0; // reset per-cycle budget so ORACLE fires fresh each scan
    logger.info('Scanning market for opportunities', { userId, limit });

    const [vixLevel, regime] = await Promise.all([
        getVixLevel(),
        marketRegimeService.getMarketRegime(),
        tradeIntelligenceService.ensureTradeIntelligenceSchema()
    ]);
    const riskConfig = await getUserRiskConfig(userId);
    const minBuyScore = overrideMinScore !== null ? overrideMinScore : riskConfig.minBuyScore;

    // Score calibration — runs once per day as a background suggestion, never auto-applies.
    // The calibrator reads closed trade history and sends a Telegram suggestion when the
    // data recommends a different floor. The user reviews and approves any changes manually.
    scoreCalibratorService.runDailySuggestion(userId, minBuyScore).catch(e =>
        logger.warn('[ScoreCalibrator] Daily suggestion failed (non-blocking)', { error: e.message })
    );

    // Universe selection — three-tier fallback:
    // Tier 1 (best): Nightly pre-scored candidates from daily_universe_analysis.
    //   Overnight scan covered ALL tickers; market hours only re-analyzes top ~120 for fresh prices.
    //   3-5× fewer analyzeStockWithAI() calls, full market coverage including emerging tickers.
    // Tier 2: Dynamic pre-market cache (built at 8:45 AM ET).
    // Tier 3: Live HERMES fetch (first run or cache miss).
    let _rawUniverse;
    try {
        const precomputedReady = await precomputedUniverseService.isAvailable();
        if (precomputedReady) {
            const precomputedList = await precomputedUniverseService.loadCandidates({
                minScore: Math.max(80, minBuyScore - 5), // quality floor: ≥80 removes noise while keeping stocks that gap up intraday
                // Cut from 120 — each candidate re-runs the full live PULSE+ORACLE pipeline,
                // and with Gemini's free-tier quota exhausted almost immediately every real
                // scan, that means 5-15s of genuine local-Ollama-LLM inference PER candidate,
                // not a rate limit. 116 candidates was reliably taking 5-10 real minutes,
                // blowing past the scheduler's 4-min window for any account with room to buy
                // (confirmed live 2026-07-31/08-01 on a zero-holdings account: 150+/253 cycles
                // timed out, zero trades). Candidates already come back ORDER BY ai_score DESC,
                // so this keeps exactly the best-scored overnight picks and only trims the
                // long tail that rarely clears minBuyScore anyway — same selection quality,
                // roughly a third of the LLM calls.
                limit:    40
            });
            if (precomputedList.length >= 10) {
                _rawUniverse = precomputedList; // already { symbol, marketCap, sector }
                logger.info('[PrecomputedUniverse] Using nightly pre-scored candidates', {
                    userId, count: _rawUniverse.length, source: 'daily_universe_analysis'
                });
            }
        }
    } catch (_precompErr) {
        logger.warn('[PrecomputedUniverse] Failed to load — falling back to live scan', { error: _precompErr.message });
    }

    if (!_rawUniverse) {
        _rawUniverse = dynamicUniverseService.isCacheReady()
            ? dynamicUniverseService.getScanUniverse()
            : await marketScreenerService.getStockUniverse();
    }

    // Adaptive universe cap — fewer stocks in weak regimes reduces noise and compute
    const REGIME_UNIVERSE_CAPS = { BEAR: 150, NEUTRAL: 250, BULL_MILD: 350, BULL_STRONG: 400 };
    const universeCap = REGIME_UNIVERSE_CAPS[regime?.regimeType] || 300;
    const universe = _rawUniverse.slice(0, universeCap);

    const _srcLabel = universe.length > 0 && universe[0]._preScreened
        ? 'precomputed_overnight'
        : dynamicUniverseService.isCacheReady() ? 'dynamic_cache' : 'hermes_live';

    logger.info('Market scan started', {
        userId,
        universeSize:   universe.length,
        universeCap,
        universeSource: _srcLabel,
        vixLevel:       vixLevel.toFixed(2),
    });
    
    // Filter by minimum market cap + Minervini quick pre-filter.
    // Pre-screened stocks (from overnight scan) skip passesQuickFilter — already applied overnight.
    const qualified = universe.filter(stock =>
        stock.marketCap >= riskConfig.minMarketCap &&
        (stock._preScreened || marketScreenerService.passesQuickFilter(stock))
    );

    const _universeSourceLabel = universe.length > 0 && universe[0]._preScreened
        ? 'precomputed_overnight'
        : dynamicUniverseService.isCacheReady() ? 'dynamic_cache' : 'hermes_live';

    logger.info('Stocks qualified by market cap + quick filter', {
        userId,
        universeIn:   universe.length,
        qualified:    qualified.length,
        minMarketCap: riskConfig.minMarketCap,
        source:       _universeSourceLabel
    });
    
    // Analyze all stocks in batches (reduced to prevent Yahoo Finance rate limiting)
    const opportunities = [];
    const allAnalyzed = []; // all fulfilled results — used to build sector rotation cache
    const batchSize = 5;  // Reduced from 20 to 5 to respect rate limits

    for (let i = 0; i < qualified.length; i += batchSize) {
        const batch = qualified.slice(i, i + batchSize);
        const results = await Promise.allSettled(
            batch.map(stock => analyzeStockWithAICached(stock.symbol, vixLevel, regime))
        );

        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value) {
                const analysis = result.value;
                const stockInfo = batch[index];
                const enriched = {
                    ...analysis,
                    sector: analysis.sector || stockInfo.sector,
                    industry: stockInfo.industry
                };

                // Track every analyzed stock for sector rotation intelligence
                allAnalyzed.push(enriched);

                // Only consider BUY or STRONG BUY with good score.
                // sectorMinScore enforces a higher bar for defensive sectors (Utilities/Staples/REITs = 78)
                // so they almost never pass the momentum scanner without a hard exclusion list.
                const effectiveMinScore = Math.max(minBuyScore, analysis.sectorMinScore || 0);
                if (analysis.aiScore >= effectiveMinScore &&
                    (analysis.recommendation === 'BUY' || analysis.recommendation === 'STRONG BUY')) {
                    opportunities.push(enriched);
                }
            }
        });
        
        // This pause exists to respect Yahoo Finance rate limits — but it used to fire
        // unconditionally on every batch even when Yahoo wasn't touched or already
        // wasn't the bottleneck, adding ~72s of pure dead time to a 116-candidate scan
        // (24 batches × 3s) on top of whatever the real analysis took. That's exactly
        // why zero-holdings accounts (which can never take the "portfolio at capacity"
        // early exit and so run this full loop every single cycle) were reliably
        // blowing past the scheduler's 4-min timeout with nothing to show for it
        // (confirmed live 2026-07-31: anilboddu1, 150/253 cycles over 7 days timed out).
        // The shared Yahoo circuit breaker (added 2026-07-29) already knows precisely
        // when Yahoo is actually rate-limited — defer to it instead of a blind sleep:
        // pay the full pause only while the breaker is tripped, otherwise a short gap
        // is enough to stay polite to the other per-symbol APIs (Alpaca, Gemini, SEC).
        const { isYahooRateLimited } = require('../utils/yfClient');
        await new Promise(resolve => setTimeout(resolve, isYahooRateLimited() ? 3000 : 300));
        
        // Progress update
        if ((i + batchSize) % 100 === 0) {
            logger.info('Market scan progress', { 
                userId,
                analyzed: Math.min(i + batchSize, qualified.length),
                total: qualified.length,
                opportunitiesFound: opportunities.length
            });
        }
    }
    
    // Refresh sector rotation cache from this scan (applied as boost/penalty in the next cycle)
    if (allAnalyzed.length > 0) {
        refreshSectorRotationCache(allAnalyzed);
        // Persist live PANTHEON scores to DB so the Signals page shows intraday re-scores.
        // Fire-and-forget — a cache miss is harmless, Signals page falls back to nightly score.
        _saveLiveScores(allAnalyzed).catch(e =>
            logger.warn('[LiveCache] Failed to save live scores', { err: e.message })
        );
    }

    const intelligenceAdjusted = await Promise.all(
        opportunities.map(async (opportunity) => {
            const expectancyStats = await tradeIntelligenceService.getExpectancyAdjustment({
                botType: 'stock',
                strategyFamily: opportunity.strategyFamily || 'equity_long',
                setupFamily: opportunity.setupFamily,
                regime: regime.regime
            });

            const baseAiScore = Number(opportunity.aiScore || 0);
            const adjustedAiScore = Math.max(0, Math.min(100, baseAiScore + expectancyStats.scoreAdjustment));

            return {
                ...opportunity,
                regime: regime.regime,
                baseAiScore,
                aiScore: Math.round(adjustedAiScore),
                expectancyStats,
                expectancyAdjustment: expectancyStats.scoreAdjustment
            };
        })
    );

    const filteredOpportunities = intelligenceAdjusted.filter(
        (opportunity) => opportunity.aiScore >= minBuyScore
    );

    // Setup priority: breakout_leader (Minervini pivot breakout) > oversold_reversal >
    // quality_continuation > mean_reversion_bounce. Used as tiebreaker within same score band.
    // Validated by June 18 backtest: breakout_leader avg +0.12% vs quality_continuation +0.02%.
    const SETUP_PRIORITY = { breakout_leader: 4, oversold_reversal: 3, quality_continuation: 2, mean_reversion_bounce: 1 };

    filteredOpportunities.sort((a, b) => {
        // Primary: tier (1 = mega/large cap quality, lower = better)
        if ((a.tier || 3) !== (b.tier || 3)) return (a.tier || 3) - (b.tier || 3);
        // Secondary: AI score (higher = better) — 2-pt band before setup breaks tie
        if (Math.abs(b.aiScore - a.aiScore) >= 2) return b.aiScore - a.aiScore;
        // Tiebreaker: setup family — breakout_leader > oversold_reversal > quality_continuation > mean_reversion_bounce
        const spDiff = (SETUP_PRIORITY[b.setupFamily] || 0) - (SETUP_PRIORITY[a.setupFamily] || 0);
        if (spDiff !== 0) return spDiff;
        // Final tiebreaker: VCP confirmed stocks first
        const vcpA = a.vcpPattern === 'confirmed' ? 2 : a.vcpPattern === 'forming' ? 1 : 0;
        const vcpB = b.vcpPattern === 'confirmed' ? 2 : b.vcpPattern === 'forming' ? 1 : 0;
        return vcpB - vcpA;
    });

    // Raise minimum score for speculative (tier 5)
    const filteredByTier = filteredOpportunities.filter(
        (opportunity) => {
            if (opportunity.tier === 5) return opportunity.aiScore >= Math.max(75, minBuyScore);
            return opportunity.aiScore >= minBuyScore;
        }
    );

    await Promise.all(
        filteredByTier.slice(0, Math.min(limit, 15)).map((opportunity) =>
            tradeIntelligenceService.recordCandidate(userId, {
                botType: 'stock',
                symbol: opportunity.symbol,
                setupFamily: opportunity.setupFamily,
                strategyFamily: opportunity.strategyFamily,
                regime: opportunity.regime,
                score: opportunity.aiScore,
                scoreAdjustment: opportunity.expectancyAdjustment,
                sizeMultiplier: opportunity.expectancyStats?.sizeMultiplier,
                expectancy: opportunity.expectancyStats?.expectancy,
                confidence: opportunity.expectancyStats?.confidence,
                metadata: {
                    baseAiScore: opportunity.baseAiScore,
                    recommendation: opportunity.recommendation,
                    sector: opportunity.sector,
                    daysToEarnings: opportunity.daysToEarnings ?? null,
                    newsSentiment: opportunity.newsSentiment,
                    relativeStrength: opportunity.relativeStrength,
                    scoringLog: opportunity.scoringLog
                }
            })
        )
    );
    logger.info('Market scan complete', { 
        userId,
        totalOpportunities: filteredByTier.length,
        returning: Math.min(filteredByTier.length, limit),
        scanned: allAnalyzed.length,
        regime: regime.regime
    });
    const scanResult = filteredByTier.slice(0, limit);
    scanResult._scanned = allAnalyzed.length;
    return scanResult;
}

/**
 * Execute autonomous trading for a user
 */
async function executeAutonomousTrading(userId) {
    agentHealth.recordHeartbeat('ARROW', 'START', { userId });
    try {
        logger.info('Starting autonomous trading', { userId });

        await ensurePhase0Schema();
        await tradeIntelligenceService.ensureTradeIntelligenceSchema();

        // PANTHEON Activation Gate — log current step and any unmet gates at every run
        evaluateGates(userId).catch(e =>
            logger.warn('[ActivationGate] Gate evaluation failed (non-blocking)', { error: e.message })
        );

        // COMPASS — prefetch sector RS ranks so the sector rotation scoring is fresh
        compassService.getSectorRanks().catch(e =>
            logger.warn('[COMPASS] Sector rank prefetch failed (non-blocking)', { error: e.message })
        );

        // ATLAS — pre-warm global market sentiment cache before per-stock scoring begins
        globalSentimentService.getGlobalSentiment().catch(e =>
            logger.warn('[ATLAS] Global sentiment prefetch failed (non-blocking)', { error: e.message })
        );

        const [globalControl, userControls] = await Promise.all([
            getGlobalTradingControl(),
            getUserTradingControls(userId)
        ]);

        if (!globalControl.globalTradingEnabled) {
            logger.warn('Global trading kill switch active, skipping trading', {
                userId,
                reason: globalControl.killSwitchReason || null
            });
            return {
                success: false,
                message: globalControl.killSwitchReason
                    ? `Global trading disabled: ${globalControl.killSwitchReason}`
                    : 'Global trading disabled'
            };
        }

        if (!userControls.aiTradingEnabled) {
            logger.warn('AI trading disabled for user, skipping trading', { userId });
            return { success: false, message: 'AI trading disabled for user' };
        }

        if (userControls.emergencyStopEnabled) {
            logger.warn('User emergency stop enabled, skipping trading', { userId });
            return { success: false, message: 'User emergency stop enabled' };
        }

        // Check if market is open
        if (!isMarketOpen()) {
            logger.info('Market is closed, skipping trading', { userId });
            return { success: false, message: 'Market is closed' };
        }

        // Data-freshness guard: verify live quote is reachable before allowing trades.
        // Each call has a hard 8-second timeout — Yahoo 429 retry loops can otherwise
        // hang indefinitely and freeze the scheduler's isRunning lock for the entire day.
        const DATA_MAX_AGE_MS = parseInt(process.env.DATA_MAX_AGE_MS || '120000'); // 2 min default
        const _dataGuardTimeout = (promise) =>
            Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('DataGuard timeout')), 8000))]);
        {
            let dataOk = false;
            try {
                const testQuote = await _dataGuardTimeout(dataProvider.getQuote('SPY'));
                const quoteAge = Date.now() - (testQuote._fetchedAt || 0);
                if (testQuote._fetchedAt && quoteAge > DATA_MAX_AGE_MS) {
                    logger.error('[DataGuard] Quote data is stale, halting trading', {
                        userId, ageMs: quoteAge, maxAgeMs: DATA_MAX_AGE_MS
                    });
                    return { success: false, message: `Market data is stale (${Math.round(quoteAge / 1000)}s old). Trading paused until fresh data available.` };
                }
                dataOk = true;
            } catch (dataErr) {
                logger.warn('[DataGuard] Primary provider unreachable — trying Yahoo Finance fallback', {
                    userId, error: dataErr.message
                });
            }
            if (!dataOk) {
                try {
                    const { default: yf } = require('yahoo-finance2');
                    const fn = yf._originalQuote || yf.quote;
                    await _dataGuardTimeout(fn.call(yf, 'SPY'));
                    logger.info('[DataGuard] Yahoo Finance fallback succeeded — proceeding with trading', { userId });
                    dataOk = true;
                } catch (yahooErr) {
                    logger.warn('[DataGuard] Both providers unreachable or timed out — proceeding with caution', {
                        userId, error: yahooErr.message
                    });
                    // Fail-open: Alpaca order submission will still reject if prices are stale.
                    // Better to attempt the cycle than freeze the scheduler for the entire session.
                    dataOk = true;
                }
            }
        }

        const [riskConfig, regime] = await Promise.all([
            getUserRiskConfig(userId),
            marketRegimeService.getMarketRegime()
        ]);

        // ── Regime shift detection ───────────────────────────────────────────────
        // Compare current regime to the last known regime for this user.
        // If it changed, send a Telegram alert describing what behaviour will change.
        {
            const prev = _lastRegimePerUser.get(userId);
            const curKey = `${regime.regime}:${regime.regimeType}`;
            const prevKey = prev ? `${prev.regime}:${prev.regimeType}` : null;
            if (prevKey && prevKey !== curKey) {
                const rt = (regime.regimeType || '').toUpperCase();
                const isBearish = rt.includes('BEAR') || rt === 'RISK_OFF' || rt === 'PANIC';
                const isBullish = rt.includes('BULL') || rt === 'RISK_ON' || rt === 'TRENDING_UP';
                const impacts = [];
                if (isBearish) {
                    impacts.push('Exit thresholds tightened (7% / 12% / 20%)');
                    impacts.push('New entries: score bar raised');
                    impacts.push('breakout_leader entries blocked');
                } else if (isBullish) {
                    impacts.push('Exit thresholds relaxed (12% / 18% / 30%)');
                    impacts.push('Position size multiplier increased');
                } else {
                    impacts.push('Neutral mode: standard thresholds apply');
                }

                // ── Immediate downgrade response ─────────────────────────────────────
                // Regime-scaled exit thresholds and position caps already recompute every
                // cycle from the *current* regime, so those apply on the very next cycle
                // regardless. What doesn't happen automatically: reacting *this instant* to
                // the transition itself — cancelling orders that were queued under the old
                // regime's assumptions and giving open positions an extra margin of safety
                // while the market digests the shift.
                const prevRank = _regimeRank(prev.regimeType);
                const curRank  = _regimeRank(regime.regimeType);
                if (curRank < prevRank) {
                    _regimeDowngradeUntil.set(userId, Date.now() + 2 * 3600000); // 2h extra-tighten window
                    try {
                        const openOrders  = await brokerService.getOpenOrders(userId).catch(() => []);
                        const pendingBuys = (openOrders || []).filter(o => o.side === 'buy');
                        for (const o of pendingBuys) {
                            try {
                                await brokerService.cancelOrder(userId, o.id);
                                logger.warn('[RegimeShift] Cancelled pending buy order on regime downgrade', {
                                    userId, symbol: o.symbol, orderId: o.id
                                });
                            } catch (_cancelErr) { /* order may have already filled/cancelled */ }
                        }
                    } catch (_ordersErr) { /* non-blocking */ }
                    impacts.push('Pending buy orders cancelled; trailing stops tightened an extra 2h');
                }

                const shiftMsg = [
                    '🔄 *MARKET REGIME SHIFT*',
                    '',
                    `Previous: ${prev.regime} (${prev.regimeType || '?'})`,
                    `Current:  *${regime.regime}* (${regime.regimeType})`,
                    '',
                    '*Behaviour changes:*',
                    ...impacts.map(l => `  • ${l}`),
                    '',
                    `VIX: ${regime.vixLevel || '?'} | Score floor: ${regime.minBuyScore || '?'}`
                ].join('\n');
                alertService.sendMessage(userId, shiftMsg).catch(() => {});
                logger.info('[RegimeShift] Alert queued', {
                    userId, from: prevKey, to: curKey
                });
            }
            _lastRegimePerUser.set(userId, {
                regime: regime.regime,
                regimeType: regime.regimeType,
                seenAt: Date.now()
            });
        }

        // Apply market regime overrides — regime caps risk and raises bar in bear/neutral markets.
        // Adaptive score: user base (minBuyScore) adjusted by regime quality.
        // BULL_STRONG → -3 pts (allow more trades in a rising market)
        // BULL_MILD   → -1 pt
        // NEUTRAL     → +2 pts (be more selective when direction is unclear)
        // CHOPPY      → +5 pts
        // BEAR        → +6 pts (only high-conviction trades in downtrend)
        // PANIC       → +10 pts (near-impossible bar — exits only)
        const REGIME_SCORE_OFFSET = {
            'BULL_STRONG': -3, 'BULL_MILD': -1,
            'NEUTRAL': 2, 'CHOPPY': 5, 'BEAR': 6, 'PANIC': 10
        };
        const _regimeOffset    = REGIME_SCORE_OFFSET[regime.regimeType || regime.regime] ?? 0;
        const effectiveMaxRisk = Math.min(riskConfig.maxPortfolioRisk, regime.maxRisk);
        const effectiveMinScore = Math.max(0, Math.min(100, riskConfig.minBuyScore + _regimeOffset));
        const healthMultiplier = await getSystemHealthMultiplier(userId);
        const effectiveSizeMultiplier = (regime.positionSizeMultiplier || 1.0) * healthMultiplier;

        logger.info('Market regime applied', {
            userId,
            regime: regime.regime,
            regimeType: regime.regimeType,
            effectiveMaxRisk,
            effectiveMinScore,
            effectiveSizeMultiplier,
            healthMultiplier,
            regimeDescription: regime.description,
            qqqAboveMa50: regime.qqqAboveMa50,
            risingRates: regime.risingRates,
            atrExpansion: regime.atrExpansion,
            spy5dRangePct: regime.spy5dRangePct
        });

        // PANIC regime — halt all new buys, manage exits only
        if (regime.regimeType === 'PANIC') {
            logger.warn('[RegimeGuard] PANIC regime — no new entries, managing exits only', {
                userId, vixLevel: regime.vixLevel, return20d: regime.return20d
            });
            await manageExistingPositions(userId);
            return { success: false, message: `Market in PANIC regime (VIX=${regime.vixLevel}, 20d=${regime.return20d}%) — exits only` };
        }

        // CHOPPY regime — momentum entries fail in range-bound markets, exits only
        if (regime.regimeType === 'CHOPPY') {
            logger.info('[RegimeGuard] CHOPPY regime — skipping momentum entries, managing exits', {
                userId, spy5dRangePct: regime.spy5dRangePct, atrExpansion: regime.atrExpansion
            });
            await manageExistingPositions(userId);
            return { success: true, message: `Market choppy (5d range=${regime.spy5dRangePct}%, ATR ratio=${regime.atrExpansion}) — exits only` };
        }

        // Use regime-adjusted config for this session
        const sessionRiskConfig = {
            ...riskConfig,
            maxPortfolioRisk: effectiveMaxRisk,
            minBuyScore: effectiveMinScore
        };

        // Fetch Kelly metrics once per session (null if < 10 trades history)
        const kellyMetrics = await performanceService.getKellyMetrics(userId);

        const vixLevel = await getVixLevel();
        
        // Get account and portfolio info
        const account = await accountDb.getTradingAccount(userId);
        const portfolio = await tradingServiceDB.getPortfolioSummary(userId);

        let availableBalance = parseFloat(account.balance);
        const currentHoldings = portfolio.holdings || [];

        // For Alpaca broker: fetch live account values FIRST so that StrategyScale,
        // sector allocation checks, and the daily loss circuit breaker all operate on
        // the real portfolio value — not a stale DB figure that may be 100× too large
        // (e.g. a $500 live account that has a $200K paper balance in the DB).
        let totalPortfolioValue = portfolio.totalPortfolioValue || availableBalance;
        if (process.env.BROKER === 'alpaca') {
            try {
                const brokerAcct = await brokerService.getAccountInfo(userId);
                totalPortfolioValue = brokerAcct.portfolioValue || availableBalance;
                // Use actual cash (not buying power) so the bot never sizes positions using margin credit.
                // Buying power includes Reg-T margin (~2×) which would let the bot over-deploy.
                availableBalance = Math.max(0, brokerAcct.cashBalance ?? brokerAcct.buyingPower);
                logger.info('[CashGuard] Synced from Alpaca', {
                    userId,
                    portfolioValue: totalPortfolioValue.toFixed(2),
                    cashAvailable:  availableBalance.toFixed(2),
                    buyingPower:    brokerAcct.buyingPower?.toFixed(2),
                });
            } catch (bpErr) {
                logger.warn('[CashGuard] Could not fetch Alpaca account — using DB balance', {
                    userId, err: bpErr.message
                });
            }
        }

        // Blitz capital carve-out — this same Alpaca account may also be running the
        // opt-in intraday module (Blitz), which draws from the same real cash pool.
        // Subtract whatever Blitz currently has deployed so swing never double-spends
        // dollars Blitz has already committed. Read-only and fail-open: a failure here
        // never blocks or delays a swing trade, it just proceeds without the carve-out
        // (matching the existing CashGuard's own fail-open behavior above).
        try {
            const capitalCoordinator = require('./capitalCoordinator');
            const intradayCommitted = await capitalCoordinator.getIntradayCommittedCapital(userId);
            if (intradayCommitted > 0) {
                availableBalance = Math.max(0, availableBalance - intradayCommitted);
                logger.info('[CashGuard] Carved out Blitz-committed capital', { userId, intradayCommitted: intradayCommitted.toFixed(2), availableBalance: availableBalance.toFixed(2) });
            }
        } catch (icErr) {
            logger.warn('[CashGuard] Could not read Blitz committed capital — proceeding without carve-out', { userId, err: icErr.message });
        }

        // Strategy vs Amount: dynamically cap maxOpenPositions and maxOrderNotional
        // proportional to the actual portfolio value. Ensures every user runs the same
        // strategy quality (minBuyScore unchanged) while position scale reflects balance.
        {
            const pv = totalPortfolioValue;
            const dynamicMaxPos = pv < 2000 ? 8 : pv < 15000 ? 10 : pv < 30000 ? 12 : pv < 75000 ? 14 : 15;
            const dynamicMaxNotional = Math.min(20000, Math.max(300, Math.round(pv * 0.10)));
            // Only tighten — never let DB config exceed what the balance can support
            if (sessionRiskConfig.maxOpenPositions > dynamicMaxPos) {
                sessionRiskConfig.maxOpenPositions = dynamicMaxPos;
            }
            if (sessionRiskConfig.maxOrderNotional > dynamicMaxNotional) {
                sessionRiskConfig.maxOrderNotional = dynamicMaxNotional;
            }
            logger.info('[StrategyScale] Proportional limits applied', {
                userId, portfolioValue: pv.toFixed(2),
                maxOpenPositions: sessionRiskConfig.maxOpenPositions,
                maxOrderNotional: sessionRiskConfig.maxOrderNotional
            });
        }

        logger.info('Account status', {
            userId,
            availableBalance: availableBalance.toFixed(2),
            holdings: currentHoldings.length,
            portfolioValue: totalPortfolioValue.toFixed(2)
        });

        // Check daily loss circuit breaker (dynamic % of portfolio — PANTHEON SHIELD)
        const lossLimitReached = await checkDailyLossLimit(userId, sessionRiskConfig, totalPortfolioValue);
        if (lossLimitReached) {
            logger.error('Daily loss limit reached, stopping trading', { userId });
            return { success: false, message: 'Daily loss limit reached' };
        }

        // Check consecutive loss streak circuit breaker
        const streakBreaker = await checkLossStreakBreaker(userId);
        if (streakBreaker.halt) {
            alertService.alertTradingStarted(userId, 0, 0).catch(() => {}); // reuse for now — sends info
            logger.error('[CircuitBreaker] Trading halted due to consecutive loss streak', {
                userId, streak: streakBreaker.streak
            });
            return { success: false, message: `Circuit breaker: ${streakBreaker.streak} consecutive losses — trading halted` };
        }
        
        // Max portfolio drawdown — 3-level PANTHEON circuit breaker
        const drawdownState = await checkMaxDrawdown(userId, totalPortfolioValue);
        if (drawdownState.halt) {
            return { success: false, message: `Max drawdown exceeded (${drawdownState.drawdownPct.toFixed(1)}%) — all new buys halted` };
        }
        // Level 2: paper-only mode — block live new buys but allow the session to manage exits
        if (drawdownState.paperOnly && brokerService.isLive) {
            logger.warn('[DrawdownBreaker] Live new buys blocked — paper-only mode active', {
                drawdownPct: drawdownState.drawdownPct.toFixed(2)
            });
            sessionRiskConfig._drawdownPaperOnly = true;
        }
        // Level 1: halve position sizes for all new entries this session
        if (drawdownState.reduceSizing) {
            sessionRiskConfig._drawdownReduceSizing = true;
        }

        // Weekly loss limit — PANTHEON SHIELD: halt if week P&L < -10% portfolio
        const weeklyHalt = await checkWeeklyLossLimit(userId, totalPortfolioValue, sessionRiskConfig);
        if (weeklyHalt) {
            return { success: false, message: 'Weekly loss limit reached — trading halted until Monday' };
        }

        // Daily circuit breaker: halt new entries if EITHER condition fires:
        //   1. Stop-loss count ≥ DAILY_STOP_HALT (default 3) — signals hostile tape
        //   2. Realized losses today ≥ DAILY_LOSS_HALT_PCT % of equity (default 2%) — protects capital
        // Either condition alone is sufficient; whichever fires first triggers the halt.
        try {
            const _todayStopRes = await query(`
                SELECT
                    COUNT(*) FILTER (WHERE pnl < 0)  AS cnt,
                    COALESCE(SUM(pnl) FILTER (WHERE pnl < 0), 0) AS loss_sum
                FROM trades
                WHERE user_id = $1
                  AND action = 'SELL'
                  AND trade_date >= CURRENT_DATE
            `, [userId]);
            const _todayStops   = parseInt(_todayStopRes.rows[0]?.cnt || 0);
            const _todayLossUsd = Math.abs(parseFloat(_todayStopRes.rows[0]?.loss_sum || 0));
            const _stopHaltThreshold = parseInt(process.env.DAILY_STOP_HALT || '3');
            const _lossHaltPct  = parseFloat(process.env.DAILY_LOSS_HALT_PCT || '2.0');

            // Condition 2: loss % of equity
            let _lossHaltFired = false;
            let _lossHaltMsg   = '';
            if (_lossHaltPct > 0 && accountTotalValue > 0) {
                const _todayLossPct = (_todayLossUsd / accountTotalValue) * 100;
                if (_todayLossPct >= _lossHaltPct) {
                    _lossHaltFired = true;
                    _lossHaltMsg   = `Daily loss limit: -$${_todayLossUsd.toFixed(2)} (${_todayLossPct.toFixed(2)}% of equity, limit ${_lossHaltPct}%)`;
                }
            }

            if (_todayStops >= _stopHaltThreshold || _lossHaltFired) {
                const reason = _lossHaltFired ? _lossHaltMsg : `${_todayStops} stop-losses fired today (limit: ${_stopHaltThreshold})`;
                logger.warn('[DailyCircuitBreaker] Halting new entries', { userId, reason });
                alertService.sendMessage(userId,
                    `⚠️ *Daily Circuit Breaker Triggered*\n${reason}\n` +
                    `_No new entries until tomorrow — managing open positions only._`
                ).catch(() => {});
                await manageExistingPositions(userId);
                return { success: false, message: `Daily circuit breaker: ${reason}` };
            }
        } catch (_stopBreakerErr) {
            logger.warn('[DailyCircuitBreaker] Check failed — proceeding', { err: _stopBreakerErr.message });
        }

        // SHIELD — FRED macro gate: raise minBuyScore or halt new buys in severe bear macro
        const macroSnapshot = await fredMacroService.getMacroSnapshot();
        if (macroSnapshot.macroSignal === 'bearish' && macroSnapshot.scoreAdj <= -8) {
            logger.warn('[SHIELD/FRED] Severe bearish macro — halting new purchases', {
                macroSignal: macroSnapshot.macroSignal,
                scoreAdj:    macroSnapshot.scoreAdj,
                fedFunds:    macroSnapshot.fedFundsRate,
                yieldSpread: macroSnapshot.yieldSpread10Y2Y
            });
            await manageExistingPositions(userId);
            return { success: false, message: `Macro environment too bearish (FRED scoreAdj: ${macroSnapshot.scoreAdj})` };
        }
        if (macroSnapshot.macroSignal === 'bearish') {
            // Moderate bearish: raise buy threshold by 5 pts so only high-conviction entries go through
            sessionRiskConfig.minBuyScore = Math.min(85, sessionRiskConfig.minBuyScore + 5);
            logger.info('[SHIELD/FRED] Moderate bearish macro — minBuyScore raised', {
                newMinBuyScore: sessionRiskConfig.minBuyScore,
                scoreAdj: macroSnapshot.scoreAdj
            });
        }

        // ── FOMC / Fed Day Gate ───────────────────────────────────────────────────
        const fomcWindow = checkFomcWindow();
        if (fomcWindow.isFomcDay) {
            sessionRiskConfig.minBuyScore = Math.min(95, sessionRiskConfig.minBuyScore + 10);
            logger.warn('[FOMC] Fed decision day — minBuyScore raised +10', {
                userId,
                newMinBuyScore: sessionRiskConfig.minBuyScore,
                fomcDate: fomcWindow.date
            });
        } else if (fomcWindow.isFomcEve) {
            sessionRiskConfig.minBuyScore = Math.min(90, sessionRiskConfig.minBuyScore + 5);
            logger.info('[FOMC] Fed eve — minBuyScore raised +5', {
                userId,
                newMinBuyScore: sessionRiskConfig.minBuyScore,
                fomcDate: fomcWindow.nextDate
            });
        }

        // ── CPI / NFP Release Gate ────────────────────────────────────────────────
        const macroReleaseEvents = checkMacroReleaseWindow();
        for (const evt of macroReleaseEvents) {
            if (evt.timing === 'today') {
                sessionRiskConfig.minBuyScore = Math.min(92, sessionRiskConfig.minBuyScore + 7);
                logger.warn(`[EVENT] ${evt.type} release day — minBuyScore raised +7`, {
                    userId, newMinBuyScore: sessionRiskConfig.minBuyScore, date: evt.date
                });
            } else {
                sessionRiskConfig.minBuyScore = Math.min(88, sessionRiskConfig.minBuyScore + 4);
                logger.info(`[EVENT] ${evt.type} release tomorrow — minBuyScore raised +4`, {
                    userId, newMinBuyScore: sessionRiskConfig.minBuyScore, date: evt.date
                });
            }
        }

        // ── Post-Holiday Return Day Gate ─────────────────────────────────────────
        // First trading day back from a holiday (e.g. Monday July 7 after July 4):
        // lower liquidity, wider spreads, gap fills, and position squaring by desks.
        // Raise minBuyScore +5 and cap new entries to 2 max for the day.
        if (isPostHolidayReturnDay()) {
            const prevScore = sessionRiskConfig.minBuyScore;
            sessionRiskConfig.minBuyScore = Math.min(93, sessionRiskConfig.minBuyScore + 5);
            logger.warn('[HolidayReturn] First trading day back — minBuyScore raised, entries limited', {
                userId,
                before: prevScore,
                after: sessionRiskConfig.minBuyScore,
                note: 'Post-holiday liquidity lower; widened spreads increase stop-hunt risk'
            });
        }

        // ── OPEX Gate (3rd Friday gamma unwind) ──────────────────────────────────
        const opexWindow = checkOpexWindow();
        if (opexWindow.isOpex) {
            sessionRiskConfig.minBuyScore = Math.min(90, sessionRiskConfig.minBuyScore + 5);
            logger.warn('[OPEX] Options expiration day — minBuyScore raised +5', {
                userId, newMinBuyScore: sessionRiskConfig.minBuyScore, opexDate: opexWindow.date
            });
        } else if (opexWindow.isOpexEve) {
            sessionRiskConfig.minBuyScore = Math.min(87, sessionRiskConfig.minBuyScore + 3);
            logger.info('[OPEX] OPEX eve — minBuyScore raised +3', {
                userId, newMinBuyScore: sessionRiskConfig.minBuyScore, opexDate: opexWindow.date
            });
        }

        // SHIELD — Gross exposure cap: total market value < 75% of portfolio
        const totalMarketValue    = currentHoldings.reduce((sum, h) => sum + (h.marketValue || 0), 0);
        const grossExposurePct    = totalPortfolioValue > 0 ? totalMarketValue / totalPortfolioValue : 0;
        const maxGrossExposure    = riskConfig.maxGrossExposurePct || 0.75;
        if (grossExposurePct >= maxGrossExposure) {
            logger.info('[SHIELD] Gross exposure cap reached — no new buys', {
                userId, grossExposurePct: (grossExposurePct * 100).toFixed(1) + '%', cap: (maxGrossExposure * 100) + '%'
            });
            await manageExistingPositions(userId);
            return { success: true, message: `Gross exposure cap reached (${(grossExposurePct * 100).toFixed(1)}%)` };
        }

        // SHIELD — Portfolio beta gate: prevent over-correlation with the market
        const portfolioBeta    = await computePortfolioBeta(currentHoldings, totalPortfolioValue).catch(() => 1);
        const maxPortfolioBeta = riskConfig.maxPortfolioBeta || 1.5;
        if (portfolioBeta > maxPortfolioBeta) {
            logger.warn('[SHIELD] Portfolio beta too high — no new buys', {
                userId, portfolioBeta, maxPortfolioBeta
            });
            await manageExistingPositions(userId);
            return { success: false, message: `Portfolio beta ${portfolioBeta} exceeds max ${maxPortfolioBeta}` };
        }
        if (portfolioBeta > 0) {
            logger.info('[SHIELD] Portfolio beta OK', { userId, portfolioBeta });
        }

        // Send trading started alert — rate-limited to once per hour so the bot
        // cycling every 5 minutes doesn't flood Telegram with identical messages.
        const _lastSent = _tradingStartedLastSent.get(userId) || 0;
        if (Date.now() - _lastSent >= 3600_000) {
            _tradingStartedLastSent.set(userId, Date.now());
            alertService.alertTradingStarted(userId, availableBalance, currentHoldings.length).catch(() => {});
        }

        // VIX Spike Monitor — halt immediately on EXTREME/PANIC spike (fast moves
        // may not yet be reflected in the polled vixLevel from this cycle)
        const spikeState = vixMonitor.getSpikeState();
        if (spikeState.spikeActive && (spikeState.level === 'EXTREME' || spikeState.level === 'PANIC')) {
            logger.warn('[VIXSpike] Halting new entries — spike active', {
                userId, level: spikeState.level,
                vix: spikeState.vixAtSpike, pctChange: spikeState.pctChange?.toFixed(1)
            });
            await manageExistingPositions(userId);
            return {
                success: false,
                message: `VIX spike halt (${spikeState.level} — VIX ${spikeState.vixAtSpike?.toFixed(1)}, ${spikeState.pctChange >= 0 ? '+' : ''}${spikeState.pctChange?.toFixed(1)}% move)`
            };
        }

        // Check VIX - reduce trading if too volatile
        if (vixLevel > sessionRiskConfig.maxVix) {
            logger.warn('VIX too high, skipping new purchases', { userId, vixLevel: vixLevel.toFixed(2) });
            alertService.alertHighVIX(userId, vixLevel).catch(() => {});
            // Still check for stop-loss and exits
            await manageExistingPositions(userId);
            return { success: false, message: `Market too volatile (VIX: ${vixLevel.toFixed(2)})` };
        }

        // Manage existing positions (stop-loss, take-profit, trailing stops)
        await manageExistingPositions(userId);

        // SENTINEL live-readiness gate — blocks new buys only; exits above have already run.
        // Checked once per session (30-day look-back). Fail-open if DB errors so daily loss
        // and drawdown circuit breakers still protect.
        {
            const { checkLiveReadiness } = require('./liveReadinessService');
            const readiness = await checkLiveReadiness(String(userId));
            if (!readiness.ready) {
                logger.error('[SENTINEL] Live-readiness gate blocked new buys (exits already managed)', {
                    userId, reason: readiness.reason, blockers: readiness.blockers
                });
                alertService.sendMessage(userId,
                    `⛔ *SENTINEL: New Buys Blocked*\n` +
                    `_${readiness.reason}_\n\n` +
                    Object.entries(readiness.blockers)
                        .filter(([, v]) => v > 0)
                        .map(([k, v]) => `  • ${k}: ${v}`)
                        .join('\n') +
                    `\n\n_Exits still managed. Resolve the issue then restart the bot._`
                ).catch(() => {});
                return { success: false, message: `SENTINEL gate: ${readiness.reason}` };
            }
        }

        // Calculate how much we can invest
        const maxInvestment = totalPortfolioValue * sessionRiskConfig.maxPortfolioRisk;
        const currentInvestment = currentHoldings.reduce((sum, h) => sum + (h.marketValue || 0), 0);
        const availableToInvest = Math.min(
            availableBalance,
            maxInvestment - currentInvestment
        );

        logger.info('Investment capacity calculated', {
            userId,
            availableToInvest: availableToInvest.toFixed(2),
            maxPositions: sessionRiskConfig.maxOpenPositions,
            currentPositions: currentHoldings.length,
            regime: regime.regime
        });

        if (availableToInvest < 50 || currentHoldings.length >= sessionRiskConfig.maxOpenPositions) {
            logger.info('Portfolio at capacity', { userId, availableToInvest, currentHoldings: currentHoldings.length });
            return { success: true, message: 'Portfolio at capacity' };
        }

        // ── QQQ Green-Day Gate ────────────────────────────────────────────────────
        // Avoid new entries on a broad-market red day. QQQ down ≥1.5% is a meaningful
        // institutional sell signal; regime must be BULL_STRONG to override it.
        //   • down ≥0.5%: raise minBuyScore +5 (high-conviction entries only)
        //   • down ≥1.5% and regime ≠ BULL_STRONG: skip new buys entirely
        try {
            const qqqQuote     = await dataProvider.getQuote('QQQ');
            const qqqChangePct = typeof qqqQuote.changePercent === 'number' ? qqqQuote.changePercent : 0;
            if (qqqChangePct <= -1.5 && regime.regimeType !== 'BULL_STRONG') {
                logger.warn('[QQQGate] QQQ down ≥1.5% and regime not BULL_STRONG — skipping new buys', {
                    userId, qqqChangePct: qqqChangePct.toFixed(2), regime: regime.regime
                });
                return { success: true, message: `QQQ red day (${qqqChangePct.toFixed(2)}%) — no new entries` };
            }
            if (qqqChangePct <= -0.5) {
                sessionRiskConfig.minBuyScore = Math.min(92, sessionRiskConfig.minBuyScore + 5);
                logger.info('[QQQGate] QQQ slightly red — raising minBuyScore +5', {
                    userId, qqqChangePct: qqqChangePct.toFixed(2), newMinBuyScore: sessionRiskConfig.minBuyScore
                });
            }
            logger.debug('[QQQGate] QQQ intraday', { qqqChangePct: qqqChangePct.toFixed(2) });
        } catch (qqqErr) {
            logger.debug('[QQQGate] QQQ quote unavailable — gate skipped', { error: qqqErr.message });
        }

        // Scan market for best opportunities (pass regime minBuyScore so scan filters correctly)
        const opportunities = await scanMarketForOpportunities(userId, 100, sessionRiskConfig.minBuyScore);

        if (opportunities.length === 0) {
            logger.info('No qualifying opportunities found', { userId, vixLevel });
            alertService.alertNoOpportunities(userId, opportunities._scanned || 0, vixLevel).catch(() => {});
            return { success: true, message: 'No opportunities meet criteria' };
        }

        // Filter out stocks we already own
        const ownedSymbols = currentHoldings.map(h => h.symbol);
        const newOpportunities = opportunities.filter(opp => !ownedSymbols.includes(opp.symbol));

        // Edge Gate: only enter new positions when there is at least one STRONG BUY signal.
        // Pure BUY signals (borderline score) alone are not enough conviction to risk capital.
        const highConvictionCount = newOpportunities.filter(opp => opp.recommendation === 'STRONG BUY').length;
        if (highConvictionCount === 0) {
            logger.info('[EdgeGate] No STRONG BUY signals — skipping buy cycle, managing exits only', {
                userId, totalOpportunities: newOpportunities.length
            });
            _bumpGateStat(userId, 'edgeGate');
            // Operator awareness: alert once per day so the user knows no trades were opened
            alertService.alertEdgeGateBlocked(userId, newOpportunities.length).catch(() => {});
            await manageExistingPositions(userId);
            return { success: true, message: 'No high-conviction opportunities — exits managed' };
        }

        // SPY broad-market filter: no new longs when SPY is below its 20-day SMA.
        // When the market is in a downtrend, even high-scoring setups fail at ~3× the normal rate
        // (evidenced by Jun 16 mass stop-out — 6 positions stopped on the same broad-market down day).
        try {
            const _spyBars = await _dataGuardTimeout(dataProvider.getBars('SPY', '1d', 25));
            if (_spyBars && _spyBars.length >= 20) {
                const _spyCloses = _spyBars.map(b => b.close || b.c || 0).filter(c => c > 0);
                if (_spyCloses.length >= 20) {
                    const _spySma20 = _spyCloses.slice(-20).reduce((s, c) => s + c, 0) / 20;
                    const _spyPrice = _spyCloses[_spyCloses.length - 1];
                    if (_spyPrice < _spySma20) {
                        logger.info('[SPYGate] Broad market below 20-day SMA — blocking new longs, managing exits only', {
                            userId,
                            spyPrice: _spyPrice.toFixed(2),
                            spySma20: _spySma20.toFixed(2),
                            deviation: ((_spyPrice - _spySma20) / _spySma20 * 100).toFixed(2) + '%'
                        });
                        _bumpGateStat(userId, 'spyGate');
                        await manageExistingPositions(userId);
                        return { success: true, message: 'SPY below 20-day SMA — broad market weak, exits managed only' };
                    }
                    logger.debug('[SPYGate] Broad market healthy', {
                        userId, spyPrice: _spyPrice.toFixed(2), spySma20: _spySma20.toFixed(2),
                        pctAbove: ((_spyPrice - _spySma20) / _spySma20 * 100).toFixed(2) + '%'
                    });
                }
            }
        } catch (_spyErr) {
            logger.debug('[SPYGate] SPY check unavailable — proceeding without gate', { error: _spyErr.message });
        }

        // Build sector allocations (dollar) and counts (position count) for diversification.
        // Also track industry-group counts to prevent trucking/semis/airline clusters.
        const sectorAllocations = {};
        const sectorCounts      = {};
        const industryCounts    = {};
        currentHoldings.forEach(h => {
            const sec = h.sector || 'Unknown';
            sectorAllocations[sec] = (sectorAllocations[sec] || 0) + (h.marketValue || 0);
            sectorCounts[sec]      = (sectorCounts[sec]      || 0) + 1;
            const ind = sectorMetadata.getIndustry(h.symbol);
            if (ind) industryCounts[ind] = (industryCounts[ind] || 0) + 1;
        });

        // === SECTOR CONCENTRATION CHECK ===
        // If any single sector already exceeds 50% of invested capital, block new buys in that sector
        const totalInvested = currentInvestment || 1;
        const overconcentratedSectors = Object.entries(sectorAllocations)
            .filter(([, value]) => value / totalInvested > 0.50)
            .map(([sec]) => sec);

        if (overconcentratedSectors.length > 0) {
            logger.warn('Sector concentration warning', { userId, overconcentratedSectors });
        }

        // Swing trade guard: no new entries in the last 30 min of the trading day.
        // Entering at 3:30 PM ET leaves no time to confirm the setup holds overnight.
        const _etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const _etMinutes = _etNow.getHours() * 60 + _etNow.getMinutes();
        const _isLateDay = _etMinutes >= 15 * 60 + 30; // 3:30 PM ET
        if (_isLateDay) {
            logger.info('[SwingGuard] After 3:30 PM ET — skipping new entries, managing exits only', { userId });
            await manageExistingPositions(userId);
            return { success: true, message: 'After 3:30 PM ET — swing-only mode, exits managed' };
        }

        // Opening volatility block: no new entries in the first 30 min of the session.
        // 9:30-10:00 AM ET is price discovery — wide spreads, stop hunts, and gap fills
        // make entries statistically worse. Exits and position management still run.
        const _isOpeningWindow = _etMinutes >= 9 * 60 + 30 && _etMinutes < 10 * 60;
        if (_isOpeningWindow) {
            logger.info('[OpenGuard] Before 10:00 AM ET — skipping new entries, managing exits only', { userId });
            await manageExistingPositions(userId);
            return { success: true, message: 'Before 10:00 AM ET — opening volatility window, exits managed' };
        }

        // Regime-aware per-cycle new-position cap.
        // Bear/Choppy/Neutral: hard cap. Bull: scale with signal breadth so wide conviction
        // (many STRONG BUY signals) unlocks more positions while thin conviction stays conservative.
        const _REGIME_POS_CAP = { BEAR: 1, NEUTRAL: 2, CHOPPY: 2 };
        const _regimeUpper = (regime.regime || '').toUpperCase();

        // Regime-gated TOTAL open-position limit (portfolio-wide cap, not just per-cycle).
        // Separate from regimeNewPosCap which governs how many NEW entries per trading cycle.
        const _isBearRegime = _regimeUpper.includes('BEAR') || _regimeUpper === 'RISK_OFF' || _regimeUpper === 'PANIC';
        const _REGIME_TOTAL_POS = {
            BEAR: 2, BEAR_QUIET: 3, BEAR_MILD: 4, RISK_OFF: 3, PANIC: 2, NEUTRAL: 6, CHOPPY: 5
        };
        const regimeMaxPositions = _REGIME_TOTAL_POS[_regimeUpper]
            ?? (_regimeUpper.includes('BULL_MILD') ? 6 : sessionRiskConfig.maxOpenPositions);
        let regimeNewPosCap;
        if (_REGIME_POS_CAP[_regimeUpper] !== undefined) {
            regimeNewPosCap = _REGIME_POS_CAP[_regimeUpper];
        } else {
            // Bull / unknown: breadth-adaptive cap — at least 2, hard-capped at 3 per cycle.
            // Previously used highConvictionCount which could unlock 10+ entries on a day with
            // many STRONG BUY signals — exactly what caused the Jun 16 mass-entry incident.
            regimeNewPosCap = Math.min(
                3,                               // hard cap: max 3 new positions per cycle even in BULL
                sessionRiskConfig.maxOpenPositions,
                Math.max(2, highConvictionCount)
            );
            logger.info('[RegimeCap] Bull regime — position cap', {
                userId, regime: regime.regime, highConvictionCount, regimeNewPosCap
            });
        }

        // Execute trades
        const trades = [];
        let remainingCapital = availableToInvest;
        // IMPROVEMENT: fetch bleeding symbols once per session to block chronically losing stocks
        const bleedingSymbols = await getBleedingSymbols(userId);

        // ── Portfolio Heat Budget ────────────────────────────────────────────────
        // Aggregate dollar-risk-to-stop across all open positions, capped as a % of equity.
        // Position-count caps (regimeMaxPositions) don't capture this: if VIX doubles, stop
        // distances widen and the same 5 positions can carry 2x the dollar risk with no
        // change in count. Shares the MAX_PORTFOLIO_RISK_PCT env var with the
        // /api/ai-trading/portfolio-heat dashboard endpoint so what's displayed is what's enforced.
        const _heatStopPct = Math.abs(riskConfig.stopLoss || 0.05);
        const _maxPortfolioRiskPct = parseFloat(process.env.MAX_PORTFOLIO_RISK_PCT || '2.5');
        let runningHeatUsd = currentHoldings.reduce((s, h) => {
            const qty = parseFloat(h.quantity) || 0;
            const avgPrice = parseFloat(h.average_price) || 0;
            return s + (qty * avgPrice * _heatStopPct);
        }, 0);

        // Batch-load all active stop-loss cooldowns for this user in ONE query (avoids N+1 per opportunity).
        const cooldownSymbols = new Set();
        try {
            const cooldownPrefix = `COOLDOWN_${userId}_`;
            const cooldownRes = await query(
                `SELECT symbol FROM asset_blacklist
                 WHERE symbol LIKE $1 AND (expires_at IS NULL OR expires_at > NOW())`,
                [`${cooldownPrefix}%`]
            );
            for (const row of cooldownRes.rows) {
                // Strip prefix to get the raw ticker (e.g. "COOLDOWN_42_AAPL" → "AAPL")
                cooldownSymbols.add(row.symbol.slice(cooldownPrefix.length).toUpperCase());
            }
        } catch (_) {}

        // Late-day entry gate — no NEW positions after 2:30 PM ET.
        // The last 90 minutes before close have elevated volatility, wider spreads, and
        // momentum reversals that hit stops the same afternoon. Managing existing positions
        // continues normally; only new entries are blocked.
        const _etParts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false
        }).formatToParts(new Date());
        const _etHour   = parseInt(_etParts.find(p => p.type === 'hour').value,   10);
        const _etMinute = parseInt(_etParts.find(p => p.type === 'minute').value, 10);
        const _etMinTotal = _etHour * 60 + _etMinute;
        const _lateDayBlock = _etMinTotal >= (14 * 60 + 30); // 2:30 PM ET = 870 minutes

        if (_lateDayBlock && newOpportunities.length > 0) {
            logger.info('[LateDay] Blocking new entries after 2:30 PM ET — managing existing positions only', {
                userId, etTime: `${_etHour}:${String(_etMinute).padStart(2, '0')}`
            });
        }

        for (const opportunity of (_lateDayBlock ? [] : newOpportunities)) {
            if (trades.length >= sessionRiskConfig.maxDailyTrades) break;
            if (remainingCapital < 100) break;
            if (currentHoldings.length + trades.length >= regimeMaxPositions) break;
            if (trades.length >= regimeNewPosCap) { // regime cap: BEAR=1, NEUTRAL/CHOPPY=2, BULL=breadth
                logger.info('[RegimeCap] New-position cap reached for this cycle', {
                    userId, cap: regimeNewPosCap, regime: regime.regime
                });
                _bumpGateStat(userId, 'regimeCap');
                _recordRejection(opportunity.symbol, 'regime_cap', `${regime.regime} cap=${regimeNewPosCap}`);
                break;
            }

            // Skip earnings-flagged stocks entirely (0-4 days — too close)
            if (opportunity.earningsFlag) {
                logger.info('[EarningsGuard] Skipping — earnings within 4 days, IV crush risk', {
                    userId, symbol: opportunity.symbol, daysToEarnings: opportunity.daysToEarnings
                });
                _recordRejection(opportunity.symbol, 'earnings_guard', `${opportunity.daysToEarnings}d to earnings`);
                continue;
            }

            // Pre-earnings setup (5-15 days): allow BUT require score ≥ 88 and half position size
            const _isEarningsSetup = !!opportunity.earningsSetup;
            if (_isEarningsSetup && (opportunity.aiScore || 0) < 88) {
                logger.info('[EarningsSetup] Skipping — pre-earnings entry requires score ≥ 88', {
                    userId, symbol: opportunity.symbol,
                    score: opportunity.aiScore, daysToEarnings: opportunity.daysToEarnings
                });
                continue;
            }

            // IMPROVEMENT: Skip chronically losing symbols (≥60% loss rate, ≥3 trades in 30d)
            if (bleedingSymbols.has(opportunity.symbol.toUpperCase())) {
                logger.warn('[BleedingGate] Skipping chronically losing symbol', {
                    userId, symbol: opportunity.symbol
                });
                continue;
            }

            // Enforce max 1 active position per symbol (including in-session buys this cycle)
            if (trades.some(t => t.symbol === opportunity.symbol)) {
                logger.info('[DupSymbol] Skipping — already bought this session', { userId, symbol: opportunity.symbol });
                continue;
            }

            // Open-order guard: block if Alpaca already has a pending order for this symbol.
            // Prevents the order-storm bug where partial fills + cycle-changing aiScore keys
            // bypassed idempotency and submitted hundreds of redundant orders per symbol.
            {
                const openOrders = await brokerService.getOpenOrders(userId, opportunity.symbol).catch(() => []);
                if (openOrders.length > 0) {
                    logger.info('[OpenOrderGuard] Skipping — open order already pending on broker', {
                        userId, symbol: opportunity.symbol, orderId: openOrders[0].id
                    });
                    continue;
                }
            }

            // Order rate limiter: hard cap on orders per symbol and per account per day.
            // Second line of defence after the open-order guard — catches edge cases where
            // the broker check is unavailable (e.g. simulated broker) or orders were placed
            // by a different process instance.
            {
                const rateCheck = _checkOrderRateLimit(userId, opportunity.symbol);
                if (!rateCheck.allowed) {
                    logger.warn('[RateLimit] Skipping buy — daily order limit reached', {
                        userId, symbol: opportunity.symbol, reason: rateCheck.reason, count: rateCheck.count
                    });
                    continue;
                }
            }

            // Broker position guard — ask Alpaca directly whether we already hold this symbol.
            // The open-order guard catches working orders; this catches positions that filled
            // between cycles or were opened outside this process (manual trade, another bot).
            // Alpaca is the source of truth; the DB is only a mirror.
            {
                const existingPos = await brokerService.getPosition(userId, opportunity.symbol).catch(() => null);
                if (existingPos) {
                    logger.info('[PositionGuard] Skipping — Alpaca already shows open position', {
                        userId, symbol: opportunity.symbol, qty: existingPos.qty
                    });
                    continue;
                }
            }

            // Stop-loss cooldown: block re-entry for 5 days (batch-loaded above — O(1) lookup)
            if (cooldownSymbols.has(opportunity.symbol.toUpperCase())) {
                logger.info('[StopCooldown] Re-entry blocked — symbol in cooldown period', { userId, symbol: opportunity.symbol });
                _recordRejection(opportunity.symbol, 'stop_cooldown');
                continue;
            }

            // Abnormal gap filter: stocks that gapped >20% today are news-driven spikes
            // that often reverse violently — too dangerous to chase at the extended price.
            // Stocks in the 12-20% gap zone are allowed but require score ≥ 86 (above minimum).
            {
                const todayChangePct = opportunity.change || 0; // already in percentage (e.g. 15.5 = 15.5%)
                if (todayChangePct > 20) {
                    logger.info('[GapFilter] Skipping — abnormal gap-up >20% today', {
                        userId, symbol: opportunity.symbol, changePct: todayChangePct.toFixed(1)
                    });
                    continue;
                }
                if (todayChangePct > 12 && (opportunity.aiScore || 0) < 86) {
                    logger.info('[GapFilter] Skipping — elevated gap 12-20% requires score ≥ 86', {
                        userId, symbol: opportunity.symbol,
                        changePct: todayChangePct.toFixed(1), score: opportunity.aiScore
                    });
                    continue;
                }

                // Moderate gap penalty (3-12%): stock moved since nightly scan flagged it.
                // Entry is now stale — apply a score haircut proportional to the gap.
                // 3% gap → -3 pts, 8% gap → -8 pts, 12% gap → -12 pts (capped).
                if (todayChangePct > 3 && todayChangePct <= 12) {
                    const gapPenalty = Math.round(Math.min(12, todayChangePct));
                    const effectiveScore = (opportunity.aiScore || 0) - gapPenalty;
                    const _gapMinScore = sessionRiskConfig.minBuyScore;
                    if (effectiveScore < _gapMinScore) {
                        logger.info('[GapFilter] Skipping — moderate gap reduces effective score below threshold', {
                            userId, symbol: opportunity.symbol,
                            changePct: todayChangePct.toFixed(1),
                            originalScore: opportunity.aiScore,
                            gapPenalty, effectiveScore, minBuyScore: _gapMinScore
                        });
                        continue;
                    }
                    logger.info('[GapFilter] Moderate gap — applying score haircut but proceeding', {
                        userId, symbol: opportunity.symbol,
                        changePct: todayChangePct.toFixed(1),
                        originalScore: opportunity.aiScore,
                        gapPenalty, effectiveScore
                    });
                }
            }

            // Regime gate: breakout_leader setups require a trending bullish regime.
            // In NEUTRAL/BEAR regimes this setup family has a 20% win rate — block unless score ≥ 88.
            if (opportunity.setupFamily === 'breakout_leader') {
                const oppRegime = ((opportunity.regime || (typeof regime === 'object' && regime?.regime) || '')).toString().toUpperCase();
                const bullishRegimes = ['BULL', 'RISK_ON', 'STRONG_BULL', 'TRENDING_UP'];
                if (!bullishRegimes.some(r => oppRegime.includes(r))) {
                    if ((opportunity.aiScore || 0) < 88) {
                        logger.info('[RegimeGate] Skipping breakout_leader — regime not bullish', {
                            userId, symbol: opportunity.symbol, regime: oppRegime, score: opportunity.aiScore
                        });
                        continue;
                    }
                }
            }

            // Volume confirmation gate: CHOPPY/NEUTRAL/BEAR regimes require a volume surge
            // (≥1.5× avg) to confirm real buying interest before entry.
            {
                const _vgRegime = ((opportunity.regime || (typeof regime === 'object' && regime?.regime) || '')).toString().toUpperCase();
                if (_vgRegime.includes('CHOPPY') || _vgRegime.includes('NEUTRAL') || _vgRegime.includes('BEAR')) {
                    const volRatio = parseFloat(opportunity.volumeRatio) || 0;
                    if (volRatio < 1.5) {
                        logger.info('[VolumeGate] Skipping — no volume surge in low-conviction regime', {
                            userId, symbol: opportunity.symbol, volumeRatio: volRatio, regime: _vgRegime
                        });
                        _bumpGateStat(userId, 'volumeGate');
                        continue;
                    }
                }
            }

            // Earnings protection: hard block within 7 days of earnings.
            // Even a high-scoring setup can be destroyed by an earnings gap.
            // The scoring already applies a -15 penalty inside analyzeStockWithAI, but an
            // explicit block here ensures no stock slips through at the minimum score gate.
            {
                const _dte = opportunity.daysToEarnings;
                if (_dte !== null && _dte !== undefined && _dte <= 7) {
                    logger.info('[EarningsGuard] Skipping — earnings within 7 days', {
                        userId, symbol: opportunity.symbol,
                        daysToEarnings: _dte, score: opportunity.aiScore
                    });
                    continue;
                }
            }

            // Relative strength gate: require price above 50-day MA for standard entries.
            // Stocks below both MAs are in a downtrend — the setup may look good on a
            // short-term bounce but lacks structural tailwinds.
            // Exception: ultra-high conviction (score ≥ 92) may override — could be a
            // Stage 1→2 breakout that hasn't reclaimed the MA yet.
            {
                const _above50  = opportunity.aboveMa50;
                const _above200 = opportunity.aboveMa200;
                const _score    = opportunity.aiScore || 0;
                if (_above50 === false && _above200 === false && _score < 92) {
                    logger.info('[RSFilter] Skipping — price below both 50MA and 200MA', {
                        userId, symbol: opportunity.symbol,
                        price: opportunity.price,
                        ma50: opportunity.ma50, ma200: opportunity.ma200, score: _score
                    });
                    continue;
                }
                if (_above50 === false && _score < 88) {
                    logger.info('[RSFilter] Skipping — price below 50MA, requires score ≥88', {
                        userId, symbol: opportunity.symbol,
                        price: opportunity.price, ma50: opportunity.ma50, score: _score
                    });
                    continue;
                }
            }

            // Jones R/R gate — PANTHEON STEP 6: minimum 2.5:1 reward-to-risk required.
            // Raised from 2.0 → 2.5: tighter selectivity means only setups with genuine
            // upside-to-downside room pass. Borderline 2.1:1 setups now filtered out.
            if (!opportunity.riskReward || opportunity.riskReward < (riskConfig.minRiskRewardRatio || 2.5)) {
                logger.info('Skipping stock — R/R below minimum', {
                    userId, symbol: opportunity.symbol,
                    riskReward: opportunity.riskReward,
                    required:   riskConfig.minRiskRewardRatio || 2.5
                });
                _recordRejection(opportunity.symbol, 'risk_reward', `R/R ${opportunity.riskReward} < ${riskConfig.minRiskRewardRatio || 2.5}`);
                continue;
            }

            // ── Gap gate — don't chase setups that already ran overnight / pre-market ──
            // Compare the live price against the scan entry price. If current price
            // is >2% above the entry level from the scan, skip — buying here means
            // entering near the day's high with no cushion left before the target.
            try {
                const _liveQuote = await dataProvider.getQuote(opportunity.symbol);
                const _livePrice = _liveQuote?.price ?? _liveQuote?.close ?? 0;
                const _scanEntry = opportunity.entry || opportunity.price || 0;
                if (_livePrice > 0 && _scanEntry > 0 && _livePrice > _scanEntry * 1.02) {
                    const _gapPct = ((_livePrice / _scanEntry - 1) * 100).toFixed(1);
                    logger.info('[GapGate] Skipping — price already +' + _gapPct + '% above scan entry', {
                        userId, symbol: opportunity.symbol,
                        scanEntry: _scanEntry.toFixed(2), livePrice: _livePrice.toFixed(2)
                    });
                    _recordRejection(opportunity.symbol, 'gap_gate', `+${_gapPct}% above scan entry`);
                    continue;
                }
            } catch (_gapErr) { /* quote unavailable — proceed without gate */ }

            // ── Extension guard — don't enter stocks >10% above their 20-day SMA ──
            // Stocks this extended have high mean-reversion risk: any weakness pulls them
            // back hard. The score already penalises extension but doesn't hard-block it.
            const _distSma20 = opportunity.distFromSma20Pct;
            if (_distSma20 != null && _distSma20 > 10) {
                logger.info('[ExtensionGuard] Skipping — stock overextended above SMA20', {
                    userId, symbol: opportunity.symbol,
                    distFromSma20Pct: _distSma20.toFixed(1) + '% (limit: 10%)'
                });
                _recordRejection(opportunity.symbol, 'extension_guard', `+${_distSma20.toFixed(1)}% above SMA20`);
                continue;
            }

            // Unknown sector guard — when sector is unresolved, PANTHEON's sector momentum,
            // regime fit, and trade profile logic are all impaired. Utility/energy stocks
            // like SRE were incorrectly bought as if they were growth stocks because Alpaca
            // paper trading doesn't provide sector metadata and the symbol resolver missed them.
            // Skip execution if sector is unknown AND score is below the high-conviction floor.
            const sector = opportunity.sector || 'Unknown';
            if (sector === 'Unknown' && opportunity.aiScore < 88) {
                logger.info('Skipping stock — sector unknown, requiring score ≥88 for unknown-sector entries', {
                    userId, symbol: opportunity.symbol, score: opportunity.aiScore
                });
                continue;
            }
            const sectorCurrent      = sectorAllocations[sector] || 0;
            const sectorPositionCount = (sectorCounts[sector] || 0) + trades.filter(t => (t.sector || 'Unknown') === sector).length;
            const sectorAllocPct     = SECTOR_MAX_ALLOCATION[sector] ?? sessionRiskConfig.maxSectorAllocation;
            const sectorLimit        = totalPortfolioValue * sectorAllocPct;
            const maxPositionsPerSector = sessionRiskConfig.maxPositionsPerSector ?? 1;

            if (sectorPositionCount >= maxPositionsPerSector) {
                logger.info('Skipping stock — sector position count at limit', {
                    userId, symbol: opportunity.symbol, sector,
                    count: sectorPositionCount, max: maxPositionsPerSector
                });
                _recordRejection(opportunity.symbol, 'sector_count_cap', `${sector}: ${sectorPositionCount}/${maxPositionsPerSector}`);
                continue;
            }

            // Industry-level correlation cap — blocks trucking/semi/airline clusters
            // regardless of the broader sector limit being open.
            const industry = sectorMetadata.getIndustry(opportunity.symbol);
            if (industry) {
                const industryCount = (industryCounts[industry] || 0) +
                    trades.filter(t => sectorMetadata.getIndustry(t.symbol) === industry).length;
                if (industryCount >= sectorMetadata.MAX_POSITIONS_PER_INDUSTRY) {
                    logger.info('Skipping stock — industry group at limit', {
                        userId, symbol: opportunity.symbol, industry,
                        count: industryCount, max: sectorMetadata.MAX_POSITIONS_PER_INDUSTRY
                    });
                    continue;
                }
            }

            // Also block overconcentrated sectors (dollar cap)
            if (sectorCurrent >= sectorLimit || overconcentratedSectors.includes(sector)) {
                logger.info('Skipping stock - sector dollar limit reached', {
                    userId,
                    symbol: opportunity.symbol,
                    sector,
                    sectorCurrent: sectorCurrent.toFixed(2),
                    sectorLimit: sectorLimit.toFixed(2),
                    sectorCapPct: `${(sectorAllocPct * 100).toFixed(0)}%`
                });
                _recordRejection(opportunity.symbol, 'sector_dollar_cap', `${sector}: $${sectorCurrent.toFixed(0)}/$${sectorLimit.toFixed(0)}`);
                continue;
            }

            // ── Correlation risk check ──────────────────────────────────────
            const ownedNow = currentHoldings.map(h => h.symbol).concat(trades.map(t => t.symbol));
            const tooCorrelated = await isTooCorrelated(ownedNow, opportunity.symbol);
            if (tooCorrelated) {
                logger.info('Skipping stock — too correlated with existing holdings', {
                    userId, symbol: opportunity.symbol
                });
                _recordRejection(opportunity.symbol, 'correlation');
                continue;
            }

            // ── Position sizing ─────────────────────────────────────────────
            const accountTotalValue = availableBalance + currentInvestment;

            // Use the new PositionSizingService to get the Kelly Fraction.
            // The confidence score from the opportunity (0-100) is normalized to 0-1.
            const confidence = (opportunity.confidence || 50) / 100;
            const kellyFraction = await positionSizingService.getKellyFraction(confidence);

            // Apply regime and streak multipliers to the fraction.
            const expectancySizeMultiplier = opportunity.expectancyStats?.sizeMultiplier || 1;

            // Score-tier multiplier — scales position size with conviction level.
            // Target allocations (approximate, subject to Kelly/ATR/regime caps):
            //   85-89 → ~3% of portfolio (probe size — quality but not exceptional)
            //   90-94 → ~5% of portfolio (standard size — strong conviction)
            //   95+   → ~7-9% of portfolio (overweight — rare, highest quality)
            // Scores below 85 are blocked by the 85 min_buy_score gate — multiplier
            // for 80-84 kept for edge cases (live cache may boost a borderline score).
            const _oppScore = opportunity.aiScore || opportunity.confidence || 50;
            const scoreTierMultiplier = _oppScore >= 95 ? 1.8 :
                                        _oppScore >= 90 ? 1.3 :
                                        _oppScore >= 85 ? 0.9 :
                                        _oppScore >= 80 ? 0.7 : 0.5;

            // Signal-clarity multiplier: adjusts size based on bull/bear attribution ratio.
            // A score of 90 with a 4:1 bull/bear ratio is a much cleaner setup than a 90 with
            // a 1.1:1 ratio (barely net-positive). Same raw score, different bet quality.
            //   ratio ≥ 2.0 → clear signal, full multiplier
            //   ratio 1.5–2.0 → minor friction, unchanged (0% adj)
            //   ratio 1.2–1.5 → mixed, reduce 10%
            //   ratio < 1.2 → nearly balanced, reduce 20%
            let signalClarityMultiplier = 1.0;
            let _bullBearRatio = null;
            if (Array.isArray(opportunity.scoringLog) && opportunity.scoringLog.length > 0) {
                let grossBull = 0, grossBear = 0;
                for (const line of opportunity.scoringLog) {
                    const m = line.match(/([+-]\d+)/);
                    if (!m) continue;
                    const pts = parseInt(m[1]);
                    if (pts > 0) grossBull += pts;
                    else if (pts < 0) grossBear += Math.abs(pts);
                }
                if (grossBear > 0) {
                    _bullBearRatio = grossBull / grossBear;
                    signalClarityMultiplier = _bullBearRatio >= 2.0 ? 1.0 :
                                             _bullBearRatio >= 1.5 ? 1.0 :
                                             _bullBearRatio >= 1.2 ? 0.9 : 0.8;
                }
            }

            const combinedMultiplier = effectiveSizeMultiplier * streakBreaker.multiplier * expectancySizeMultiplier * scoreTierMultiplier * signalClarityMultiplier;
            let positionFraction = kellyFraction * combinedMultiplier;

            // VIX-level size reduction — EXTREME/PANIC already blocks entries upstream.
            // ELEVATED (VIX ~20–25): trade at 75% size — fear is rising, reduce exposure.
            // HIGH     (VIX ~25–30): trade at 50% size — meaningful fear, half position only.
            const _spikeState = vixMonitor.getSpikeState();
            const _vixSizeMult = (_spikeState.spikeActive && _spikeState.level === 'HIGH')     ? 0.50
                               : (_spikeState.spikeActive && _spikeState.level === 'ELEVATED') ? 0.75
                               : 1.0;
            if (_vixSizeMult < 1.0) {
                logger.info('[VIXSize] Reducing position size — VIX level ' + _spikeState.level, {
                    userId, symbol: opportunity.symbol,
                    vixAtSpike: _spikeState.vixAtSpike, multiplier: _vixSizeMult
                });
                positionFraction *= _vixSizeMult;
            }

            // Calculate the dollar amount for the position.
            let positionSize = accountTotalValue * positionFraction;

            // Cap at remaining sector room and max order notional.
            positionSize = Math.min(positionSize, sectorLimit - sectorCurrent);
            if (riskConfig.maxOrderNotional > 0) {
                positionSize = Math.min(positionSize, riskConfig.maxOrderNotional);
            }

            // ATR-based position sizing — unified formula.
            // riskDollars = account × baseRisk% × confidenceFactor × regimeFactor
            // shares      = riskDollars / stopDistance
            // stopDistance = ATR × sectorStopMult (AGGRESSIVE=2.0, STANDARD=1.5, DEFENSIVE=1.2)
            //
            // Result: high-ATR stocks get smaller positions; low-confidence or bad-regime
            // trades shrink through the same formula rather than as a separate multiplier.
            if (opportunity.atr && opportunity.atr > 0) {
                const baseRisk         = riskConfig.minPositionSize || 0.02;
                const confidenceFactor = Math.max(0.3, (opportunity.confidence || 50) / 100);
                const regimeFactor     = effectiveSizeMultiplier; // regime.positionSizeMultiplier (0.25–1.0)
                // Tighten stop by 20% in bear/risk-off regimes — exit faster before deeper drawdown
                const _bearStopFactor  = _isBearRegime ? 0.8 : 1.0;
                const sectorStopMult   = (SECTOR_TRADE_PROFILES[opportunity.tradeProfile]?.stopMult
                                      ?? riskConfig.atrStopMultiplier ?? 1.5) * _bearStopFactor;

                const riskDollars  = accountTotalValue * baseRisk * confidenceFactor * regimeFactor;
                const stopDistance = parseFloat(opportunity.atr) * sectorStopMult;
                const atrShares    = Math.floor(riskDollars / stopDistance);
                const atrSize      = atrShares * opportunity.price;

                if (atrSize > 0) {
                    positionSize = Math.min(positionSize, atrSize);
                }
            }

            // DRAWDOWN Level 1: halve position size while in reduce-sizing mode
            if (sessionRiskConfig._drawdownReduceSizing) {
                positionSize *= 0.5;
                logger.warn('[DrawdownBreaker] Position size halved (Level 1 reduce mode)', {
                    symbol: opportunity.symbol, reducedSize: positionSize.toFixed(2)
                });
            }

            // Pre-earnings setup: half position size — capturing the run-up, not the event
            if (_isEarningsSetup) {
                positionSize *= 0.5;
                logger.info('[EarningsSetup] Half position size — pre-earnings entry', {
                    userId, symbol: opportunity.symbol,
                    daysToEarnings: opportunity.daysToEarnings,
                    positionSize: positionSize.toFixed(2)
                });
            }

            logger.info('Position sizing', {
                userId, symbol: opportunity.symbol,
                method: 'Kelly+ATR unified',
                kellyFraction: kellyFraction.toFixed(4),
                confidence: ((opportunity.confidence || 50) / 100).toFixed(2),
                streakMultiplier: streakBreaker.multiplier,
                regimeMultiplier: effectiveSizeMultiplier,
                scoreTierMultiplier,
                expectancyMultiplier: expectancySizeMultiplier,
                signalClarityMultiplier,
                bullBearRatio: _bullBearRatio !== null ? parseFloat(_bullBearRatio.toFixed(2)) : 'n/a',
                tradeProfile: opportunity.tradeProfile || 'STANDARD',
                atr: opportunity.atr,
                finalFraction: (positionSize / accountTotalValue).toFixed(4),
                positionSize: positionSize.toFixed(2),
                drawdownReducing: !!sessionRiskConfig._drawdownReduceSizing,
            });

            // Confidence-based Kelly hard caps: prevent over-sizing low-confidence calls.
            // Calibrated for real-world confidence output of 43-55% (model is well-calibrated
            // but conservatively scored — even 45% confidence is meaningful for swing trades).
            const confPct = opportunity.confidence || 50;
            const maxByConf = confPct >= 85 ? 0.15  // high conviction  → up to 15%
                : confPct >= 70 ? 0.12              // good conviction  → up to 12%
                : confPct >= 55 ? 0.09              // moderate         → up to  9%
                : confPct >= 45 ? 0.07              // typical output   → up to  7%
                : confPct >= 35 ? 0.05              // below average    → up to  5%
                : 0.03;                             // low              → up to  3%
            const confCap = accountTotalValue * maxByConf;
            if (positionSize > confCap) {
                logger.info('Position size clipped by confidence cap', {
                    userId, symbol: opportunity.symbol,
                    confPct, maxByConf: (maxByConf * 100).toFixed(0) + '%',
                    before: positionSize.toFixed(2), after: confCap.toFixed(2)
                });
                positionSize = confCap;
            }

            // Risk-based position cap: ensure no single trade risks more than maxRiskPerTrade dollars.
            // Auto-scale with account: configured value OR 0.3% of equity, whichever is LARGER
            // (previous Math.min meant the $15 default always won even on $20K+ accounts).
            // Hard ceiling: 1% of equity so a single bad trade can't wipe more than 1%.
            const _riskPerTrade = Math.min(
                Math.max(
                    riskConfig.maxRiskPerTrade || 15,
                    accountTotalValue * 0.003    // 0.3% of equity — scales with account growth
                ),
                accountTotalValue * 0.01         // hard ceiling: never risk more than 1% per trade
            );
            // Use the actual stop distance for this specific opportunity rather than the global config.
            // Opportunity.stop comes from ATR-based calc; using config default (5%) would undersize
            // positions for AGGRESSIVE stocks where actual stop might be 6-7%.
            const _actualStopDist = (opportunity.stop && opportunity.price && opportunity.price > opportunity.stop)
                ? (opportunity.price - opportunity.stop) / opportunity.price
                : Math.abs(riskConfig.stopLoss || 0.05);
            const _stopDist = Math.max(0.02, _actualStopDist); // guard: never divide by <2%
            const _riskBasedCap = _riskPerTrade / _stopDist;
            if (positionSize > _riskBasedCap) {
                logger.info('[RiskCap] Position size capped by max-risk-per-trade', {
                    userId, symbol: opportunity.symbol,
                    before: positionSize.toFixed(2), after: _riskBasedCap.toFixed(2),
                    riskPerTrade: _riskPerTrade.toFixed(2), stopDist: (_stopDist * 100).toFixed(1) + '%',
                    accountEquity: accountTotalValue.toFixed(0)
                });
                positionSize = _riskBasedCap;
            }

            // Portfolio heat gate: cap aggregate $ risk-to-stop across all open + newly-sized
            // positions this cycle. Shrinks this trade to fit remaining budget rather than
            // skipping outright; if budget is already exhausted, stop opening new positions entirely.
            {
                const _maxHeatUsd = accountTotalValue * (_maxPortfolioRiskPct / 100);
                const _heatRemaining = _maxHeatUsd - runningHeatUsd;
                if (_heatRemaining <= 0) {
                    logger.info('[HeatGate] Portfolio risk budget exhausted — no more new entries this cycle', {
                        userId, maxHeatUsd: _maxHeatUsd.toFixed(2), runningHeatUsd: runningHeatUsd.toFixed(2)
                    });
                    _bumpGateStat(userId, 'heatGate');
                    _recordRejection(opportunity.symbol, 'heat_gate', `budget exhausted at $${_maxHeatUsd.toFixed(0)}`);
                    break;
                }
                // Dollar risk = position notional × stop distance fraction — shares × price cancels out.
                let _tradeRiskUsd = positionSize * _stopDist;
                if (_tradeRiskUsd > _heatRemaining) {
                    const _shrinkRatio = Math.max(0, _heatRemaining / _tradeRiskUsd);
                    logger.info('[HeatGate] Position size shrunk to fit portfolio risk budget', {
                        userId, symbol: opportunity.symbol,
                        shrinkRatio: _shrinkRatio.toFixed(2), heatRemaining: _heatRemaining.toFixed(2)
                    });
                    positionSize *= _shrinkRatio;
                    _tradeRiskUsd = positionSize * _stopDist;
                }
                runningHeatUsd += _tradeRiskUsd;
            }

            // Hard minimum notional: sector-cap or multi-factor shrinkage can reduce positionSize to
            // single digits (e.g. PNC → $9 when sector headroom was exhausted). A <$100 position
            // contributes nothing to portfolio returns and wastes a fractional share slot.
            if (positionSize < 100) {
                logger.info('[MinNotional] Position too small after all caps — skipping', {
                    userId, symbol: opportunity.symbol,
                    positionSize: positionSize.toFixed(2), price: opportunity.price
                });
                continue;
            }

            let shares = Math.floor(positionSize / opportunity.price);

            // Small-account floor: Kelly rounds to 0 for stocks > Kelly positionSize.
            // Bump to 1 share only when 1 share fits within the computed position size (no over-sizing).
            // Stocks too expensive for 1 whole share fall through to the fractional notional path.
            if (shares === 0 && opportunity.price > 0 && opportunity.price <= positionSize) {
                shares = 1;
                logger.info('[MinShareFloor] Kelly rounds to 0 — bumped to 1 share', {
                    userId, symbol: opportunity.symbol,
                    price: opportunity.price, positionSize: positionSize.toFixed(2)
                });
            }

            // Fractional buy: stock price exceeds Kelly positionSize so even 1 whole share is too expensive.
            // Use Alpaca's notional (dollar-amount) market order — buys the correct fractional quantity.
            if (shares === 0 && opportunity.price > positionSize && positionSize >= 1) {
                logger.info('[FractionalBuy] Price exceeds Kelly position size — using notional buy', {
                    userId, symbol: opportunity.symbol,
                    price: opportunity.price, notional: positionSize.toFixed(2)
                });
                try {
                    const fracResult = await brokerService.buyFractional(userId, opportunity.symbol, positionSize, {
                        executedBy:    'AI_BOT',
                        aiScore:       opportunity.aiScore,
                        sector:        opportunity.sector,
                        stopPrice:     opportunity.stop,
                        targetPrice:   opportunity.target,
                        signalPrice:   opportunity.price,
                        atr:           opportunity.atr || null,
                        regime:        regime?.regime || null,
                        oraclePattern: opportunity.oraclePattern || null,
                    });
                    _incrementOrderCount(userId, opportunity.symbol);
                    const fracShares = fracResult.filledQty || 0;
                    if (fracShares > 0) {
                        trades.push({
                            action: 'BUY', symbol: opportunity.symbol,
                            shares: fracShares, price: fracResult.filledAvgPrice,
                            total: fracResult.filledAvgPrice * fracShares,
                            aiScore: opportunity.aiScore, sector: opportunity.sector,
                            broker: fracResult.broker, fractional: true
                        });
                        remainingCapital -= fracResult.filledAvgPrice * fracShares;
                        const sec = opportunity.sector || 'Unknown';
                        sectorAllocations[sec] = (sectorAllocations[sec] || 0) + fracResult.filledAvgPrice * fracShares;
                        sectorCounts[sec]      = (sectorCounts[sec] || 0) + 1;
                    }
                } catch (err) {
                    logger.warn('[FractionalBuy] Failed', { userId, symbol: opportunity.symbol, err: err.message });
                }
                continue; // skip the whole-share buyBracket path below
            }

            // Pre-execution liquidity check: cap order at 0.5% of average daily dollar volume.
            // Prevents market-impact slippage on thinly traded names.
            // avgVolume comes from the screener/universe cache — always present for analyzed stocks.
            {
                const avgDailyDollarVol = (opportunity.avgVolume || 0) * (opportunity.price || 0);
                if (avgDailyDollarVol > 0) {
                    const maxLiquidityShares = Math.floor(avgDailyDollarVol * 0.005 / opportunity.price);
                    if (shares > maxLiquidityShares) {
                        if (maxLiquidityShares < 1) {
                            logger.info('[LiquidityCheck] Skipping — order exceeds 0.5% of avg daily volume', {
                                userId, symbol: opportunity.symbol,
                                orderNotional: (shares * opportunity.price).toFixed(0),
                                avgDailyDollarVol: avgDailyDollarVol.toFixed(0)
                            });
                            continue;
                        }
                        logger.info('[LiquidityCheck] Shares clipped to 0.5% daily-vol cap', {
                            userId, symbol: opportunity.symbol, before: shares, after: maxLiquidityShares,
                            avgDailyDollarVol: avgDailyDollarVol.toFixed(0)
                        });
                        shares = maxLiquidityShares;
                    }
                }
            }

            if (shares > 0 && (shares * opportunity.price) > riskConfig.maxOrderNotional) {
                logger.info('Skipping stock - order notional exceeds hard cap after sizing', {
                    userId,
                    symbol: opportunity.symbol,
                    calculatedNotional: (shares * opportunity.price).toFixed(2),
                    maxOrderNotional: riskConfig.maxOrderNotional.toFixed(2)
                });
                continue;
            }
            
            if (shares > 0) {
                // DRAWDOWN Level 2: paper-only mode blocks live new buys
                if (sessionRiskConfig._drawdownPaperOnly && brokerService.isLive) {
                    logger.warn('[DrawdownBreaker] Skipping live buy — paper-only mode (Level 2)', {
                        symbol: opportunity.symbol, drawdownPct: drawdownState.drawdownPct.toFixed(2)
                    });
                    continue;
                }

                try {
                    logger.trade('BUY', opportunity.symbol, shares, opportunity.price, {
                        aiScore: opportunity.aiScore,
                        rsi: opportunity.rsiInterpretation,
                        macd: opportunity.macdSignal,
                        atr: opportunity.atr
                    });

                    // PANTHEON ARROW: use atomic bracket order (entry + stop + target in one submission).
                    // Simulated broker falls back to a regular limit buy.
                    const result = await brokerService.buyBracket(
                        userId,
                        opportunity.symbol,
                        shares,
                        {
                            executedBy:     'AI_BOT',
                            aiScore:        opportunity.aiScore,
                            sector:         opportunity.sector,
                            stopPrice:      opportunity.stop,
                            targetPrice:    opportunity.target,
                            signalPrice:    opportunity.price,
                            atr:            opportunity.atr || null,  // stored in holdings for ATR-aware trailing stops
                            regime:         regime?.regime || null,
                            oraclePattern:  opportunity.oraclePattern || null,
                            earningsSetup:  _isEarningsSetup || undefined,
                            daysToEarnings: _isEarningsSetup ? opportunity.daysToEarnings : undefined,
                        }
                    );

                    // Count this order submission immediately — rate limiter tracks
                    // submissions, not fills.  Must run before any early-continue below.
                    _incrementOrderCount(userId, opportunity.symbol);

                    // Resolve actual filled quantity from broker response.
                    // If the order is still working (PENDING_FILL / partially_filled),
                    // record only what Alpaca confirmed.  The open-order guard and
                    // position guard will block re-entry on the next cycle.
                    const actualShares = result.filledQty || 0;

                    if (actualShares === 0) {
                        logger.info('[Bot] Order submitted but no fill confirmed yet — skipping trade record', {
                            userId, symbol: opportunity.symbol,
                            orderId: result.orderId, status: result.status
                        });
                        // Capital is still reserved — deduct requested amount so the bot
                        // doesn't treat the same capital as available in this same cycle.
                        remainingCapital -= (result.filledAvgPrice * shares);
                        continue;
                    }

                    trades.push({
                        action: 'BUY',
                        symbol: opportunity.symbol,
                        shares: actualShares,
                        price:  result.filledAvgPrice,
                        total:  result.filledAvgPrice * actualShares,
                        aiScore: opportunity.aiScore,
                        sector: opportunity.sector,
                        broker: result.broker
                    });

                    const filledPrice = result.filledAvgPrice;
                    const tradeTotal  = filledPrice * actualShares;
                    const commission  = result.commission || 0;

                    // Build detailed AI reasoning for Telegram alert
                    let aiReasoning = '';
                    if (Array.isArray(opportunity.scoringLog) && opportunity.scoringLog.length > 0) {
                        aiReasoning = opportunity.scoringLog.slice(0, 8).join('\n');
                    } else {
                        aiReasoning = `RSI: ${opportunity.rsiInterpretation}, MACD: ${opportunity.macdSignal}`;
                    }

                    const partialNote = actualShares < shares ? ` (partial: ${actualShares}/${shares})` : '';
                    alertService.alertTradeExecuted(
                        userId,
                        'BUY',
                        opportunity.symbol,
                        actualShares,
                        filledPrice,
                        opportunity.aiScore,
                        aiReasoning + partialNote
                    ).catch(() => {});

                    // Record performance
                    await performanceService.recordTradePerformance(userId, {
                        action: 'BUY',
                        symbol: opportunity.symbol,
                        quantity: actualShares,
                        price: filledPrice,
                        fees: commission
                    });

                    await tradeIntelligenceService.recordExecution(userId, {
                        botType: 'stock',
                        symbol: opportunity.symbol,
                        setupFamily: opportunity.setupFamily,
                        strategyFamily: opportunity.strategyFamily || 'equity_long',
                        regime: opportunity.regime || regime.regime,
                        score: opportunity.aiScore,
                        scoreAdjustment: opportunity.expectancyAdjustment,
                        sizeMultiplier: expectancySizeMultiplier,
                        expectancy: opportunity.expectancyStats?.expectancy,
                        confidence: opportunity.expectancyStats?.confidence,
                        entryPrice: filledPrice,
                        tradeRefType: 'equity_symbol',
                        tradeRefId: `${userId}:${opportunity.symbol}:${Date.now()}`,
                        metadata: (() => {
                            // Auto-tags: derived from entry conditions for richer post-mortem
                            const autoTags = [];
                            if ((opportunity.change || 0) > 5)                       autoTags.push('gap_play');
                            if ((opportunity.newsSentiment || 0) > 30)               autoTags.push('news_driven');
                            const hp = parseFloat(opportunity.week52HighProximity) || 0;
                            if (hp > 92)                                              autoTags.push('52w_breakout');
                            if (opportunity.weinSteinStage === 2)                     autoTags.push('stage2_uptrend');
                            if ((opportunity.rsi || 0) < 35)                          autoTags.push('oversold');
                            if (opportunity.setupFamily === 'breakout_leader')        autoTags.push('momentum');
                            if (opportunity.setupFamily === 'news_momentum')          autoTags.push('catalyst');
                            const rt = (opportunity.regime || '').toUpperCase();
                            if (rt.includes('BULL') || rt === 'RISK_ON')              autoTags.push('bull_regime_entry');
                            return {
                                shares: actualShares,
                                requestedShares: shares,
                                sector: opportunity.sector,
                                baseAiScore: opportunity.baseAiScore,
                                recommendation: opportunity.recommendation,
                                rsiInterpretation: opportunity.rsiInterpretation,
                                macdSignal: opportunity.macdSignal,
                                scoringLog: opportunity.scoringLog,
                                // Attribution metrics — stored explicitly so calibrator can slice
                                // by ratio bucket without recomputing from scoringLog each time.
                                daysToEarnings: opportunity.daysToEarnings ?? null,
                                atrPct: opportunity.atrPct ?? null,
                                bullBearRatio: _bullBearRatio !== null ? parseFloat(_bullBearRatio.toFixed(2)) : null,
                                signalClarityMultiplier,
                                signalPrice: opportunity.price,
                                slippage: Number((filledPrice - opportunity.price).toFixed(4)),
                                slippagePct: opportunity.price > 0
                                    ? Number(((filledPrice - opportunity.price) / opportunity.price * 100).toFixed(4))
                                    : 0,
                                autoTags: autoTags.length > 0 ? autoTags : undefined,
                                // Aggregate dollar-risk-to-stop across the whole portfolio (including
                                // this trade), as a % of equity — answers "was the book already
                                // stretched thin when this position was added" (2026-07-11, per review).
                                portfolioHeatPctAtEntry: accountTotalValue > 0
                                    ? Number((runningHeatUsd / accountTotalValue * 100).toFixed(2))
                                    : null
                            };
                        })()
                    });

                    remainingCapital -= (tradeTotal + commission);
                    sectorAllocations[sector] = (sectorAllocations[sector] || 0) + tradeTotal;
                    
                } catch (error) {
                    logger.error('Error executing buy order', { 
                        userId,
                        symbol: opportunity.symbol, 
                        error: error.message 
                    });
                }
            }
        }
        
        const capitalDeployed = availableToInvest - remainingCapital;
        
        const _cyclGateStats = getGateStats(userId);
        logger.info('Trading session complete', {
            userId,
            tradesExecuted: trades.length,
            capitalDeployed: capitalDeployed.toFixed(2),
            opportunitiesFound: opportunities.length,
            gateStats: _cyclGateStats
                ? { volumeGate: _cyclGateStats.volumeGate, regimeCap: _cyclGateStats.regimeCap }
                : undefined
        });

        // LOCAL BRAIN: refresh win-rate cache after session so next run uses latest data
        localBrain.refresh().catch(e =>
            logger.warn('[LocalBrain] Post-session refresh failed', { err: e.message })
        );

        // SAGE: regenerate learned adjustments in background after each session (fire-and-forget)
        agentHealth.recordHeartbeat('SAGE', 'START');
        sageService.generateLearnings()
            .then(() => agentHealth.recordHeartbeat('SAGE', 'OK'))
            .catch(e => {
                agentHealth.recordHeartbeat('SAGE', 'ERROR', { error: e.message });
                logger.warn('[SAGE] Background learning update failed', { err: e.message });
            });

        agentHealth.recordHeartbeat('ARROW', 'OK', { userId, tradesExecuted: trades.length });
        return {
            success: true,
            tradesExecuted: trades.length,
            trades,
            capitalDeployed,
            opportunitiesFound: opportunities.length
        };

    } catch (error) {
        agentHealth.recordHeartbeat('ARROW', 'ERROR', { userId, error: error.message });
        logger.error('Error in autonomous trading', { userId, error: error.message });
        return { success: false, error: error.message };
    }
}

/**
 * Multi-stage trailing stop with breakeven floor.
 *
 * Stages (ChatGPT recommendation 2026-07-02):
 *   +2%  → activate breakeven floor (stop can never fall below entry price)
 *   +4%  → 6% trailing distance
 *   +8%  → 7% trailing distance
 *   +12% → 8% trailing distance
 *   +15% → 10% trailing distance
 *   +25% → 12% trailing distance (lock-in core profit)
 *
 * ATR floor: never narrower than 3×ATR to survive normal daily moves.
 *
 * @param {number} changePercent  — current gain as decimal (e.g. 0.12 = 12%)
 * @param {number|null} atr       — average true range in dollars
 * @param {number|null} peakPrice — current peak price (used to convert ATR to %)
 * @returns {{ trailPct: number, useBreakevenFloor: boolean }}
 */
function getDynamicTrailingStop(changePercent, atr, peakPrice) {
    // Once up 2%, stop floor = entry price — position can never become a loser.
    const useBreakevenFloor = changePercent >= 0.02;

    // Swing-trading: stops get TIGHTER as gains grow — the more profit, the less we give back.
    // Based on ChatGPT recommendation 2026-07-02: invert the tightening direction for swing mode.
    let trailPct;
    if      (changePercent >= 0.20) trailPct = 0.020; // ≥ 20% → 2.0% trail (nearly locked in)
    else if (changePercent >= 0.15) trailPct = 0.025; // ≥ 15% → 2.5% trail
    else if (changePercent >= 0.10) trailPct = 0.030; // ≥ 10% → 3.0% trail
    else if (changePercent >= 0.05) trailPct = 0.040; // ≥  5% → 4.0% trail
    else if (changePercent >= 0.02) trailPct = 0.050; // ≥  2% → 5.0% trail (breakeven stage)
    else                            trailPct = 0.055; // < 2% → 5.5% trail (fresh position)

    // ATR safety floor: never tighter than 1.5×ATR (volatility-adjusted).
    // Prevents stopping out on normal daily moves for high-ATR stocks.
    if (atr && atr > 0 && peakPrice && peakPrice > 0) {
        const atrFloor = (atr * 1.5) / peakPrice;
        trailPct = Math.max(trailPct, atrFloor);
    }
    return { trailPct, useBreakevenFloor };
}

/**
 * Manage existing positions (stop-loss, take-profit, trailing stops)
 */
async function manageExistingPositions(userId) {
    try {
        const holdings = await holdingsDb.getUserHoldings(userId);
        
        if (!holdings || holdings.length === 0) {
            return;
        }
        
        const riskConfig = await getUserRiskConfig(userId);

        // Regime-adaptive exit thresholds — tighten in Bear/Risk-Off, loosen in Bull/Risk-On.
        // Fetched once for the whole position-management pass (not per-holding to avoid rate limits).
        let exitThresholds;
        try {
            const regimeData   = await marketRegimeService.getMarketRegime();
            const rt           = (regimeData?.regimeType || regimeData?.regime || 'NEUTRAL').toUpperCase();
            const isBearish    = rt.includes('BEAR') || rt === 'RISK_OFF' || rt === 'PANIC';
            const isBullish    = rt.includes('BULL') || rt === 'RISK_ON' || rt === 'TRENDING_UP';
            // Swing trade exit thresholds — regime scales around the DB config values.
            // Bull: +25% headroom vs neutral to let winners run slightly more.
            // Bear: tighten to 80% of neutral to lock in gains before reversal.
            const _ep = riskConfig.earlyPartialProfitPercent || 0.08;
            const _mp = riskConfig.partialTakeProfitPercent  || 0.12;
            const _fe = riskConfig.takeProfitPercent          || 0.20;
            exitThresholds = {
                earlyPartial: isBearish ? Math.max(0.05, _ep * 0.80) : isBullish ? _ep * 1.25 : _ep,
                mainPartial:  isBearish ? Math.max(0.08, _mp * 0.80) : isBullish ? _mp * 1.25 : _mp,
                fullExit:     isBearish ? Math.max(0.15, _fe * 0.80) : isBullish ? _fe * 1.25 : _fe,
                regime: rt,
            };
            if (isBearish || isBullish) {
                logger.info('[RegimeExit] Adaptive exit thresholds applied', {
                    userId, regime: rt,
                    earlyPartial: `${(exitThresholds.earlyPartial * 100).toFixed(0)}%`,
                    mainPartial:  `${(exitThresholds.mainPartial  * 100).toFixed(0)}%`,
                    fullExit:     `${(exitThresholds.fullExit     * 100).toFixed(0)}%`,
                });
            }
        } catch (_regimeErr) {
            exitThresholds = {
                earlyPartial: riskConfig.earlyPartialProfitPercent || 0.15,
                mainPartial:  riskConfig.partialTakeProfitPercent  || 0.22,
                fullExit:     riskConfig.takeProfitPercent          || 0.35,
                regime: 'NEUTRAL',
            };
        }

        // Distress mode: when ≥2 holdings are already down >3%, tighten the hard stop from -7% → -5%
        // to cut losers early and prevent a bad day from cascading into a catastrophic one.
        const _distressCount = holdings.filter(h => {
            if (!h.current_price || !h.average_price || h.average_price === 0) return false;
            return (h.current_price - h.average_price) / h.average_price <= -0.03;
        }).length;
        const isNowInDistress  = _distressCount >= 2;
        const wasInDistress    = _distressActiveCache.get(userId) || false;
        _distressActiveCache.set(userId, isNowInDistress);

        const effectiveStopLoss = isNowInDistress
            ? Math.max(riskConfig.stopLoss, -0.05)
            : riskConfig.stopLoss;

        if (isNowInDistress && !wasInDistress) {
            logger.warn('[DistressMode] Portfolio under stress — tightening hard stop', {
                userId, distressCount: _distressCount,
                effectiveStopLoss: (effectiveStopLoss * 100).toFixed(1) + '%',
                configuredStopLoss: (riskConfig.stopLoss * 100).toFixed(1) + '%'
            });
            _bumpGateStat(userId, 'distressMode');
        } else if (!isNowInDistress && wasInDistress) {
            logger.info('[DistressMode] Recovery — portfolio stress eased, normal stop-loss restored', { userId });
            alertService.alertDistressModeRecovery(userId).catch(() => {});
        }

        // ── Per-cycle stop verification & stale-stop repair ──────────────────────
        // Fetch ALL broker open orders once (one API call) then check each position.
        // Self-healing: if stop is missing → place it. If stop price is stale (>0.2%
        // off expected) → cancel + replace. Catches API failures, manual cancellations,
        // partial fills, rejected orders, broker outages.
        try {
            const brokerOrders = await brokerService.getOpenOrders(userId).catch(() => []);
            // Build map: symbol → active stop order(s) on the sell side
            const stopOrderMap = new Map(); // symbol → { orderId, stopPrice }
            for (const o of brokerOrders) {
                if (o.side === 'sell' && (o.type === 'stop' || o.type === 'stop_limit' || o.type === 'trailing_stop')) {
                    stopOrderMap.set(o.symbol, { orderId: o.id, stopPrice: parseFloat(o.stop_price || o.limit_price || 0) });
                }
            }

            const stopLossPct = Math.abs(effectiveStopLoss);
            for (const h of holdings) {
                if (!h.average_price || parseFloat(h.quantity) <= 0) continue;
                const sym      = h.symbol;
                const entry    = parseFloat(h.average_price);
                const peak     = parseFloat(h.peak_price || entry);
                const hChange  = entry > 0 ? (peak - entry) / entry : 0;
                const { trailPct, useBreakevenFloor } = getDynamicTrailingStop(hChange, h.atr, peak);
                let expectedStop = peak * (1 - trailPct);
                if (useBreakevenFloor) expectedStop = Math.max(expectedStop, entry);
                // Hard stop floor: never place broker stop below the configured hard stop (e.g. -5% from entry).
                // getDynamicTrailingStop already handles ATR-based width from PEAK; no separate entry-based
                // ATR floor is needed here — that earlier Math.min(expectedStop, entry - 1.5×ATR) was
                // destroying trailing stops on winners (e.g. stop at +25% above entry got reset to -4.5%).
                expectedStop = parseFloat(Math.max(expectedStop, entry * (1 - stopLossPct)).toFixed(2));

                const existing = stopOrderMap.get(sym);
                const qty = String(parseFloat(h.quantity));

                if (!existing) {
                    // MISSING stop — but first confirm the position is actually still live at the
                    // broker. `holdings` is a snapshot taken at the top of this function; if the
                    // position's own stop fired moments ago (between that snapshot and this check),
                    // "missing stop" is a false positive — the position is already flat. Placing a
                    // fresh stop here would oversell into a naked short (2026-07-06 EAT incident:
                    // a stop filled at 14:43, this block placed a duplicate stop at 14:47 before the
                    // holdings snapshot caught up, and the duplicate filled again 3h later against
                    // zero shares).
                    try {
                        const livePosition = await brokerService.getPosition(userId, sym);
                        const liveQty = livePosition ? parseFloat(livePosition.qty) : 0;
                        // holdings.quantity is NUMERIC(18,8) — Alpaca's true qty can carry more
                        // precision (e.g. 0.481337867), so the DB snapshot is a ROUNDED value that
                        // can end up microscopically LARGER than the live qty whenever the 9th+
                        // decimal digit rounds up. A strict liveQty < qty comparison then reads as
                        // "position closed" every single cycle for that symbol, permanently — not
                        // a real close, just rounding dust (confirmed live 2026-07-21: NET and MELI
                        // stuck "no longer matches snapshot" every cycle for hours, off by ~3e-9
                        // shares, while the position was fully open the whole time). A real partial
                        // close changes qty by a meaningful fraction, not billionths — 1e-6 headroom
                        // comfortably separates the two.
                        const QTY_EPSILON = 1e-6;
                        if (liveQty < parseFloat(qty) - QTY_EPSILON) {
                            logger.warn('[StopRepair] Skipping — position no longer matches snapshot (likely just closed)', {
                                userId, sym, snapshotQty: qty, liveQty
                            });
                            // Immediately reconcile rather than leaving this phantom holding to be
                            // caught by a coincidental later startup/scheduled reconciliation pass —
                            // or never. Without this, order_audit_log never gets a proper CLOSED
                            // entry for the exit (SENTINEL's stopLossFailures blocker then flags it
                            // days later with no real record of how/when it closed — confirmed live
                            // 2026-07-27 on LNG, which sat un-reconciled for days versus CVX, whose
                            // otherwise-identical phantom got caught only because a worker restart
                            // happened to trigger startup reconciliation shortly after it closed).
                            try {
                                const positionReconciliationService = require('./positionReconciliationService');
                                await positionReconciliationService.reconcilePositions(userId, { trigger: 'STOP_REPAIR_DETECTED' });
                            } catch (reconcileErr) {
                                logger.error('[StopRepair] Immediate reconciliation failed', { userId, sym, err: reconcileErr.message });
                            }
                        } else {
                            // Use the broker's own qty for the order, not the DB snapshot — placing
                            // a sell for a rounded-up qty that's fractionally more than truly
                            // available would itself fail.
                            const placeQty = livePosition ? String(livePosition.qty) : qty;
                            await brokerService.placeStopOrder(userId, sym, placeQty, expectedStop);
                            logger.warn('[StopRepair] Missing stop — placed new GTC stop', { userId, sym, expectedStop, qty: placeQty });
                            alertService.sendMessage(userId,
                                `🛡️ *Stop Repaired* — ${sym}\nStop was missing; placed GTC stop @ $${expectedStop.toFixed(2)}`
                            ).catch(() => {});
                        }
                    } catch (placeErr) {
                        logger.error('[StopRepair] Failed to place stop', { userId, sym, err: placeErr.message });
                    }
                } else if (existing.stopPrice > 0) {
                    // MONOTONICITY INVARIANT: for long positions, the broker stop must never move downward.
                    // A trailing stop that calculates a lower stop (e.g. from a code bug or data glitch)
                    // must be silently ignored — only moves upward (locking in more profit) are allowed.
                    if (expectedStop < existing.stopPrice) {
                        logger.warn('[StopMonotonicity] Rejected downward stop move — preserving existing stop', {
                            userId, sym, existing: existing.stopPrice, rejected: expectedStop
                        });
                    } else {
                        // STALE stop — check if price diverged >0.2% from expected
                        const drift = Math.abs(existing.stopPrice - expectedStop) / expectedStop;
                        if (drift > 0.002) {
                            // Cancel-then-place is not atomic: if placeStopOrder fails after the
                            // cancel already succeeded, the position is left with NO stop at all
                            // until the next cycle. Observed live 2026-07-21 — TMUS/NET/MELI
                            // repeatedly lost their stop here for hours during market hours (403/422
                            // on the re-place — Alpaca hasn't released the shares from the
                            // just-canceled order yet). A flat 2s wait wasn't reliably long enough
                            // (worked most cycles, still failed some) — poll qty_available instead
                            // of guessing a fixed delay, matching the verify-and-retry pattern
                            // trailingStopService.js already uses for its own order cancellation.
                            const neededQty = parseFloat(qty);
                            let released = false;
                            // Prefer the broker's own qty over the DB-snapshot `qty` when we have
                            // it — same rounding-mismatch reasoning as the "missing stop" branch
                            // above (NUMERIC(18,8) snapshot can round up past the true live qty).
                            let placeQty = qty;
                            try {
                                await brokerService.cancelOrder(userId, existing.orderId);
                                for (let attempt = 0; attempt < 4 && !released; attempt++) {
                                    await new Promise(r => setTimeout(r, 1500));
                                    const live = await brokerService.getPosition(userId, sym).catch(() => null);
                                    if (live && parseFloat(live.qty_available ?? live.qty) >= neededQty - 1e-6) {
                                        released = true;
                                        placeQty = String(live.qty);
                                    }
                                }
                                await brokerService.placeStopOrder(userId, sym, placeQty, expectedStop);
                                logger.info('[StopRepair] Stale stop raised', {
                                    userId, sym, was: existing.stopPrice, now: expectedStop, drift: (drift * 100).toFixed(2) + '%', sharesReleased: released
                                });
                            } catch (updateErr) {
                                logger.warn('[StopRepair] Stop update failed — restoring previous stop price', { userId, sym, err: updateErr.message, sharesReleased: released });
                                try {
                                    if (!released) {
                                        for (let attempt = 0; attempt < 4 && !released; attempt++) {
                                            await new Promise(r => setTimeout(r, 1500));
                                            const live = await brokerService.getPosition(userId, sym).catch(() => null);
                                            if (live && parseFloat(live.qty_available ?? live.qty) >= neededQty - 1e-6) {
                                                released = true;
                                                placeQty = String(live.qty);
                                            }
                                        }
                                    }
                                    await brokerService.placeStopOrder(userId, sym, placeQty, existing.stopPrice);
                                    logger.info('[StopRepair] Previous stop restored after raise failure', { userId, sym, restoredPrice: existing.stopPrice });
                                } catch (restoreErr) {
                                    logger.error('[StopRepair] CRITICAL — position left with no stop after failed raise+restore', {
                                        userId, sym, err: restoreErr.message
                                    });
                                    alertService.sendMessage(userId,
                                        `⚠️ *Stop Protection Failed* — ${sym}\nCould not update or restore protective stop. Please check this position manually.`
                                    ).catch(() => {});
                                }
                            }
                        }
                    }
                }
            }
        } catch (_stopRepairErr) {
            logger.warn('[StopRepair] Error during stop verification — cycle will retry', { err: _stopRepairErr.message });
        }

        for (const holding of holdings) {
            // Race-condition guard: skip if a sell for this holding is already in-flight
            const sellKey = `${userId}:${holding.symbol}`;
            if (_sellInProgress.has(sellKey)) {
                logger.warn('[SellLock] Skipping — sell already in progress', { userId, symbol: holding.symbol });
                continue;
            }
            // Cross-cycle exit guard: skip if this position was already exited in a
            // recent cycle but the DB record hasn't been removed yet (broker settling).
            const exitExpiry = _exitPending.get(sellKey) || 0;
            if (Date.now() < exitExpiry) {
                logger.info('[ExitGuard] Skipping — exit already sent this cycle', { userId, symbol: holding.symbol });
                continue;
            }

            try {
                const currentPrice = await tradingServiceDB.getCurrentPrice(holding.symbol);
                if (!currentPrice) continue;

                // Keep stored price + derived fields fresh every cycle so UI always shows live value
                try {
                    const costBasis   = parseFloat(holding.average_price) * parseInt(holding.quantity);
                    const marketValue = currentPrice * parseInt(holding.quantity);
                    const gainLoss    = marketValue - costBasis;
                    const gainLossPct = costBasis > 0 ? (gainLoss / costBasis) * 100 : 0;
                    await query(
                        `UPDATE holdings
                         SET current_price = $1, market_value = $2,
                             gain_loss = $3, gain_loss_percent = $4, updated_at = NOW()
                         WHERE user_id = $5 AND symbol = $6`,
                        [currentPrice, marketValue, gainLoss, gainLossPct, userId, holding.symbol]
                    );
                } catch (_priceUpd) {}

                const purchasePrice = holding.average_price;
                const changePercent = (currentPrice - purchasePrice) / purchasePrice;

                // Update peak price for trailing stop
                if (!holding.peak_price || currentPrice > holding.peak_price) {
                    await holdingsDb.updatePeakPrice(userId, holding.symbol, currentPrice);
                    holding.peak_price = currentPrice;
                }

                // ── Quality Score Decay: periodic re-score of open positions ──────────
                // Entry uses the full AI score (technicals + news + smart money + AI overlays);
                // without this, every post-entry decision is purely price-driven. Re-score at
                // most once per ~20h and tighten/exit based on whether the thesis still holds.
                // Tiers: ≥85 normal | 75-84 tighten trail | 65-74 tighten hard | <65 twice → exit.
                let decayScore = holding.last_rescore_score != null ? parseFloat(holding.last_rescore_score) : null;
                let lowScoreStreak = holding.low_score_streak || 0;
                const _rescoreAgeHrs = holding.last_rescore_at
                    ? (Date.now() - new Date(holding.last_rescore_at).getTime()) / 3600000
                    : Infinity;
                if (_rescoreAgeHrs >= 20) {
                    try {
                        const _reAnalysis = await analyzeStockWithAI(holding.symbol, null, null, null);
                        if (_reAnalysis && typeof _reAnalysis.aiScore === 'number') {
                            decayScore = _reAnalysis.aiScore;
                            lowScoreStreak = decayScore < 65 ? lowScoreStreak + 1 : 0;
                            await holdingsDb.updateRescoreState(userId, holding.symbol, decayScore, lowScoreStreak);
                            // Durable history alongside the latest-value/streak fields above — holdings
                            // gets deleted on exit, this table doesn't, so decay trend vs. actual outcome
                            // can be studied later (2026-07-07). Fire-and-forget, never blocks the cycle.
                            query(
                                `INSERT INTO holding_rescore_history (user_id, symbol, score) VALUES ($1, $2, $3)`,
                                [userId, holding.symbol, decayScore]
                            ).catch(err => logger.debug('[ScoreDecay] Failed to log rescore history', { userId, symbol: holding.symbol, error: err.message }));
                            logger.info('[ScoreDecay] Re-scored open position', {
                                userId, symbol: holding.symbol, score: decayScore, streak: lowScoreStreak
                            });
                        }
                    } catch (_rescoreErr) {
                        logger.debug('[ScoreDecay] Re-score failed — keeping prior score', {
                            userId, symbol: holding.symbol, error: _rescoreErr.message
                        });
                    }
                }
                const decayTrailMult = decayScore == null ? 1.0
                    : decayScore >= 85 ? 1.0
                    : decayScore >= 75 ? 0.7
                    : decayScore >= 65 ? 0.5
                    : 0.4;

                // Regime downgrade response: for a bounded window right after a downgrade is
                // detected, tighten trails an extra 25% on top of everything else — a defensive
                // margin while the market digests the shift, separate from the standard
                // regime-scaled exit thresholds that already recompute every cycle.
                const _downgradeUntil = _regimeDowngradeUntil.get(userId) || 0;
                const regimeDowngradeMult = Date.now() < _downgradeUntil ? 0.75 : 1.0;

                // Multi-stage trailing stop with breakeven floor (ATR-aware).
                // Once position is up ≥2%, the stop floor locks at entry price — no loser from a winner.
                const { trailPct: dynamicTrailPctBase, useBreakevenFloor } =
                    getDynamicTrailingStop(changePercent, holding.atr, holding.peak_price);
                const dynamicTrailPct = dynamicTrailPctBase * decayTrailMult * regimeDowngradeMult;
                let trailingStopPrice = holding.peak_price * (1 - dynamicTrailPct);
                if (useBreakevenFloor && purchasePrice > 0) {
                    trailingStopPrice = Math.max(trailingStopPrice, purchasePrice);
                }

                let shouldSell = false;
                let isHardStop = false; // used to insert stop-loss cooldown
                let reason = '';
                let sellQuantity = holding.quantity;
                // Deferred alert — captures context at signal-detection time, fires only after sell executes.
                // Prevents duplicate Telegram messages when a sell attempt fails and the cycle retries.
                let pendingAlert = null;

                // Swing trade minimum hold: 3 full trading days before any trailing/profit exit fires.
                // Hard stop-loss always fires immediately — risk management can never wait.
                const purchaseMs = holding.purchase_date ? new Date(holding.purchase_date).getTime() : 0;
                const holdAgeHrs = purchaseMs ? (Date.now() - purchaseMs) / 3600000 : 999;
                // Profitable positions (up >2%) unlock trailing/profit exits after 24h — prevents a +5% day-1 gain
                // from reversing all the way back to the -5% hard stop because the 72h swing guard blocked exits.
                // Flat/losing positions still enforce 72h to avoid panic exits on normal intraday volatility.
                const profitableHold = changePercent > 0.02;
                const tooNew = holdAgeHrs < (profitableHold ? 24 : 72);

                // Alert on large unrealized loss
                if (changePercent <= -0.10 && !holding.large_loss_alerted) {
                    alertService.alertLargeLoss(userId, holding.symbol, changePercent * 100, currentPrice, purchasePrice).catch(() => {});
                }

                // Earnings proximity exit: if earnings are ≤2 days away, exit the position now.
                // Earnings gaps are unpredictable; even a bullish setup can gap -20% overnight.
                // This check overrides the swing-trade minimum hold (tooNew) — risk management wins.
                if (!shouldSell) {
                    try {
                        const _earningsDte = await getDaysToEarnings(holding.symbol);
                        if (_earningsDte !== null && _earningsDte <= 2) {
                            shouldSell = true;
                            reason = `Earnings protection exit — earnings in ${_earningsDte} day(s), closing to avoid gap risk`;
                            logger.warn('[EarningsExit] Closing position before earnings', {
                                userId, symbol: holding.symbol,
                                daysToEarnings: _earningsDte,
                                gainPct: (changePercent * 100).toFixed(2)
                            });
                            alertService.sendMessage(userId,
                                `⚠️ *Earnings Exit* — ${holding.symbol}\n` +
                                `Earnings in ${_earningsDte} day(s) — closing to avoid gap risk\n` +
                                `_Current P&L: ${changePercent >= 0 ? '+' : ''}${(changePercent * 100).toFixed(2)}%_`
                            ).catch(() => {});
                        }
                    } catch (_earningsErr) { /* non-blocking — if lookup fails, hold the position */ }
                }

                // Hard stop-loss (normally -7%, tightened to -5% in distress mode when ≥2 positions red)
                if (changePercent <= effectiveStopLoss) {
                    shouldSell = true;
                    isHardStop = true;
                    const stopLabel = effectiveStopLoss !== riskConfig.stopLoss ? ' [distress mode]' : '';
                    reason = `Stop-loss triggered at ${(changePercent * 100).toFixed(2)}%${stopLabel}`;
                    const loss = (currentPrice - purchasePrice) * sellQuantity;
                    // Deferred — fires only after the sell order succeeds
                    pendingAlert = () => alertService.alertStopLossTriggered(userId, holding.symbol, sellQuantity, currentPrice, loss);
                }
                // Quality score decay exit — conviction broke down for 2 consecutive re-scores.
                // Fires regardless of tooNew: if the AI wouldn't buy this today (twice running),
                // don't wait for price to catch up before getting out.
                else if (lowScoreStreak >= 2) {
                    shouldSell = true;
                    reason = `Quality score decay: re-score fell below 65 for ${lowScoreStreak} consecutive checks (latest: ${decayScore})`;
                    logger.warn('[ScoreDecay] Exiting on sustained low re-score', {
                        userId, symbol: holding.symbol, score: decayScore, streak: lowScoreStreak
                    });
                }
                // Trailing stop — skipped on entry day (swing guard)
                else if (!tooNew && currentPrice <= trailingStopPrice) {
                    shouldSell = true;
                    const dropFromPeak = ((currentPrice - holding.peak_price) / holding.peak_price * 100).toFixed(2);
                    reason = `Trailing stop (${(dynamicTrailPct * 100).toFixed(0)}%) triggered: dropped ${dropFromPeak}% from peak`;
                    logger.riskEvent('TRAILING_STOP', holding.symbol, { currentPrice, peakPrice: holding.peak_price, dropFromPeak, dynamicTrailPct });
                }
                // Break-even protection: position peaked ≥ earlyPartial threshold above entry but reversed back to entry.
                // Fires REGARDLESS of tooNew — a trade that was up 5%+ must never be allowed to hit the hard stop at -5%.
                else if (holding.peak_price && ((holding.peak_price - purchasePrice) / purchasePrice) >= exitThresholds.earlyPartial && currentPrice <= purchasePrice * 1.005) {
                    shouldSell = true;
                    const peakGainPct = ((holding.peak_price - purchasePrice) / purchasePrice * 100).toFixed(1);
                    reason = `Break-even protection: peaked at +${peakGainPct}% but returned to entry — preventing full reversal`;
                }
                // Full take-profit — skipped on entry day (swing guard)
                else if (!tooNew && changePercent >= exitThresholds.fullExit) {
                    shouldSell = true;
                    reason = `Take-profit target reached at ${(changePercent * 100).toFixed(2)}% [regime: ${exitThresholds.regime}]`;
                    const profit = (currentPrice - purchasePrice) * sellQuantity;
                    alertService.alertTakeProfitExecuted(userId, holding.symbol, sellQuantity, currentPrice, profit, changePercent * 100).catch(() => {});
                }
                // Partial take-profit (sell 50%) — skipped on entry day
                else if (!tooNew && changePercent >= exitThresholds.mainPartial && !holding.partial_profit_taken) {
                    shouldSell = true;
                    sellQuantity = Math.floor(holding.quantity / 2);
                    reason = `Partial take-profit at ${(changePercent * 100).toFixed(2)}% (selling 50%) [regime: ${exitThresholds.regime}]`;
                    await holdingsDb.markPartialProfitTaken(userId, holding.symbol, true);
                }
                // Early partial (sell 25% to lock in floor) — skipped on entry day
                else if (!tooNew && changePercent >= exitThresholds.earlyPartial && !holding.partial_profit_taken) {
                    const earlyQty = Math.max(1, Math.floor(holding.quantity * 0.25));
                    if (earlyQty > 0 && earlyQty < holding.quantity) {
                        shouldSell = true;
                        sellQuantity = earlyQty;
                        reason = `Early partial take-profit at ${(changePercent * 100).toFixed(2)}% (selling 25% — locking floor)`;
                    }
                }

                // ── Swing Trade Max Hold (7 trading days = 168h) ──────────────────────
                // Tightened from 20d → 7d based on trade data: 5-day holds averaged +8-10%
                // while 18-20 day holds averaged only +1-6%. Time-limiting frees capital
                // for fresh high-conviction setups and improves Sharpe by cutting dead money.
                //
                // Partial exit rule: if the winner is >5% and not yet partially exited, sell
                // only 50% to lock gains — the remaining half trails with getDynamicTrailingStop.
                // Weak winners (gain 0–5%) or already-partial positions exit fully at 7 days.
                else if (holdAgeHrs >= 168 && changePercent > 0) {
                    shouldSell = true;
                    const holdDays = Math.round(holdAgeHrs / 24);
                    const halfQty  = Math.floor(holding.quantity / 2);
                    if (changePercent > 0.05 && !holding.partial_profit_taken && halfQty >= 1) {
                        sellQuantity = halfQty;
                        reason = `Swing max-hold partial: ${holdDays}d — locking 50% at +${(changePercent * 100).toFixed(2)}%, trailing remainder`;
                        await holdingsDb.markPartialProfitTaken(userId, holding.symbol, true);
                        logger.info('[SwingExit] Max-hold partial — strong winner, trailing remaining half', {
                            userId, symbol: holding.symbol, holdDays,
                            gainPct: (changePercent * 100).toFixed(2), halfQty
                        });
                        pendingAlert = () => alertService.sendMessage(userId,
                            `⏰ *Swing Max-Hold Partial*\n${holding.symbol}: ${holdDays}d | +${(changePercent * 100).toFixed(2)}% | Selling 50%, trailing the rest`
                        );
                    } else {
                        reason = `Swing max-hold: ${holdDays}d held (limit 7d) — closing to redeploy capital [gain: +${(changePercent * 100).toFixed(2)}%]`;
                        logger.info('[SwingExit] Max-hold full exit', { userId, symbol: holding.symbol, holdDays, gainPct: (changePercent * 100).toFixed(2) });
                        pendingAlert = () => alertService.sendMessage(userId,
                            `⏰ *Swing Max-Hold Exit*\n${holding.symbol}: held ${holdDays} days | +${(changePercent * 100).toFixed(2)}% | Releasing capital for new signals`
                        );
                    }
                }

                // ── Slow Mover Eject (5+ days, gain < 2%) ──────────────────────────────
                // Tightened from 10d/<3% → 5d/<2%: USB held 18 days for +1% — dead money.
                // Exit earlier and redeploy into this week's high-conviction candidates.
                else if (!tooNew && holdAgeHrs >= 120 && changePercent >= 0 && changePercent < 0.02) {
                    shouldSell = true;
                    const holdDays = Math.round(holdAgeHrs / 24);
                    reason = `Slow mover: ${holdDays}d held with only +${(changePercent * 100).toFixed(2)}% — deploying capital to stronger signals`;
                    logger.info('[SwingExit] Slow mover ejected', { userId, symbol: holding.symbol, holdDays, gainPct: (changePercent * 100).toFixed(2) });
                    pendingAlert = () => alertService.sendMessage(userId, `🐌 *Slow Mover Exit*\n${holding.symbol}: ${holdDays}d stall at +${(changePercent * 100).toFixed(2)}% — capital redeployed`);
                }

                // ── Pre-Earnings Exit ──────────────────────────────────────────────────
                // If a holding was entered as a pre-earnings setup (5-15 days before earnings)
                // and earnings are now ≤ 1 day away, sell to lock in the run-up before the event.
                // Only fires when in profit (≥ 2%) — avoids crystallising losses on bad setups.
                if (!shouldSell) {
                    try {
                        const daysLeft = await getDaysToEarnings(holding.symbol);
                        if (daysLeft !== null && daysLeft >= 0 && daysLeft <= 1 && changePercent >= 0.02) {
                            shouldSell = true;
                            reason = `Pre-earnings exit: ${daysLeft}d to earnings — locking in +${(changePercent * 100).toFixed(2)}% run-up`;
                            logger.info('[EarningsSetup] Pre-earnings exit triggered', {
                                userId, symbol: holding.symbol,
                                daysToEarnings: daysLeft, gainPct: (changePercent * 100).toFixed(2)
                            });
                            pendingAlert = () => alertService.sendMessage(userId,
                                `📅 *Pre-Earnings Exit*\n${holding.symbol}: earnings in ${daysLeft}d — sold at +${(changePercent * 100).toFixed(2)}% to avoid event risk`
                            );
                        }
                    } catch (_earningsCheckErr) { /* non-critical — skip */ }
                }

                if (shouldSell && sellQuantity > 0) {
                    // ── Alpaca long-position guard ──────────────────────────────────────
                    // Before placing a sell order in Alpaca, verify we actually hold a long
                    // position there. If the DB says we own it but Alpaca doesn't, selling
                    // would create an unintended short. Instead, clean up the stale DB record.
                    if (process.env.BROKER === 'alpaca' || process.env.DATA_PROVIDER === 'alpaca') {
                        // Guard 1: DB sell-record check — prevents re-selling after worker restart wipes
                        // _exitPending. If a SELL trade was recorded in the last 4 hours for this symbol,
                        // the position was already exited in a previous cycle. Remove the stale DB holding.
                        try {
                            const recentSell = await query(
                                `SELECT id FROM trades WHERE user_id=$1 AND symbol=$2 AND action='SELL'
                                 AND trade_date > NOW() - INTERVAL '4 hours' LIMIT 1`,
                                [userId, holding.symbol]
                            );
                            if (recentSell.rows.length > 0) {
                                logger.warn('[AlpacaGuard] Recent SELL found in trades — position already exited, removing stale holding', {
                                    userId, symbol: holding.symbol
                                });
                                try { await holdingsDb.deleteHolding(userId, holding.symbol); } catch (_) {}
                                _exitPending.set(sellKey, Date.now() + 2 * 3600_000);
                                continue;
                            }
                        } catch (_tradeCheckErr) { /* non-blocking */ }

                        // Guard 2: Live Alpaca position check — if not long in broker, don't sell (would create short)
                        try {
                            const brokerPositions = await brokerService.getPositions(userId);
                            const alpacaPos = brokerPositions.find(p => p.symbol.toUpperCase() === holding.symbol.toUpperCase());
                            const alpacaQty = parseFloat(alpacaPos?.qty ?? 0);

                            if (alpacaQty < 0) {
                                // Already short — a previous sell accidentally shorted it. Never sell deeper.
                                logger.warn('[AlpacaGuard] Position is SHORT in Alpaca — blocking sell to prevent deeper short', {
                                    userId, symbol: holding.symbol, alpacaQty
                                });
                                try { await holdingsDb.deleteHolding(userId, holding.symbol); } catch (_) {}
                                _exitPending.set(sellKey, Date.now() + 2 * 3600_000);
                                continue;
                            }

                            if (!alpacaPos || alpacaQty === 0) {
                                logger.warn('[AlpacaGuard] No long position in Alpaca — removing stale DB holding', {
                                    userId, symbol: holding.symbol,
                                    dbQty: holding.quantity,
                                    alpacaQty: alpacaPos?.qty ?? 'not found'
                                });
                                try { await holdingsDb.deleteHolding(userId, holding.symbol); } catch (_) {}
                                _exitPending.set(sellKey, Date.now() + 2 * 3600_000);
                                continue;
                            }

                            // Cap sell quantity to what Alpaca actually holds (prevents over-selling fractionals)
                            if (alpacaQty < sellQuantity) {
                                logger.warn('[AlpacaGuard] Capping sell qty to Alpaca position', {
                                    userId, symbol: holding.symbol, requested: sellQuantity, actual: alpacaQty
                                });
                                sellQuantity = alpacaQty;
                            }
                        } catch (guardErr) {
                            // Positions check failed — skip this sell to be safe (never sell blind)
                            logger.warn('[AlpacaGuard] Could not verify Alpaca position — skipping sell', {
                                userId, symbol: holding.symbol, error: guardErr.message
                            });
                            continue;
                        }
                    }

                    _sellInProgress.add(sellKey);
                    const isFullExit = sellQuantity >= holding.quantity;

                    // Set exit-pending BEFORE attempting the sell so the next bot cycle
                    // won't re-trigger even if the sell order fails (broker error, 429, etc.).
                    // Initial 30-min TTL on failure; extended to 2h after confirmed fill.
                    _exitPending.set(sellKey, Date.now() + 1800_000);

                    try {
                        logger.trade('SELL', holding.symbol, sellQuantity, currentPrice, { reason });

                        // Fire the deferred notification now — sell is about to execute.
                        // Doing it here (not at signal-detection time) ensures it fires
                        // exactly once even when retries occur. Not awaited — the actual
                        // sell order below must never wait on a Telegram round-trip.
                        if (pendingAlert) { pendingAlert().catch(() => {}); }

                        const result = await brokerService.sellMarket(userId, holding.symbol, sellQuantity, { executedBy: 'AI_BOT', reason });

                        const exitPrice  = result.filledAvgPrice || currentPrice;
                        const profitLoss = (exitPrice - purchasePrice) * sellQuantity;
                        const pnlPercent = purchasePrice > 0 ? ((exitPrice - purchasePrice) / purchasePrice) * 100 : 0;

                        // Extend exit-pending to 2h now that the sell is confirmed.
                        _exitPending.set(sellKey, Date.now() + (isFullExit ? 2 * 3600_000 : 1800_000));

                        // For full exits, immediately remove the holding from DB so the
                        // next call to getUserHoldings doesn't return a stale record.
                        if (isFullExit) {
                            try { await holdingsDb.deleteHolding(userId, holding.symbol); } catch (_delErr) {
                                logger.warn('[ExitCleanup] Failed to delete holding from DB', { userId, symbol: holding.symbol });
                            }
                        }

                        // Invalidate the cached holdings line so the trade-executed
                        // alert shows the updated (post-sell) portfolio.
                        if (typeof alertService.invalidateHoldingsCache === 'function') {
                            alertService.invalidateHoldingsCache(userId);
                        }

                        await performanceService.recordTradePerformance(userId, {
                            action: 'SELL', symbol: holding.symbol, quantity: sellQuantity,
                            price: exitPrice, profit_loss: profitLoss, fees: result.commission || 0
                        });

                        let aiReasoning = reason;
                        if (holding.scoringLog && Array.isArray(holding.scoringLog) && holding.scoringLog.length > 0) {
                            aiReasoning += '\n' + holding.scoringLog.slice(0, 8).join('\n');
                        }

                        alertService.alertTradeExecuted(userId, 'SELL', holding.symbol, sellQuantity, exitPrice, holding.aiScore || '', aiReasoning).catch(() => {});

                        const sellSlippage = exitPrice - currentPrice; // positive = worse fill
                        // Classify the exit into a clean category for hypothesis analytics
                        const _exitCategory = reason.startsWith('Stop-loss')            ? 'stop_loss'
                            : reason.startsWith('Trailing stop')                        ? 'trailing_stop'
                            : reason.startsWith('Partial take-profit')                  ? 'partial_take_profit'
                            : reason.startsWith('Early partial take-profit')            ? 'partial_take_profit'
                            : reason.startsWith('Take-profit')                          ? 'take_profit'
                            : reason.startsWith('Break-even')                           ? 'break_even'
                            : reason.startsWith('Pre-earnings')                         ? 'pre_earnings_exit'
                            : reason.startsWith('Swing max-hold partial')               ? 'max_hold_partial'
                    : reason.startsWith('Swing max-hold')                       ? 'max_hold_time'
                            : reason.startsWith('Slow mover')                           ? 'slow_mover'
                            : 'other';

                        // Determine outcome tag and exit-time DTE (best-effort, non-blocking)
                        const _outcome = pnlPercent > 0.5 ? 'win' : pnlPercent < -0.5 ? 'loss' : 'breakeven';
                        let _exitDte = null;
                        try { _exitDte = await getDaysToEarnings(holding.symbol); } catch (_) {}

                        // Richer win/loss attribution tag
                        const _winLossReason = _outcome === 'win'
                            ? (_exitCategory === 'take_profit'        ? 'target_hit'
                            : _exitCategory === 'trailing_stop'       ? 'trail_profit_taken'
                            : _exitCategory === 'partial_take_profit' ? 'partial_profit'
                            : _exitCategory === 'pre_earnings_exit'   ? 'earnings_exit_profit'
                            : 'held_to_win')
                            : _outcome === 'loss'
                            ? (_exitCategory === 'stop_loss'          ? 'stopped_out'
                            : _exitCategory === 'trailing_stop'       ? 'trail_reversed'
                            : _exitCategory === 'pre_earnings_exit'   ? 'earnings_exit_loss'
                            : _exitCategory === 'slow_mover'          ? 'opportunity_cost'
                            : _exitCategory === 'max_hold_time'       ? 'time_stop'
                            : 'closed_at_loss')
                            : 'flat_exit';

                        await tradeIntelligenceService.closeLatestOpenExecution(userId, {
                            botType: 'stock', symbol: holding.symbol, exitPrice, pnl: profitLoss, pnlPercent,
                            outcome: _outcome,
                            metadata: {
                                reason, exitReason: _exitCategory, winLossReason: _winLossReason,
                                sellQuantity, purchasePrice,
                                exitRegime: exitThresholds.regime,
                                signalPrice: currentPrice,
                                daysToEarningsAtExit: _exitDte,
                                slippage: Number(sellSlippage.toFixed(4)),
                                slippagePct: currentPrice > 0 ? Number((sellSlippage / currentPrice * 100).toFixed(4)) : 0
                            }
                        });

                        // After a hard stop-loss, blacklist the symbol for 5 trading days to prevent re-entry
                        if (isHardStop) {
                            try {
                                await query(
                                    `INSERT INTO asset_blacklist (symbol, reason, added_by, expires_at)
                                     VALUES ($1, $2, 'ai_bot_stop_loss', NOW() + INTERVAL '5 days')
                                     ON CONFLICT (symbol) DO UPDATE
                                       SET reason = EXCLUDED.reason,
                                           expires_at = GREATEST(EXCLUDED.expires_at, asset_blacklist.expires_at)`,
                                    [`COOLDOWN_${userId}_${holding.symbol}`, `Stop-loss cooldown for ${holding.symbol} (exit: ${(pnlPercent).toFixed(1)}%)`]
                                );
                                logger.info('[StopCooldown] 5-day re-entry cooldown set', { userId, symbol: holding.symbol });
                            } catch (cooldownErr) {
                                logger.warn('[StopCooldown] Failed to insert cooldown', { error: cooldownErr.message });
                            }
                        }
                    } catch (sellErr) {
                        // Broker says the position doesn't exist (already closed at broker level
                        // but our DB is stale). Remove the ghost holding immediately so the
                        // next cycle doesn't attempt another sell + extend exit-pending to 2h.
                        if (/don.t own|you don.*own|insufficient.*(qty|shares|quantity)|position.*not.*found|no.*position|already.*closed/i.test(sellErr.message)) {
                            logger.warn('[SellFail] Broker position not found — removing stale DB record', { userId, symbol: holding.symbol, error: sellErr.message });
                            try { await holdingsDb.deleteHolding(userId, holding.symbol); } catch (_) {}
                            _exitPending.set(sellKey, Date.now() + 2 * 3600_000);
                        } else {
                            logger.error('[SellFail] Sell order failed — exit suppressed for 30 min', { userId, symbol: holding.symbol, error: sellErr.message });
                        }
                    } finally {
                        _sellInProgress.delete(sellKey);
                    }
                }

            } catch (error) {
                _sellInProgress.delete(sellKey);
                logger.error('Error managing position', { userId, symbol: holding.symbol, error: error.message });
            }
        }
        
    } catch (error) {
        logger.error('Error managing positions', { userId, error: error.message });
    }
}

module.exports = {
    executeAutonomousTrading,
    scanMarketForOpportunities,
    analyzeStockWithAI,
    isMarketOpen,
    getUserRiskConfig,
    manageExistingPositions,
    getGateStats,
    getVixLevel
};

// Test-only exports — stripped from consideration in production because NODE_ENV !== 'test'
if (process.env.NODE_ENV === 'test') {
    module.exports._test = {
        checkLossStreakBreaker,
        deriveStockSetupFamily,
        refreshSectorRotationCache,
        getSectorRotation: () => _sectorRotation
    };
}
