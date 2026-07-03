const optionsService = require('./optionsService');
const tradingAccountService = require('./tradingAccountService');
const { logger } = require('../utils/logger');
const telegramAlertService = require('./telegramAlertService');
const performanceMetricsService = require('./performanceMetricsService');
const marketRegimeService = require('./marketRegimeService');
const tradeIntelligenceService = require('./tradeIntelligenceService');
const dataProvider = require('./dataProvider');
const globalSentimentService = require('./globalSentimentService');
const { query } = require('../config/database');
const vixMonitor = require('./vixSpikeMonitorService');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

/**
 * AUTONOMOUS OPTIONS TRADING BOT
 * 
 * Professional options trading system with:
 * - Greeks-based strategy selection
 * - Multi-strategy approach (scalping, swing, spreads)
 * - Advanced risk management
 * - Real-time position monitoring
 * - Automated entry/exit execution
 * 
 * Strategies:
 * 1. Delta-Neutral Scalping (quick profits from volatility)
 * 2. Directional Swing (momentum-based options)
 * 3. Credit Spreads (income generation)
 * 4. Protective Puts (portfolio hedging)
 */

// === CONFIGURATION ===

const BOT_CONFIG = {
    // Account limits
    maxAccountRisk: 0.10,           // Max 10% of account at risk
    maxPositionRisk: 0.02,          // Max 2% risk per position
    maxOpenPositions: 5,             // Max concurrent options positions
    minAccountBalance: 10000,        // Minimum $10k to trade options
    
    // Strategy allocation
    strategies: {
        deltaNeutralScalping: {
            enabled: true,
            allocation: 0.30,        // 30% of options capital
            timeframe: 'intraday',
            targetReturn: 0.20       // 20% return target
        },
        directionalSwing: {
            enabled: true,
            allocation: 0.40,        // 40% of options capital
            timeframe: '2-5 days',
            targetReturn: 0.35       // 35% return target
        },
        creditSpreads: {
            enabled: true,
            allocation: 0.20,        // 20% of options capital
            timeframe: '7-30 days',
            targetReturn: 0.15       // 15% return target (lower risk)
        },
        protectivePuts: {
            enabled: true,
            allocation: 0.10,        // 10% for hedging
            timeframe: '30-60 days',
            targetReturn: -0.05      // Cost of insurance
        }
    },
    
    // Greeks thresholds for each strategy
    greeksThresholds: {
        deltaNeutralScalping: {
            minGamma: 0.08,
            minVega: 0.15,
            maxTheta: -0.30,
            targetDelta: 0.50,
            deltaRange: 0.10
        },
        directionalSwing: {
            minDelta: 0.60,
            maxDelta: 0.85,
            minGamma: 0.03,
            maxTheta: -0.50,
            minVega: 0.10
        },
        creditSpreads: {
            shortDelta: 0.30,        // Sell OTM (30% probability ITM)
            longDelta: 0.20,         // Buy further OTM
            minPremium: 0.30,        // Min $0.30 credit
            maxWidth: 5              // Max $5 strike width
        },
        protectivePuts: {
            targetDelta: -0.20,      // 20% OTM puts
            minVega: 0.05,
            maxCost: 0.02            // Max 2% of stock value
        }
    },
    
    // Liquidity requirements
    liquidity: {
        minVolume: 500,
        minOpenInterest: 1000,
        maxBidAskSpread: 0.15,       // 15% max spread
        minStockPrice: 20,           // $20 minimum
        minMarketCap: 2000           // $2B minimum
    },
    
    // Risk management
    risk: {
        stopLoss: 0.30,              // Exit at -30%
        takeProfit: 0.50,            // Take profit at +50%
        trailingStop: 0.15,          // Trail by 15%
        maxDailyLoss: 1000,          // $1,000 max daily loss
        positionSizeMethod: 'greeks' // 'greeks' or 'fixed'
    },
    
    // Timing
    trading: {
        startTime: '09:45',          // Wait 15 min after open
        endTime: '15:45',            // Stop 15 min before close
        scanInterval: 300000,        // 5 minutes
        maxDaysToExp: 60,
        minDaysToExp: 7
    }
};

const DEFAULT_USER_BOT_CONFIG = {
    enabled: false,
    scalping_enabled: false,  // Disabled: too complex, requires near-perfect Greek data
    swing_enabled: true,
    spreads_enabled: true,
    hedging_enabled: false,
    max_position_risk: BOT_CONFIG.maxPositionRisk,
    max_account_risk: BOT_CONFIG.maxAccountRisk,
    max_open_positions: BOT_CONFIG.maxOpenPositions,
    max_daily_loss: BOT_CONFIG.risk.maxDailyLoss,
    position_size_method: BOT_CONFIG.risk.positionSizeMethod,
    fixed_contracts: 1,
    take_profit_percent: BOT_CONFIG.risk.takeProfit * 100,
    stop_loss_percent: BOT_CONFIG.risk.stopLoss * 100,
    trailing_stop_percent: BOT_CONFIG.risk.trailingStop * 100,
    trading_start_time: `${BOT_CONFIG.trading.startTime}:00`,
    trading_end_time: `${BOT_CONFIG.trading.endTime}:00`,
    min_liquidity_score: 50,
    min_opportunity_score: 70
};

async function getUserBotConfig(userId) {
    // Guard: skip users not in the users table (e.g. probe/healthcheck accounts)
    const userCheck = await query(`SELECT id FROM users WHERE id = $1`, [userId]);
    if (userCheck.rows.length === 0) {
        logger.warn('[OptionsBot] getUserBotConfig skipped — user not in users table', { userId });
        return DEFAULT_USER_BOT_CONFIG;
    }
    const result = await query(
        `INSERT INTO options_bot_config (
            user_id, enabled, scalping_enabled, swing_enabled, spreads_enabled, hedging_enabled,
            max_position_risk, max_account_risk, max_open_positions, max_daily_loss,
            position_size_method, fixed_contracts, take_profit_percent, stop_loss_percent,
            trailing_stop_percent, trading_start_time, trading_end_time,
            min_liquidity_score, min_opportunity_score
        ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10,
            $11, $12, $13, $14,
            $15, $16, $17,
            $18, $19
        )
        ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
        RETURNING *`,
        [
            userId,
            DEFAULT_USER_BOT_CONFIG.enabled,
            DEFAULT_USER_BOT_CONFIG.scalping_enabled,
            DEFAULT_USER_BOT_CONFIG.swing_enabled,
            DEFAULT_USER_BOT_CONFIG.spreads_enabled,
            DEFAULT_USER_BOT_CONFIG.hedging_enabled,
            DEFAULT_USER_BOT_CONFIG.max_position_risk,
            DEFAULT_USER_BOT_CONFIG.max_account_risk,
            DEFAULT_USER_BOT_CONFIG.max_open_positions,
            DEFAULT_USER_BOT_CONFIG.max_daily_loss,
            DEFAULT_USER_BOT_CONFIG.position_size_method,
            DEFAULT_USER_BOT_CONFIG.fixed_contracts,
            DEFAULT_USER_BOT_CONFIG.take_profit_percent,
            DEFAULT_USER_BOT_CONFIG.stop_loss_percent,
            DEFAULT_USER_BOT_CONFIG.trailing_stop_percent,
            DEFAULT_USER_BOT_CONFIG.trading_start_time,
            DEFAULT_USER_BOT_CONFIG.trading_end_time,
            DEFAULT_USER_BOT_CONFIG.min_liquidity_score,
            DEFAULT_USER_BOT_CONFIG.min_opportunity_score
        ]
    );

    return result.rows[0];
}

function buildRuntimeConfig(userConfig = {}) {
    return {
        ...BOT_CONFIG,
        maxAccountRisk: Number(userConfig.max_account_risk ?? BOT_CONFIG.maxAccountRisk),
        maxPositionRisk: Number(userConfig.max_position_risk ?? BOT_CONFIG.maxPositionRisk),
        maxOpenPositions: Number(userConfig.max_open_positions ?? BOT_CONFIG.maxOpenPositions),
        strategies: {
            ...BOT_CONFIG.strategies,
            deltaNeutralScalping: {
                ...BOT_CONFIG.strategies.deltaNeutralScalping,
                enabled: userConfig.scalping_enabled ?? BOT_CONFIG.strategies.deltaNeutralScalping.enabled
            },
            directionalSwing: {
                ...BOT_CONFIG.strategies.directionalSwing,
                enabled: userConfig.swing_enabled ?? BOT_CONFIG.strategies.directionalSwing.enabled
            },
            creditSpreads: {
                ...BOT_CONFIG.strategies.creditSpreads,
                enabled: userConfig.spreads_enabled ?? BOT_CONFIG.strategies.creditSpreads.enabled
            },
            protectivePuts: {
                ...BOT_CONFIG.strategies.protectivePuts,
                enabled: userConfig.hedging_enabled ?? BOT_CONFIG.strategies.protectivePuts.enabled
            }
        },
        risk: {
            ...BOT_CONFIG.risk,
            stopLoss: Number(userConfig.stop_loss_percent ?? BOT_CONFIG.risk.stopLoss * 100) / 100,
            takeProfit: Number(userConfig.take_profit_percent ?? BOT_CONFIG.risk.takeProfit * 100) / 100,
            trailingStop: Number(userConfig.trailing_stop_percent ?? BOT_CONFIG.risk.trailingStop * 100) / 100,
            maxDailyLoss: Number(userConfig.max_daily_loss ?? BOT_CONFIG.risk.maxDailyLoss),
            positionSizeMethod: userConfig.position_size_method || BOT_CONFIG.risk.positionSizeMethod,
            fixedContracts: Number(userConfig.fixed_contracts ?? 1)
        },
        trading: {
            ...BOT_CONFIG.trading,
            startTime: String(userConfig.trading_start_time || DEFAULT_USER_BOT_CONFIG.trading_start_time).slice(0, 5),
            endTime: String(userConfig.trading_end_time || DEFAULT_USER_BOT_CONFIG.trading_end_time).slice(0, 5)
        },
        minimums: {
            liquidityScore: Number(userConfig.min_liquidity_score ?? DEFAULT_USER_BOT_CONFIG.min_liquidity_score),
            opportunityScore: Number(userConfig.min_opportunity_score ?? DEFAULT_USER_BOT_CONFIG.min_opportunity_score)
        }
    };
}

function deriveOptionsSetupFamily(strategy, opportunity) {
    const ivRankLabel = opportunity.ivRankLabel || 'NORMAL';
    const momentum = Number(opportunity.underlyingMomentum || 0);

    if (strategy === 'creditSpreads') {
        return `${String(opportunity.type || 'credit_spread').toLowerCase()}_${ivRankLabel.toLowerCase()}`;
    }

    if (strategy === 'directionalSwing') {
        return momentum >= 0 ? `bullish_swing_${ivRankLabel.toLowerCase()}` : `bearish_swing_${ivRankLabel.toLowerCase()}`;
    }

    if (strategy === 'deltaNeutralScalping') {
        return `gamma_scalp_${ivRankLabel.toLowerCase()}`;
    }

    return `${strategy}_${ivRankLabel.toLowerCase()}`;
}

function getOptionsRegimeAdjustment(strategy, regime, opportunity, globalSentiment = null) {
    const momentum = Number(opportunity.underlyingMomentum || 0);
    let scoreAdjustment = 0;
    let sizeMultiplier = 1;
    let thresholdAdjustment = 0;

    // Local market regime (BULL / BEAR / NEUTRAL from market breadth)
    if (regime === 'BEAR') {
        sizeMultiplier = 0.8;
        thresholdAdjustment = 5;

        if (strategy === 'creditSpreads') {
            scoreAdjustment += 6;
            sizeMultiplier = 0.95;
        } else if (strategy === 'directionalSwing') {
            scoreAdjustment += momentum < 0 ? 4 : -8;
        } else if (strategy === 'deltaNeutralScalping') {
            scoreAdjustment += 2;
        }
    } else if (regime === 'BULL') {
        if (strategy === 'directionalSwing') {
            scoreAdjustment += momentum > 0 ? 5 : -3;
            sizeMultiplier = momentum > 0 ? 1.05 : 0.9;
        } else if (strategy === 'creditSpreads') {
            scoreAdjustment += 2;
        }
    } else {
        sizeMultiplier = 0.92;
        thresholdAdjustment = 2;
    }

    // ATLAS global macro overlay — applied on top of local regime adjustments
    if (globalSentiment) {
        const atlasLabel = globalSentiment.label;

        if (atlasLabel === 'RISK_OFF') {
            // Global market in stress — shrink all positions, raise bar to enter
            sizeMultiplier      *= 0.6;
            thresholdAdjustment += 8;
            if (strategy === 'directionalSwing' && momentum > 0) {
                scoreAdjustment -= 10; // block fresh bullish calls
            } else if (strategy === 'creditSpreads') {
                scoreAdjustment += 4;  // defined-risk spreads preferred in RISK_OFF
            }
        } else if (atlasLabel === 'BEARISH') {
            sizeMultiplier      *= 0.8;
            thresholdAdjustment += 5;
            if (strategy === 'directionalSwing' && momentum > 0) {
                scoreAdjustment -= 5;  // reduce bullish call confidence
            } else if (strategy === 'creditSpreads') {
                scoreAdjustment += 3;  // spreads more attractive in bearish global
            }
        } else if (atlasLabel === 'BULLISH') {
            if (strategy === 'directionalSwing' && momentum > 0) {
                scoreAdjustment += 4;
                sizeMultiplier   *= 1.05;
            } else if (strategy === 'creditSpreads') {
                scoreAdjustment += 2;
            }
        } else if (atlasLabel === 'STRONG_BULLISH') {
            if (strategy === 'directionalSwing' && momentum > 0) {
                scoreAdjustment += 7;
                sizeMultiplier   *= 1.10;
            } else if (strategy === 'deltaNeutralScalping') {
                scoreAdjustment += 3;
            }
        }
        // NEUTRAL → no adjustment (default)
    }

    return { scoreAdjustment, sizeMultiplier, thresholdAdjustment };
}

// Valid physical bounds for each Greek — values outside these indicate bad API data.
// delta ∈ [-1, 1]  gamma ∈ [0, 1]  theta ≤ 0  vega ≥ 0  IV ∈ [0, 5] (0-500%)
const GREEKS_BOUNDS = {
    delta:             { min: -1,  max: 1   },
    gamma:             { min: 0,   max: 1   },
    theta:             { min: -50, max: 0   },
    vega:              { min: 0,   max: 50  },
    impliedVolatility: { min: 0,   max: 5   }
};

function validateAndClampGreeks(raw, symbol) {
    const g = { ...raw };
    for (const [key, { min, max }] of Object.entries(GREEKS_BOUNDS)) {
        const v = Number(g[key]);
        if (!Number.isFinite(v)) {
            if (g[key] !== undefined && g[key] !== null) {
                logger.warn(`[OptionsGreeks] Non-finite ${key} for ${symbol || '?'}: ${g[key]}, defaulting to 0`);
            }
            g[key] = 0;
        } else if (v < min || v > max) {
            logger.warn(`[OptionsGreeks] ${key} out of range for ${symbol || '?'}: ${v.toFixed(4)} (valid [${min}, ${max}]), clamping`);
            g[key] = Math.max(min, Math.min(max, v));
        }
    }
    return g;
}

function getOptionGreeks(option, symbol) {
    const raw = option.greeks || {
        delta:             option.delta             || 0,
        gamma:             option.gamma             || 0,
        theta:             option.theta             || 0,
        vega:              option.vega              || 0,
        impliedVolatility: option.impliedVolatility || 0,
        theoreticalPrice:  option.theoreticalPrice  || 0,
        intrinsicValue:    option.intrinsicValue    || 0,
        timeValue:         option.timeValue         || 0
    };
    return validateAndClampGreeks(raw, symbol || option.symbol);
}

function getOptionType(option) {
    return (option.optionType || option.type || '').toLowerCase();
}

function getOptionExpiration(option) {
    return option.expirationDate || option.expiration;
}

function isTradableOption(option) {
    const bid = Number(option?.bid || 0);
    const ask = Number(option?.ask || 0);
    if (bid <= 0 || ask <= 0 || ask < bid) return false;
    return ((ask - bid) / ask) <= BOT_CONFIG.liquidity.maxBidAskSpread;
}

function findMatchingOption(options, criteria) {
    return options.find((option) =>
        Number(option.strike) === Number(criteria.strike) &&
        getOptionExpiration(option) === criteria.expiration &&
        getOptionType(option) === criteria.optionType
    );
}

function getCurrentEasternTimeMinutes() {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return et.getHours() * 60 + et.getMinutes();
}

function isWithinTradingWindow(runtimeConfig) {
    const [startHour, startMinute] = runtimeConfig.trading.startTime.split(':').map(Number);
    const [endHour, endMinute] = runtimeConfig.trading.endTime.split(':').map(Number);
    const currentTime = getCurrentEasternTimeMinutes();
    return currentTime >= (startHour * 60 + startMinute) && currentTime <= (endHour * 60 + endMinute);
}

// === MARKET DATA & ANALYSIS ===

/**
 * Get current VIX level for volatility assessment
 */
async function getVixLevel() {
    try {
        const vixData = await dataProvider.getQuote('^VIX');
        const vixLevel = vixData?.price || vixData?.regularMarketPrice;
        
        logger.info('[Options Bot] VIX Level', { vix: vixLevel });
        
        return {
            value: vixLevel,
            regime: vixLevel < 15 ? 'LOW' : vixLevel < 25 ? 'NORMAL' : vixLevel < 35 ? 'HIGH' : 'EXTREME'
        };
    } catch (error) {
        logger.error('[Options Bot] Error fetching VIX', { error: error.message });
        return { value: 20, regime: 'NORMAL' }; // Default
    }
}

/**
 * Get stock's implied volatility rank (IV Rank)
 *
 * True IV Rank = (currentIV - 52wk_low_IV) / (52wk_high_IV - 52wk_low_IV) * 100
 *
 * Since we don't have a time-series of historical IV from Yahoo Finance, we estimate
 * the 52-week IV range using realized (historical) volatility from weekly price returns
 * as a proxy. This is a standard industry approximation.
 *
 * Interpretation:
 *   IV Rank < 30  → IV is CHEAP  → Prefer BUYING options (debit strategies)
 *   IV Rank 30-70 → IV is NORMAL → Any strategy
 *   IV Rank > 70  → IV is EXPENSIVE → Prefer SELLING options (credit strategies, avoid debit)
 */
async function calculateIVRank(symbol, optionsData = null) {
    try {
        const [resolvedOptionsData, bars] = await Promise.all([
            optionsData ? Promise.resolve(optionsData) : optionsService.getOptionsWithGreeks(symbol),
            dataProvider.getBars(symbol, '1d', 90)
        ]);

        if (!resolvedOptionsData.options || resolvedOptionsData.options.length === 0) {
            return null;
        }

        // Current IV: average of near-ATM options (delta 0.40 – 0.60)
        const atmOptions = resolvedOptionsData.options
            .filter(opt => {
                const d = Math.abs(opt.greeks?.delta || 0);
                return d >= 0.40 && d <= 0.60 && (opt.greeks?.impliedVolatility || 0) > 0;
            })
            .slice(0, 10);

        if (atmOptions.length === 0) return null;

        const currentIV = atmOptions.reduce((sum, opt) => sum + opt.greeks.impliedVolatility, 0) / atmOptions.length;

        // Estimate 52-week IV range using historical realized volatility (weekly returns)
        const closes = (bars || []).map(q => q.close).filter(c => c != null && c > 0);
        if (closes.length < 10) {
            return {
                currentIV: parseFloat((currentIV * 100).toFixed(1)),
                historicalVol: null,
                ivRank: 50,
                ivRankLabel: 'NORMAL',
                strategyBias: 'NEUTRAL',
                interpretation: 'Insufficient historical data for IV Rank — using neutral'
            };
        }

        // Annualized realized volatility from weekly log-returns
        const weeklyReturns = [];
        for (let i = 1; i < closes.length; i++) {
            weeklyReturns.push(Math.log(closes[i] / closes[i - 1]));
        }
        const avgRet = weeklyReturns.reduce((a, b) => a + b, 0) / weeklyReturns.length;
        const variance = weeklyReturns.reduce((sum, r) => sum + Math.pow(r - avgRet, 2), 0) / weeklyReturns.length;
        const historicalVol = Math.sqrt(variance * 52); // annualize weekly vol

        // Rolling min/max historical vol over the year → proxy for 52wk IV range
        // We compute rolling 4-week realized vol windows to approximate the distribution
        const windowSize = 4;
        const rollingVols = [];
        for (let i = windowSize; i <= weeklyReturns.length; i++) {
            const window = weeklyReturns.slice(i - windowSize, i);
            const wAvg = window.reduce((a, b) => a + b, 0) / windowSize;
            const wVar = window.reduce((sum, r) => sum + Math.pow(r - wAvg, 2), 0) / windowSize;
            rollingVols.push(Math.sqrt(wVar * 52));
        }

        const minIV = Math.min(...rollingVols);
        const maxIV = Math.max(...rollingVols);
        const ivRange = maxIV - minIV;

        // IV Rank: where does current IV sit in the 52-week range?
        const ivRank = ivRange > 0
            ? Math.min(100, Math.max(0, ((currentIV - minIV) / ivRange) * 100))
            : 50;

        // Strategy bias based on IV Rank
        let ivRankLabel, strategyBias, interpretation;
        if (ivRank >= 70) {
            ivRankLabel = 'HIGH';
            strategyBias = 'SELL_PREMIUM';   // Sell options — collect expensive premium
            interpretation = `High IV Rank (${ivRank.toFixed(0)}) — prefer credit spreads, covered calls, cash-secured puts`;
        } else if (ivRank <= 30) {
            ivRankLabel = 'LOW';
            strategyBias = 'BUY_OPTIONS';    // Buy options — cheap premium, limited downside
            interpretation = `Low IV Rank (${ivRank.toFixed(0)}) — prefer buying calls/puts or debit spreads`;
        } else {
            ivRankLabel = 'NORMAL';
            strategyBias = 'NEUTRAL';
            interpretation = `Normal IV Rank (${ivRank.toFixed(0)}) — any strategy appropriate`;
        }

        return {
            currentIV: parseFloat((currentIV * 100).toFixed(1)),      // as percentage
            historicalVol: parseFloat((historicalVol * 100).toFixed(1)),
            minIV52w: parseFloat((minIV * 100).toFixed(1)),
            maxIV52w: parseFloat((maxIV * 100).toFixed(1)),
            ivRank: parseFloat(ivRank.toFixed(1)),
            ivRankLabel,
            strategyBias,
            interpretation
        };
    } catch (error) {
        logger.error('[Options Bot] Error calculating IV Rank', { symbol, error: error.message });
        return null;
    }
}

/**
 * Analyze stock for options trading suitability
 */
async function analyzeStockForOptions(symbol) {
    try {
        // Get stock quote
        const quote = await dataProvider.getQuote(symbol);
        const price = Number(quote?.price || quote?.regularMarketPrice || 0);
        const marketCapValue = Number(quote?.marketCap || 0);
        const volume = Number(quote?.volume || quote?.regularMarketVolume || 0);
        const momentum = Number(quote?.changePercent || quote?.regularMarketChangePercent || 0);
        
        // Check basic requirements
        if (!price || price < BOT_CONFIG.liquidity.minStockPrice) {
            return null;
        }
        
        const marketCap = marketCapValue ? marketCapValue / 1000000 : 0;
        if (marketCap < BOT_CONFIG.liquidity.minMarketCap) {
            return null;
        }
        
        // Get options chain
        const optionsData = await optionsService.getOptionsWithGreeks(symbol, marketCap);
        if (!optionsData.options || optionsData.options.length === 0) {
            logger.warn('[Options Bot] Skipping symbol because no usable options chain was available', {
                symbol,
                error: optionsData.error || null,
                warning: optionsData.warning || null,
                cacheSource: optionsData.cache?.source || null,
                cacheAgeMs: optionsData.cache?.ageMs || null
            });
            return null;
        }
        
        // Calculate IV Rank
        const ivRank = await calculateIVRank(symbol, optionsData);
        
        return {
            symbol,
            stockPrice: price,
            marketCap,
            volume,
            momentum,
            ivRank,
            optionsData,
            optionsAvailable: optionsData.options.length,
            analysis: {
                liquidityScore: calculateLiquidityScore(optionsData.options),
                trendStrength: Math.abs(momentum),
                volatilityRegime: ivRank ? ivRank.interpretation : 'UNKNOWN'
            }
        };
    } catch (error) {
        logger.error('[Options Bot] Error analyzing stock', { symbol, error: error.message });
        return null;
    }
}

/**
 * Calculate liquidity score for options
 */
function calculateLiquidityScore(options) {
    if (!options || options.length === 0) return 0;
    
    const liquidOptions = options.filter(opt => 
        opt.volume >= BOT_CONFIG.liquidity.minVolume &&
        opt.openInterest >= BOT_CONFIG.liquidity.minOpenInterest &&
        opt.bid > 0 && opt.ask > 0 &&
        ((opt.ask - opt.bid) / opt.ask) <= BOT_CONFIG.liquidity.maxBidAskSpread
    );
    
    return (liquidOptions.length / options.length) * 100;
}

// === STRATEGY SELECTION & EXECUTION ===

/**
 * Find delta-neutral scalping opportunities
 * Strategy: Buy ATM options with high gamma for quick delta swings
 */
async function findDeltaNeutralScalps(symbol, stockAnalysis, optionsData) {
    try {
        const criteria = BOT_CONFIG.greeksThresholds.deltaNeutralScalping;
        
        const opportunities = optionsData.options.filter(opt => {
            const greeks = getOptionGreeks(opt);
            const delta = Math.abs(greeks.delta);
            const gamma = greeks.gamma;
            const vega = greeks.vega;
            const theta = greeks.theta;
            
            // ATM options with high gamma
            return (
                delta >= criteria.targetDelta - criteria.deltaRange &&
                delta <= criteria.targetDelta + criteria.deltaRange &&
                gamma >= criteria.minGamma &&
                vega >= criteria.minVega &&
                theta >= criteria.maxTheta && // Less negative is better
                isTradableOption(opt) &&
                opt.volume >= BOT_CONFIG.liquidity.minVolume &&
                opt.openInterest >= BOT_CONFIG.liquidity.minOpenInterest
            );
        });
        
        // Score and rank opportunities
        const scored = opportunities.map(opt => ({
            ...opt,
            scalperScore: calculateScalperScore(opt, stockAnalysis)
        })).sort((a, b) => b.scalperScore - a.scalperScore);
        
        return scored.slice(0, 3); // Top 3 opportunities
    } catch (error) {
        logger.error('[Options Bot] Error finding scalps', { symbol, error: error.message });
        return [];
    }
}

/**
 * Calculate scalper score for an option
 */
function calculateScalperScore(option, stockAnalysis) {
    let score = 0;
    const greeks = getOptionGreeks(option);
    
    // Gamma weight (40%) - Higher gamma = faster profits
    score += (greeks.gamma / 0.15) * 40;
    
    // Vega weight (30%) - Higher vega = profit from vol spikes
    score += (greeks.vega / 0.30) * 30;
    
    // Liquidity weight (20%)
    const spreadPercent = (option.ask - option.bid) / option.ask;
    score += (1 - spreadPercent / BOT_CONFIG.liquidity.maxBidAskSpread) * 20;
    
    // Theta penalty (10%) - Less theta decay is better
    const thetaScore = Math.max(0, 1 + (greeks.theta / 1.0));
    score += thetaScore * 10;
    
    return Math.min(100, Math.max(0, score));
}

/**
 * Find directional swing opportunities
 * Strategy: Buy ITM options with momentum in favorable direction
 */
async function findDirectionalSwings(symbol, stockAnalysis, optionsData, scanSignal = null) {
    try {
        const criteria = BOT_CONFIG.greeksThresholds.directionalSwing;

        // Direction priority:
        // 1. Nightly AI scan recommendation (STRONG BUY → CALL, STRONG SELL → PUT)
        //    More reliable than intraday momentum — uses overnight fundamental + technical AI score
        // 2. Intraday momentum fallback (>1% move, lowered from 2%)
        let bullish;
        if (scanSignal) {
            const rec = (scanSignal.recommendation || '').toUpperCase();
            if (rec.includes('BUY'))  { bullish = true;  }
            else if (rec.includes('SELL')) { bullish = false; }
            else { bullish = stockAnalysis.momentum > 1; }
            logger.info('[Options Bot] Direction from scan signal', {
                symbol, recommendation: scanSignal.recommendation,
                aiScore: scanSignal.ai_score, direction: bullish ? 'CALL' : 'PUT'
            });
        } else {
            bullish = stockAnalysis.momentum > 1; // lowered threshold: any meaningful positive move
        }

        const opportunities = optionsData.options.filter(opt => {
            const greeks = getOptionGreeks(opt);
            const delta = greeks.delta;
            const gamma = greeks.gamma;
            const vega = greeks.vega;
            const theta = greeks.theta;

            // Bullish (STRONG BUY) → BUY CALL (delta 0.50–0.85)
            // Bearish (STRONG SELL) → BUY PUT (delta -0.50 to -0.85)
            const deltaCheck = bullish
                ? (delta >= criteria.minDelta && delta <= criteria.maxDelta)
                : (delta <= -criteria.minDelta && delta >= -criteria.maxDelta);

            return (
                deltaCheck &&
                gamma >= criteria.minGamma &&
                vega >= criteria.minVega &&
                theta >= criteria.maxTheta &&
                isTradableOption(opt) &&
                opt.volume >= BOT_CONFIG.liquidity.minVolume &&
                opt.openInterest >= BOT_CONFIG.liquidity.minOpenInterest &&
                opt.daysToExpiration >= 21 &&   // roadmap: DTE ≥ 21 at entry
                opt.daysToExpiration <= 60
            );
        });
        
        const scored = opportunities.map(opt => ({
            ...opt,
            swingScore: calculateSwingScore(opt, stockAnalysis, bullish)
        })).sort((a, b) => b.swingScore - a.swingScore);
        
        return scored.slice(0, 3);
    } catch (error) {
        logger.error('[Options Bot] Error finding swings', { symbol, error: error.message });
        return [];
    }
}

/**
 * Calculate swing trade score
 */
function calculateSwingScore(option, stockAnalysis, bullish) {
    let score = 0;
    const greeks = getOptionGreeks(option);
    
    // Delta alignment (40%)
    const delta = Math.abs(greeks.delta);
    score += (delta / 0.85) * 40;
    
    // Momentum alignment (30%)
    const momentumScore = Math.abs(stockAnalysis.momentum) / 10;
    score += Math.min(30, momentumScore * 30);
    
    // Liquidity (20%)
    const spreadPercent = (option.ask - option.bid) / option.ask;
    score += (1 - spreadPercent / BOT_CONFIG.liquidity.maxBidAskSpread) * 20;
    
    // Time value (10%) - Prefer options with 20-40 DTE
    const dteScore = option.daysToExpiration >= 20 && option.daysToExpiration <= 40 ? 1 : 0.5;
    score += dteScore * 10;
    
    return Math.min(100, Math.max(0, score));
}

/**
 * Find credit spread opportunities
 * Strategy: Sell OTM options, buy further OTM for protection
 */
async function findCreditSpreads(symbol, stockAnalysis, optionsData) {
    try {
        const criteria = BOT_CONFIG.greeksThresholds.creditSpreads;
        const spreads = [];
        
        // Group options by expiration and type
        const expirations = {};
        optionsData.options.forEach(opt => {
            if (!expirations[opt.expirationDate]) {
                expirations[opt.expirationDate] = { calls: [], puts: [] };
            }
            if (opt.optionType === 'call') {
                expirations[opt.expirationDate].calls.push(opt);
            } else {
                expirations[opt.expirationDate].puts.push(opt);
            }
        });
        
        // Find spreads for each expiration
        for (const [exp, options] of Object.entries(expirations)) {
            // Bull put spread (sell put, buy lower put)
            const puts = options.puts.sort((a, b) => b.strike - a.strike);
            for (let i = 0; i < puts.length - 1; i++) {
                const shortPut = puts[i];
                const longPut = puts[i + 1];
                
                if (Math.abs(shortPut.greeks.delta) <= criteria.shortDelta &&
                    Math.abs(longPut.greeks.delta) <= criteria.longDelta &&
                    isTradableOption(shortPut) &&
                    isTradableOption(longPut) &&
                    (shortPut.strike - longPut.strike) <= criteria.maxWidth &&
                    shortPut.bid >= criteria.minPremium) {
                    
                    const credit = shortPut.bid - longPut.ask;
                    const maxRisk = (shortPut.strike - longPut.strike) - credit;
                    const returnOnRisk = (credit / maxRisk) * 100;
                    
                    if (returnOnRisk >= 15) { // Min 15% return on risk
                        spreads.push({
                            type: 'BULL_PUT_SPREAD',
                            symbol,
                            expiration: exp,
                            shortLeg: shortPut,
                            longLeg: longPut,
                            credit,
                            maxRisk,
                            returnOnRisk,
                            spreadScore: returnOnRisk
                        });
                    }
                }
            }
            
            // Bear call spread (sell call, buy higher call)
            const calls = options.calls.sort((a, b) => a.strike - b.strike);
            for (let i = 0; i < calls.length - 1; i++) {
                const shortCall = calls[i];
                const longCall = calls[i + 1];
                
                if (Math.abs(shortCall.greeks.delta) <= criteria.shortDelta &&
                    Math.abs(longCall.greeks.delta) <= criteria.longDelta &&
                    isTradableOption(shortCall) &&
                    isTradableOption(longCall) &&
                    (longCall.strike - shortCall.strike) <= criteria.maxWidth &&
                    shortCall.bid >= criteria.minPremium) {
                    
                    const credit = shortCall.bid - longCall.ask;
                    const maxRisk = (longCall.strike - shortCall.strike) - credit;
                    const returnOnRisk = (credit / maxRisk) * 100;
                    
                    if (returnOnRisk >= 15) {
                        spreads.push({
                            type: 'BEAR_CALL_SPREAD',
                            symbol,
                            expiration: exp,
                            shortLeg: shortCall,
                            longLeg: longCall,
                            credit,
                            maxRisk,
                            returnOnRisk,
                            spreadScore: returnOnRisk
                        });
                    }
                }
            }
        }
        
        return spreads.sort((a, b) => b.spreadScore - a.spreadScore).slice(0, 2);
    } catch (error) {
        logger.error('[Options Bot] Error finding spreads', { symbol, error: error.message });
        return [];
    }
}

// === POSITION MANAGEMENT ===

/**
 * Calculate position size based on Greeks and risk
 */
function calculateOptionsPositionSize(option, accountBalance, strategy, runtimeConfig) {
    try {
        const maxRiskAmount = accountBalance * runtimeConfig.maxPositionRisk;
        
        if (strategy === 'creditSpreads') {
            // For spreads, risk is max loss
            const contracts = Math.floor(maxRiskAmount / (option.maxRisk * 100));
            return Math.max(1, Math.min(contracts, 10)); // 1-10 contracts
        }

        if (runtimeConfig.risk.positionSizeMethod === 'fixed') {
            return Math.max(1, runtimeConfig.risk.fixedContracts || 1);
        }
        
        // For long options, risk is premium paid
        const optionPrice = (option.bid + option.ask) / 2;
        const contracts = Math.floor(maxRiskAmount / (optionPrice * 100));
        
        // Adjust for delta exposure
        const greeks = getOptionGreeks(option);
        const deltaAdjusted = Math.abs(greeks.delta) * contracts;
        
        // Don't exceed equivalent of 500 shares
        const maxContracts = Math.floor(500 / Math.max(Math.abs(greeks.delta) * 100, 1));
        
        return Math.max(1, Math.min(contracts, maxContracts, 20)); // 1-20 contracts
    } catch (error) {
        logger.error('[Options Bot] Error calculating position size', { error: error.message });
        return 1;
    }
}

/**
 * Execute options trade (paper trading - store in database)
 */
async function executeOptionsTrade(userId, opportunity, strategy, contracts) {
    try {
        const entryPrice = (opportunity.bid + opportunity.ask) / 2;
        const totalCost = entryPrice * contracts * 100; // Each contract = 100 shares
        
        // Check if spread
        if (opportunity.type && opportunity.type.includes('SPREAD')) {
            return await executeCreditSpread(userId, opportunity, contracts);
        }
        
        // Insert into options_trades table
        const result = await query(
            `INSERT INTO options_trades 
             (user_id, symbol, strike, expiration, option_type, action, contracts, entry_price, 
              entry_date, strategy, status, greeks_at_entry)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, $10, $11)
             RETURNING *`,
            [
                userId,
                opportunity.symbol,
                opportunity.strike,
                getOptionExpiration(opportunity),
                getOptionType(opportunity).toUpperCase(),
                'BUY',
                contracts,
                entryPrice,
                strategy,
                'OPEN',
                JSON.stringify(getOptionGreeks(opportunity))
            ]
        );
        
        const trade = result.rows[0];

        await tradeIntelligenceService.recordExecution(userId, {
            botType: 'options',
            symbol: opportunity.symbol,
            setupFamily: opportunity.setupFamily,
            strategyFamily: strategy,
            regime: opportunity.regime,
            score: opportunity.score,
            scoreAdjustment: opportunity.intelligenceScoreAdjustment,
            sizeMultiplier: opportunity.intelligenceSizeMultiplier,
            expectancy: opportunity.expectancyStats?.expectancy,
            confidence: opportunity.expectancyStats?.confidence,
            entryPrice,
            tradeRefType: 'options_trade',
            tradeRefId: trade.id,
            metadata: {
                contracts,
                strike: opportunity.strike,
                optionType: getOptionType(opportunity),
                expiration: getOptionExpiration(opportunity),
                ivRankLabel: opportunity.ivRankLabel,
                underlyingMomentum: opportunity.underlyingMomentum
            }
        });
        
        // Log trade
        logger.trade('BUY', opportunity.symbol, contracts, entryPrice, {
            type: 'OPTIONS',
            strike: opportunity.strike,
            expiration: getOptionExpiration(opportunity),
            optionType: getOptionType(opportunity),
            strategy,
            greeks: getOptionGreeks(opportunity),
            score: opportunity.scalperScore || opportunity.swingScore || 0
        });
        
        // Send directional signal alert (CALL or PUT with full thesis)
        const greeks = getOptionGreeks(opportunity);
        await telegramAlertService.alertOptionsSignalEntry(userId, {
            symbol: opportunity.symbol,
            stockPrice: opportunity.underlyingPrice || 0,
            momentum: opportunity.underlyingMomentum || 0,
            score: opportunity.score || opportunity.swingScore || opportunity.scalperScore || 0,
            regime: opportunity.regime || 'UNKNOWN',
            optionType: getOptionType(opportunity),
            strike: opportunity.strike,
            expiration: getOptionExpiration(opportunity),
            dte: opportunity.daysToExpiration || 0,
            price: entryPrice,
            contracts,
            totalCost,
            delta: greeks.delta,
            gamma: greeks.gamma,
            theta: greeks.theta,
            ivRankLabel: opportunity.ivRankLabel || 'NORMAL',
            ivRank: opportunity.ivRankNumeric,
            strategy
        });
        
        return trade;
    } catch (error) {
        logger.error('[Options Bot] Error executing trade', { error: error.message });
        throw error;
    }
}

/**
 * Execute credit spread (multi-leg trade)
 */
async function executeCreditSpread(userId, spread, contracts) {
    try {
        const result = await query(
            `INSERT INTO options_trades 
             (user_id, symbol, strike, expiration, option_type, action, contracts, entry_price, 
              entry_date, strategy, status, spread_type, long_strike, greeks_at_entry)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, $10, $11, $12, $13)
             RETURNING *`,
            [
                userId,
                spread.symbol,
                spread.shortLeg.strike,
                spread.expiration,
                spread.shortLeg.optionType.toUpperCase(),
                'SELL',
                contracts,
                spread.credit,
                'creditSpreads',
                'OPEN',
                spread.type,
                spread.longLeg.strike,
                JSON.stringify({
                    shortLegGreeks: spread.shortLeg.greeks,
                    longLegGreeks: spread.longLeg.greeks
                })
            ]
        );
        
        await tradeIntelligenceService.recordExecution(userId, {
            botType: 'options',
            symbol: spread.symbol,
            setupFamily: spread.setupFamily,
            strategyFamily: 'creditSpreads',
            regime: spread.regime,
            score: spread.score,
            scoreAdjustment: spread.intelligenceScoreAdjustment,
            sizeMultiplier: spread.intelligenceSizeMultiplier,
            expectancy: spread.expectancyStats?.expectancy,
            confidence: spread.expectancyStats?.confidence,
            entryPrice: spread.credit,
            tradeRefType: 'options_trade',
            tradeRefId: result.rows[0].id,
            metadata: {
                contracts,
                spreadType: spread.type,
                shortStrike: spread.shortLeg.strike,
                longStrike: spread.longLeg.strike,
                expiration: spread.expiration,
                ivRankLabel: spread.ivRankLabel,
                underlyingMomentum: spread.underlyingMomentum
            }
        });

        logger.trade('SELL_SPREAD', spread.symbol, contracts, spread.credit, {
            type: 'CREDIT_SPREAD',
            spreadType: spread.type,
            shortStrike: spread.shortLeg.strike,
            longStrike: spread.longLeg.strike,
            credit: spread.credit,
            maxRisk: spread.maxRisk,
            returnOnRisk: spread.returnOnRisk
        });
        
        await telegramAlertService.alertCreditSpreadExecuted(userId, {
            ...spread,
            contracts,
            totalCredit: spread.credit * contracts * 100
        });
        
        return result.rows[0];
    } catch (error) {
        logger.error('[Options Bot] Error executing spread', { error: error.message });
        throw error;
    }
}

/**
 * Monitor open options positions
 */
async function monitorOptionsPositions(userId) {
    try {
        const userConfig = await getUserBotConfig(userId);
        const runtimeConfig = buildRuntimeConfig(userConfig);
        const result = await query(
            `SELECT * FROM options_trades 
             WHERE user_id = $1 AND status = 'OPEN' 
             ORDER BY entry_date DESC`,
            [userId]
        );
        
        const positions = result.rows;
        
        for (const position of positions) {
            await checkOptionsExit(userId, position, runtimeConfig);
        }
        
        return positions;
    } catch (error) {
        logger.error('[Options Bot] Error monitoring positions', { error: error.message });
        return [];
    }
}

/**
 * Check if options position should be exited
 */
async function checkOptionsExit(userId, position, runtimeConfig) {
    try {
        // Get current options data
        const optionsData = await optionsService.getOptionsWithGreeks(position.symbol);
        if (!optionsData.options || optionsData.options.length === 0) {
            logger.warn('[Options Bot] Skipping exit evaluation because no usable options chain was available', {
                positionId: position.id,
                symbol: position.symbol,
                error: optionsData.error || null,
                warning: optionsData.warning || null,
                cacheSource: optionsData.cache?.source || null,
                cacheAgeMs: optionsData.cache?.ageMs || null
            });
            return;
        }
        const optionType = String(position.option_type || '').toLowerCase();
        let exitSnapshot = null;

        if (position.spread_type) {
            const shortLeg = findMatchingOption(optionsData.options, {
                strike: position.strike,
                expiration: position.expiration,
                optionType
            });
            const longLeg = findMatchingOption(optionsData.options, {
                strike: position.long_strike,
                expiration: position.expiration,
                optionType
            });

            if (!shortLeg || !longLeg) {
                logger.warn('[Options Bot] Could not find current spread leg data', { position: position.id });
                return;
            }

            const closeDebit = Math.max(0, (shortLeg.ask || 0) - (longLeg.bid || 0));
            const entryCredit = parseFloat(position.entry_price);
            exitSnapshot = {
                currentPrice: closeDebit,
                pnl: (entryCredit - closeDebit) * position.contracts * 100,
                pnlPercent: entryCredit > 0 ? ((entryCredit - closeDebit) / entryCredit) * 100 : 0,
                daysToExp: Math.min(shortLeg.daysToExpiration, longLeg.daysToExpiration),
                thetaDecayRatio: 0
            };
        } else {
            const currentOption = findMatchingOption(optionsData.options, {
                strike: position.strike,
                expiration: position.expiration,
                optionType
            });

            if (!currentOption) {
                logger.warn('[Options Bot] Could not find current option data', { position: position.id });
                return;
            }

            const currentPrice = (currentOption.bid + currentOption.ask) / 2;
            const entryPrice = parseFloat(position.entry_price);
            const greeks = getOptionGreeks(currentOption);
            exitSnapshot = {
                currentPrice,
                pnl: (currentPrice - entryPrice) * position.contracts * 100,
                pnlPercent: entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0,
                daysToExp: currentOption.daysToExpiration,
                thetaDecayRatio: currentPrice > 0 ? (Math.abs(greeks.theta) * 7) / currentPrice : 0
            };
        }
        
        let exitReason = null;
        
        // Check take profit
        if (exitSnapshot.pnlPercent >= (runtimeConfig.risk.takeProfit * 100)) {
            exitReason = 'TAKE_PROFIT';
        }
        
        // Check stop loss
        if (exitSnapshot.pnlPercent <= -(runtimeConfig.risk.stopLoss * 100)) {
            exitReason = 'STOP_LOSS';
        }
        
        // Check expiration (close if < 7 days)
        if (exitSnapshot.daysToExp < 7) {
            exitReason = 'EXPIRATION_APPROACHING';
        }
        
        // Check theta decay (close if losing too much to time)
        if (exitSnapshot.thetaDecayRatio > 0.20) { // 20% decay in week
            exitReason = 'HIGH_THETA_DECAY';
        }
        
        if (exitReason) {
            await closeOptionsPosition(userId, position, exitSnapshot, exitReason);
        }
    } catch (error) {
        logger.error('[Options Bot] Error checking exit', { positionId: position.id, error: error.message });
    }
}

/**
 * Close options position
 */
async function closeOptionsPosition(userId, position, exitSnapshot, reason) {
    try {
        const entryPrice = parseFloat(position.entry_price);
        const exitPrice = exitSnapshot.currentPrice;
        const pnl = exitSnapshot.pnl;
        const pnlPercent = exitSnapshot.pnlPercent;
        
        // Update position
        await query(
            `UPDATE options_trades 
             SET status = 'CLOSED', exit_price = $1, exit_date = NOW(), 
                 profit_loss = $2, exit_reason = $3
             WHERE id = $4`,
            [exitPrice, pnl, reason, position.id]
        );
        
        logger.trade('CLOSE_OPTION', position.symbol, position.contracts, exitPrice, {
            entryPrice,
            pnl,
            pnlPercent,
            reason,
            strategy: position.strategy,
            daysHeld: Math.floor((Date.now() - new Date(position.entry_date).getTime()) / (1000 * 60 * 60 * 24))
        });
        
        // Send alert
        await telegramAlertService.alertOptionsPositionClosed(userId, {
            symbol: position.symbol,
            strike: position.strike,
            expiration: position.expiration,
            contracts: position.contracts,
            entryPrice,
            exitPrice,
            pnl,
            pnlPercent,
            reason
        });
        
        // Record performance
        await performanceMetricsService.recordTradePerformance(userId, {
            symbol: position.symbol,
            action: 'SELL',
            quantity: position.contracts,
            price: exitPrice,
            profit_loss: pnl,
            trade_type: 'OPTIONS'
        });

        await tradeIntelligenceService.closeExecutionByRef(userId, {
            tradeRefType: 'options_trade',
            tradeRefId: position.id,
            exitPrice,
            pnl,
            pnlPercent,
            metadata: {
                reason,
                strategy: position.strategy,
                spreadType: position.spread_type || null
            }
        });
        
    } catch (error) {
        logger.error('[Options Bot] Error closing position', { positionId: position.id, error: error.message });
    }
}

// === MAIN BOT LOGIC ===

/**
 * Main options trading scan and execution
 */
async function executeAutonomousOptionsTrading(userId) {
    try {
        logger.info('[Options Bot] Starting scan', { userId });
        const userConfig = await getUserBotConfig(userId);
        const runtimeConfig = buildRuntimeConfig(userConfig);
        await tradeIntelligenceService.ensureTradeIntelligenceSchema();

        if (!userConfig.enabled) {
            logger.info('[Options Bot] User config disabled', { userId });
            return;
        }

        if (!isWithinTradingWindow(runtimeConfig)) {
            logger.info('[Options Bot] Outside trading window', {
                userId,
                startTime: runtimeConfig.trading.startTime,
                endTime: runtimeConfig.trading.endTime
            });
            return;
        }
        
        // Get account info
        const account = await tradingAccountService.getTradingAccount(userId);
        if (account.balance < BOT_CONFIG.minAccountBalance) {
            logger.warn('[Options Bot] Account balance too low', { 
                balance: account.balance, 
                required: BOT_CONFIG.minAccountBalance 
            });
            return;
        }
        
        // Check daily loss limit
        const todayLoss = await performanceMetricsService.getTodayLoss(userId);
        if (todayLoss && Math.abs(todayLoss) >= runtimeConfig.risk.maxDailyLoss) {
            logger.warn('[Options Bot] Daily loss limit reached', { loss: todayLoss });
            await telegramAlertService.alertDailyLossLimitReached(userId, todayLoss);
            return;
        }
        
        // Check open positions count
        const openPositions = await monitorOptionsPositions(userId);
        if (openPositions.length >= runtimeConfig.maxOpenPositions) {
            logger.info('[Options Bot] Max positions reached', { count: openPositions.length });
            return;
        }
        
        // Get VIX, market regime, and ATLAS global sentiment in parallel
        const [vix, marketRegime, globalSentiment] = await Promise.all([
            getVixLevel(),
            marketRegimeService.getMarketRegime(),
            globalSentimentService.getGlobalSentiment().catch(() => null)
        ]);

        // Unify VIX: prefer ATLAS level (same dataProvider cache, avoids duplicate fetch)
        const atlasVix = globalSentiment?.rawData?.vixLevel;
        if (atlasVix && atlasVix > 0) {
            vix.value  = atlasVix;
            vix.regime = atlasVix < 15 ? 'LOW' : atlasVix < 25 ? 'NORMAL' : atlasVix < 35 ? 'HIGH' : 'EXTREME';
        }

        logger.info('[Options Bot] Market context', {
            vix: vix.value,
            vixRegime: vix.regime,
            marketRegime: marketRegime.regime,
            atlasLabel: globalSentiment?.label || 'unavailable',
            atlasScore: globalSentiment?.globalScore != null ? globalSentiment.globalScore.toFixed(2) : null
        });
        
        // VIX Spike guard — halt new options entries on EXTREME or PANIC spikes.
        // Options are especially sensitive to fast VIX moves: IV crush risk + wide spreads.
        const spikeState = vixMonitor.getSpikeState();
        if (spikeState.spikeActive && (spikeState.level === 'EXTREME' || spikeState.level === 'PANIC')) {
            logger.warn('[Options Bot] VIX spike halt — skipping new options entries', {
                userId, level: spikeState.level,
                vix: spikeState.vixAtSpike, pctChange: spikeState.pctChange?.toFixed(1)
            });
            return {
                success: false,
                message: `Options halted — VIX spike (${spikeState.level}, VIX ${spikeState.vixAtSpike?.toFixed(1)})`
            };
        }

        // Build universe from nightly scan STRONG BUY signals with good options liquidity.
        // Falls back to the liquid-stock default list if the scan produced no results.
        // Option-eligible = large-cap with active options markets (price >$20, mkt cap >$2B).
        let universe = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'AMD', 'META', 'TSLA', 'PANW'];
        try {
            const { query: dbQuery } = require('../config/database');
            const scanRes = await dbQuery(`
                SELECT symbol, ai_score, recommendation
                FROM daily_universe_analysis
                WHERE analysis_date >= CURRENT_DATE - INTERVAL '2 days'
                  AND analysis_date = (
                      SELECT MAX(analysis_date) FROM daily_universe_analysis
                      WHERE analysis_date >= CURRENT_DATE - INTERVAL '2 days'
                  )
                  AND recommendation IN ('STRONG BUY','BUY')
                  AND ai_score >= 75
                ORDER BY ai_score DESC
                LIMIT 20
            `);
            if (scanRes.rows.length >= 3) {
                universe = scanRes.rows.map(r => r.symbol);
                logger.info('[Options Bot] Universe loaded from nightly scan', {
                    count: universe.length, topPick: universe[0]
                });
            }
        } catch (_) { /* keep default universe on DB error */ }

        // Store scan signals for direction override below
        const scanSignalMap = {};
        try {
            const { query: dbQuery } = require('../config/database');
            const sigs = await dbQuery(`
                SELECT symbol, ai_score, recommendation
                FROM daily_universe_analysis
                WHERE analysis_date >= CURRENT_DATE - INTERVAL '2 days'
                  AND analysis_date = (SELECT MAX(analysis_date) FROM daily_universe_analysis WHERE analysis_date >= CURRENT_DATE - INTERVAL '2 days')
            `);
            sigs.rows.forEach(r => { scanSignalMap[r.symbol] = r; });
        } catch (_) {}

        // Analyze each stock
        const opportunities = {
            scalps: [],
            swings: [],
            spreads: []
        };
        
        for (const symbol of universe) {
            const stockAnalysis = await analyzeStockForOptions(symbol);
            if (!stockAnalysis) continue;
            if (stockAnalysis.analysis.liquidityScore < runtimeConfig.minimums.liquidityScore) continue;
            
            const optionsData = stockAnalysis.optionsData;
            if (!optionsData.options || optionsData.options.length === 0) continue;
            
            // Use IV Rank to bias strategy selection
            // HIGH IV (>70)  → Prefer credit spreads (sell expensive premium)
            // LOW  IV (<30)  → Prefer directional / scalps (buy cheap premium)
            // NORMAL         → All strategies eligible
            const ivBias = stockAnalysis.ivRank?.strategyBias || 'NEUTRAL';
            const debitStrategiesEnabled = ivBias !== 'SELL_PREMIUM';
            const creditStrategiesEnabled = ivBias !== 'BUY_OPTIONS';

            logger.info('[Options Bot] IV Rank strategy bias', {
                symbol,
                ivRank: stockAnalysis.ivRank?.ivRank,
                ivBias
            });

            // Find opportunities for each strategy (gated by IV Rank)
            const commonFields = {
                underlyingMomentum: stockAnalysis.momentum,
                underlyingPrice: stockAnalysis.stockPrice,
                ivRankLabel: stockAnalysis.ivRank?.ivRankLabel || 'NORMAL',
                ivRankNumeric: stockAnalysis.ivRank?.ivRank ?? null,
                liquidityScore: stockAnalysis.analysis.liquidityScore
            };

            if (runtimeConfig.strategies.deltaNeutralScalping.enabled && debitStrategiesEnabled) {
                const scalps = await findDeltaNeutralScalps(symbol, stockAnalysis, optionsData);
                opportunities.scalps.push(...scalps.map((opp) => ({ ...opp, ...commonFields })));
            }

            if (runtimeConfig.strategies.directionalSwing.enabled && debitStrategiesEnabled) {
                const scanSig = scanSignalMap[symbol] || null;
                const swings = await findDirectionalSwings(symbol, stockAnalysis, optionsData, scanSig);
                opportunities.swings.push(...swings.map((opp) => ({ ...opp, ...commonFields })));
            }

            if (runtimeConfig.strategies.creditSpreads.enabled && creditStrategiesEnabled) {
                const spreads = await findCreditSpreads(symbol, stockAnalysis, optionsData);
                if (ivBias === 'SELL_PREMIUM') {
                    spreads.forEach(s => { s.spreadScore = (s.spreadScore || 50) + 15; s.ivBoost = true; });
                }
                opportunities.spreads.push(...spreads.map((opp) => ({ ...opp, ...commonFields })));
            }

            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        
        logger.info('[Options Bot] Opportunities found', {
            scalps: opportunities.scalps.length,
            swings: opportunities.swings.length,
            spreads: opportunities.spreads.length
        });
        
        // Execute trades (respect position limits)
        const positionsToOpen = runtimeConfig.maxOpenPositions - openPositions.length;
        let tradesExecuted = 0;
        const openSymbols = new Set(openPositions.map(position => position.symbol));
        const selectedSymbols = new Set();
        
        // Prioritize by strategy allocation and scores
        const allOpportunities = [
            ...opportunities.scalps.map(o => ({ ...o, strategy: 'deltaNeutralScalping', score: o.scalperScore })),
            ...opportunities.swings.map(o => ({ ...o, strategy: 'directionalSwing', score: o.swingScore })),
            ...opportunities.spreads.map(o => ({ ...o, strategy: 'creditSpreads', score: o.spreadScore }))
        ];

        const intelligenceAdjusted = await Promise.all(
            allOpportunities.map(async (opp) => {
                const setupFamily = deriveOptionsSetupFamily(opp.strategy, opp);
                const regimeAdjustment = getOptionsRegimeAdjustment(opp.strategy, marketRegime.regime, opp, globalSentiment);
                const expectancyStats = await tradeIntelligenceService.getExpectancyAdjustment({
                    botType: 'options',
                    strategyFamily: opp.strategy,
                    setupFamily,
                    regime: marketRegime.regime
                });
                const intelligenceScoreAdjustment = regimeAdjustment.scoreAdjustment + expectancyStats.scoreAdjustment;
                const intelligenceSizeMultiplier = regimeAdjustment.sizeMultiplier * (expectancyStats.sizeMultiplier || 1);

                return {
                    ...opp,
                    setupFamily,
                    regime: marketRegime.regime,
                    expectancyStats,
                    intelligenceScoreAdjustment,
                    intelligenceSizeMultiplier,
                    minimumScore: runtimeConfig.minimums.opportunityScore + regimeAdjustment.thresholdAdjustment,
                    score: Number((opp.score + intelligenceScoreAdjustment).toFixed(2))
                };
            })
        );

        await Promise.all(
            intelligenceAdjusted
                .filter((opp) => opp.score >= opp.minimumScore)
                .slice(0, 12)
                .map((opp) => tradeIntelligenceService.recordCandidate(userId, {
                    botType: 'options',
                    symbol: opp.symbol,
                    setupFamily: opp.setupFamily,
                    strategyFamily: opp.strategy,
                    regime: opp.regime,
                    score: opp.score,
                    scoreAdjustment: opp.intelligenceScoreAdjustment,
                    sizeMultiplier: opp.intelligenceSizeMultiplier,
                    expectancy: opp.expectancyStats?.expectancy,
                    confidence: opp.expectancyStats?.confidence,
                    metadata: {
                        baseScore: opp.scalperScore || opp.swingScore || opp.spreadScore || 0,
                        ivRankLabel: opp.ivRankLabel,
                        underlyingMomentum: opp.underlyingMomentum,
                        liquidityScore: opp.liquidityScore,
                        type: opp.type || null,
                        atlasLabel: globalSentiment?.label || null,
                        atlasScore: globalSentiment?.globalScore ?? null
                    }
                }))
        );

        const qualifiedOpportunities = intelligenceAdjusted
            .filter((opp) => opp.score >= opp.minimumScore)
            .filter((opp) => !openSymbols.has(opp.symbol))
            .sort((a, b) => b.score - a.score);
        
        for (const opp of qualifiedOpportunities) {
            if (tradesExecuted >= positionsToOpen) break;
            if (selectedSymbols.has(opp.symbol)) continue;
            
            const contracts = calculateOptionsPositionSize(opp, account.balance, opp.strategy, runtimeConfig);
            const adjustedContracts = Math.max(1, Math.floor(contracts * (opp.intelligenceSizeMultiplier || 1)));
            await executeOptionsTrade(userId, opp, opp.strategy, adjustedContracts);
            tradesExecuted++;
            selectedSymbols.add(opp.symbol);
        }
        
        logger.info('[Options Bot] Scan complete', { 
            tradesExecuted,
            openPositions: openPositions.length + tradesExecuted
        });
        
    } catch (error) {
        logger.error('[Options Bot] Error in autonomous trading', { error: error.message });
    }
}

module.exports = {
    executeAutonomousOptionsTrading,
    monitorOptionsPositions,
    getVixLevel,
    BOT_CONFIG
};
