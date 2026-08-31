/**
 * PULSE — Gemini News Analyst (PANTHEON agent)
 *
 * Uses Google Gemini to analyze news headlines for a stock and return a
 * structured sentiment score.  When GEMINI_API_KEY is absent the service
 * returns null so every caller falls back to the existing basic sentiment.
 *
 * Set in .env:
 *   GEMINI_API_KEY=your_key_here
 *   GEMINI_MODEL=gemini-2.0-flash-lite   (optional, default shown)
 */

const axios         = require('axios');
const cacheService  = require('./cacheService');
const ollamaService = require('./ollamaService');
const { logger }    = require('../utils/logger');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL   = process.env.GEMINI_MODEL   || 'gemini-2.0-flash-lite';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const CACHE_TTL      = 2 * 60 * 60 * 1000; // 2 hours — reduces daily quota burn significantly

// Once Gemini confirms quota exhaustion (429 on retry), stop calling it entirely
// for this long — avoids burning ~6s per symbol (throttle + 5s retry wait) on a
// call we already know will fail. Local Ollama picks up the slack in the meantime
// (see _analyzeWithOllama below), so a conservative cooldown costs nothing.
const GEMINI_QUOTA_COOLDOWN_MS = parseInt(process.env.GEMINI_QUOTA_COOLDOWN_MS || String(30 * 60 * 1000), 10);
let _quotaExhaustedUntil = 0;

function isGeminiQuotaExhausted() {
    return Date.now() < _quotaExhaustedUntil;
}

if (!GEMINI_API_KEY) {
    logger.warn('[PULSE/Gemini] GEMINI_API_KEY not configured — falling back to local Ollama if available');
}

// Global rate limiter: max 1 request per 1.5 seconds to stay well within 30 RPM free tier
let _lastCallTime = 0;
async function _throttle() {
    const now = Date.now();
    const gap = 1500 - (now - _lastCallTime);
    if (gap > 0) await new Promise(r => setTimeout(r, gap));
    _lastCallTime = Date.now();
}

async function _callGemini(prompt) {
    await _throttle();
    const resp = await axios.post(
        `${GEMINI_URL}?key=${GEMINI_API_KEY}`,
        {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 120 }
        },
        { timeout: 12000 }
    );
    return resp;
}

/**
 * Analyse recent news headlines for a stock symbol using Gemini.
 *
 * @param {string}   symbol    - Ticker symbol, e.g. 'NVDA'
 * @param {string[]} headlines - Array of recent headline strings (max 10 used)
 * @returns {Promise<{score:number, label:string, thesis:string}|null>}
 *   score 0-100 (50=neutral), label Bullish|Neutral|Bearish, thesis one-liner
 *   Returns null when API key is absent or call fails — callers must handle null.
 */
function _parsePulseJSON(raw) {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const match   = cleaned.match(/\{[\s\S]*\}/);
    const parsed  = JSON.parse(match ? match[0] : cleaned);
    return {
        score:  Math.max(0, Math.min(100, Number(parsed.score) || 50)),
        label:  ['Bullish', 'Neutral', 'Bearish'].includes(parsed.label) ? parsed.label : 'Neutral',
        thesis: String(parsed.thesis || '').slice(0, 200)
    };
}

function _buildPrompt(symbol, headlineBlock) {
    return `You are PULSE, a financial sentiment analyst for PANTHEON trading system.\n` +
        `Analyse these news items for ${symbol} stock.\n\n` +
        `HEADLINES:\n${headlineBlock}\n\n` +
        `Reply with ONLY a valid JSON object, no markdown fences:\n` +
        `{"score":<0-100>,"label":"<Bullish|Neutral|Bearish>","thesis":"<1 sentence>"}\n\n` +
        `Score guide: 70-100=Bullish, 40-69=Neutral, 0-39=Bearish`;
}

// Free, local fallback when Gemini is unconfigured, quota-exhausted, or failing.
// Uses the same locally-running Ollama model already powering ORACLE/PROPHET —
// zero API cost, no rate limit.
async function _analyzeWithOllama(symbol, headlineBlock, fast = false) {
    if (!ollamaService.isEnabled()) return null;
    try {
        const raw    = await ollamaService.generate(_buildPrompt(symbol, headlineBlock), '', { maxTokens: 120, temperature: 0.1, fast });
        if (!raw) return null;
        const result = _parsePulseJSON(raw);
        logger.info(`[PULSE/Ollama] ${symbol}: score=${result.score} ${result.label} (fallback${fast ? ', fast model' : ''})`);
        return { ...result, source: 'ollama' };
    } catch (err) {
        logger.warn(`[PULSE/Ollama] ${symbol} fallback failed: ${err.message}`);
        return null;
    }
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.fast] — true from a live per-user trading cycle, routes the
 *   Ollama fallback (when Gemini is down/exhausted) to the smaller/faster model
 *   instead of the nightly-scan default.
 */
async function analyzeHeadlines(symbol, headlines = [], opts = {}) {
    const cacheKey = `gemini_pulse_${symbol}`;
    const cached   = cacheService.get(cacheKey);
    if (cached) return cached;

    const headlineBlock = headlines.length > 0
        ? headlines.slice(0, 10).map((h, i) => `${i + 1}. ${h}`).join('\n')
        : '(No recent headlines available — provide general market sentiment)';

    if (GEMINI_API_KEY && !isGeminiQuotaExhausted()) {
        const prompt = _buildPrompt(symbol, headlineBlock);

        // Retry once on 429 (rate limit burst) with a 5-second back-off
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const resp   = await _callGemini(prompt);
                const raw    = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                const result = { ..._parsePulseJSON(raw), source: 'gemini' };

                cacheService.set(cacheKey, result, CACHE_TTL);
                logger.info(`[PULSE/Gemini] ${symbol}: score=${result.score} ${result.label}`);
                return result;

            } catch (err) {
                const status = err.response?.status;
                if (status === 429 && attempt === 1) {
                    logger.warn(`[PULSE/Gemini] ${symbol} rate-limited (429) — waiting 5s before retry`);
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }
                if (status === 429) {
                    _quotaExhaustedUntil = Date.now() + GEMINI_QUOTA_COOLDOWN_MS;
                    logger.warn(`[PULSE/Gemini] quota exhausted — pausing Gemini calls for ${Math.round(GEMINI_QUOTA_COOLDOWN_MS / 60000)}min, falling back to Ollama`);
                } else {
                    logger.warn(`[PULSE/Gemini] ${symbol} failed: ${status || err.message}`);
                }
                break; // fall through to Ollama below
            }
        }
    }

    const ollamaResult = await _analyzeWithOllama(symbol, headlineBlock, opts.fast);
    if (ollamaResult) {
        cacheService.set(cacheKey, ollamaResult, CACHE_TTL);
        return ollamaResult;
    }

    return null;
}

module.exports = {
    analyzeHeadlines,
    isEnabled: () => !!GEMINI_API_KEY || ollamaService.isEnabled(),
    isGeminiQuotaExhausted
};
