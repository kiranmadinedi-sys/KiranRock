const cacheService = require('./cacheService');
const dataProvider = require('./dataProvider');
const { logger } = require('../utils/logger');

const CACHE_TTL = 10 * 60 * 1000;        // 10 minutes (was 60 — faster VIX-spike response)
const STALE_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours (stale fallback)
const STALE_CACHE_KEY = 'market_regime:last_known';

function isRateLimitError(error) {
    const message = String(error?.message || '').toLowerCase();
    return message.includes('429') ||
        message.includes('too many requests') ||
        message.includes('failed to get crumb');
}

/**
 * Market Regime Detection Service
 *
 * Classifies the market into 5 regimes using 7 signals:
 *   1. SPY price vs 200-day / 50-day MA
 *   2. VIX level (fear gauge)
 *   3. QQQ trend (tech-sector divergence detection)
 *   4. TLT 20-day return (bond direction = rate environment)
 *   5. SPY 5-day price range % (chop detection)
 *   6. ATR(5) / ATR(20) expansion ratio (volatility regime)
 *   7. SPY volume vs 20-day avg (conviction check)
 *
 * Regimes (priority order):
 *   PANIC      → VIX > 40 or catastrophic 20d drop   → halt new entries
 *   BEAR       → SPY well below 200MA + bad returns   → tiny size, very high bar
 *   CHOPPY     → tight 5d range + ATR contracting     → halt momentum entries
 *   NEUTRAL    → SPY below 200MA or VIX elevated      → reduced size + higher bar
 *   BULL_MILD  → above 200MA with headwinds            → normal with penalty
 *   BULL_STRONG→ SPY+QQQ above MAs, low VIX, no rates → full size
 */

function sma(values, period) {
    if (!values || values.length < period) return null;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

// Average True Range over `period` bars. Requires period+1 bars (needs previous close).
function calcAtr(bars, period) {
    if (!bars || bars.length < period + 1) return null;
    const slice = bars.slice(-(period + 1));
    let sum = 0;
    for (let i = 1; i < slice.length; i++) {
        const curr = slice[i];
        const prev = slice[i - 1];
        const high     = curr.high  ?? curr.close;
        const low      = curr.low   ?? curr.close;
        const prevClose = prev.close ?? curr.close;
        sum += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    }
    return sum / period;
}

function getConsecutiveLossDays(closes) {
    let streak = 0;
    for (let i = closes.length - 1; i > 0; i--) {
        if (closes[i] < closes[i - 1]) streak++;
        else break;
    }
    return streak;
}

async function getMarketRegime() {
    const cached = cacheService.get('market_regime');
    if (cached) return cached;

    const lastKnownRegime = cacheService.get(STALE_CACHE_KEY);

    try {
        // Fetch all 4 signals in parallel — SPY required, QQQ/TLT/VIX optional (allSettled)
        const [spyResult, qqqResult, tltResult, vixResult] = await Promise.allSettled([
            dataProvider.getBars('SPY', '1d', 210),
            dataProvider.getBars('QQQ', '1d', 60),
            dataProvider.getBars('TLT', '1d', 30),
            dataProvider.getQuote('^VIX')
        ]);

        if (spyResult.status === 'rejected' || !spyResult.value?.length) {
            throw new Error('SPY bars unavailable: ' + (spyResult.reason?.message || 'empty'));
        }

        const spyData = spyResult.value;
        const closes  = spyData.map(b => b.close).filter(c => c != null && c > 0);
        const volumes = spyData.map(b => b.volume).filter(v => v != null && v > 0);

        if (closes.length < 50) {
            logger.warn('[MarketRegime] Insufficient SPY data, using neutral defaults');
            return getDefaultRegime();
        }

        // ── SPY signals ──────────────────────────────────────────────────────
        const currentPrice = closes[closes.length - 1];
        const ma200        = sma(closes, Math.min(200, closes.length));
        const ma50         = sma(closes, 50);
        const vixLevel     = vixResult.status === 'fulfilled' ? (vixResult.value?.price || 20) : 20;

        const price20dAgo = closes[Math.max(0, closes.length - 20)];
        const return20d   = ((currentPrice - price20dAgo) / price20dAgo) * 100;

        const consecutiveLossDays = getConsecutiveLossDays(closes);

        // 5-day price range as % of price — tight = potential chop
        const spy5dHigh    = Math.max(...closes.slice(-5));
        const spy5dLow     = Math.min(...closes.slice(-5));
        const spy5dRangePct = ((spy5dHigh - spy5dLow) / currentPrice) * 100;

        // ATR expansion: short-term vs historical — ratio < 0.85 = vol contracting = chop
        const atr5  = calcAtr(spyData, 5);
        const atr20 = calcAtr(spyData, 20);
        const atrExpansion = (atr5 && atr20 && atr20 > 0) ? atr5 / atr20 : 1.0;

        // Volume expansion vs 20-day avg (logged, not a classification gate on its own)
        const currentVolume   = volumes[volumes.length - 1] || 0;
        const avgVolume20d    = sma(volumes, Math.min(20, volumes.length)) || 1;
        const volumeExpansion = currentVolume / avgVolume20d;

        // ── QQQ signals (tech-sector divergence) ─────────────────────────────
        let qqqAboveMa50 = true;
        let qqqReturn20d = 0;
        if (qqqResult.status === 'fulfilled' && qqqResult.value?.length >= 21) {
            const qqqCloses = qqqResult.value.map(b => b.close).filter(c => c > 0);
            const qqqMa50   = sma(qqqCloses, Math.min(50, qqqCloses.length));
            const qqqPrice  = qqqCloses[qqqCloses.length - 1];
            qqqAboveMa50    = qqqMa50 ? qqqPrice > qqqMa50 : true;
            const qqq20dAgo = qqqCloses[Math.max(0, qqqCloses.length - 20)];
            qqqReturn20d    = ((qqqPrice - qqq20dAgo) / qqq20dAgo) * 100;
        }

        // ── TLT signals (bond price direction) ───────────────────────────────
        // TLT falling > 3% over 20 days = yields rising sharply = equity headwind
        let tltReturn20d = 0;
        let risingRates  = false;
        if (tltResult.status === 'fulfilled' && tltResult.value?.length >= 21) {
            const tltCloses = tltResult.value.map(b => b.close).filter(c => c > 0);
            const tlt20dAgo = tltCloses[Math.max(0, tltCloses.length - 20)];
            tltReturn20d    = ((tltCloses[tltCloses.length - 1] - tlt20dAgo) / tlt20dAgo) * 100;
            risingRates     = tltReturn20d < -3;
        }

        // ── Derived booleans ─────────────────────────────────────────────────
        const aboveMa200       = ma200 ? currentPrice > ma200 : true;
        const aboveMa50        = ma50  ? currentPrice > ma50  : true;
        const aboveMa200By5pct = ma200 ? currentPrice > ma200 * 1.05 : false;
        const below200By5pct   = ma200 ? currentPrice < ma200 * 0.95 : false;

        const extremeFear = vixLevel > 40;
        const highFear    = vixLevel > 35;
        const highVix     = vixLevel > 25;

        // Choppy = 5-day range tight + ATR contracting + not in a strong trend
        const isChoppy = spy5dRangePct < 1.5 && atrExpansion < 0.85 && Math.abs(return20d) < 5;

        // ── REGIME CLASSIFICATION (priority — first match wins) ──────────────
        let regime, regimeType, description, maxRisk, minBuyScore, positionSizeMultiplier;

        // 1. PANIC — VIX > 40 or catastrophic 20-day drop
        if (extremeFear || (highFear && return20d < -12) || return20d < -15) {
            regime               = 'PANIC';
            regimeType           = 'PANIC';
            description          = `Panic/capitulation: VIX=${vixLevel.toFixed(1)}, 20d return=${return20d.toFixed(1)}% — no new entries, exits only`;
            maxRisk              = 0.10;
            minBuyScore          = 92;
            positionSizeMultiplier = 0.25;

        // 2. BEAR — sustained decline, SPY well below 200MA
        } else if (below200By5pct && return20d < -8) {
            regime               = 'BEAR';
            regimeType           = 'BEAR';
            description          = `Bear market: SPY well below 200MA, VIX=${vixLevel.toFixed(1)}, 20d return=${return20d.toFixed(1)}%` +
                                   (!qqqAboveMa50 ? ', QQQ also weak' : '');
            maxRisk              = 0.20;
            minBuyScore          = 80;
            positionSizeMultiplier = 0.5;

        // 3. CHOPPY — tight range, ATR contracting, no strong direction
        } else if (isChoppy) {
            regime               = 'CHOPPY';
            regimeType           = 'CHOPPY';
            description          = `Choppy/range-bound: 5d range=${spy5dRangePct.toFixed(2)}%, ATR ratio=${atrExpansion.toFixed(2)}, VIX=${vixLevel.toFixed(1)} — exits only`;
            maxRisk              = 0.25;
            minBuyScore          = 78;
            positionSizeMultiplier = 0.55;

        // 4. NEUTRAL — below 200MA or elevated VIX + negative return
        } else if (!aboveMa200 || (highVix && return20d < -5)) {
            regime               = 'NEUTRAL';
            regimeType           = 'NEUTRAL';
            description          = `Neutral/cautious: SPY ${aboveMa200 ? 'above' : 'below'} 200MA, VIX=${vixLevel.toFixed(1)}, 20d return=${return20d.toFixed(1)}%`;
            maxRisk              = 0.35;
            minBuyScore          = 70;
            positionSizeMultiplier = 0.75;

        // 5. BULL (Strong) — SPY+QQQ above MAs, VIX calm, no rising-rate headwind
        } else if (aboveMa200By5pct && aboveMa50 && vixLevel < 20 && return20d > 0 && qqqAboveMa50 && !risingRates) {
            regime               = 'BULL';
            regimeType           = 'BULL_STRONG';
            description          = `Strong bull: SPY & QQQ above MAs, VIX=${vixLevel.toFixed(1)}, 20d return=+${return20d.toFixed(1)}%`;
            maxRisk              = 0.60;
            minBuyScore          = 62;
            positionSizeMultiplier = 1.0;

        // 6. BULL (Mild) — above 200MA but with one or more headwinds
        } else {
            const headwinds = [];
            if (risingRates)    headwinds.push('rates rising');
            if (!qqqAboveMa50)  headwinds.push('QQQ weak');
            if (highVix)        headwinds.push(`VIX ${vixLevel.toFixed(0)}`);

            regime               = 'BULL';
            regimeType           = 'BULL_MILD';
            description          = `Mild bull: SPY above 200MA, VIX=${vixLevel.toFixed(1)}, 20d return=${return20d.toFixed(1)}%` +
                                   (headwinds.length ? ` | headwinds: ${headwinds.join(', ')}` : '');
            maxRisk              = 0.50;
            minBuyScore          = 65;
            // Penalty per headwind: rates = -0.10, QQQ weak = -0.05
            const headwindPenalty = (risingRates ? 0.10 : 0) + (!qqqAboveMa50 ? 0.05 : 0);
            positionSizeMultiplier = Math.max(0.70, 0.90 - headwindPenalty);
        }

        // ── CHOPPY breakout confirmation ─────────────────────────────────────
        // isChoppy is built entirely from lookback signals (5-day range, ATR ratio) --
        // a single strong session doesn't move those much, so a genuine same-day
        // breakout can sit hard-blocked for a day or more before the lagging
        // indicators catch up. Rather than loosen the CHOPPY gate itself, layer a
        // narrow, same-day confirmation check on top: only true when SPY and QQQ
        // are BOTH up meaningfully right now, with real volume behind it (not a
        // thin/holiday drift), and VIX hasn't spiked. Callers decide what to do
        // with this -- it does not change regimeType or unblock anything itself.
        let breakoutConfirmed = false, spyChangePct = 0, qqqChangePct = 0, spyVolRatio = 0;
        if (regimeType === 'CHOPPY') {
            try {
                const [spyQ, qqqQ] = await Promise.allSettled([
                    dataProvider.getQuote('SPY'),
                    dataProvider.getQuote('QQQ')
                ]);
                spyChangePct = spyQ.status === 'fulfilled' ? (spyQ.value?.changePercent || 0) : 0;
                qqqChangePct = qqqQ.status === 'fulfilled' ? (qqqQ.value?.changePercent || 0) : 0;
                const spyVol = spyQ.status === 'fulfilled' ? (spyQ.value?.volume || 0) : 0;
                const spyAvgVol = spyQ.status === 'fulfilled' ? (spyQ.value?.avgVolume || 0) : 0;
                spyVolRatio = spyAvgVol > 0 ? spyVol / spyAvgVol : 0;

                breakoutConfirmed = spyChangePct >= 0.5 && qqqChangePct >= 0.5 &&
                                    spyVolRatio >= 0.5 && vixLevel < 20;

                if (breakoutConfirmed) {
                    logger.info('[MarketRegime] CHOPPY breakout confirmed', {
                        spyChangePct: spyChangePct.toFixed(2), qqqChangePct: qqqChangePct.toFixed(2),
                        spyVolRatio: spyVolRatio.toFixed(2), vixLevel
                    });
                }
            } catch (err) {
                logger.debug('[MarketRegime] Breakout confirmation check failed (non-fatal)', { error: err.message });
            }
        }

        // ── Post-classification adjustments ──────────────────────────────────

        // 3+ consecutive down days → extra caution in non-PANIC/BEAR regimes
        if (consecutiveLossDays >= 3 && regime !== 'BEAR' && regime !== 'PANIC') {
            minBuyScore = Math.min(minBuyScore + 5, 85);
            maxRisk     = Math.max(maxRisk - 0.05, 0.15);
            description += ` | ${consecutiveLossDays} consecutive down days`;
        }

        // Rising rates in BULL → score bar +3 (rate-sensitive tech stocks need higher conviction)
        if (risingRates && regime === 'BULL') {
            minBuyScore  = Math.min(minBuyScore + 3, 85);
            description += ' | rate headwind: +3 min score';
        }

        const result = {
            regime,
            regimeType,
            description,
            // Core SPY indicators
            spyPrice:  parseFloat(currentPrice.toFixed(2)),
            ma200:     ma200 ? parseFloat(ma200.toFixed(2)) : null,
            ma50:      ma50  ? parseFloat(ma50.toFixed(2))  : null,
            vixLevel:  parseFloat(vixLevel.toFixed(2)),
            return20d: parseFloat(return20d.toFixed(2)),
            consecutiveLossDays,
            // New signals
            qqqAboveMa50,
            qqqReturn20d:   parseFloat(qqqReturn20d.toFixed(2)),
            tltReturn20d:   parseFloat(tltReturn20d.toFixed(2)),
            risingRates,
            spy5dRangePct:  parseFloat(spy5dRangePct.toFixed(2)),
            atrExpansion:   parseFloat(atrExpansion.toFixed(3)),
            volumeExpansion: parseFloat(volumeExpansion.toFixed(2)),
            // CHOPPY breakout confirmation (only meaningful when regimeType === 'CHOPPY')
            breakoutConfirmed,
            spyChangePct: parseFloat(spyChangePct.toFixed(2)),
            qqqChangePct: parseFloat(qqqChangePct.toFixed(2)),
            spyVolRatio:  parseFloat(spyVolRatio.toFixed(2)),
            // Trading parameters
            maxRisk,
            minBuyScore,
            positionSizeMultiplier,
            timestamp: new Date().toISOString()
        };

        cacheService.set('market_regime', result, CACHE_TTL);
        cacheService.set(STALE_CACHE_KEY, result, STALE_CACHE_TTL);

        logger.info('[MarketRegime] Regime determined', {
            regime, regimeType,
            vixLevel,
            return20d:      return20d.toFixed(2),
            qqqAboveMa50,
            risingRates,
            spy5dRangePct:  spy5dRangePct.toFixed(2),
            atrExpansion:   atrExpansion.toFixed(3),
            volumeExpansion: volumeExpansion.toFixed(2),
            minBuyScore,
            positionSizeMultiplier
        });

        return result;

    } catch (error) {
        if (lastKnownRegime) {
            const logMethod = isRateLimitError(error) ? 'warn' : 'error';
            logger[logMethod]('[MarketRegime] Using last known regime after fetch failure', {
                error: error.message,
                fallbackRegime: lastKnownRegime.regime,
                fallbackTimestamp: lastKnownRegime.timestamp
            });
            cacheService.set('market_regime', lastKnownRegime, CACHE_TTL);
            return lastKnownRegime;
        }

        const logMethod = isRateLimitError(error) ? 'warn' : 'error';
        logger[logMethod]('[MarketRegime] Error fetching regime data, using neutral defaults', { error: error.message });
        return getDefaultRegime();
    }
}

function getDefaultRegime() {
    return {
        regime: 'NEUTRAL',
        regimeType: 'NEUTRAL',
        description: 'Unable to determine market regime — conservative neutral defaults',
        spyPrice: null,
        ma200: null,
        ma50: null,
        vixLevel: null,
        return20d: null,
        consecutiveLossDays: 0,
        qqqAboveMa50: true,
        qqqReturn20d: 0,
        tltReturn20d: 0,
        risingRates: false,
        spy5dRangePct: 0,
        atrExpansion: 1.0,
        volumeExpansion: 1.0,
        maxRisk: 0.40,
        minBuyScore: 68,
        positionSizeMultiplier: 0.85,
        timestamp: new Date().toISOString()
    };
}

function invalidateCache() {
    cacheService.delete('market_regime');
    logger.info('[MarketRegime] Cache invalidated by VIX spike monitor');
}

module.exports = { getMarketRegime, getDefaultRegime, invalidateCache };
