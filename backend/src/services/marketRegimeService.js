const cacheService = require('./cacheService');
const dataProvider = require('./dataProvider');
const { logger } = require('../utils/logger');

const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

/**
 * Market Regime Detection Service
 *
 * Classifies the current market as BULL, NEUTRAL, or BEAR based on:
 *   1. SPY price vs 200-day MA
 *   2. SPY price vs 50-day MA
 *   3. VIX level
 *   4. 20-day SPY return
 *
 * Regime adjusts the AI bot's risk tolerance and minimum buy score
 * to prevent buying aggressively into bear markets.
 */

/**
 * Calculate SMA from a price array over the last `period` bars
 */
function sma(prices, period) {
    if (prices.length < period) return null;
    const slice = prices.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Fetch SPY chart and compute consecutive losing-day streaks
 */
async function getConsecutiveLossDays(closes) {
    let streak = 0;
    for (let i = closes.length - 1; i > 0; i--) {
        if (closes[i] < closes[i - 1]) streak++;
        else break;
    }
    return streak;
}

/**
 * Determine current market regime
 * @returns {object} regime details with trading parameters
 */
async function getMarketRegime() {
    const cached = cacheService.get('market_regime');
    if (cached) return cached;

    try {
        const [spyBars, vixQuote] = await Promise.all([
            dataProvider.getBars('SPY', '1d', 210),
            dataProvider.getQuote('^VIX')
        ]);

        const closes = spyBars
            .map(q => q.close)
            .filter(c => c != null && c > 0);

        if (closes.length < 50) {
            logger.warn('[MarketRegime] Insufficient SPY data, using neutral defaults');
            return getDefaultRegime();
        }

        const currentPrice = closes[closes.length - 1];
        const ma200 = sma(closes, Math.min(200, closes.length));
        const ma50 = sma(closes, 50);
        const vixLevel = vixQuote.price || 20;

        // 20-day return
        const price20dAgo = closes[Math.max(0, closes.length - 20)];
        const return20d = ((currentPrice - price20dAgo) / price20dAgo) * 100;

        // Consecutive losing days (cooling off signal)
        const consecutiveLossDays = await getConsecutiveLossDays(closes);

        // Fear & Greed proxy: VIX above 35 = extreme fear
        const extremeFear = vixLevel > 35;
        const highVix = vixLevel > 25;

        // === REGIME CLASSIFICATION ===
        let regime, description, maxRisk, minBuyScore, positionSizeMultiplier;

        const aboveMa200 = ma200 ? currentPrice > ma200 : true;
        const aboveMa50 = ma50 ? currentPrice > ma50 : true;
        const aboveMa200By5pct = ma200 ? currentPrice > ma200 * 1.05 : false;
        const below200By5pct = ma200 ? currentPrice < ma200 * 0.95 : false;

        if (extremeFear || (below200By5pct && return20d < -8)) {
            // BEAR market
            regime = 'BEAR';
            description = `Bear market: SPY ${below200By5pct ? 'well below 200MA' : ''} VIX=${vixLevel.toFixed(1)}, 20d return=${return20d.toFixed(1)}%`;
            maxRisk = 0.20;            // Only 20% invested max
            minBuyScore = 80;          // Need very high conviction
            positionSizeMultiplier = 0.5;
        } else if (!aboveMa200 || (highVix && return20d < -5)) {
            // NEUTRAL/CAUTIOUS market
            regime = 'NEUTRAL';
            description = `Neutral market: SPY ${aboveMa200 ? 'above' : 'below'} 200MA, VIX=${vixLevel.toFixed(1)}, 20d return=${return20d.toFixed(1)}%`;
            maxRisk = 0.35;
            minBuyScore = 70;
            positionSizeMultiplier = 0.75;
        } else if (aboveMa200By5pct && aboveMa50 && vixLevel < 20 && return20d > 0) {
            // Strong BULL
            regime = 'BULL';
            description = `Bull market: SPY well above 200MA & 50MA, VIX=${vixLevel.toFixed(1)}, 20d return=+${return20d.toFixed(1)}%`;
            maxRisk = 0.60;
            minBuyScore = 62;
            positionSizeMultiplier = 1.0;
        } else {
            // Mild BULL
            regime = 'BULL';
            description = `Mild bull: SPY above 200MA, VIX=${vixLevel.toFixed(1)}, 20d return=${return20d.toFixed(1)}%`;
            maxRisk = 0.50;
            minBuyScore = 65;
            positionSizeMultiplier = 0.9;
        }

        // Additional caution if 3+ consecutive down days
        if (consecutiveLossDays >= 3 && regime !== 'BEAR') {
            minBuyScore = Math.min(minBuyScore + 5, 85);
            maxRisk = Math.max(maxRisk - 0.05, 0.15);
            description += ` | ${consecutiveLossDays} consecutive down days - extra caution`;
        }

        const result = {
            regime,
            description,
            spyPrice: parseFloat(currentPrice.toFixed(2)),
            ma200: ma200 ? parseFloat(ma200.toFixed(2)) : null,
            ma50: ma50 ? parseFloat(ma50.toFixed(2)) : null,
            vixLevel: parseFloat(vixLevel.toFixed(2)),
            return20d: parseFloat(return20d.toFixed(2)),
            consecutiveLossDays,
            maxRisk,
            minBuyScore,
            positionSizeMultiplier,
            timestamp: new Date().toISOString()
        };

        cacheService.set('market_regime', result, CACHE_TTL);
        logger.info('[MarketRegime] Regime determined', { regime, vixLevel, return20d: return20d.toFixed(2) });
        return result;

    } catch (error) {
        logger.error('[MarketRegime] Error fetching regime data', { error: error.message });
        return getDefaultRegime();
    }
}

/**
 * Default neutral regime when data is unavailable
 */
function getDefaultRegime() {
    return {
        regime: 'NEUTRAL',
        description: 'Unable to determine market regime — using conservative neutral defaults',
        spyPrice: null,
        ma200: null,
        ma50: null,
        vixLevel: null,
        return20d: null,
        consecutiveLossDays: 0,
        maxRisk: 0.40,
        minBuyScore: 68,
        positionSizeMultiplier: 0.85,
        timestamp: new Date().toISOString()
    };
}

module.exports = { getMarketRegime, getDefaultRegime };
