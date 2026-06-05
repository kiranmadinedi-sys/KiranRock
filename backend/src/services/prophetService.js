/**
 * PROPHET — Earnings Forecaster (PANTHEON agent)
 *
 * Uses Claude to predict whether an upcoming earnings report is likely to
 * be a BEAT, IN_LINE, or MISS, based on fundamentals + recent news.
 * Only fires when 15-45 days from earnings (the "preview window").
 * Returns null when outside that window or when ANTHROPIC_API_KEY is absent.
 *
 * Set in .env:
 *   ANTHROPIC_API_KEY=your_key_here
 *   PROPHET_WINDOW_MIN_DAYS=15   (optional, default 15)
 *   PROPHET_WINDOW_MAX_DAYS=45   (optional, default 45)
 */

const ollamaService   = require('./ollamaService');
const cacheService    = require('./cacheService');
const { logger }      = require('../utils/logger');

const WINDOW_MIN    = parseInt(process.env.PROPHET_WINDOW_MIN_DAYS || '15', 10);
const WINDOW_MAX    = parseInt(process.env.PROPHET_WINDOW_MAX_DAYS || '45', 10);
const CACHE_TTL     = 6 * 60 * 60 * 1000; // 6 hours — earnings thesis doesn't shift hourly

if (ollamaService.isEnabled()) {
    logger.info('[PROPHET] Running via local Ollama — zero API cost');
} else {
    logger.warn('[PROPHET] Ollama not configured (OLLAMA_BASE_URL missing) — earnings forecast disabled');
}

/**
 * Forecast earnings direction for a stock.
 *
 * @param {string}   symbol
 * @param {number}   daysToEarnings    — calendar days until earnings
 * @param {string[]} headlines         — recent news headlines (max 8 used)
 * @param {object}   fundamentals      — { earningsGrowth, revenueGrowth } from getFundamentalsQuick
 * @returns {Promise<{verdict,confidence,thesis,scoreAdj,source}|null>}
 *   scoreAdj: -8 to +8. null when outside window or key absent.
 */
async function forecastEarnings(symbol, daysToEarnings, headlines = [], fundamentals = null) {
    // Route to local Ollama — no API charges
    if (ollamaService.isEnabled()) {
        const cacheKey = `prophet_ollama_${symbol}_${Math.floor(Date.now() / CACHE_TTL)}`;
        const cached   = cacheService.get(cacheKey);
        if (cached) return cached;
        const result = await ollamaService.forecastEarnings(symbol, daysToEarnings, headlines, fundamentals);
        if (result) cacheService.set(cacheKey, result, CACHE_TTL);
        return result;
    }
    return null;

    // ── Legacy Claude path (unreachable when Ollama is enabled) ──
    if (daysToEarnings === null || daysToEarnings < WINDOW_MIN || daysToEarnings > WINDOW_MAX) return null;

    const cacheKey = `prophet_${symbol}_${Math.floor(Date.now() / CACHE_TTL)}`;
    const cached   = cacheService.get(cacheKey);
    if (cached) return cached;

    const egPct = fundamentals?.earningsGrowth != null
        ? `${(fundamentals.earningsGrowth * 100).toFixed(0)}% YoY`
        : 'unknown';
    const rgPct = fundamentals?.revenueGrowth != null
        ? `${(fundamentals.revenueGrowth * 100).toFixed(0)}% YoY`
        : 'unknown';

    const headlineBlock = headlines.length > 0
        ? headlines.slice(0, 8).map((h, i) => `${i + 1}. ${h}`).join('\n')
        : '(no recent headlines)';

    const prompt =
        `You are PROPHET, PANTHEON's earnings forecaster. Earnings for ${symbol} are ${daysToEarnings} days away.\n\n` +
        `FUNDAMENTALS:\n- EPS growth (TTM): ${egPct}\n- Revenue growth (TTM): ${rgPct}\n\n` +
        `RECENT NEWS:\n${headlineBlock}\n\n` +
        `Based ONLY on the above data, predict the most likely earnings outcome.\n` +
        `Reply with ONLY a valid JSON object, no markdown:\n` +
        `{"verdict":"BEAT|IN_LINE|MISS","confidence":"HIGH|MEDIUM|LOW","thesis":"1 sentence"}\n\n` +
        `Definitions: BEAT=EPS above consensus, MISS=EPS below, IN_LINE=roughly as expected.\n` +
        `Be conservative — default to IN_LINE when evidence is weak.`;

    try {
        const client   = getClient();
        const response = await client.messages.create({
            model: MODEL,
            max_tokens: 100,
            messages:   [{ role: 'user', content: prompt }]
        });

        const raw    = response.content?.[0]?.text || '';
        const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());

        const verdict    = ['BEAT', 'IN_LINE', 'MISS'].includes(parsed.verdict) ? parsed.verdict : 'IN_LINE';
        const confidence = ['HIGH', 'MEDIUM', 'LOW'].includes(parsed.confidence) ? parsed.confidence : 'LOW';
        const thesis     = String(parsed.thesis || '').slice(0, 200);

        const adjMap = {
            'BEAT:HIGH': +8, 'BEAT:MEDIUM': +4, 'BEAT:LOW': +2,
            'IN_LINE:HIGH': 0, 'IN_LINE:MEDIUM': 0, 'IN_LINE:LOW': 0,
            'MISS:HIGH': -8, 'MISS:MEDIUM': -4, 'MISS:LOW': -2
        };
        const scoreAdj = adjMap[`${verdict}:${confidence}`] ?? 0;

        const result = { verdict, confidence, thesis, scoreAdj, source: 'prophet' };
        cacheService.set(cacheKey, result, CACHE_TTL);
        logger.info(`[PROPHET] ${symbol}: ${verdict}/${confidence} adj=${scoreAdj} (${daysToEarnings}d away)`);
        return result;

    } catch (err) {
        logger.warn(`[PROPHET] ${symbol} failed: ${err.message}`);
        return null;
    }
}

module.exports = {
    forecastEarnings,
    isEnabled: () => ollamaService.isEnabled(),
};
