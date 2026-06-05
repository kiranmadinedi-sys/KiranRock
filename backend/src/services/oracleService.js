/**
 * ORACLE — Trade Strategist (PANTHEON agent)
 *
 * Runs the ORACLE Master Prompt per stock using Claude.
 * Bull vs Bear debate → 8-step scoring → strict JSON verdict.
 *
 * Supplements code-based scoring in enhancedAITradingBot.js.
 * Only fires when ANTHROPIC_API_KEY is set and pre-score ≥ 55.
 *
 * Output verdict adjusts the final code score:
 *   TRADE   → +10 (Claude confirms edge)
 *   WATCHLIST → 0 (neutral)
 *   SKIP    → -15 (Claude red-flags it)
 */

const Anthropic      = require('@anthropic-ai/sdk');
const cacheService   = require('./cacheService');
const { logger }     = require('../utils/logger');
const ollamaService  = require('./ollamaService');

const API_KEY  = process.env.ANTHROPIC_API_KEY || '';
const MODEL    = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const CACHE_TTL = 30 * 60 * 1000; // 30 min — intraday signals don't shift fast

// Claude is a cost-incurring fallback. It only fires when ALL of:
//   1. Ollama is not running (primary AI)
//   2. ANTHROPIC_API_KEY is set
//   3. ORACLE_ALLOW_CLAUDE_FALLBACK=true (explicit opt-in)
// Default is false — Ollama down → code-score-only, zero API spend.
const ALLOW_CLAUDE_FALLBACK =
    (process.env.ORACLE_ALLOW_CLAUDE_FALLBACK || 'false').toLowerCase() === 'true';

if (!API_KEY) {
    logger.info('[ORACLE] ANTHROPIC_API_KEY not set — Claude path disabled. Ollama is primary.');
} else if (!ALLOW_CLAUDE_FALLBACK) {
    logger.info('[ORACLE] ORACLE_ALLOW_CLAUDE_FALLBACK=false — Claude fallback disabled. Set true to enable.');
}

let _client = null;
function getClient() {
    if (!_client) _client = new Anthropic({ apiKey: API_KEY });
    return _client;
}

const SYSTEM_PROMPT =
    `You are the PANTHEON Signal Agent. You think simultaneously like:
Minervini (SEPA) + O'Neil (CANSLIM) + Livermore (patience) + Weinstein (stage)
+ Wyckoff (volume) + Jones (risk-first) + Darvas (boxes) + Druckenmiller (concentration)

BULL vs BEAR DEBATE: Before scoring, run two sub-analyses simultaneously.
Bull analyst: strongest case to BUY. Bear analyst: strongest case to SKIP.
ORACLE synthesises both into the final score.

STEP 1 — WEINSTEIN GATE: Stage 3 or 4 = SKIP immediately.
STEP 2 — TREND TEMPLATE (0-25): 5 MA conditions x 5 pts each.
STEP 3 — PATTERN (0-20): VCP=10, Cup&Handle=9, Darvas=8, None=0.
STEP 4 — CANSLIM (0-20): EPS 25%+=8, Rev 20%+=6, Margins+3, Catalyst+3.
STEP 5 — WYCKOFF VOLUME (0-15): VDU+5, Up>Down vol+5, Breakout vol+5.
STEP 6 — JONES R/R (0-15): >=3:1=15, >=2:1=10, <2:1=0 SKIP.
STEP 7 — GEMINI BONUS: Bullish+5, Neutral=0, Bearish=-10.
STEP 8 — SMART MONEY BONUS: Institutional confirmed+8, Insider buy+5.
VERDICT: >=70 TRADE, 50-69 WATCHLIST, <50 SKIP.

Reply with ONLY valid JSON — no markdown, no explanation outside JSON.`;

/**
 * Run ORACLE Claude verdict for a stock.
 *
 * @param {object} data — { symbol, price, stage, pattern, rsi, macd, atr,
 *                          sma50, sma150, sma200, volume, avgVolume,
 *                          earningsGrowth, revenueGrowth, daysToEarnings,
 *                          geminiLabel, smartMoneyScore, sectorRank,
 *                          riskReward, entry, stop, target, regime }
 * @returns {Promise<object|null>}  ORACLE JSON verdict or null if disabled/failed
 */
async function getVerdict(data) {
    // Always prefer local Ollama — zero API cost, DB-enriched with OHLCV history
    if (ollamaService.isEnabled()) return ollamaService.getVerdictWithDBHistory(data);

    // Claude path: requires explicit ORACLE_ALLOW_CLAUDE_FALLBACK=true to prevent surprise charges
    if (!API_KEY || !ALLOW_CLAUDE_FALLBACK) return null;

    const cacheKey = `oracle_${data.symbol}_${new Date().toISOString().slice(0, 13)}h`;
    const cached   = cacheService.get(cacheKey);
    if (cached) return cached;

    const ohlcvSummary = [
        `Price: $${data.price}`,
        `Stage: ${data.stage}`,
        `Pattern: ${data.pattern || 'None'}`,
        `RSI: ${data.rsi}`,
        `MACD: ${data.macd}`,
        `ATR: ${data.atr}`,
        `SMA50: ${data.sma50?.toFixed(2) || 'N/A'}`,
        `SMA150: ${data.sma150?.toFixed(2) || 'N/A'}`,
        `SMA200: ${data.sma200?.toFixed(2) || 'N/A'}`,
        `Volume: ${data.volume?.toLocaleString() || 'N/A'} (avg ${data.avgVolume?.toLocaleString() || 'N/A'})`,
        `EPS Growth: ${data.earningsGrowth != null ? (data.earningsGrowth * 100).toFixed(0) + '%' : 'N/A'}`,
        `Revenue Growth: ${data.revenueGrowth != null ? (data.revenueGrowth * 100).toFixed(0) + '%' : 'N/A'}`,
        `Days To Earnings: ${data.daysToEarnings ?? 'N/A'}`,
        `Gemini Sentiment: ${data.geminiLabel || 'N/A'}`,
        `Smart Money Score: ${data.smartMoneyScore ?? 'N/A'}`,
        `Sector Rank: ${data.sectorRank || 'N/A'}`,
        `R/R: ${data.riskReward?.toFixed(1) || 'N/A'}:1`,
        `Entry: $${data.entry}, Stop: $${data.stop}, Target: $${data.target}`,
        `Market Regime: ${data.regime || 'N/A'}`
    ].join('\n');

        const userPrompt =
        `Analyse ${data.symbol} for a US equity swing trade.\n\n` +
        `MARKET DATA:\n${ohlcvSummary}\n\n` +
        `Provide your ORACLE verdict as strict JSON:\n` +
        `{"symbol":"${data.symbol}","verdict":"TRADE|WATCHLIST|SKIP","score":<0-100>,` +
        `"stage":"<1-4>","pattern":"<VCP|Cup|Flag|Darvas|None>",` +
        `"entry":<price>,"stop":<price>,"target":<price>,"risk_reward":"<X:1>",` +
        `"position_size_pct":<0-15>,` +
        `"confidence":"<HIGH|MEDIUM|LOW>","thesis":"<2 sentence bull case>",` +
        `"bear_case":"<1 sentence key risk>","key_risk":"<biggest single risk>",` +
        `"master_alignment":["<up to 3 masters who agree>"]}`;

    // Retry-once-after-10s per PANTHEON failure recovery spec
    async function callClaude(strictMode = false) {
        const client = getClient();
        // strictMode: used on JSON-parse retry — shorter, more explicit instruction
        const messages = strictMode
            ? [{
                role: 'user',
                content:
                    `IMPORTANT: Your previous response could not be parsed as JSON.\n` +
                    `Respond with ONLY a raw JSON object. No markdown, no ` + '```' + `, no commentary.\n\n` +
                    userPrompt
              }]
            : [{ role: 'user', content: userPrompt }];

        return client.messages.create({
            model:      MODEL,
            max_tokens: 320,
            system:     SYSTEM_PROMPT,
            messages
        });
    }

    let response;
    // --- Network/API error retry (10 s delay) ---
    try {
        response = await callClaude();
    } catch (firstErr) {
        logger.warn(`[ORACLE] ${data.symbol} first attempt failed — retrying in 10s`, { err: firstErr.message });
        await new Promise(r => setTimeout(r, 10000));
        try {
            response = await callClaude();
        } catch (retryErr) {
            logger.warn(`[ORACLE] ${data.symbol} retry also failed — skipping`, { err: retryErr.message });
            return null;
        }
    }

    // --- JSON parse with explicit-instruction retry on failure ---
    function tryParse(raw) {
        // Strip common wrapping patterns Claude sometimes emits
        const cleaned = raw
            .replace(/```json\s*/gi, '')
            .replace(/```\s*/gi, '')
            .trim();
        // Extract first {...} block in case of leading/trailing text
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (!match) throw new SyntaxError('No JSON object found in response');
        return JSON.parse(match[0]);
    }

    let parsed;
    try {
        const raw = response.content?.[0]?.text || '';
        parsed = tryParse(raw);
    } catch (parseErr) {
        // PANTHEON spec: "Retry with explicit JSON instruction, skip if fails."
        logger.warn(`[ORACLE] ${data.symbol} JSON parse failed — retrying with strict JSON prompt`, {
            err: parseErr.message,
            raw: (response.content?.[0]?.text || '').slice(0, 200)
        });
        try {
            const strictResponse = await callClaude(true /* strictMode */);
            const strictRaw = strictResponse.content?.[0]?.text || '';
            parsed = tryParse(strictRaw);
        } catch (retryParseErr) {
            logger.warn(`[ORACLE] ${data.symbol} strict-mode retry also failed — skipping`, {
                err: retryParseErr.message,
                raw: (response.content?.[0]?.text || '').slice(0, 200)
            });
            return null;
        }
    }

    const verdict = ['TRADE', 'WATCHLIST', 'SKIP'].includes(parsed.verdict) ? parsed.verdict : 'WATCHLIST';
    const score   = Math.max(0, Math.min(100, Number(parsed.score) || 50));
    // position_size_pct: Claude suggests %, capped at RISK_POLICY max 15
    const positionSizePct = Math.max(0, Math.min(15, Number(parsed.position_size_pct) || 0));

    const result = {
        symbol:          data.symbol,
        verdict,
        score,
        stage:           String(parsed.stage || data.stage),
        pattern:         String(parsed.pattern || 'None'),
        entry:           Number(parsed.entry  || data.entry),
        stop:            Number(parsed.stop   || data.stop),
        target:          Number(parsed.target || data.target),
        riskReward:      String(parsed.risk_reward || `${data.riskReward?.toFixed(1)}:1`),
        positionSizePct,
        confidence:      ['HIGH', 'MEDIUM', 'LOW'].includes(parsed.confidence) ? parsed.confidence : 'MEDIUM',
        thesis:          String(parsed.thesis    || '').slice(0, 300),
        bearCase:        String(parsed.bear_case || '').slice(0, 200),
        keyRisk:         String(parsed.key_risk  || '').slice(0, 200),
        masterAlignment: Array.isArray(parsed.master_alignment) ? parsed.master_alignment : [],
        source:          'oracle'
    };

    cacheService.set(cacheKey, result, CACHE_TTL);
    logger.info(`[ORACLE] ${data.symbol}: ${verdict} score=${score} ${result.confidence} size=${positionSizePct}%`);
    return result;
}

/**
 * Returns true if ORACLE can run.
 * Ollama takes priority — Claude is fallback only when Ollama is not running.
 */
function isEnabled() {
    return ollamaService.isEnabled() || !!API_KEY;
}

/** Map ORACLE verdict to score adjustment applied on top of code score.
 *  TRADE caps at +8 (was +12) — prevents a weak code score from being rescued by ORACLE alone.
 *  SKIP stays punitive: a red-flag from ORACLE should reliably kill the trade.
 */
function verdictToAdj(verdict, confidence) {
    if (verdict === 'TRADE') {
        return confidence === 'HIGH' ? 8 : confidence === 'MEDIUM' ? 5 : 3;
    }
    if (verdict === 'SKIP') {
        return confidence === 'HIGH' ? -15 : confidence === 'MEDIUM' ? -10 : -5;
    }
    return 0; // WATCHLIST → no change
}

module.exports = { getVerdict, verdictToAdj, isEnabled };
