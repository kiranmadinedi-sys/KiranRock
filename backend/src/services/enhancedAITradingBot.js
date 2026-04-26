const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const marketScreenerService = require('./marketScreenerService');
const tradingServiceDB = require('./tradingServiceDB');
const userDb = require('./userDatabaseService');
const accountDb = require('./tradingAccountDatabaseService');
const holdingsDb = require('./holdingsDatabaseService');
const tradesDb = require('./tradesDatabaseService');
const { query } = require('../config/database');
const { logger, aiTradingLogger } = require('../utils/logger');
const alertService = require('./telegramAlertService');
const performanceService = require('./performanceMetricsService');
const indicators = require('./technicalIndicators');
const marketRegimeService = require('./marketRegimeService');
const newsSentimentService = require('./newsSentimentService');
const cacheService = require('./cacheService');
// Broker + data abstraction — switch provider/broker via .env without code changes
const brokerService = require('./brokerService');
const dataProvider  = require('./dataProvider');

const AI_NEWS_SCORING_ENABLED = (process.env.AI_NEWS_SCORING_ENABLED || 'true').toLowerCase() === 'true';
const AI_NEWS_SCORE_WEIGHT = Math.max(0, Math.min(1, parseFloat(process.env.AI_NEWS_SCORE_WEIGHT || '1')));
const AI_NEWS_MAX_IMPACT = Math.max(0, parseFloat(process.env.AI_NEWS_MAX_IMPACT || '8'));

/**
 * Enhanced AI Trading Bot Service - PostgreSQL Version
 * Automatically analyzes ALL available stocks and trades autonomously
 */

// Default risk management configuration
const DEFAULT_RISK_CONFIG = {
    // Position sizing
    maxPositionSize: 0.15,        // Max 15% in single stock
    minPositionSize: 0.02,        // Min 2% per position
    maxPortfolioRisk: 0.60,       // Max 60% invested (40% cash reserve)
    
    // Entry/Exit rules
    minBuyScore: 65,              // Min AI score to buy
    stopLoss: -0.12,              // Sell at 12% loss
    trailingStopPercent: 0.08,    // Trail stop 8% from peak
    takeProfitPercent: 0.25,      // Take profit at 25% gain
    partialTakeProfitPercent: 0.15, // Sell 50% at 15% gain
    
    // Risk limits
    maxOpenPositions: 25,         // Max number of holdings
    minMarketCap: 5000000000,     // Min $5B market cap
    maxDailyTrades: 10,           // Max trades per day
    
    // Volatility management
    maxVix: 30,                   // Don't buy if VIX > 30
    reducePositionsVix: 25,       // Reduce exposure if VIX > 25
    
    // Diversification
    maxSectorAllocation: 0.35,    // Max 35% per sector
    preferredSectors: ['Technology', 'Healthcare', 'Financials', 'Consumer']
};

/**
 * Get user's risk configuration from database
 */
async function getUserRiskConfig(userId) {
    try {
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
                maxSectorAllocation: parseFloat(dbConfig.max_sector_allocation)
            };
        }
        
        return DEFAULT_RISK_CONFIG;
    } catch (err) {
        logger.error('Error getting risk config', { error: err.message, userId });
        return DEFAULT_RISK_CONFIG;
    }
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
        const chart = await yahooFinance.chart(symbol, {
            period1: new Date(Date.now() - 70 * 86400000).toISOString().split('T')[0],
            interval: '1d'
        });
        const closes = (chart?.quotes || []).map(q => q.close).filter(Boolean);
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

/**
 * Check daily loss limit (circuit breaker)
 */
async function checkDailyLossLimit(userId, riskConfig) {
    try {
        const dailyLoss = await performanceService.getTodayLoss(userId);
        const lossLimit = riskConfig.dailyLossLimit || -1000; // Default -$1,000
        
        if (dailyLoss <= lossLimit) {
            logger.error('Daily loss limit reached', { userId, dailyLoss, lossLimit });
            await alertService.alertDailyLossLimitReached(userId, dailyLoss);
            return true; // Trading stopped
        }
        
        // Warning at 75% of limit
        if (dailyLoss <= lossLimit * 0.75) {
            await alertService.alertDailyLossWarning(userId, dailyLoss, lossLimit);
        }
        
        return false; // Trading allowed
    } catch (error) {
        logger.error('Error checking daily loss limit', { error: error.message, userId });
        return false; // Allow trading if check fails
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
        const chart = await yahooFinance.chart('SPY', {
            period1: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            interval: '1d'
        });
        const closes = chart.quotes.map(q => q.close).filter(Boolean);
        if (closes.length < 20) return 0;
        const ret = ((closes[closes.length - 1] - closes[closes.length - 20]) / closes[closes.length - 20]) * 100;
        cacheService.set('spy_20d_return', ret, 15 * 60 * 1000);
        return ret;
    } catch {
        return 0;
    }
}

/**
 * Get days until the stock's next earnings report.
 * Returns null if unavailable, positive number = days until earnings,
 * 0 or negative = earnings passed or today.
 */
async function getDaysToEarnings(symbol) {
    const cacheKey = `earnings_days_${symbol}`;
    const cached = cacheService.get(cacheKey);
    if (cached !== null) return cached;

    try {
        const summary = await yahooFinance.quoteSummary(symbol, { modules: ['calendarEvents'] });
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
 * Analyze a single stock with AI scoring
 *
 * Scoring breakdown (max ±points from base 50):
 *   Momentum        ±10  (today's % change)
 *   Volume          ±10  (vs 10-day avg volume)
 *   RSI             ±15  (via interpretRSI)
 *   MACD            ±10  (via interpretMACD)
 *   Bollinger Bands ±12  (via interpretBollingerBands) — NEW
 *   Relative Strength ±8 (stock vs SPY 20-day return)  — NEW
 *   52-Week High    ±7   (proximity to yearly high)     — NEW
 *   Earnings Risk   -15  (within 5 days of earnings)   — NEW
 *   News Sentiment  ±8   (headline sentiment, configurable) — NEW
 *   VIX             ±10  (market volatility)
 *   Market Cap      ±5   (size quality)
 */
async function analyzeStockWithAI(symbol, vixLevel) {
    try {
        // Fetch core market data through provider abstraction to avoid Yahoo-specific 429 failures
        const [quote, historicalData, spyReturn, daysToEarnings, newsData] = await Promise.all([
            dataProvider.getQuote(symbol),
            dataProvider.getBars(symbol, '1d', 90),
            getSPY20DayReturn(),
            getDaysToEarnings(symbol),
            AI_NEWS_SCORING_ENABLED
                ? newsSentimentService.getNewsSentiment(symbol).catch(() => null)
                : Promise.resolve(null)
        ]);

        if (!quote || !quote.price) {
            return null;
        }

        const price = quote.price;
        const change = quote.changePercent || 0;
        const volume = quote.volume || 0;
        const avgVolume = quote.avgVolume || volume;
        const marketCap = quote.marketCap || 0;
        const sector = quote.sector || 'Unknown';
        const week52High = quote.high52w || price;

        const quotes = (historicalData || []).filter(q => q.close != null);
        const closes = quotes.map(q => q.close).filter(Boolean);
        const highs  = quotes.map(q => q.high).filter(Boolean);
        const lows   = quotes.map(q => q.low).filter(Boolean);

        if (closes.length < 20) return null;

        /*
        const [quote, historicalData, spyReturn, daysToEarnings, newsData] = await Promise.all([
            yahooFinance.quoteSummary(symbol, {
                modules: ['price', 'summaryDetail', 'defaultKeyStatistics']
            }),
            yahooFinance.chart(symbol, {
                period1: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                interval: '1d'
            }),
            getSPY20DayReturn(),
            getDaysToEarnings(symbol),
            AI_NEWS_SCORING_ENABLED
                ? newsSentimentService.getNewsSentiment(symbol).catch(() => null)
                : Promise.resolve(null)
        ]);
        */

        // --- Core technical indicators ---
        const rsi  = indicators.calculateSimpleRSI(closes, 14);
        const macd = indicators.calculateSimpleMACD(closes, 12, 26, 9);
        const atr  = indicators.calculateSimpleATR(highs, lows, closes, 14);
        const bb   = indicators.calculateBollingerBands(closes, 20, 2);

        const rsiSignal  = indicators.interpretRSI(rsi);
        const macdSignal = indicators.interpretMACD(macd);
        const bbSignal   = indicators.interpretBollingerBands(bb);

        const volumeRatio = volume / (avgVolume || volume);
        const momentum    = change / 100;

        // 20-day stock return for Relative Strength vs SPY
        const price20dAgo = closes[Math.max(0, closes.length - 20)];
        const stockReturn20d = ((price - price20dAgo) / price20dAgo) * 100;
        const relativeStrength = stockReturn20d - spyReturn;

        // 52-week high proximity (how close price is to 52wk high)
        const highProximity = week52High > 0 ? price / week52High : 1;

        // ===================== SCORING =====================
        let score = 50; // Base score
        const scoringLog = [];

        // 1. Momentum (±10) — today's price change
        if (momentum > 0.03)       { score += 10; scoringLog.push('Momentum: +10 (strong up)'); }
        else if (momentum > 0.01)  { score += 6;  scoringLog.push('Momentum: +6'); }
        else if (momentum > 0)     { score += 2;  scoringLog.push('Momentum: +2'); }
        else if (momentum > -0.01) { score -= 2;  scoringLog.push('Momentum: -2'); }
        else if (momentum > -0.03) { score -= 6;  scoringLog.push('Momentum: -6'); }
        else                       { score -= 10; scoringLog.push('Momentum: -10 (strong down)'); }

        // 2. Volume (±10) — vs 10-day average
        if (volumeRatio > 2.0)      { score += 10; scoringLog.push('Volume: +10 (2x avg)'); }
        else if (volumeRatio > 1.5) { score += 6;  scoringLog.push('Volume: +6'); }
        else if (volumeRatio > 1.0) { score += 3;  scoringLog.push('Volume: +3'); }
        else if (volumeRatio < 0.5) { score -= 6;  scoringLog.push('Volume: -6 (very low)'); }

        // 3. RSI (±15)
        score += rsiSignal.scoreAdjustment;
        scoringLog.push(`RSI: ${rsiSignal.scoreAdjustment > 0 ? '+' : ''}${rsiSignal.scoreAdjustment} (${rsiSignal.signal})`);

        // 4. MACD (±10)
        score += macdSignal.scoreAdjustment;
        scoringLog.push(`MACD: ${macdSignal.scoreAdjustment > 0 ? '+' : ''}${macdSignal.scoreAdjustment} (${macdSignal.signal})`);

        // 5. Bollinger Bands (±12) — NEW
        score += bbSignal.scoreAdjustment;
        scoringLog.push(`BB: ${bbSignal.scoreAdjustment > 0 ? '+' : ''}${bbSignal.scoreAdjustment} (${bbSignal.signal})`);

        // 6. Relative Strength vs SPY (±8) — NEW
        if (relativeStrength > 8)       { score += 8;  scoringLog.push('RelStrength: +8 (strongly outperforming SPY)'); }
        else if (relativeStrength > 3)  { score += 4;  scoringLog.push('RelStrength: +4 (outperforming SPY)'); }
        else if (relativeStrength > -3) { score += 0;  scoringLog.push('RelStrength: 0 (in-line with SPY)'); }
        else if (relativeStrength > -8) { score -= 4;  scoringLog.push('RelStrength: -4 (underperforming SPY)'); }
        else                            { score -= 8;  scoringLog.push('RelStrength: -8 (strongly underperforming SPY)'); }

        // 7. 52-Week High Proximity (±7) — NEW
        // Stocks near/at 52wk highs have momentum; far below shows weakness
        if (highProximity >= 0.97)      { score += 7;  scoringLog.push('52wkHigh: +7 (within 3% of 52wk high)'); }
        else if (highProximity >= 0.90) { score += 3;  scoringLog.push('52wkHigh: +3 (within 10% of 52wk high)'); }
        else if (highProximity < 0.60)  { score -= 7;  scoringLog.push('52wkHigh: -7 (>40% below 52wk high)'); }
        else if (highProximity < 0.75)  { score -= 3;  scoringLog.push('52wkHigh: -3 (>25% below 52wk high)'); }

        // 8. Earnings Risk (-15) — NEW
        // Avoid buying within 5 trading days of earnings (IV crush, gap risk)
        let earningsFlag = false;
        if (daysToEarnings !== null && daysToEarnings >= 0 && daysToEarnings <= 5) {
            score -= 15;
            earningsFlag = true;
            scoringLog.push(`Earnings: -15 (${daysToEarnings}d to earnings — high risk)`);
        } else if (daysToEarnings !== null && daysToEarnings >= 6 && daysToEarnings <= 14) {
            score -= 5;
            scoringLog.push(`Earnings: -5 (${daysToEarnings}d to earnings — mild risk)`);
        }

        // 9. VIX (±10)
        if (vixLevel < 15)      { score += 5;  scoringLog.push('VIX: +5 (calm market)'); }
        else if (vixLevel < 20) { score += 2; }
        else if (vixLevel > 30) { score -= 10; scoringLog.push('VIX: -10 (extreme fear)'); }
        else if (vixLevel > 25) { score -= 5;  scoringLog.push('VIX: -5 (elevated fear)'); }

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
                score += newsScoreAdjustment;
                scoringLog.push(`News: ${newsScoreAdjustment >= 0 ? '+' : ''}${newsScoreAdjustment.toFixed(2)} (sentiment ${newsSentiment.toFixed(1)}, sources ${newsSourceCount}${xPostCount ? `, X ${xPostCount}` : ''})`);
            }
        }

        // 10. Market Cap Quality (±5)
        if (marketCap > 100e9)      { score += 3; }
        else if (marketCap > 10e9)  { score += 2; }
        else if (marketCap < 5e9)   { score -= 5; }

        // Normalize score to 0-100
        score = Math.max(0, Math.min(100, score));

        // Generate recommendation
        let recommendation = 'HOLD';
        if (score >= 75) recommendation = 'STRONG BUY';
        else if (score >= 65) recommendation = 'BUY';
        else if (score <= 25) recommendation = 'STRONG SELL';
        else if (score <= 35) recommendation = 'SELL';

        const analysis = {
            symbol,
            price,
            change,
            volume,
            volumeRatio: volumeRatio.toFixed(2),
            marketCap,
            sector,
            aiScore: Math.round(score),
            recommendation,
            confidence: Math.abs(score - 50) / 50 * 100,
            vixLevel,
            // Technical indicators
            rsi: rsi.toFixed(2),
            bbPercentB: bb.percentB.toFixed(3),
            bbSignal: bbSignal.signal,
            relativeStrength: relativeStrength.toFixed(2),
            week52HighProximity: (highProximity * 100).toFixed(1) + '%',
            earningsFlag,
            daysToEarnings,
            newsSentiment: Number(newsSentiment.toFixed(1)),
            newsScoreAdjustment: Number(newsScoreAdjustment.toFixed(2)),
            newsSourceCount,
            xPostCount,
            scoringLog,
            rsiSignal: rsiSignal.signal,
            macd: macd.histogram.toFixed(4),
            macdSignal: macdSignal.signal,
            atr: atr.toFixed(2),
            timestamp: new Date()
        };

        // Log AI decision with structured data
        logger.aiDecision(symbol, Math.round(score), recommendation, {
            rsi: rsiSignal.signal,
            macd: macdSignal.signal,
            volumeRatio: volumeRatio.toFixed(2),
            momentum: (momentum * 100).toFixed(2) + '%',
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

/**
 * Scan entire market universe and find best opportunities
 * @param {string} userId
 * @param {number} limit - max results to return
 * @param {number} [overrideMinScore] - optional regime-adjusted min score
 */
async function scanMarketForOpportunities(userId, limit = 50, overrideMinScore = null) {
    logger.info('Scanning market for opportunities', { userId, limit });

    const vixLevel = await getVixLevel();
    const riskConfig = await getUserRiskConfig(userId);
    const minBuyScore = overrideMinScore !== null ? overrideMinScore : riskConfig.minBuyScore;
    const universe = await marketScreenerService.getStockUniverse();
    
    logger.info('Market scan started', { 
        userId, 
        universeSize: universe.length, 
        vixLevel: vixLevel.toFixed(2) 
    });
    
    // Filter by minimum market cap
    const qualified = universe.filter(stock => 
        stock.marketCap >= riskConfig.minMarketCap
    );
    
    logger.info('Stocks qualified by market cap', { 
        userId, 
        qualified: qualified.length, 
        minMarketCap: riskConfig.minMarketCap 
    });
    
    // Analyze all stocks in batches (reduced to prevent Yahoo Finance rate limiting)
    const opportunities = [];
    const batchSize = 5;  // Reduced from 20 to 5 to respect rate limits
    
    for (let i = 0; i < qualified.length; i += batchSize) {
        const batch = qualified.slice(i, i + batchSize);
        const results = await Promise.allSettled(
            batch.map(stock => analyzeStockWithAI(stock.symbol, vixLevel))
        );
        
        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value) {
                const analysis = result.value;
                const stockInfo = batch[index];
                
                // Only consider BUY or STRONG BUY with good score (uses regime-adjusted threshold)
                if (analysis.aiScore >= minBuyScore &&
                    (analysis.recommendation === 'BUY' || analysis.recommendation === 'STRONG BUY')) {
                    opportunities.push({
                        ...analysis,
                        sector: stockInfo.sector,
                        industry: stockInfo.industry
                    });
                }
            }
        });
        
        // Increased delay between batches to respect Yahoo Finance rate limits
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3 seconds between batches
        
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
    
    // Sort by AI score and return top opportunities
    opportunities.sort((a, b) => b.aiScore - a.aiScore);
    
    logger.info('Market scan complete', { 
        userId,
        totalOpportunities: opportunities.length, 
        returning: Math.min(opportunities.length, limit)
    });
    
    return opportunities.slice(0, limit);
}

/**
 * Execute autonomous trading for a user
 */
async function executeAutonomousTrading(userId) {
    try {
        logger.info('Starting autonomous trading', { userId });

        // Check if market is open
        if (!isMarketOpen()) {
            logger.info('Market is closed, skipping trading', { userId });
            return { success: false, message: 'Market is closed' };
        }

        const [riskConfig, regime] = await Promise.all([
            getUserRiskConfig(userId),
            marketRegimeService.getMarketRegime()
        ]);

        // Apply market regime overrides — regime caps risk and raises bar in bear/neutral markets
        const effectiveMaxRisk = Math.min(riskConfig.maxPortfolioRisk, regime.maxRisk);
        const effectiveMinScore = Math.max(riskConfig.minBuyScore, regime.minBuyScore);
        const effectiveSizeMultiplier = regime.positionSizeMultiplier || 1.0;

        logger.info('Market regime applied', {
            userId,
            regime: regime.regime,
            effectiveMaxRisk,
            effectiveMinScore,
            effectiveSizeMultiplier,
            regimeDescription: regime.description
        });

        // Use regime-adjusted config for this session
        const sessionRiskConfig = {
            ...riskConfig,
            maxPortfolioRisk: effectiveMaxRisk,
            minBuyScore: effectiveMinScore
        };

        // Check daily loss circuit breaker
        const lossLimitReached = await checkDailyLossLimit(userId, sessionRiskConfig);
        if (lossLimitReached) {
            logger.error('Daily loss limit reached, stopping trading', { userId });
            return { success: false, message: 'Daily loss limit reached' };
        }

        // Check consecutive loss streak circuit breaker
        const streakBreaker = await checkLossStreakBreaker(userId);
        if (streakBreaker.halt) {
            await alertService.alertTradingStarted(userId, 0, 0); // reuse for now — sends info
            logger.error('[CircuitBreaker] Trading halted due to consecutive loss streak', {
                userId, streak: streakBreaker.streak
            });
            return { success: false, message: `Circuit breaker: ${streakBreaker.streak} consecutive losses — trading halted` };
        }

        // Fetch Kelly metrics once per session (null if < 10 trades history)
        const kellyMetrics = await performanceService.getKellyMetrics(userId);

        const vixLevel = await getVixLevel();
        
        // Get account and portfolio info
        const account = await accountDb.getTradingAccount(userId);
        const portfolio = await tradingServiceDB.getPortfolioSummary(userId);
        
        const availableBalance = parseFloat(account.balance);
        const currentHoldings = portfolio.holdings || [];
        const totalPortfolioValue = portfolio.totalPortfolioValue || availableBalance;
        
        logger.info('Account status', { 
            userId,
            availableBalance: availableBalance.toFixed(2),
            holdings: currentHoldings.length,
            portfolioValue: totalPortfolioValue.toFixed(2)
        });
        
        // Send trading started alert
        await alertService.alertTradingStarted(userId, availableBalance, currentHoldings.length);
        
        // Check VIX - reduce trading if too volatile
        if (vixLevel > sessionRiskConfig.maxVix) {
            logger.warn('VIX too high, skipping new purchases', { userId, vixLevel: vixLevel.toFixed(2) });
            await alertService.alertHighVIX(userId, vixLevel);
            // Still check for stop-loss and exits
            await manageExistingPositions(userId);
            return { success: false, message: `Market too volatile (VIX: ${vixLevel.toFixed(2)})` };
        }

        // Manage existing positions (stop-loss, take-profit, trailing stops)
        await manageExistingPositions(userId);

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

        if (availableToInvest < 100 || currentHoldings.length >= sessionRiskConfig.maxOpenPositions) {
            logger.info('Portfolio at capacity', { userId, availableToInvest, currentHoldings: currentHoldings.length });
            return { success: true, message: 'Portfolio at capacity' };
        }

        // Scan market for best opportunities (pass regime minBuyScore so scan filters correctly)
        const opportunities = await scanMarketForOpportunities(userId, 30, sessionRiskConfig.minBuyScore);

        if (opportunities.length === 0) {
            logger.info('No qualifying opportunities found', { userId, vixLevel });
            await alertService.alertNoOpportunities(userId, 0, vixLevel);
            return { success: true, message: 'No opportunities meet criteria' };
        }

        // Filter out stocks we already own
        const ownedSymbols = currentHoldings.map(h => h.symbol);
        const newOpportunities = opportunities.filter(opp => !ownedSymbols.includes(opp.symbol));

        // Build sector allocations for diversification enforcement
        const sectorAllocations = {};
        currentHoldings.forEach(h => {
            const sec = h.sector || 'Unknown';
            sectorAllocations[sec] = (sectorAllocations[sec] || 0) + (h.marketValue || 0);
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

        // Execute trades
        const trades = [];
        let remainingCapital = availableToInvest;

        for (const opportunity of newOpportunities) {
            if (trades.length >= sessionRiskConfig.maxDailyTrades) break;
            if (remainingCapital < 100) break;
            if (currentHoldings.length + trades.length >= sessionRiskConfig.maxOpenPositions) break;

            // Skip earnings-flagged stocks entirely
            if (opportunity.earningsFlag) {
                logger.info('Skipping stock - earnings within 5 days', {
                    userId, symbol: opportunity.symbol, daysToEarnings: opportunity.daysToEarnings
                });
                continue;
            }

            // Check sector limit
            const sector = opportunity.sector || 'Unknown';
            const sectorCurrent = sectorAllocations[sector] || 0;
            const sectorLimit = totalPortfolioValue * sessionRiskConfig.maxSectorAllocation;

            // Also block overconcentrated sectors
            if (sectorCurrent >= sectorLimit || overconcentratedSectors.includes(sector)) {
                logger.info('Skipping stock - sector at limit', {
                    userId,
                    symbol: opportunity.symbol,
                    sector,
                    sectorCurrent: sectorCurrent.toFixed(2),
                    sectorLimit: sectorLimit.toFixed(2)
                });
                continue;
            }

            // ── Correlation risk check ──────────────────────────────────────
            const ownedNow = currentHoldings.map(h => h.symbol).concat(trades.map(t => t.symbol));
            const tooCorrelated = await isTooCorrelated(ownedNow, opportunity.symbol);
            if (tooCorrelated) {
                logger.info('Skipping stock — too correlated with existing holdings', {
                    userId, symbol: opportunity.symbol
                });
                continue;
            }

            // ── Position sizing ─────────────────────────────────────────────
            const accountTotalValue = availableBalance + currentInvestment;

            // Try Kelly Criterion first (uses 90-day historical win/loss data)
            const kellySizing = kellyMetrics
                ? kellyPositionSize(
                    kellyMetrics.winRate,
                    kellyMetrics.avgWin,
                    Math.abs(kellyMetrics.avgLoss),
                    accountTotalValue,
                    sessionRiskConfig.maxPositionSize   // cap at user's max
                  )
                : null;

            // Fall back to score-scaled default sizing if Kelly not available
            const basePosition = remainingCapital * sessionRiskConfig.minPositionSize;
            const maxPosition  = Math.min(
                remainingCapital * sessionRiskConfig.maxPositionSize,
                sectorLimit - sectorCurrent
            );
            const scoreMultiplier = (opportunity.aiScore - sessionRiskConfig.minBuyScore)
                / (100 - sessionRiskConfig.minBuyScore);
            const defaultSizing = basePosition + (maxPosition - basePosition) * scoreMultiplier;

            // Kelly overrides default when available; both are subject to regime + streak multipliers
            const combinedMultiplier = effectiveSizeMultiplier * streakBreaker.multiplier;
            let positionSize = (kellySizing !== null ? kellySizing : defaultSizing) * combinedMultiplier;

            // Cap at remaining sector room
            positionSize = Math.min(positionSize, sectorLimit - sectorCurrent);

            // Adjust for volatility using ATR (if available)
            if (opportunity.atr && opportunity.atr > 0) {
                const riskAmount   = accountTotalValue * 0.02; // Risk 2% per trade
                const stopDistance = parseFloat(opportunity.atr) * 2; // 2 ATR stop
                const maxShares    = Math.floor(riskAmount / stopDistance);
                const atrPositionSize = maxShares * opportunity.price;
                positionSize = Math.min(positionSize, atrPositionSize);
            }

            logger.info('Position sizing', {
                userId, symbol: opportunity.symbol,
                method:          kellySizing !== null ? 'kelly' : 'score-scaled',
                positionSize:    positionSize.toFixed(2),
                kellyMetrics:    kellyMetrics || null,
                streakMultiplier: streakBreaker.multiplier,
                regimeMultiplier: effectiveSizeMultiplier
            });
            
            const shares = Math.floor(positionSize / opportunity.price);
            
            if (shares > 0) {
                try {
                    logger.trade('BUY', opportunity.symbol, shares, opportunity.price, { 
                        aiScore: opportunity.aiScore,
                        rsi: opportunity.rsiSignal,
                        macd: opportunity.macdSignal,
                        atr: opportunity.atr
                    });
                    
                    const result = await brokerService.buyMarket(
                        userId,
                        opportunity.symbol,
                        shares,
                        {
                            executedBy: 'AI_BOT',
                            aiScore:    opportunity.aiScore,
                            sector:     opportunity.sector
                        }
                    );

                    trades.push({
                        action: 'BUY',
                        symbol: opportunity.symbol,
                        shares,
                        price:  result.filledAvgPrice,
                        total:  result.total || (result.filledAvgPrice * shares),
                        aiScore: opportunity.aiScore,
                        sector: opportunity.sector,
                        broker: result.broker
                    });
                    
                    const filledPrice = result.filledAvgPrice;
                    const tradeTotal  = result.total || (filledPrice * shares);
                    const commission  = result.commission || 0;

                    // Send trade alert
                    await alertService.alertTradeExecuted(
                        userId,
                        'BUY',
                        opportunity.symbol,
                        shares,
                        filledPrice,
                        opportunity.aiScore,
                        `RSI: ${opportunity.rsiSignal}, MACD: ${opportunity.macdSignal}`
                    );

                    // Record performance
                    await performanceService.recordTradePerformance(userId, {
                        action: 'BUY',
                        symbol: opportunity.symbol,
                        quantity: shares,
                        price: filledPrice,
                        fees: commission
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
        
        logger.info('Trading session complete', { 
            userId,
            tradesExecuted: trades.length,
            capitalDeployed: capitalDeployed.toFixed(2),
            opportunitiesFound: opportunities.length
        });
        
        return {
            success: true,
            tradesExecuted: trades.length,
            trades,
            capitalDeployed,
            opportunitiesFound: opportunities.length
        };
        
    } catch (error) {
        logger.error('Error in autonomous trading', { userId, error: error.message });
        return { success: false, error: error.message };
    }
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
        
        for (const holding of holdings) {
            try {
                const currentPrice = await tradingServiceDB.getCurrentPrice(holding.symbol);
                if (!currentPrice) continue;
                
                const purchasePrice = holding.average_price;
                const changePercent = (currentPrice - purchasePrice) / purchasePrice;
                
                // Update peak price for trailing stop
                if (!holding.peak_price || currentPrice > holding.peak_price) {
                    await holdingsDb.updatePeakPrice(userId, holding.symbol, currentPrice);
                    holding.peak_price = currentPrice;
                }
                
                const trailingStopPrice = holding.peak_price * (1 - riskConfig.trailingStopPercent);
                
                let shouldSell = false;
                let reason = '';
                let sellQuantity = holding.quantity;
                
                // Alert on large unrealized loss
                if (changePercent <= -0.10 && !holding.large_loss_alerted) {
                    await alertService.alertLargeLoss(
                        userId,
                        holding.symbol,
                        changePercent * 100,
                        currentPrice,
                        purchasePrice
                    );
                    // Mark to avoid repeated alerts (would need DB field)
                }
                
                // Hard stop-loss
                if (changePercent <= riskConfig.stopLoss) {
                    shouldSell = true;
                    reason = `Stop-loss triggered at ${(changePercent * 100).toFixed(2)}%`;
                    
                    const loss = (currentPrice - purchasePrice) * sellQuantity;
                    await alertService.alertStopLossTriggered(
                        userId,
                        holding.symbol,
                        sellQuantity,
                        currentPrice,
                        loss
                    );
                }
                // Trailing stop
                else if (currentPrice <= trailingStopPrice) {
                    shouldSell = true;
                    const dropFromPeak = ((currentPrice - holding.peak_price) / holding.peak_price * 100).toFixed(2);
                    reason = `Trailing stop triggered: dropped ${dropFromPeak}% from peak`;
                    
                    logger.riskEvent('TRAILING_STOP', holding.symbol, {
                        currentPrice,
                        peakPrice: holding.peak_price,
                        dropFromPeak
                    });
                }
                // Full take-profit
                else if (changePercent >= riskConfig.takeProfitPercent) {
                    shouldSell = true;
                    reason = `Take-profit target reached at ${(changePercent * 100).toFixed(2)}%`;
                    
                    const profit = (currentPrice - purchasePrice) * sellQuantity;
                    await alertService.alertTakeProfitExecuted(
                        userId,
                        holding.symbol,
                        sellQuantity,
                        currentPrice,
                        profit,
                        changePercent * 100
                    );
                }
                // Partial take-profit
                else if (changePercent >= riskConfig.partialTakeProfitPercent && !holding.partial_profit_taken) {
                    shouldSell = true;
                    sellQuantity = Math.floor(holding.quantity / 2);
                    reason = `Partial take-profit at ${(changePercent * 100).toFixed(2)}% (selling 50%)`;
                    await holdingsDb.markPartialProfitTaken(userId, holding.symbol, true);
                }
                
                if (shouldSell && sellQuantity > 0) {
                    logger.trade('SELL', holding.symbol, sellQuantity, currentPrice, { reason });

                    const result = await brokerService.sellMarket(
                        userId,
                        holding.symbol,
                        sellQuantity,
                        { executedBy: 'AI_BOT', reason }
                    );
                    
                    // Record performance
                    const profitLoss = (currentPrice - purchasePrice) * sellQuantity;
                    await performanceService.recordTradePerformance(userId, {
                        action: 'SELL',
                        symbol: holding.symbol,
                        quantity: sellQuantity,
                        price: currentPrice,
                        profit_loss: profitLoss,
                        fees: result.commission || 0
                    });
                }
                
            } catch (error) {
                logger.error('Error managing position', { 
                    userId,
                    symbol: holding.symbol, 
                    error: error.message 
                });
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
    manageExistingPositions
};
