/**
 * Enhanced Signal Service with Multi-Indicator Confluence
 * Provides high-confidence trading signals with comprehensive analysis
 */

const stockDataService = require('./stockDataService');
const cacheService = require('./cacheService');
const {
    calculateRSI,
    calculateMACD,
    detectSupportResistance,
    detectRSIDivergence,
    calculateAverageVolume,
    detectVolumeSpikes,
    detectPatterns,
    calculateRiskReward,
    calculateATR
} = require('./technicalIndicators');

/**
 * Calculate EMA
 */
const calculateEMA = (data, period) => {
    if (data.length < period) return [];
    const multiplier = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((sum, d) => sum + d.close, 0) / period;
    const result = [{ time: data[period - 1].time, value: ema }];
    
    for (let i = period; i < data.length; i++) {
        ema = (data[i].close - ema) * multiplier + ema;
        result.push({ time: data[i].time, value: ema });
    }
    return result;
};

/**
 * Get Enhanced Signals with Multi-Indicator Confluence
 */
const getEnhancedSignals = async (symbol, interval = '1d', options = {}) => {
    const {
        shortPeriod = 5,
        longPeriod = 15,
        includePatterns = true,
        includeDivergence = true,
        minConfluence = 3 // Minimum number of indicators that must agree
    } = options;
    
    // Check cache
    const cacheKey = `enhanced:${symbol}:${interval}:${shortPeriod}:${longPeriod}`;
    const cached = cacheService.get(cacheKey);
    if (cached) {
        console.log(`[Enhanced Signal Service] Using cached enhanced signals for ${symbol}`);
        return cached;
    }
    
    console.log(`[Enhanced Signal Service] Calculating enhanced signals for ${symbol} on ${interval}`);
    
    // Fetch data
    const data = await stockDataService.getStockData(symbol, interval);
    if (data.length < Math.max(longPeriod, 50)) {
        console.log(`[Enhanced Signal Service] Insufficient data for ${symbol}: ${data.length} points`);
        return { signals: [], metadata: {} };
    }
    
    // Fetch VIX
    const vixQuote = await stockDataService.getCurrentPrice('^VIX');
    const vix = typeof vixQuote === 'number' ? vixQuote : null;
    
    // Calculate all indicators
    const emaShort = calculateEMA(data, shortPeriod);
    const emaLong = calculateEMA(data, longPeriod);
    const rsi = calculateRSI(data, 14);
    const macd = calculateMACD(data, 12, 26, 9);
    const atr = calculateATR(data, 14);
    const { support, resistance } = detectSupportResistance(data, 50);
    const volumeSpikes = detectVolumeSpikes(data, 1.5, 20);
    const avgVolume = calculateAverageVolume(data, 20);
    
    let patterns = [];
    let divergences = [];
    
    if (includePatterns) {
        patterns = detectPatterns(data, 30);
    }
    
    if (includeDivergence && rsi.length > 0) {
        divergences = detectRSIDivergence(data, rsi, 14);
    }
    
    // Generate confluence-based signals
    const signals = [];
    const emaShortOffset = emaShort.length - emaLong.length;
    
    for (let i = 1; i < emaLong.length; i++) {
        const dataIndex = data.length - emaLong.length + i;
        const currentData = data[dataIndex];
        
        const prevEmaShort = emaShort[i + emaShortOffset - 1].value;
        const prevEmaLong = emaLong[i - 1].value;
        const currentEmaShort = emaShort[i + emaShortOffset].value;
        const currentEmaLong = emaLong[i].value;
        
        const rsiValue = rsi[dataIndex] ? rsi[dataIndex].value : null;
        const macdValue = macd[dataIndex] ? macd[dataIndex] : null;
        const currentATR = atr[dataIndex] ? atr[dataIndex].value : null;
        const currentVolume = currentData.volume || 0;
        const volumeRatio = currentVolume / avgVolume;
        
        // Check for EMA crossover
        const emaBullish = prevEmaShort <= prevEmaLong && currentEmaShort > currentEmaLong;
        const emaBearish = prevEmaShort >= prevEmaLong && currentEmaShort < currentEmaLong;
        
        if (emaBullish || emaBearish) {
            const isBuy = emaBullish;
            let confluenceScore = 0;
            let confluenceReasons = [];
            
            // 1. EMA Crossover (base signal)
            confluenceScore++;
            confluenceReasons.push(isBuy ? 'EMA Bullish Cross' : 'EMA Bearish Cross');
            
            // 2. RSI Confirmation
            if (rsiValue !== null) {
                if (isBuy && rsiValue < 70 && rsiValue > 30) {
                    confluenceScore++;
                    confluenceReasons.push(`RSI ${rsiValue.toFixed(1)} (not overbought)`);
                } else if (!isBuy && rsiValue > 30 && rsiValue < 70) {
                    confluenceScore++;
                    confluenceReasons.push(`RSI ${rsiValue.toFixed(1)} (not oversold)`);
                } else if (isBuy && rsiValue < 30) {
                    confluenceScore += 1.5;
                    confluenceReasons.push(`RSI ${rsiValue.toFixed(1)} (oversold - strong)`);
                } else if (!isBuy && rsiValue > 70) {
                    confluenceScore += 1.5;
                    confluenceReasons.push(`RSI ${rsiValue.toFixed(1)} (overbought - strong)`);
                }
            }
            
            // 3. MACD Confirmation
            if (macdValue && macdValue.histogram) {
                if (isBuy && macdValue.histogram > 0) {
                    confluenceScore++;
                    confluenceReasons.push('MACD Positive');
                } else if (!isBuy && macdValue.histogram < 0) {
                    confluenceScore++;
                    confluenceReasons.push('MACD Negative');
                }
            }
            
            // 4. Volume Confirmation
            if (volumeRatio > 1.5) {
                confluenceScore++;
                confluenceReasons.push(`Volume ${volumeRatio.toFixed(1)}x avg`);
            }
            
            // 5. Support/Resistance Confirmation
            const nearSupport = support.some(s => Math.abs(currentData.close - s.price) / s.price < 0.02);
            const nearResistance = resistance.some(r => Math.abs(currentData.close - r.price) / r.price < 0.02);
            
            if (isBuy && nearSupport) {
                confluenceScore++;
                confluenceReasons.push('Near Support');
            } else if (!isBuy && nearResistance) {
                confluenceScore++;
                confluenceReasons.push('Near Resistance');
            }
            
            // 6. VIX Adjustment
            let vixImpact = 0;
            if (vix !== null) {
                if (isBuy && vix > 25) {
                    confluenceScore -= 0.5;
                    vixImpact = -10;
                    confluenceReasons.push(`VIX ${vix.toFixed(1)} (high fear)`);
                } else if (!isBuy && vix > 25) {
                    confluenceScore += 0.5;
                    vixImpact = 10;
                    confluenceReasons.push(`VIX ${vix.toFixed(1)} (high fear)`);
                } else if (vix < 15) {
                    confluenceReasons.push(`VIX ${vix.toFixed(1)} (low fear)`);
                }
            }
            
            // Calculate confidence percentage (0-100)
            const maxPossibleScore = 6;
            let confidence = Math.min(100, (confluenceScore / maxPossibleScore) * 100);
            
            // Only include signals with minimum confluence
            if (confluenceScore >= minConfluence) {
                // Calculate risk/reward if ATR available
                let riskReward = null;
                if (currentATR) {
                    riskReward = calculateRiskReward(
                        currentData.close,
                        isBuy ? 'buy' : 'sell',
                        currentATR,
                        2 // 1:2 risk/reward ratio
                    );
                }
                
                signals.push({
                    time: currentData.time,
                    position: isBuy ? 'belowBar' : 'aboveBar',
                    color: isBuy ? '#00E676' : '#FF1744',
                    shape: isBuy ? 'arrowUp' : 'arrowDown',
                    type: isBuy ? 'BUY' : 'SELL',
                    price: currentData.close,
                    confidence: confidence.toFixed(1),
                    confluenceScore: confluenceScore.toFixed(1),
                    maxScore: maxPossibleScore,
                    confluenceReasons,
                    indicators: {
                        rsi: rsiValue ? rsiValue.toFixed(1) : null,
                        macd: macdValue ? macdValue.histogram.toFixed(2) : null,
                        volume: currentVolume,
                        volumeRatio: volumeRatio.toFixed(2),
                        vix: vix ? vix.toFixed(2) : null
                    },
                    riskReward,
                    nearSupport: isBuy && nearSupport,
                    nearResistance: !isBuy && nearResistance
                });
            }
        }
    }
    
    // Add pattern signals
    const patternSignals = patterns.map(p => ({
        time: p.time,
        type: 'PATTERN',
        pattern: p.type,
        confidence: p.confidence,
        bullish: p.bullish,
        bearish: p.bearish,
        position: 'inBar',
        color: p.bullish ? '#4CAF50' : '#F44336',
        shape: 'square'
    }));
    
    // Add divergence signals
    const divergenceSignals = divergences.map(d => ({
        time: d.time,
        type: 'DIVERGENCE',
        divergenceType: d.type,
        strength: d.strength.toFixed(1),
        position: d.type === 'bullish' ? 'belowBar' : 'aboveBar',
        color: d.type === 'bullish' ? '#2196F3' : '#FF9800',
        shape: 'circle'
    }));
    
    const result = {
        signals: signals.sort((a, b) => a.time - b.time),
        patterns: patternSignals,
        divergences: divergenceSignals,
        metadata: {
            symbol,
            interval,
            totalSignals: signals.length,
            avgConfidence: signals.length > 0 
                ? (signals.reduce((sum, s) => sum + parseFloat(s.confidence), 0) / signals.length).toFixed(1)
                : 0,
            support,
            resistance,
            currentVIX: vix,
            avgVolume: avgVolume.toFixed(0),
            recentVolumeSpikes: volumeSpikes.slice(-5)
        }
    };
    
    // Cache for 5 minutes
    cacheService.set(cacheKey, result, 5 * 60 * 1000);
    
    console.log(`[Enhanced Signal Service] Generated ${signals.length} high-confidence signals for ${symbol}`);
    return result;
};

/**
 * Get Multi-Timeframe Analysis
 */
const getMultiTimeframeAnalysis = async (symbol) => {
    const timeframes = ['1d', '1wk', '1mo'];
    const analyses = {};
    
    for (const tf of timeframes) {
        try {
            const result = await getEnhancedSignals(symbol, tf, { minConfluence: 3 });
            const lastSignal = result.signals.length > 0 ? result.signals[result.signals.length - 1] : null;
            
            analyses[tf] = {
                signal: lastSignal ? lastSignal.type : 'HOLD',
                confidence: lastSignal ? lastSignal.confidence : 0,
                confluenceScore: lastSignal ? lastSignal.confluenceScore : 0
            };
        } catch (error) {
            console.error(`[Enhanced Signal Service] Error analyzing ${tf} for ${symbol}:`, error);
            analyses[tf] = { signal: 'ERROR', confidence: 0 };
        }
    }
    
    // Calculate alignment score
    const signals = Object.values(analyses).map(a => a.signal);
    const buyCount = signals.filter(s => s === 'BUY').length;
    const sellCount = signals.filter(s => s === 'SELL').length;
    
    let alignment = 'MIXED';
    let alignmentStrength = 0;
    
    if (buyCount === 3) {
        alignment = 'STRONG BUY';
        alignmentStrength = 100;
    } else if (buyCount === 2) {
        alignment = 'BUY';
        alignmentStrength = 70;
    } else if (sellCount === 3) {
        alignment = 'STRONG SELL';
        alignmentStrength = 100;
    } else if (sellCount === 2) {
        alignment = 'SELL';
        alignmentStrength = 70;
    } else {
        alignmentStrength = 30;
    }
    
    return {
        symbol,
        timeframes: analyses,
        alignment,
        alignmentStrength,
        recommendation: alignmentStrength >= 70 ? alignment : 'HOLD'
    };
};

module.exports = {
    getEnhancedSignals,
    getMultiTimeframeAnalysis
};
