const stockDataService = require('./stockDataService');
const { calculateSimpleADX } = require('./technicalIndicators'); // dependency-free — safe to require

/**
 * Detects technical chart patterns.
 * @param {string} symbol - Stock symbol
 * @param {string} interval - Timeframe interval
 * @returns {Promise<Object>} Detected patterns
 */
const detectPatterns = async (symbol, interval = '1d') => {
    const data = await stockDataService.getStockData(symbol, interval);
    
    if (data.length < 50) {
        return { error: 'Insufficient data for pattern detection' };
    }

    const patterns = [];

    // Detect various patterns
    patterns.push(...detectDoubleTop(data));
    patterns.push(...detectDoubleBottom(data));
    patterns.push(...detectHeadAndShoulders(data));
    patterns.push(...detectBreakouts(data));
    patterns.push(...detectReversals(data));
    patterns.push(...detectTriangles(data));

    return {
        patterns: patterns.slice(-10), // Return last 10 patterns
        summary: summarizePatterns(patterns),
        alerts: generatePatternAlerts(patterns)
    };
};

/**
 * Detects double top pattern (bearish reversal).
 */
const detectDoubleTop = (data) => {
    const patterns = [];
    const tolerance = 0.02; // 2% tolerance

    for (let i = 20; i < data.length - 10; i++) {
        const peaks = findLocalPeaks(data.slice(i - 20, i + 10), 3);
        
        if (peaks.length >= 2) {
            const [peak1, peak2] = peaks.slice(-2);
            const priceDiff = Math.abs(peak1.price - peak2.price) / peak1.price;
            
            if (priceDiff < tolerance && peak2.index > peak1.index) {
                // Check for lower valley between peaks
                const valley = findLowestPoint(data.slice(peak1.index, peak2.index));
                
                if (valley.price < Math.min(peak1.price, peak2.price) * 0.95) {
                    patterns.push({
                        type: 'Double Top',
                        signal: 'Bearish',
                        strength: 'Strong',
                        time: data[i].time,
                        price: data[i].close,
                        description: 'Bearish reversal pattern detected. Consider selling or shorting.',
                        confidence: calculatePatternConfidence(priceDiff, 'doubleTop')
                    });
                }
            }
        }
    }

    return patterns;
};

/**
 * Detects double bottom pattern (bullish reversal).
 */
const detectDoubleBottom = (data) => {
    const patterns = [];
    const tolerance = 0.02;

    for (let i = 20; i < data.length - 10; i++) {
        const troughs = findLocalTroughs(data.slice(i - 20, i + 10), 3);
        
        if (troughs.length >= 2) {
            const [trough1, trough2] = troughs.slice(-2);
            const priceDiff = Math.abs(trough1.price - trough2.price) / trough1.price;
            
            if (priceDiff < tolerance && trough2.index > trough1.index) {
                const peak = findHighestPoint(data.slice(trough1.index, trough2.index));
                
                if (peak.price > Math.max(trough1.price, trough2.price) * 1.05) {
                    patterns.push({
                        type: 'Double Bottom',
                        signal: 'Bullish',
                        strength: 'Strong',
                        time: data[i].time,
                        price: data[i].close,
                        description: 'Bullish reversal pattern detected. Consider buying.',
                        confidence: calculatePatternConfidence(priceDiff, 'doubleBottom')
                    });
                }
            }
        }
    }

    return patterns;
};

/**
 * Detects head and shoulders pattern (bearish reversal).
 */
const detectHeadAndShoulders = (data) => {
    const patterns = [];
    
    for (let i = 30; i < data.length - 10; i++) {
        const peaks = findLocalPeaks(data.slice(i - 30, i + 10), 5);
        
        if (peaks.length >= 3) {
            const [shoulder1, head, shoulder2] = peaks.slice(-3);
            
            // Head should be higher than shoulders
            if (head.price > shoulder1.price && head.price > shoulder2.price) {
                // Shoulders should be roughly equal
                const shoulderDiff = Math.abs(shoulder1.price - shoulder2.price) / shoulder1.price;
                
                if (shoulderDiff < 0.03) {
                    patterns.push({
                        type: 'Head and Shoulders',
                        signal: 'Bearish',
                        strength: 'Very Strong',
                        time: data[i].time,
                        price: data[i].close,
                        description: 'Major bearish reversal pattern. Strong sell signal.',
                        confidence: calculatePatternConfidence(shoulderDiff, 'headAndShoulders')
                    });
                }
            }
        }
    }

    return patterns;
};

/**
 * Detects breakout patterns.
 */
const detectBreakouts = (data) => {
    const patterns = [];
    const lookback = 20;

    for (let i = lookback; i < data.length; i++) {
        const recentData = data.slice(i - lookback, i);
        const high = Math.max(...recentData.map(d => d.high));
        const low = Math.min(...recentData.map(d => d.low));
        const avgVolume = recentData.reduce((sum, d) => sum + d.volume, 0) / lookback;

        // Bullish breakout
        if (data[i].close > high && data[i].volume > avgVolume * 1.5) {
            patterns.push({
                type: 'Bullish Breakout',
                signal: 'Bullish',
                strength: 'Strong',
                time: data[i].time,
                price: data[i].close,
                description: `Price broke above resistance at $${high.toFixed(2)} with strong volume.`,
                confidence: 85
            });
        }
        
        // Bearish breakdown
        if (data[i].close < low && data[i].volume > avgVolume * 1.5) {
            patterns.push({
                type: 'Bearish Breakdown',
                signal: 'Bearish',
                strength: 'Strong',
                time: data[i].time,
                price: data[i].close,
                description: `Price broke below support at $${low.toFixed(2)} with strong volume.`,
                confidence: 85
            });
        }
    }

    return patterns;
};

/**
 * Detects reversal patterns.
 */
const detectReversals = (data) => {
    const patterns = [];
    
    for (let i = 5; i < data.length; i++) {
        const recent = data.slice(i - 5, i + 1);
        
        // Bullish reversal (V-bottom)
        const lowestIndex = recent.findIndex(d => d.low === Math.min(...recent.map(x => x.low)));
        if (lowestIndex > 0 && lowestIndex < recent.length - 1) {
            const beforeLow = recent.slice(0, lowestIndex);
            const afterLow = recent.slice(lowestIndex + 1);
            
            if (isDowntrend(beforeLow) && isUptrend(afterLow)) {
                patterns.push({
                    type: 'V-Bottom Reversal',
                    signal: 'Bullish',
                    strength: 'Medium',
                    time: data[i].time,
                    price: data[i].close,
                    description: 'Sharp reversal from downtrend to uptrend.',
                    confidence: 70
                });
            }
        }
    }

    return patterns;
};

/**
 * Detects triangle patterns.
 */
const detectTriangles = (data) => {
    const patterns = [];
    const lookback = 30;

    for (let i = lookback; i < data.length; i++) {
        const recent = data.slice(i - lookback, i);
        const highs = recent.map(d => d.high);
        const lows = recent.map(d => d.low);
        
        const highTrend = calculateTrend(highs);
        const lowTrend = calculateTrend(lows);
        
        // Ascending triangle (bullish)
        if (Math.abs(highTrend) < 0.001 && lowTrend > 0.002) {
            patterns.push({
                type: 'Ascending Triangle',
                signal: 'Bullish',
                strength: 'Medium',
                time: data[i].time,
                price: data[i].close,
                description: 'Ascending triangle pattern suggests bullish breakout potential.',
                confidence: 75
            });
        }
        
        // Descending triangle (bearish)
        if (Math.abs(lowTrend) < 0.001 && highTrend < -0.002) {
            patterns.push({
                type: 'Descending Triangle',
                signal: 'Bearish',
                strength: 'Medium',
                time: data[i].time,
                price: data[i].close,
                description: 'Descending triangle pattern suggests bearish breakdown potential.',
                confidence: 75
            });
        }
    }

    return patterns;
};

// Helper functions
const findLocalPeaks = (data, threshold) => {
    const peaks = [];
    for (let i = threshold; i < data.length - threshold; i++) {
        let isPeak = true;
        for (let j = i - threshold; j <= i + threshold; j++) {
            if (j !== i && data[j].high >= data[i].high) {
                isPeak = false;
                break;
            }
        }
        if (isPeak) {
            peaks.push({ index: i, price: data[i].high });
        }
    }
    return peaks;
};

const findLocalTroughs = (data, threshold) => {
    const troughs = [];
    for (let i = threshold; i < data.length - threshold; i++) {
        let isTrough = true;
        for (let j = i - threshold; j <= i + threshold; j++) {
            if (j !== i && data[j].low <= data[i].low) {
                isTrough = false;
                break;
            }
        }
        if (isTrough) {
            troughs.push({ index: i, price: data[i].low });
        }
    }
    return troughs;
};

const findHighestPoint = (data) => {
    let max = data[0];
    data.forEach(d => {
        if (d.high > max.high) max = d;
    });
    return { price: max.high };
};

const findLowestPoint = (data) => {
    let min = data[0];
    data.forEach(d => {
        if (d.low < min.low) min = d;
    });
    return { price: min.low };
};

const isUptrend = (data) => {
    if (data.length < 2) return false;
    const firstPrice = data[0].close;
    const lastPrice = data[data.length - 1].close;
    return lastPrice > firstPrice * 1.02;
};

const isDowntrend = (data) => {
    if (data.length < 2) return false;
    const firstPrice = data[0].close;
    const lastPrice = data[data.length - 1].close;
    return lastPrice < firstPrice * 0.98;
};

const calculateTrend = (values) => {
    const n = values.length;
    const sumX = (n * (n - 1)) / 2;
    const sumY = values.reduce((a, b) => a + b, 0);
    const sumXY = values.reduce((sum, val, idx) => sum + idx * val, 0);
    const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    return slope;
};

const calculatePatternConfidence = (deviation, patternType) => {
    const baseConfidence = {
        doubleTop: 80,
        doubleBottom: 80,
        headAndShoulders: 90
    };
    
    const base = baseConfidence[patternType] || 75;
    const penalty = deviation * 1000;
    return Math.max(50, Math.min(100, base - penalty));
};

const summarizePatterns = (patterns) => {
    const bullish = patterns.filter(p => p.signal === 'Bullish').length;
    const bearish = patterns.filter(p => p.signal === 'Bearish').length;
    
    const overall = bullish > bearish ? 'Bullish' : bearish > bullish ? 'Bearish' : 'Neutral';
    
    return {
        total: patterns.length,
        bullish,
        bearish,
        overall,
        dominantPattern: patterns.length > 0 ? patterns[patterns.length - 1].type : 'None'
    };
};

const generatePatternAlerts = (patterns) => {
    const recent = patterns.slice(-5);
    const strongPatterns = recent.filter(p => p.strength === 'Strong' || p.strength === 'Very Strong');
    
    return strongPatterns.map(p => ({
        type: p.type,
        signal: p.signal,
        message: `${p.type} detected: ${p.description}`,
        urgency: p.strength === 'Very Strong' ? 'High' : 'Medium'
    }));
};

// ─── PANTHEON ORACLE PATTERNS ────────────────────────────────────────────────
// These three patterns feed directly into ORACLE Step 3 scoring.
// Input: bars array of { open, high, low, close, volume } sorted oldest→newest.

/**
 * Volatility Contraction Pattern (Minervini VCP).
 * Looks for ≥2 successive pullbacks where each swing is ≤60% of the prior,
 * volume drying up, and price within 15% of the 52-week high.
 * @param {Array} bars
 * @returns {boolean}
 */
function detectVCP(bars) {
    if (bars.length < 45) return false;

    const recent = bars.slice(-65);
    const highs  = recent.map(b => b.high);
    const lows   = recent.map(b => b.low);
    const vols   = recent.map(b => b.volume);

    const week52High = Math.max(...highs);
    const currentClose = recent[recent.length - 1].close;
    if (currentClose < week52High * 0.85) return false; // Must be within 15% of 52wk high

    // Find pullback swings: local high → local low pairs
    const swings = [];
    let inPullback = false;
    let swingHigh = 0;

    for (let i = 5; i < recent.length - 3; i++) {
        const isLocalHigh = recent[i].high >= recent[i - 1].high &&
                            recent[i].high >= recent[i + 1].high &&
                            recent[i].high >= recent[i - 2].high;
        const isLocalLow  = recent[i].low <= recent[i - 1].low &&
                            recent[i].low <= recent[i + 1].low &&
                            recent[i].low <= recent[i - 2].low;

        if (isLocalHigh && !inPullback) {
            swingHigh   = recent[i].high;
            inPullback  = true;
        } else if (isLocalLow && inPullback) {
            const swingDepth = (swingHigh - recent[i].low) / swingHigh;
            swings.push({ depth: swingDepth, volAtLow: vols[i] });
            inPullback = false;
        }
    }

    if (swings.length < 2) return false;

    // Each swing must be ≤65% of the prior (contracting)
    for (let i = 1; i < swings.length; i++) {
        if (swings[i].depth > swings[i - 1].depth * 0.65) return false;
    }

    // Volume at last low should be below 20-day average (drying up)
    const avgVol20 = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const lastSwingVol = swings[swings.length - 1].volAtLow;
    if (lastSwingVol > avgVol20 * 1.1) return false;

    return true;
}

/**
 * Cup & Handle (O'Neil).
 * Cup: smooth U-shape 15-35% deep over ≥30 bars; right lip recovers to within 5% of left.
 * Handle: subsequent 5-15% pullback over 5-20 bars with declining volume.
 * @param {Array} bars
 * @returns {boolean}
 */
function detectCupAndHandle(bars) {
    if (bars.length < 55) return false;

    // Use the last 75 bars for the cup
    const cupBars = bars.slice(-75, -5);
    if (cupBars.length < 30) return false;

    const leftLipPrice  = cupBars[0].high;
    const cupLow        = Math.min(...cupBars.map(b => b.low));
    const rightLipPrice = cupBars[cupBars.length - 1].close;
    const cupDepth      = (leftLipPrice - cupLow) / leftLipPrice;

    if (cupDepth < 0.15 || cupDepth > 0.35) return false; // Cup must be 15-35% deep
    if (rightLipPrice < leftLipPrice * 0.95) return false; // Right lip within 5% of left

    // Cup shape: midpoint price should be near the cup low
    const midClose = cupBars[Math.floor(cupBars.length / 2)].close;
    if (midClose > leftLipPrice * 0.88) return false; // Mid should be at least 12% below left lip

    // Handle: last 5-20 bars should be a shallow pullback
    const handleBars = bars.slice(-20);
    const handleHigh = Math.max(...handleBars.map(b => b.high));
    const handleLow  = Math.min(...handleBars.map(b => b.low));
    const handleDepth = (handleHigh - handleLow) / handleHigh;

    if (handleDepth < 0.05 || handleDepth > 0.15) return false; // Handle 5-15% deep

    // Volume declining in handle
    const handleVols = handleBars.map(b => b.volume);
    const firstHalfVol = handleVols.slice(0, Math.floor(handleVols.length / 2)).reduce((a, b) => a + b, 0);
    const secondHalfVol = handleVols.slice(Math.floor(handleVols.length / 2)).reduce((a, b) => a + b, 0);
    if (secondHalfVol >= firstHalfVol) return false; // Volume must contract

    return true;
}

/**
 * Darvas Box.
 * Finds a price "box" (consolidation range) then checks if price has broken
 * above the box ceiling on above-average volume.
 * @param {Array} bars
 * @returns {boolean}
 */
function detectDarvasBox(bars) {
    if (bars.length < 30) return false;

    const recent  = bars.slice(-40);
    const boxBars = recent.slice(0, -5); // Box formation — all but last 5 bars
    const breakBars = recent.slice(-5);  // Potential breakout bars

    const boxHigh = Math.max(...boxBars.map(b => b.high));
    const boxLow  = Math.min(...boxBars.map(b => b.low));
    const boxRange = (boxHigh - boxLow) / boxHigh;

    if (boxRange > 0.20) return false; // Box must be tight (< 20% range)
    if (boxRange < 0.04) return false; // Must have some range (not flat)

    // Ceiling must have been tested at least twice
    const ceilingTests = boxBars.filter(b => b.high >= boxHigh * 0.99).length;
    if (ceilingTests < 2) return false;

    // Current price must have broken above box ceiling
    const currentClose = breakBars[breakBars.length - 1].close;
    if (currentClose <= boxHigh) return false;

    // Breakout bar should have above-average volume
    const avgVol = boxBars.reduce((a, b) => a + b.volume, 0) / boxBars.length;
    const breakoutVol = Math.max(...breakBars.map(b => b.volume));
    if (breakoutVol < avgVol * 1.3) return false;

    return true;
}

/** Local SMA helper — kept self-contained rather than requiring enhancedAITradingBot.js
 * (which already requires this file — a back-require would be circular). */
function _sma(values, period) {
    if (!values || values.length < period) return null;
    const slice = values.slice(-period);
    return slice.reduce((s, v) => s + v, 0) / period;
}

/**
 * Frog-in-the-Pan (Da, Gurun & Warachka 2014, "Information Discreteness").
 * Looks for a SMOOTH, gradual uptrend — meaningfully more up-days than down-days
 * over a ~6-month lookback, no single day's move exceeding 6% either direction,
 * price above both SMA50 and SMA200. Deliberately distinct from VCP/Cup&Handle/
 * Darvas, which all look for a basing/coiling structure before a breakout —
 * this looks for a quiet, steady grind that's already underway. The paper's
 * finding: for the same cumulative return, a "smooth" (low-discreteness) path
 * continues more reliably than a "jumpy" (high-discreteness, i.e. driven by a
 * few big days) one. Added 2026-09-06, adopted from
 * github.com/sofus-nl/swing-trading-strategies.
 * @param {Array} bars — needs 200+ bars for a reliable SMA200
 * @returns {boolean}
 */
function detectFrogInThePan(bars) {
    const LOOKBACK = 126; // ~6 months of trading days
    if (!bars || bars.length < 200) return false;

    const closes = bars.map(b => b.close);
    const window = closes.slice(-LOOKBACK);
    if (window.length < LOOKBACK) return false;

    // Cumulative return over the window must be a real, not marginal, gain.
    const cumReturn = (window[window.length - 1] - window[0]) / window[0];
    if (cumReturn < 0.15) return false;

    // No single day's close-to-close move may exceed 6% — a gap that big breaks
    // the gradual-repricing thesis (this is what "smooth" means here).
    let upDays = 0, downDays = 0;
    for (let i = 1; i < window.length; i++) {
        const dailyReturn = (window[i] - window[i - 1]) / window[i - 1];
        if (Math.abs(dailyReturn) > 0.06) return false;
        if (dailyReturn > 0) upDays++;
        else if (dailyReturn < 0) downDays++;
    }

    // Low information discreteness: meaningfully more up-days than down-days —
    // the gain came from many small steps, not a few large jumps.
    const totalDays = upDays + downDays;
    if (totalDays === 0 || upDays / totalDays < 0.55) return false;

    // Trend confirmation: price above both SMA50 and SMA200.
    const sma50  = _sma(closes, 50);
    const sma200 = _sma(closes, 200);
    const currentClose = closes[closes.length - 1];
    if (sma50 === null || sma200 === null) return false;
    if (currentClose < sma50 || currentClose < sma200) return false;

    return true;
}

/**
 * Power Earnings Gap (PEG) — post-earnings gap-and-hold continuation.
 * Added 2026-09-06, adopted from github.com/sofus-nl/swing-trading-strategies
 * (strategies/06-power-earnings-gap.md). Complementary to PROPHET, which only
 * forecasts direction BEFORE earnings — this looks for a gap that has ALREADY
 * happened and is holding, a signal nothing else in PANTHEON watches for.
 *
 * Scans the last few bars for a day that gapped up 5-20% on 2x+ average
 * volume, then requires every close since to have held above the pre-gap
 * close (the "institutional defense line" the strategy is named for) for at
 * least 3 bars, plus trend-strength confirmation (price > SMA50, ADX(14)>20).
 *
 * Scope note: this is a detection/scoring signal only — it does NOT compute
 * or override stop/target levels (the source strategy's gap-day-low stop and
 * 1.5x/3x-gap-range targets aren't wired into order placement). Deliberately
 * scoped down for a first pass; SECTOR_TRADE_PROFILES' existing ATR-based
 * stop/target logic still applies uniformly, same as every other pattern here.
 *
 * @param {Array} bars
 * @returns {boolean}
 */
function detectPowerEarningsGap(bars) {
    if (!bars || bars.length < 60) return false;

    const closes = bars.map(b => b.close);
    const highs  = bars.map(b => b.high);
    const lows   = bars.map(b => b.low);
    const vols   = bars.map(b => b.volume);
    const n      = bars.length;

    // Gap day must be recent enough to still be a "fresh" setup (within the
    // last 10 bars) but old enough to have the required 3-bar hold confirmed.
    for (let gapIdx = n - 4; gapIdx >= Math.max(1, n - 10); gapIdx--) {
        const prevClose = closes[gapIdx - 1];
        const gapOpen    = bars[gapIdx].open;
        const gapPct     = (gapOpen - prevClose) / prevClose;
        if (gapPct < 0.05 || gapPct > 0.20) continue;

        // Volume confirmation, using the 50 days BEFORE the gap (excluding it,
        // so the gap's own volume spike can't inflate its own baseline).
        const priorVols = vols.slice(Math.max(0, gapIdx - 50), gapIdx);
        if (priorVols.length < 20) continue;
        const avgVol = priorVols.reduce((s, v) => s + v, 0) / priorVols.length;
        if (avgVol === 0 || vols[gapIdx] < avgVol * 2) continue;

        // Held above pre-gap close for at least 3 bars since the gap.
        if (n - 1 - gapIdx < 3) continue;
        if (!closes.slice(gapIdx).every(c => c >= prevClose)) continue;

        // Trend-strength confirmation.
        const sma50 = _sma(closes, 50);
        if (sma50 === null || closes[n - 1] < sma50) continue;
        if (calculateSimpleADX(highs, lows, closes, 14) <= 20) continue;

        return true;
    }

    return false;
}

/**
 * Detect the best PANTHEON ORACLE pattern in a bar series.
 * Returns the pattern name and its ORACLE Step 3 score contribution.
 *
 * @param {Array} bars  — OHLCV array sorted oldest→newest
 * @returns {{ pattern: string, score: number, signal: string }}
 */
function detectOraclePatterns(bars) {
    if (!bars || bars.length < 30) return { pattern: 'None', score: 0, signal: 'None' };

    if (detectVCP(bars))               return { pattern: 'VCP',             score: 10, signal: 'Bullish' };
    if (detectPowerEarningsGap(bars))  return { pattern: 'PowerEarningsGap', score: 9,  signal: 'Bullish' };
    if (detectCupAndHandle(bars))      return { pattern: 'Cup&Handle',      score: 8,  signal: 'Bullish' };
    if (detectDarvasBox(bars))         return { pattern: 'Darvas',          score: 8,  signal: 'Bullish' };
    if (detectFrogInThePan(bars))      return { pattern: 'FrogInThePan',    score: 7,  signal: 'Bullish' };

    return { pattern: 'None', score: 0, signal: 'None' };
}

module.exports = {
    detectPatterns,
    detectOraclePatterns,
    detectVCP,
    detectCupAndHandle,
    detectDarvasBox,
    detectFrogInThePan,
    detectPowerEarningsGap
};
