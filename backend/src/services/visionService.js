/**
 * VISION — Pattern Prophet (PANTHEON agent)
 *
 * Rule-based directional classifier — the foundation layer before LSTM.
 * Uses MA alignment, momentum, RSI position, volume trend, and breakout proximity
 * to estimate probability of an upward move in the next 5 trading days.
 *
 * Returns a structured signal used as a scoring component in ORACLE.
 * Score contribution: +8 (strong up), +4 (moderate up), 0 (neutral), -4 (down), -8 (strong down)
 *
 * Future upgrade path: replace score computation with an LSTM model trained
 * on the same features — the interface stays identical.
 */

const cacheService = require('./cacheService');
const { logger }   = require('../utils/logger');

const CACHE_TTL = 20 * 60 * 1000; // 20 min

/**
 * Compute VISION directional probability from raw OHLCV bars.
 *
 * @param {string} symbol
 * @param {Array}  bars   — { open, high, low, close, volume } sorted oldest→newest
 * @param {object} hints  — { sma50, sma150, sma200, sma200Rising, rsi, week52High } from analyzeStock
 * @returns {{ direction:'UP'|'DOWN'|'NEUTRAL', probability:number, confidence:'HIGH'|'MEDIUM'|'LOW', scoreAdj:number }}
 */
function computeSignal(symbol, bars, hints = {}) {
    if (!bars || bars.length < 30) {
        return { direction: 'NEUTRAL', probability: 0.50, confidence: 'LOW', scoreAdj: 0 };
    }

    const cacheKey = `vision_${symbol}`;
    const cached   = cacheService.get(cacheKey);
    if (cached) return cached;

    const closes  = bars.map(b => b.close).filter(Boolean);
    const volumes = bars.map(b => b.volume).filter(Boolean);
    const n       = closes.length;

    let bullPoints = 0;
    let bearPoints = 0;
    const reasons  = [];

    // ── 1. MA Alignment (max ±25 pts) ────────────────────────────────────────
    const price = closes[n - 1];
    const { sma50, sma150, sma200, sma200Rising } = hints;

    if (sma50  && price > sma50)          { bullPoints += 5; }  else if (sma50)  { bearPoints += 5; }
    if (sma150 && price > sma150)         { bullPoints += 5; }  else if (sma150) { bearPoints += 5; }
    if (sma200 && price > sma200)         { bullPoints += 5; }  else if (sma200) { bearPoints += 5; }
    if (sma50  && sma200 && sma50 > sma200) { bullPoints += 5; } else if (sma50 && sma200) { bearPoints += 3; }
    if (sma200Rising)                     { bullPoints += 5; }  else              { bearPoints += 2; }

    // ── 2. Short-term momentum (5-day vs 20-day return) ──────────────────────
    if (n >= 20) {
        const ret5  = (closes[n - 1] - closes[n - 6])  / closes[n - 6];
        const ret20 = (closes[n - 1] - closes[n - 21]) / closes[n - 21];
        if (ret5 > 0.02)  { bullPoints += 10; reasons.push('momentum+'); }
        else if (ret5 > 0){ bullPoints += 4; }
        else if (ret5 < -0.02){ bearPoints += 10; reasons.push('momentum-'); }
        else               { bearPoints += 4; }

        if (ret20 > 0.05)  { bullPoints += 6; }
        else if (ret20 < -0.05){ bearPoints += 6; }
    }

    // ── 3. RSI position (ideal bull zone: 40-65) ─────────────────────────────
    const { rsi } = hints;
    if (rsi != null) {
        if (rsi >= 40 && rsi <= 65)       { bullPoints += 8; reasons.push('rsi_zone'); }
        else if (rsi > 65 && rsi <= 75)   { bullPoints += 3; }
        else if (rsi > 75)                { bearPoints += 8; reasons.push('overbought'); }
        else if (rsi < 40 && rsi >= 30)   { bullPoints += 3; } // recovery bounce possible
        else if (rsi < 30)                { bearPoints += 8; reasons.push('oversold_downtrend'); }
    }

    // ── 4. Volume trend (expanding on up-days) ────────────────────────────────
    if (volumes.length >= 20) {
        const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const avgVol5  = volumes.slice(-5).reduce((a, b) => a + b, 0)  / 5;

        // Is volume rising into price strength?
        const last5Closes = closes.slice(-5);
        const last5Vols   = volumes.slice(-5);
        let upVol = 0, downVol = 0;
        for (let i = 1; i < last5Closes.length; i++) {
            if (last5Closes[i] >= last5Closes[i - 1]) upVol  += last5Vols[i];
            else                                        downVol += last5Vols[i];
        }
        if (upVol > downVol * 1.2 && avgVol5 > avgVol20 * 0.9) {
            bullPoints += 8; reasons.push('vol_confirm');
        } else if (downVol > upVol * 1.2) {
            bearPoints += 6;
        }
    }

    // ── 5. Proximity to 52-week high ─────────────────────────────────────────
    const { week52High } = hints;
    if (week52High > 0) {
        const prox = price / week52High;
        if (prox >= 0.97)      { bullPoints += 8; reasons.push('near52wkH'); }
        else if (prox >= 0.90) { bullPoints += 4; }
        else if (prox < 0.70)  { bearPoints += 6; }
    }

    // ── 6. Consolidation tightness (low ATR% = coiling) ─────────────────────
    if (n >= 14 && price > 0) {
        let trSum = 0;
        for (let i = n - 14; i < n; i++) {
            const hi = bars[i]?.high || closes[i];
            const lo = bars[i]?.low  || closes[i];
            trSum += hi - lo;
        }
        const atrPct = (trSum / 14) / price * 100;
        if (atrPct < 1.5) { bullPoints += 5; reasons.push('tight_coil'); }
    }

    // ── Score → probability ───────────────────────────────────────────────────
    const total     = bullPoints + bearPoints;
    const bullRatio = total > 0 ? bullPoints / total : 0.5;
    // Sigmoid-like mapping: 0.5 = neutral
    const probability = Math.max(0.10, Math.min(0.90, bullRatio));

    let direction;
    if (probability >= 0.65)      direction = 'UP';
    else if (probability <= 0.35) direction = 'DOWN';
    else                          direction = 'NEUTRAL';

    const confidence =
        probability >= 0.75 || probability <= 0.25 ? 'HIGH'   :
        probability >= 0.60 || probability <= 0.40 ? 'MEDIUM' : 'LOW';

    const scoreAdj =
        direction === 'UP'   && confidence === 'HIGH'   ? +8 :
        direction === 'UP'   && confidence === 'MEDIUM' ? +4 :
        direction === 'DOWN' && confidence === 'HIGH'   ? -8 :
        direction === 'DOWN' && confidence === 'MEDIUM' ? -4 : 0;

    const result = { direction, probability: Number(probability.toFixed(3)), confidence, scoreAdj, reasons };
    cacheService.set(cacheKey, result, CACHE_TTL);

    if (scoreAdj !== 0) {
        logger.debug(`[VISION] ${symbol}: ${direction}/${confidence} prob=${(probability*100).toFixed(0)}% adj=${scoreAdj}`);
    }
    return result;
}

module.exports = { computeSignal };
