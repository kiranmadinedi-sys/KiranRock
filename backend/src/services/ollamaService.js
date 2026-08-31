/**
 * Ollama Service — Local LLM backend (zero API cost)
 * ====================================================
 * Replaces ALL Anthropic/Claude API calls with a locally-running Ollama model.
 * Data never leaves your machine. No usage charges.
 *
 * Setup (one-time):
 *   ollama pull llama3.2:3b
 *
 * Environment variables (.env):
 *   OLLAMA_BASE_URL   http://localhost:11434  (required to enable)
 *   OLLAMA_MODEL      llama3.2:3b             (default)
 *   OLLAMA_TIMEOUT_MS 45000                   (generous for first-token latency)
 *
 * Capabilities:
 *   ORACLE trade verdicts         → getVerdict() / getVerdictWithDBHistory()
 *   PROPHET earnings forecasts    → forecastEarnings()
 *   Weekly market reports         → generate() via claudeMarketAnalysisService
 *   Backtest narrative            → explainBacktestResults()
 *   Local brain coaching          → explainLocalBrain()
 */

const { logger }     = require('../utils/logger');
const cacheService   = require('./cacheService');

const BASE_URL   = process.env.OLLAMA_BASE_URL  || '';
const MODEL      = process.env.OLLAMA_MODEL     || 'llama3.2:3b';
const TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '45000', 10);

// Second, faster model for latency-sensitive real-time callers (live per-user trading
// cycles) — MODEL stays the thorough 27B for the nightly batch scan, which has hours,
// not seconds, to work with. Added 2026-08-31: this box runs qwen3.8:27b on 100% CPU
// (no usable GPU offload — confirmed via `ollama ps`, size_vram:0), and today's real
// concurrent live-trading demand pushed per-request queue waits to 27s-342s, with the
// queue-full fail-fast (depth 5) dropping verdicts outright — anilboddu1's live cycles
// timed out 8x in a row (>4min each) as a direct result. qwen2.5:7b-instruct is ~4x
// smaller (4.7GB vs 17GB) and meaningfully faster on CPU while still a real instruct
// model — not reverting to llama3.2:3b, which was already tried and rejected for
// "templated" ORACLE verdicts (2026-08-27).
const FAST_MODEL = process.env.OLLAMA_MODEL_LIVE || 'qwen2.5:7b-instruct-q4_K_M';

// 15-min verdict cache — intraday setup doesn't shift faster than this.
// Prevents re-running Ollama on the same stock every scan cycle (every ~10 min).
const ORACLE_CACHE_TTL_MS = 15 * 60 * 1000;
const _oracleCacheWindow  = () => Math.floor(Date.now() / ORACLE_CACHE_TTL_MS);

if (BASE_URL) {
    logger.info(`[Ollama] Local LLM enabled — ${BASE_URL}  model=${MODEL} (batch)  fastModel=${FAST_MODEL} (live)`);
} else {
    logger.warn('[Ollama] OLLAMA_BASE_URL not set — local AI disabled. Set it in .env to activate.');
}

// ─── ORACLE master system prompt ──────────────────────────────────────────────
const ORACLE_SYSTEM =
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

// ─── Concurrency queue ─────────────────────────────────────────────────────
// Added 2026-08-28. Every caller in this file (ORACLE, PROPHET, PULSE's
// fallback, backtest narrative, local-brain coaching, chat) shares this one
// Ollama server, and `ollama ps` confirms it's running the 27B model with
// size_vram:0 — pure CPU inference, no GPU offload on this box. Confirmed live
// the same night: ORACLE calls that took ~36.5s isolated started timing out at
// 60s under real conditions, and PULSE calls (normally a short ~120-token task)
// were logged taking 30-45s. Two CPU-bound generations "running concurrently"
// don't get more compute — they just split the same cores, making both slower
// and more likely to blow past their own timeout. Queuing to MAX_CONCURRENT=1
// means every request gets the full CPU to itself; callers wait in FIFO order
// instead of silently competing. Revisit raising this only if this box ever
// gets real GPU offload (size_vram > 0) for this model.
const MAX_CONCURRENT_OLLAMA = 1;
// Added same night as the queue itself, found actively happening in production:
// the nightly scan's sheer request volume (500+ candidates, each wanting a
// PULSE and/or ORACLE call) completely swamped the single FIFO lane — a live
// trading cycle's own Ollama call got stuck behind 227 queued requests,
// confirmed live: "Request waited 8076.8s in queue (227 still behind it)"
// (2.24 HOURS). That starved the live per-user trading cycle, which has its
// own internal >4min timeout, causing 3 consecutive real "bot may be stuck"
// alerts. A pure FIFO queue with unbounded depth has no way to protect a
// latency-sensitive caller from a high-volume one sharing the same lane.
// Bounding queue depth converts "wait unboundedly, however long that takes"
// into "fail fast past this point" — every caller here already has a
// try/catch + neutral/null fallback for an Ollama failure (that's the whole
// design these features already treat this local server as: optional,
// never load-bearing), so failing fast is a correct degrade, not a new risk.
// Real priority-based scheduling (let live-trading calls jump the nightly
// scan's queue rather than just capping it) is the more correct fix but a
// bigger change — this is the safe stopgap for tonight.
const MAX_OLLAMA_QUEUE_DEPTH = 5;
let _activeOllamaRequests = 0;
const _ollamaQueue = [];

async function _acquireOllamaSlot() {
    if (_activeOllamaRequests < MAX_CONCURRENT_OLLAMA) {
        _activeOllamaRequests++;
        return;
    }
    if (_ollamaQueue.length >= MAX_OLLAMA_QUEUE_DEPTH) {
        throw new Error(`Ollama queue full (${_ollamaQueue.length} already waiting) — failing fast instead of piling on`);
    }
    const queuedAt = Date.now();
    await new Promise(resolve => _ollamaQueue.push(resolve));
    _activeOllamaRequests++;
    const waitedMs = Date.now() - queuedAt;
    if (waitedMs > 2000) {
        logger.info(`[Ollama] Request waited ${(waitedMs / 1000).toFixed(1)}s in queue (${_ollamaQueue.length} still behind it)`);
    }
}

function _releaseOllamaSlot() {
    _activeOllamaRequests--;
    const next = _ollamaQueue.shift();
    if (next) next();
}

// ─── HTTP helper (native — no extra npm packages) ────────────────────────────
async function _post(path, body) {
    await _acquireOllamaSlot();
    try {
        return await _rawPost(path, body);
    } finally {
        _releaseOllamaSlot();
    }
}

async function _rawPost(path, body) {
    const url     = new URL(path, BASE_URL);
    const payload = JSON.stringify(body);
    const isHttps = url.protocol === 'https:';
    const http    = isHttps ? require('https') : require('http');

    return new Promise((resolve, reject) => {
        const options = {
            hostname: url.hostname,
            port:     url.port || (isHttps ? 443 : 80),
            path:     url.pathname + url.search,
            method:   'POST',
            headers:  {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout: TIMEOUT_MS,
        };

        const req = http.request(options, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end',  () => {
                try   { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                catch (e) { reject(new Error(`Ollama JSON parse failed: ${e.message}`)); }
            });
        });

        req.on('timeout', () => { req.destroy(); reject(new Error('Ollama request timeout')); });
        req.on('error',   reject);
        req.write(payload);
        req.end();
    });
}

// Safely extract first {...} JSON block from raw model output
function _extractJSON(raw) {
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const match   = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new SyntaxError('No JSON object found in model response');
    return JSON.parse(match[0]);
}

// ─── 1. Core text generation ──────────────────────────────────────────────────
/**
 * Generate free-form text using the local Ollama model.
 * Used for reports, narratives, coaching insights.
 *
 * @param {string} userPrompt
 * @param {string} [systemPrompt]
 * @param {object} [options]  — temperature, maxTokens, model
 * @returns {Promise<string>}
 */
async function generate(userPrompt, systemPrompt = '', options = {}) {
    if (!BASE_URL) return '';

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });

    try {
        const res = await _post('/api/chat', {
            model:  options.model || (options.fast ? FAST_MODEL : MODEL),
            stream: false,
            // think:false — added 2026-08-27 alongside the switch to a "thinking"-capable
            // model (qwen3.8:27b). Without this, the model spends its entire num_predict
            // budget on an internal reasoning trace and never emits the actual answer —
            // confirmed live: a 450-token ORACLE call returned empty content, 100% consumed
            // by <thinking>. Every caller here wants a short direct answer (sentiment score,
            // narrative text), not visible chain-of-thought.
            think:  false,
            messages,
            options: {
                temperature: options.temperature ?? 0.4,
                num_predict: options.maxTokens   ?? 2000,
            },
        });
        return res?.message?.content || '';
    } catch (err) {
        logger.warn(`[Ollama] generate() failed: ${err.message}`);
        return '';
    }
}

// ─── 2. ORACLE verdict (JSON) ─────────────────────────────────────────────────
/**
 * Run ORACLE trade verdict through the local model.
 * Same interface as oracleService.getVerdict().
 *
 * @param {object} data — stock snapshot from enhancedAITradingBot
 * @returns {Promise<object|null>}
 */
async function getVerdict(data) {
    if (!BASE_URL) return null;

    // data.fast (set by live per-user trading cycles, unset for the nightly batch scan)
    // routes this call to the smaller/faster model — see FAST_MODEL comment above.
    // Cache key includes it so a live-hours verdict and a nightly-batch verdict for the
    // same symbol/window never collide and serve each other's (different-model) result.
    const modelUsed = data.fast ? FAST_MODEL : MODEL;
    // Cache hit — skip Ollama entirely if this symbol was analyzed in the current 15-min window
    const cacheKey = `ollama_oracle_${data.symbol}_${_oracleCacheWindow()}_${data.fast ? 'fast' : 'batch'}`;
    const cached   = cacheService.get(cacheKey);
    if (cached) {
        logger.debug(`[Ollama/ORACLE] ${data.symbol}: cached verdict reused (${cached.verdict})`);
        return cached;
    }

    const summary = [
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
        `Market Regime: ${data.regime || 'N/A'}`,
    ].join('\n');

    const historySection = data.priceHistory
        ? `\n\nRECENT PRICE HISTORY (${data.priceHistoryDays} trading days):\n${data.priceHistory}`
        : '';

    const userPrompt =
        `Analyse ${data.symbol} for a US equity swing trade.\n\n` +
        `MARKET DATA:\n${summary}${historySection}\n\n` +
        `Provide your ORACLE verdict as strict JSON:\n` +
        `{"symbol":"${data.symbol}","verdict":"TRADE|WATCHLIST|SKIP","score":<0-100>,` +
        `"stage":"<1-4>","pattern":"<VCP|Cup|Flag|Darvas|None>",` +
        `"entry":<price>,"stop":<price>,"target":<price>,"risk_reward":"<X:1>",` +
        `"position_size_pct":<0-15>,` +
        `"confidence":"<HIGH|MEDIUM|LOW>","thesis":"<2 sentence bull case>",` +
        `"bear_case":"<1 sentence key risk>","key_risk":"<biggest single risk>",` +
        `"master_alignment":["<up to 3 masters who agree>"]}`;

    try {
        const res = await _post('/api/chat', {
            model:    modelUsed,
            stream:   false,
            // think:false — required for qwen3.8:27b to emit an answer at all (see generate()'s
            // comment). Harmless no-op for FAST_MODEL (qwen2.5:7b-instruct isn't a "thinking" model).
            think:    false,
            messages: [
                { role: 'system', content: ORACLE_SYSTEM },
                { role: 'user',   content: userPrompt },
            ],
            options: { temperature: 0.1, num_predict: 450 },
        });

        const raw    = res?.message?.content || '';
        const parsed = _extractJSON(raw);

        const verdict         = ['TRADE', 'WATCHLIST', 'SKIP'].includes(parsed.verdict) ? parsed.verdict : 'WATCHLIST';
        const score           = Math.max(0, Math.min(100, Number(parsed.score) || 50));
        const positionSizePct = Math.max(0, Math.min(15, Number(parsed.position_size_pct) || 0));

        const result = {
            symbol:          data.symbol,
            verdict,
            score,
            stage:           String(parsed.stage   || data.stage),
            pattern:         String(parsed.pattern  || 'None'),
            entry:           Number(parsed.entry    || data.entry),
            stop:            Number(parsed.stop     || data.stop),
            target:          Number(parsed.target   || data.target),
            riskReward:      String(parsed.risk_reward || `${data.riskReward?.toFixed(1)}:1`),
            positionSizePct,
            confidence:      ['HIGH', 'MEDIUM', 'LOW'].includes(parsed.confidence) ? parsed.confidence : 'MEDIUM',
            thesis:          String(parsed.thesis    || '').slice(0, 300),
            bearCase:        String(parsed.bear_case || '').slice(0, 200),
            keyRisk:         String(parsed.key_risk  || '').slice(0, 200),
            masterAlignment: Array.isArray(parsed.master_alignment) ? parsed.master_alignment : [],
            source:          'ollama',
        };

        cacheService.set(cacheKey, result, ORACLE_CACHE_TTL_MS);
        logger.info(`[Ollama/ORACLE] ${data.symbol} (${modelUsed}): ${verdict} score=${score} ${result.confidence} size=${positionSizePct}%`);
        return result;

    } catch (err) {
        logger.warn(`[Ollama/ORACLE] ${data.symbol} (${modelUsed}) verdict failed: ${err.message}`);
        return null;
    }
}

// ─── 3. DB-enriched ORACLE verdict ───────────────────────────────────────────
/**
 * Same as getVerdict() but first fetches up to 60 days of OHLCV from
 * the ohlcv_cache table, giving the model real price-history context
 * to identify patterns (VCP, Cup & Handle, trend direction, volume trend).
 *
 * Falls back to basic getVerdict() if DB history is unavailable.
 */
async function getVerdictWithDBHistory(data) {
    if (!BASE_URL) return null;

    let enriched = { ...data };

    try {
        const { query } = require('../config/database');
        const res = await query(`
            SELECT date, open, high, low, close, volume
            FROM ohlcv_cache
            WHERE symbol = $1
            ORDER BY date DESC
            LIMIT 60
        `, [data.symbol]);

        if (res.rows.length >= 10) {
            const rows   = res.rows.slice().reverse(); // oldest first
            const header = 'Date       |  Open  |  High  |   Low  | Close  |   Volume';
            const sep    = '-----------+--------+--------+--------+--------+----------';
            const lines  = rows.map(r => {
                const dt  = String(r.date).slice(0, 10);
                const o   = Number(r.open ).toFixed(2).padStart(6);
                const h   = Number(r.high ).toFixed(2).padStart(6);
                const l   = Number(r.low  ).toFixed(2).padStart(6);
                const c   = Number(r.close).toFixed(2).padStart(6);
                const vol = (Math.round(Number(r.volume) / 1000) + 'K').padStart(8);
                return `${dt} | ${o} | ${h} | ${l} | ${c} | ${vol}`;
            });

            enriched.priceHistory     = [header, sep, ...lines].join('\n');
            enriched.priceHistoryDays = rows.length;
            logger.debug(`[Ollama] ${data.symbol}: enriched with ${rows.length} OHLCV rows from DB`);
        }
    } catch (err) {
        logger.debug(`[Ollama] ${data.symbol}: OHLCV DB history unavailable — ${err.message}`);
    }

    return getVerdict(enriched);
}

// ─── 4. PROPHET earnings forecast ────────────────────────────────────────────
/**
 * Predict earnings direction (BEAT / IN_LINE / MISS) using the local model.
 * Same interface as prophetService.forecastEarnings().
 *
 * Only fires when daysToEarnings is within [PROPHET_WINDOW_MIN, PROPHET_WINDOW_MAX].
 */
async function forecastEarnings(symbol, daysToEarnings, headlines = [], fundamentals = null) {
    if (!BASE_URL) return null;

    const WINDOW_MIN = parseInt(process.env.PROPHET_WINDOW_MIN_DAYS || '15', 10);
    const WINDOW_MAX = parseInt(process.env.PROPHET_WINDOW_MAX_DAYS || '45', 10);
    if (daysToEarnings === null || daysToEarnings < WINDOW_MIN || daysToEarnings > WINDOW_MAX) return null;

    const egPct = fundamentals?.earningsGrowth != null
        ? `${(fundamentals.earningsGrowth * 100).toFixed(0)}% YoY` : 'unknown';
    const rgPct = fundamentals?.revenueGrowth  != null
        ? `${(fundamentals.revenueGrowth  * 100).toFixed(0)}% YoY` : 'unknown';

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
        const raw    = await generate(prompt, '', { maxTokens: 130, temperature: 0.1 });
        const parsed = _extractJSON(raw);

        const verdict    = ['BEAT', 'IN_LINE', 'MISS'].includes(parsed.verdict) ? parsed.verdict : 'IN_LINE';
        const confidence = ['HIGH', 'MEDIUM', 'LOW'].includes(parsed.confidence) ? parsed.confidence : 'LOW';
        const thesis     = String(parsed.thesis || '').slice(0, 200);

        const adjMap = {
            'BEAT:HIGH': +8,  'BEAT:MEDIUM': +4,   'BEAT:LOW': +2,
            'IN_LINE:HIGH': 0,'IN_LINE:MEDIUM': 0,  'IN_LINE:LOW': 0,
            'MISS:HIGH': -8,  'MISS:MEDIUM': -4,    'MISS:LOW': -2,
        };
        const scoreAdj = adjMap[`${verdict}:${confidence}`] ?? 0;

        logger.info(`[Ollama/PROPHET] ${symbol}: ${verdict}/${confidence} adj=${scoreAdj} (${daysToEarnings}d away)`);
        return { verdict, confidence, thesis, scoreAdj, source: 'ollama-prophet' };

    } catch (err) {
        logger.warn(`[Ollama/PROPHET] ${symbol} failed: ${err.message}`);
        return null;
    }
}

// ─── 5. Backtest narrative ────────────────────────────────────────────────────
/**
 * Generate a plain-English narrative for a set of backtest statistics.
 *
 * @param {string} symbol — ticker or null for portfolio-wide
 * @param {object} stats  — { totalReturn, spyReturn, sharpe, calmar,
 *                            maxDrawdown, winRate, totalTrades, profitFactor }
 * @returns {Promise<string|null>}
 */
async function explainBacktestResults(symbol, stats) {
    if (!BASE_URL) return null;

    const label = symbol ? `$${symbol}` : 'this portfolio';

    const prompt =
        `You are a quantitative analyst explaining backtest results for ${label} to a retail investor.\n\n` +
        `BACKTEST STATISTICS:\n` +
        `- Total Return:       ${stats.totalReturn  != null ? stats.totalReturn.toFixed(2)  + '%' : 'N/A'}\n` +
        `- SPY Benchmark:      ${stats.spyReturn     != null ? stats.spyReturn.toFixed(2)    + '%' : 'N/A'}\n` +
        `- Sharpe Ratio:       ${stats.sharpe        != null ? stats.sharpe.toFixed(2)        : 'N/A'}\n` +
        `- Calmar Ratio:       ${stats.calmar        != null ? stats.calmar.toFixed(2)        : 'N/A'}\n` +
        `- Max Drawdown:       ${stats.maxDrawdown   != null ? stats.maxDrawdown.toFixed(2)  + '%' : 'N/A'}\n` +
        `- Win Rate:           ${stats.winRate       != null ? stats.winRate.toFixed(1)      + '%' : 'N/A'}\n` +
        `- Total Trades:       ${stats.totalTrades   ?? 'N/A'}\n` +
        `- Profit Factor:      ${stats.profitFactor  != null ? stats.profitFactor.toFixed(2) : 'N/A'}\n\n` +
        `Write exactly 4 plain sentences:\n` +
        `1. Did the strategy beat SPY? State the alpha clearly.\n` +
        `2. Is the risk acceptable? (Sharpe > 1.5 and Max Drawdown < 15% = good)\n` +
        `3. Is the win rate high enough to trust this strategy live?\n` +
        `4. Clear recommendation: go live / keep testing / adjust stop-loss. Be direct.\n` +
        `No jargon, no hedging, no disclaimers.`;

    return generate(prompt, '', { maxTokens: 300, temperature: 0.35 });
}

// ─── 6. Local brain coaching narrative ───────────────────────────────────────
/**
 * Generate actionable coaching advice based on the local brain snapshot
 * (what has worked historically for THIS account).
 *
 * @param {object} snapshot — from localBrainService.getBrainSnapshot()
 * @returns {Promise<string|null>}
 */
async function explainLocalBrain(snapshot) {
    if (!BASE_URL || !snapshot?.active) return null;

    const fmt = (obj, minTrades = 5) =>
        Object.entries(obj || {})
            .filter(([, v]) => v.total >= minTrades)
            .sort(([, a], [, b]) => b.winRate - a.winRate)
            .slice(0, 4)
            .map(([k, v]) =>
                `${k}: ${(v.winRate * 100).toFixed(0)}% win rate  ` +
                `(${v.total} trades, avg PnL $${v.avgPnl?.toFixed(0) ?? '?'})`
            )
            .join('\n') || 'Not enough data';

    const prompt =
        `You are a trading coach reviewing a student's actual trade history.\n\n` +
        `OVERALL: ${snapshot.totalTrades} closed trades, ` +
        `${(snapshot.overallWinRate * 100).toFixed(1)}% win rate\n\n` +
        `BY SECTOR:\n${fmt(snapshot.bySector)}\n\n` +
        `BY CHART PATTERN:\n${fmt(snapshot.byPattern)}\n\n` +
        `BY MARKET REGIME:\n${fmt(snapshot.byRegime, 3)}\n\n` +
        `Give exactly 4 bullet points of coaching advice:\n` +
        `• What this trader should do MORE of (highest edge)\n` +
        `• What to do LESS of (worst edge)\n` +
        `• Which market regime to avoid or reduce size in\n` +
        `• One specific habit change to improve win rate\n` +
        `Be direct. Use the actual numbers. No generic advice.`;

    return generate(prompt, '', { maxTokens: 350, temperature: 0.45 });
}

// ─── 7. Natural Language Chat ─────────────────────────────────────────────────
/**
 * Chat function for natural language conversations.
 * Handles informal language, spelling mistakes, and casual queries.
 *
 * @param {Array} messages — Array of message objects with role and content
 * @param {object} [options] — Optional settings
 * @returns {Promise<string>}
 */
async function chat(messages, options = {}) {
    if (!BASE_URL) return 'Local AI service is not available. Please ensure Ollama is running.';

    try {
        const res = await _post('/api/chat', {
            model: options.model || MODEL,
            stream: false,
            think: false, // see generate()'s comment — same "thinking" model behavior applies here
            messages,
            options: {
                temperature: options.temperature ?? 0.7, // Higher for more natural responses
                num_predict: options.maxTokens ?? 1500,
                top_p: 0.9,
                repeat_penalty: 1.1,
            },
        });
        return res?.message?.content || 'Sorry, I could not generate a response.';
    } catch (err) {
        logger.warn(`[Ollama] chat() failed: ${err.message}`);
        return 'I\'m having trouble connecting to the AI service right now. Please try again in a moment.';
    }
}

/** Returns true when Ollama is configured and reachable (URL set). */
function isEnabled() {
    return !!BASE_URL;
}

module.exports = {
    generate,
    getVerdict,
    getVerdictWithDBHistory,
    forecastEarnings,
    explainBacktestResults,
    explainLocalBrain,
    chat,
    isEnabled,
};
