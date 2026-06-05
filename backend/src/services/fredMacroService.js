/**
 * FRED Macro Service — SHIELD macro regime enhancement (PANTHEON)
 *
 * Fetches key macro indicators from the Federal Reserve Economic Data (FRED)
 * free API and returns a macro regime signal used by SHIELD.
 * Gracefully disabled when FRED_API_KEY is absent.
 *
 * Set in .env:
 *   FRED_API_KEY=your_key_here
 *
 * Series fetched:
 *   FEDFUNDS  — Federal Funds Effective Rate (%)
 *   T10Y2Y    — 10-Year minus 2-Year Treasury Yield Spread (negative = recession risk)
 *   UNRATE    — Civilian Unemployment Rate (%)
 */

const axios        = require('axios');
const cacheService = require('./cacheService');
const { logger }   = require('../utils/logger');

const FRED_API_KEY  = process.env.FRED_API_KEY || '';
const FRED_BASE_URL = 'https://api.stlouisfed.org/fred/series/observations';
const CACHE_TTL     = 6 * 60 * 60 * 1000;  // 6 hours — FRED data updates daily
const SNAPSHOT_KEY  = 'fred_macro_snapshot';

const NEUTRAL_SNAPSHOT = {
    fedFundsRate:     null,
    yieldSpread10Y2Y: null,
    unemploymentRate: null,
    macroSignal:      'neutral',
    scoreAdj:         0,
    source:           'disabled'
};

if (!FRED_API_KEY) {
    logger.warn('[FRED] FRED_API_KEY not configured — macro regime enhancement disabled, SHIELD uses VIX-only fallback');
}

/**
 * Fetch the most recent observation for a FRED series.
 * Returns null on any failure — never throws.
 */
async function getLatestValue(seriesId) {
    if (!FRED_API_KEY) return null;

    const cacheKey = `fred_series_${seriesId}`;
    const cached   = cacheService.get(cacheKey);
    if (cached !== null) return cached;

    try {
        const resp = await axios.get(FRED_BASE_URL, {
            params: {
                series_id:          seriesId,
                api_key:            FRED_API_KEY,
                file_type:          'json',
                sort_order:         'desc',
                limit:              1,
                observation_start:  new Date(Date.now() - 180 * 86400000).toISOString().split('T')[0]
            },
            timeout: 10000
        });

        const obs   = resp.data?.observations?.[0];
        const value = obs?.value && obs.value !== '.' ? parseFloat(obs.value) : null;

        if (value !== null) {
            cacheService.set(cacheKey, value, CACHE_TTL);
            logger.info(`[FRED] ${seriesId}: ${value}`);
        }
        return value;

    } catch (err) {
        logger.warn(`[FRED] Failed to fetch ${seriesId}: ${err.response?.status || err.message}`);
        return null;
    }
}

/**
 * Returns a macro snapshot used by SHIELD for portfolio-level regime decisions.
 * scoreAdj ranges from -10 (very bearish macro) to +10 (very bullish macro).
 * Returns NEUTRAL_SNAPSHOT when FRED_API_KEY is absent or all calls fail.
 */
async function getMacroSnapshot() {
    const cached = cacheService.get(SNAPSHOT_KEY);
    if (cached) return cached;
    if (!FRED_API_KEY) return NEUTRAL_SNAPSHOT;

    const [fedFundsRate, yieldSpread10Y2Y, unemploymentRate] = await Promise.all([
        getLatestValue('FEDFUNDS'),
        getLatestValue('T10Y2Y'),
        getLatestValue('UNRATE')
    ]);

    let adj = 0;

    // Yield curve: negative spread = recession risk (strongest signal)
    if (yieldSpread10Y2Y !== null) {
        if      (yieldSpread10Y2Y < -0.5) adj -= 8;
        else if (yieldSpread10Y2Y <  0)   adj -= 3;
        else if (yieldSpread10Y2Y >  1)   adj += 4;
    }

    // Fed funds rate: very high rates = equity headwind
    if (fedFundsRate !== null) {
        if      (fedFundsRate > 5.5) adj -= 4;
        else if (fedFundsRate > 4)   adj -= 2;
        else if (fedFundsRate < 2)   adj += 4;
    }

    // Unemployment: rising unemployment = risk-off
    if (unemploymentRate !== null) {
        if      (unemploymentRate > 5)   adj -= 4;
        else if (unemploymentRate < 3.8) adj += 2;
    }

    const scoreAdj    = Math.max(-10, Math.min(10, adj));
    const macroSignal = scoreAdj >= 4 ? 'bullish' : scoreAdj <= -4 ? 'bearish' : 'neutral';

    const snapshot = {
        fedFundsRate,
        yieldSpread10Y2Y,
        unemploymentRate,
        macroSignal,
        scoreAdj,
        source: 'fred'
    };

    cacheService.set(SNAPSHOT_KEY, snapshot, CACHE_TTL);
    logger.info('[FRED] Macro snapshot refreshed', { macroSignal, scoreAdj, fedFundsRate, yieldSpread10Y2Y, unemploymentRate });
    return snapshot;
}

module.exports = {
    getMacroSnapshot,
    getLatestValue,
    isEnabled: () => !!FRED_API_KEY
};
