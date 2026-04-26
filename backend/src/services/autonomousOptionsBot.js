const optionsService = require('./optionsService');
const tradingAccountService = require('./tradingAccountService');
const logger = require('../utils/logger');
const telegramAlertService = require('./telegramAlertService');
const performanceMetricsService = require('./performanceMetricsService');
const { query } = require('../config/database');
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

// === MARKET DATA & ANALYSIS ===

/**
 * Get current VIX level for volatility assessment
 */
async function getVixLevel() {
    try {
        const vixData = await yahooFinance.quote('^VIX');
        const vixLevel = vixData.regularMarketPrice;
        
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
async function calculateIVRank(symbol) {
    try {
        const [optionsData, chart52w] = await Promise.all([
            optionsService.getOptionsWithGreeks(symbol),
            yahooFinance.chart(symbol, {
                period1: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                interval: '1wk'
            })
        ]);

        if (!optionsData.options || optionsData.options.length === 0) {
            return null;
        }

        // Current IV: average of near-ATM options (delta 0.40 – 0.60)
        const atmOptions = optionsData.options
            .filter(opt => {
                const d = Math.abs(opt.greeks?.delta || 0);
                return d >= 0.40 && d <= 0.60 && (opt.greeks?.impliedVolatility || 0) > 0;
            })
            .slice(0, 10);

        if (atmOptions.length === 0) return null;

        const currentIV = atmOptions.reduce((sum, opt) => sum + opt.greeks.impliedVolatility, 0) / atmOptions.length;

        // Estimate 52-week IV range using historical realized volatility (weekly returns)
        const closes = chart52w.quotes.map(q => q.close).filter(c => c != null && c > 0);
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
        const quote = await yahooFinance.quote(symbol);
        
        // Check basic requirements
        if (!quote.regularMarketPrice || quote.regularMarketPrice < BOT_CONFIG.liquidity.minStockPrice) {
            return null;
        }
        
        const marketCap = quote.marketCap ? quote.marketCap / 1000000 : 0;
        if (marketCap < BOT_CONFIG.liquidity.minMarketCap) {
            return null;
        }
        
        // Get options chain
        const optionsData = await optionsService.getOptionsWithGreeks(symbol);
        if (!optionsData.options || optionsData.options.length === 0) {
            return null;
        }
        
        // Calculate IV Rank
        const ivRank = await calculateIVRank(symbol);
        
        // Get stock momentum (using recent price action)
        const historical = await yahooFinance.historical(symbol, {
            period1: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            period2: new Date()
        });
        
        const prices = historical.map(h => h.close);
        const momentum = prices.length > 0 
            ? ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100 
            : 0;
        
        return {
            symbol,
            stockPrice: quote.regularMarketPrice,
            marketCap,
            volume: quote.regularMarketVolume,
            momentum,
            ivRank,
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
            const delta = Math.abs(opt.greeks.delta);
            const gamma = opt.greeks.gamma;
            const vega = opt.greeks.vega;
            const theta = opt.greeks.theta;
            
            // ATM options with high gamma
            return (
                delta >= criteria.targetDelta - criteria.deltaRange &&
                delta <= criteria.targetDelta + criteria.deltaRange &&
                gamma >= criteria.minGamma &&
                vega >= criteria.minVega &&
                theta >= criteria.maxTheta && // Less negative is better
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
    
    // Gamma weight (40%) - Higher gamma = faster profits
    score += (option.greeks.gamma / 0.15) * 40;
    
    // Vega weight (30%) - Higher vega = profit from vol spikes
    score += (option.greeks.vega / 0.30) * 30;
    
    // Liquidity weight (20%)
    const spreadPercent = (option.ask - option.bid) / option.ask;
    score += (1 - spreadPercent / BOT_CONFIG.liquidity.maxBidAskSpread) * 20;
    
    // Theta penalty (10%) - Less theta decay is better
    const thetaScore = Math.max(0, 1 + (option.greeks.theta / 1.0));
    score += thetaScore * 10;
    
    return Math.min(100, Math.max(0, score));
}

/**
 * Find directional swing opportunities
 * Strategy: Buy ITM options with momentum in favorable direction
 */
async function findDirectionalSwings(symbol, stockAnalysis, optionsData) {
    try {
        const criteria = BOT_CONFIG.greeksThresholds.directionalSwing;
        const bullish = stockAnalysis.momentum > 2; // Positive momentum
        
        const opportunities = optionsData.options.filter(opt => {
            const delta = opt.greeks.delta;
            const gamma = opt.greeks.gamma;
            const vega = opt.greeks.vega;
            const theta = opt.greeks.theta;
            
            // For bullish: calls with high positive delta
            // For bearish: puts with high negative delta
            const deltaCheck = bullish 
                ? (delta >= criteria.minDelta && delta <= criteria.maxDelta)
                : (delta <= -criteria.minDelta && delta >= -criteria.maxDelta);
            
            return (
                deltaCheck &&
                gamma >= criteria.minGamma &&
                vega >= criteria.minVega &&
                theta >= criteria.maxTheta &&
                opt.volume >= BOT_CONFIG.liquidity.minVolume &&
                opt.openInterest >= BOT_CONFIG.liquidity.minOpenInterest &&
                opt.daysToExpiration >= 14 &&
                opt.daysToExpiration <= 45
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
    
    // Delta alignment (40%)
    const delta = Math.abs(option.greeks.delta);
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
                
                if (shortCall.greeks.delta <= criteria.shortDelta &&
                    longCall.greeks.delta <= criteria.longDelta &&
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
function calculateOptionsPositionSize(option, accountBalance, strategy) {
    try {
        const maxRiskAmount = accountBalance * BOT_CONFIG.maxPositionRisk;
        
        if (strategy === 'creditSpreads') {
            // For spreads, risk is max loss
            const contracts = Math.floor(maxRiskAmount / (option.maxRisk * 100));
            return Math.max(1, Math.min(contracts, 10)); // 1-10 contracts
        }
        
        // For long options, risk is premium paid
        const optionPrice = (option.bid + option.ask) / 2;
        const contracts = Math.floor(maxRiskAmount / (optionPrice * 100));
        
        // Adjust for delta exposure
        const deltaAdjusted = Math.abs(option.greeks.delta) * contracts;
        
        // Don't exceed equivalent of 500 shares
        const maxContracts = Math.floor(500 / (Math.abs(option.greeks.delta) * 100));
        
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
                opportunity.expirationDate,
                opportunity.optionType.toUpperCase(),
                'BUY',
                contracts,
                entryPrice,
                strategy,
                'OPEN',
                JSON.stringify(opportunity.greeks)
            ]
        );
        
        const trade = result.rows[0];
        
        // Log trade
        logger.trade('BUY', opportunity.symbol, contracts, entryPrice, {
            type: 'OPTIONS',
            strike: opportunity.strike,
            expiration: opportunity.expirationDate,
            optionType: opportunity.optionType,
            strategy,
            greeks: opportunity.greeks,
            score: opportunity.scalperScore || opportunity.swingScore || 0
        });
        
        // Send Telegram alert
        await telegramAlertService.alertOptionsTradeExecuted(userId, {
            action: 'BUY',
            symbol: opportunity.symbol,
            contracts,
            strike: opportunity.strike,
            expiration: opportunity.expirationDate,
            optionType: opportunity.optionType,
            price: entryPrice,
            totalCost,
            strategy,
            greeks: opportunity.greeks
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
        const result = await query(
            `SELECT * FROM options_trades 
             WHERE user_id = $1 AND status = 'OPEN' 
             ORDER BY entry_date DESC`,
            [userId]
        );
        
        const positions = result.rows;
        
        for (const position of positions) {
            await checkOptionsExit(userId, position);
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
async function checkOptionsExit(userId, position) {
    try {
        // Get current options data
        const optionsData = await optionsService.getOptionsWithGreeks(position.symbol);
        
        // Find matching option
        const currentOption = optionsData.options.find(opt =>
            opt.strike === parseFloat(position.strike) &&
            opt.expirationDate === position.expiration &&
            opt.optionType === position.option_type.toLowerCase()
        );
        
        if (!currentOption) {
            logger.warn('[Options Bot] Could not find current option data', { position: position.id });
            return;
        }
        
        const currentPrice = (currentOption.bid + currentOption.ask) / 2;
        const entryPrice = parseFloat(position.entry_price);
        const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
        
        let exitReason = null;
        
        // Check take profit
        if (pnlPercent >= (BOT_CONFIG.risk.takeProfit * 100)) {
            exitReason = 'TAKE_PROFIT';
        }
        
        // Check stop loss
        if (pnlPercent <= -(BOT_CONFIG.risk.stopLoss * 100)) {
            exitReason = 'STOP_LOSS';
        }
        
        // Check expiration (close if < 7 days)
        const daysToExp = currentOption.daysToExpiration;
        if (daysToExp < 7) {
            exitReason = 'EXPIRATION_APPROACHING';
        }
        
        // Check theta decay (close if losing too much to time)
        const thetaDecay = Math.abs(currentOption.greeks.theta) * 7; // 7-day theta
        if (thetaDecay / currentPrice > 0.20) { // 20% decay in week
            exitReason = 'HIGH_THETA_DECAY';
        }
        
        if (exitReason) {
            await closeOptionsPosition(userId, position, currentPrice, exitReason);
        }
    } catch (error) {
        logger.error('[Options Bot] Error checking exit', { positionId: position.id, error: error.message });
    }
}

/**
 * Close options position
 */
async function closeOptionsPosition(userId, position, exitPrice, reason) {
    try {
        const entryPrice = parseFloat(position.entry_price);
        const pnl = (exitPrice - entryPrice) * position.contracts * 100;
        const pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
        
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
        if (todayLoss && Math.abs(todayLoss) >= BOT_CONFIG.risk.maxDailyLoss) {
            logger.warn('[Options Bot] Daily loss limit reached', { loss: todayLoss });
            await telegramAlertService.alertDailyLossLimitReached(userId, todayLoss);
            return;
        }
        
        // Check open positions count
        const openPositions = await monitorOptionsPositions(userId);
        if (openPositions.length >= BOT_CONFIG.maxOpenPositions) {
            logger.info('[Options Bot] Max positions reached', { count: openPositions.length });
            return;
        }
        
        // Get VIX level
        const vix = await getVixLevel();
        logger.info('[Options Bot] Market volatility', { vix: vix.value, regime: vix.regime });
        
        // Get trading universe (liquid stocks)
        const universe = [
            'SPY', 'QQQ', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'NVDA', 'META', 
            'AMD', 'NFLX', 'JPM', 'BAC', 'XLF', 'XLE', 'GLD'
        ];
        
        // Analyze each stock
        const opportunities = {
            scalps: [],
            swings: [],
            spreads: []
        };
        
        for (const symbol of universe) {
            const stockAnalysis = await analyzeStockForOptions(symbol);
            if (!stockAnalysis) continue;
            
            const optionsData = await optionsService.getOptionsWithGreeks(symbol);
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
            if (BOT_CONFIG.strategies.deltaNeutralScalping.enabled && debitStrategiesEnabled) {
                const scalps = await findDeltaNeutralScalps(symbol, stockAnalysis, optionsData);
                opportunities.scalps.push(...scalps);
            }

            if (BOT_CONFIG.strategies.directionalSwing.enabled && debitStrategiesEnabled) {
                const swings = await findDirectionalSwings(symbol, stockAnalysis, optionsData);
                opportunities.swings.push(...swings);
            }

            if (BOT_CONFIG.strategies.creditSpreads.enabled && creditStrategiesEnabled) {
                const spreads = await findCreditSpreads(symbol, stockAnalysis, optionsData);
                // Boost score for credit spreads when IV is high (ideal conditions)
                if (ivBias === 'SELL_PREMIUM') {
                    spreads.forEach(s => { s.score = (s.score || 50) + 15; s.ivBoost = true; });
                }
                opportunities.spreads.push(...spreads);
            }
        }
        
        logger.info('[Options Bot] Opportunities found', {
            scalps: opportunities.scalps.length,
            swings: opportunities.swings.length,
            spreads: opportunities.spreads.length
        });
        
        // Execute trades (respect position limits)
        const positionsToOpen = BOT_CONFIG.maxOpenPositions - openPositions.length;
        let tradesExecuted = 0;
        
        // Prioritize by strategy allocation and scores
        const allOpportunities = [
            ...opportunities.scalps.map(o => ({ ...o, strategy: 'deltaNeutralScalping', score: o.scalperScore })),
            ...opportunities.swings.map(o => ({ ...o, strategy: 'directionalSwing', score: o.swingScore })),
            ...opportunities.spreads.map(o => ({ ...o, strategy: 'creditSpreads', score: o.spreadScore }))
        ].sort((a, b) => b.score - a.score);
        
        for (const opp of allOpportunities) {
            if (tradesExecuted >= positionsToOpen) break;
            
            const contracts = calculateOptionsPositionSize(opp, account.balance, opp.strategy);
            await executeOptionsTrade(userId, opp, opp.strategy, contracts);
            tradesExecuted++;
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
