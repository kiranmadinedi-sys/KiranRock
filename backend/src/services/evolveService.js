/**
 * EVOLVE Lite — Decision-Table ML Signal
 * =======================================
 * Trains a feature-bucket win-rate table on 2Y of OHLCV data cached in
 * `ohlcv_cache`. Computes technical features for each bar, labels them
 * WIN (5-day forward return > 2%) or LOSS, then builds a lookup table by
 * feature-combo key.
 *
 * For a live stock it computes the same features on the most recent bars
 * and returns the historical win rate for that combo as a score boost.
 *
 * No GPU, no ML library — pure statistics on your own cached market data.
 * Model table rebuilds every 24 hours.
 *
 * Score contribution: −8 to +8 (component 22 in PANTHEON scoring pipeline)
 * Minimum sample threshold: 8 labelled bars before any adjustment fires.
 *
 * Usage (standalone backfill):
 *   node -e "require('./src/services/evolveService').train()"
 */

const historicalData = require('./historicalDataService');
const { logger }     = require('../utils/logger');

const REBUILD_INTERVAL_MS = 24 * 60 * 60 * 1000;  // 24 hours
const MIN_BARS_TRAIN      = 60;   // skip symbol if fewer bars in cache
const MIN_SAMPLES         = 8;    // min labelled bars before we trust a combo
const MAX_BOOST           = 8;    // ±8 per PANTHEON spec
const TRAIN_SYMBOLS       = 50;   // number of cached symbols to use for training

let _model       = null;  // { table, overallWR, trainedAt, symbolCount }
let _lastRebuild = 0;

// ─── Technical indicator helpers ─────────────────────────────────────────────

function _rsi(closes, period = 14) {
    if (closes.length < period + 1) return null;
    const changes = [];
    for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);

    let avgGain = 0, avgLoss = 0;
    for (let i = 0; i < period; i++) {
        if (changes[i] > 0) avgGain += changes[i];
        else avgLoss += Math.abs(changes[i]);
    }
    avgGain /= period;
    avgLoss /= period;

    for (let i = period; i < changes.length; i++) {
        const g = changes[i] > 0 ? changes[i] : 0;
        const l = changes[i] < 0 ? Math.abs(changes[i]) : 0;
        avgGain = (avgGain * (period - 1) + g) / period;
        avgLoss = (avgLoss * (period - 1) + l) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
}

function _ema(closes, period) {
    if (closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
    return ema;
}

function _macdHistogram(closes) {
    const fast = _ema(closes, 12);
    const slow = _ema(closes, 26);
    if (fast === null || slow === null) return null;
    return fast - slow;
}

/**
 * Compute the feature-bucket key for the most recent bar in the given price
 * history. Requires at least 35 bars (MACD warm-up).
 *
 * Key format: <rsi>|<macd>|<vol>|<prox>|<trend>
 *   rsi:   LOW (<40) | MID (40-60) | HIGH (>60)
 *   macd:  BULL (histogram>0) | BEAR (histogram≤0)
 *   vol:   Q (<0.8×avg) | N (0.8–1.5×avg) | H (>1.5×avg)
 *   prox:  NTH (>85% of 52wk high) | MID (70-85%) | LOW (<70%)
 *   trend: UP | FLAT | DOWN  (SMA20 vs SMA20 shifted 5 bars ago)
 */
function _featureBucket(bars) {
    if (bars.length < 35) return null;

    const closes  = bars.map(b => b.close);
    const volumes = bars.map(b => b.volume);

    // RSI
    const rsiVal    = _rsi(closes);
    const rsiBucket = rsiVal === null ? 'N'
        : rsiVal < 40 ? 'LOW'
        : rsiVal > 60 ? 'HIGH'
        : 'MID';

    // MACD histogram
    const macdH     = _macdHistogram(closes);
    const macdBucket = macdH === null ? 'N' : macdH > 0 ? 'BULL' : 'BEAR';

    // Volume ratio vs 20-day average
    const slice20  = volumes.slice(-20).filter(v => v > 0);
    const avgVol   = slice20.length ? slice20.reduce((a, b) => a + b, 0) / slice20.length : 1;
    const lastVol  = volumes[volumes.length - 1] || 0;
    const volRatio = avgVol > 0 ? lastVol / avgVol : 1;
    const volBucket = volRatio < 0.8 ? 'Q' : volRatio > 1.5 ? 'H' : 'N';

    // 52-week proximity (min 52 bars, else use available)
    const lookback = Math.min(252, closes.length);
    const high52   = Math.max(...closes.slice(-lookback));
    const last     = closes[closes.length - 1];
    const prox     = high52 > 0 ? last / high52 : 1;
    const proxBucket = prox > 0.85 ? 'NTH' : prox > 0.70 ? 'MID' : 'LOW';

    // Trend: SMA20 vs SMA20 from 5 bars ago
    const sma20now  = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const sma20prev = closes.slice(-25, -5).length === 20
        ? closes.slice(-25, -5).reduce((a, b) => a + b, 0) / 20
        : sma20now;
    const trendBucket = sma20now > sma20prev * 1.005 ? 'UP'
        : sma20now < sma20prev * 0.995 ? 'DOWN'
        : 'FLAT';

    return `${rsiBucket}|${macdBucket}|${volBucket}|${proxBucket}|${trendBucket}`;
}

// ─── Training ─────────────────────────────────────────────────────────────────

async function _trainOnSymbol(symbol) {
    const bars = await historicalData.getBars(symbol, 504);
    if (bars.length < MIN_BARS_TRAIN) return {};

    const table = {};
    // Need at least 35 bars of history + 5 forward bars, so start at i=34
    for (let i = 34; i < bars.length - 5; i++) {
        const slice  = bars.slice(0, i + 1);
        const bucket = _featureBucket(slice);
        if (!bucket) continue;

        const entry = bars[i].close;
        const exit  = bars[i + 5].close;
        const fwd5  = entry > 0 ? (exit - entry) / entry : 0;
        const win   = fwd5 > 0.02 ? 1 : 0;

        if (!table[bucket]) table[bucket] = { wins: 0, total: 0 };
        table[bucket].wins += win;
        table[bucket].total++;
    }
    return table;
}

async function train() {
    try {
        const cached = await historicalData.getCachedSymbols(MIN_BARS_TRAIN);
        const symbols = cached.slice(0, TRAIN_SYMBOLS).map(r => r.symbol);
        if (symbols.length === 0) {
            logger.info('[EVOLVE] No cached symbols — run historicalDataService.downloadAll() first');
            return null;
        }

        logger.info(`[EVOLVE] Training on ${symbols.length} symbols…`);
        const merged = {};

        for (const sym of symbols) {
            const t = await _trainOnSymbol(sym);
            for (const [key, val] of Object.entries(t)) {
                if (!merged[key]) merged[key] = { wins: 0, total: 0 };
                merged[key].wins  += val.wins;
                merged[key].total += val.total;
            }
        }

        // Compute win rates
        let overallWins = 0, overallTotal = 0;
        for (const v of Object.values(merged)) {
            v.winRate   = v.total > 0 ? v.wins / v.total : 0;
            overallWins  += v.wins;
            overallTotal += v.total;
        }
        const overallWR = overallTotal > 0 ? overallWins / overallTotal : 0.5;

        const model = {
            table:       merged,
            overallWR,
            trainedAt:   new Date().toISOString(),
            symbolCount: symbols.length,
            bucketCount: Object.keys(merged).length,
        };

        logger.info('[EVOLVE] Model built', {
            symbols:    model.symbolCount,
            buckets:    model.bucketCount,
            overallWR:  (overallWR * 100).toFixed(1) + '%',
            totalBars:  overallTotal,
        });

        _model       = model;
        _lastRebuild = Date.now();
        return model;

    } catch (err) {
        logger.warn('[EVOLVE] Training failed', { err: err.message });
        return null;
    }
}

async function _ensureFresh() {
    if (_model && (Date.now() - _lastRebuild) < REBUILD_INTERVAL_MS) return _model;
    return train();
}

// ─── Live signal ──────────────────────────────────────────────────────────────

/**
 * Compute EVOLVE score boost for a live stock symbol.
 *
 * @param {string} symbol
 * @returns {Promise<{ boost: number, reason: string, confidence: string }>}
 */
async function getScoreBoost(symbol) {
    try {
        const model = await _ensureFresh();
        if (!model) return { boost: 0, reason: 'no_model', confidence: 'NONE' };

        const bars = await historicalData.getBars(symbol, 100);
        if (bars.length < 35) return { boost: 0, reason: 'insufficient_bars', confidence: 'NONE' };

        const bucket = _featureBucket(bars);
        if (!bucket) return { boost: 0, reason: 'feature_error', confidence: 'NONE' };

        const cell = model.table[bucket];
        if (!cell || cell.total < MIN_SAMPLES) {
            return { boost: 0, reason: `no_pattern_data(${bucket})`, confidence: 'NONE' };
        }

        const edge  = cell.winRate - model.overallWR;
        const boost = _edgeToBoost(edge, cell.total);
        const confidence = cell.total >= 30 ? 'HIGH' : cell.total >= 15 ? 'MEDIUM' : 'LOW';

        return {
            boost,
            reason:     `evolve:${bucket} wr=${(cell.winRate * 100).toFixed(0)}% n=${cell.total}`,
            confidence,
        };
    } catch (err) {
        logger.warn(`[EVOLVE] getScoreBoost failed for ${symbol}`, { err: err.message });
        return { boost: 0, reason: 'error', confidence: 'NONE' };
    }
}

function _edgeToBoost(edge, sampleSize) {
    // ±20% win-rate edge = ±8 pts (linear scale)
    let raw = (edge / 0.20) * MAX_BOOST;
    raw = Math.max(-MAX_BOOST, Math.min(MAX_BOOST, raw));

    // Attenuate for small samples
    if (sampleSize < 15) raw *= 0.6;
    else if (sampleSize < 30) raw *= 0.8;

    return Math.round(raw);
}

/**
 * Return current model snapshot (for API/dashboard inspection).
 */
async function getModelSnapshot() {
    const model = await _ensureFresh();
    if (!model) return { active: false, reason: 'model_not_built' };
    return {
        active:      true,
        trainedAt:   model.trainedAt,
        symbolCount: model.symbolCount,
        bucketCount: model.bucketCount,
        overallWR:   model.overallWR,
        topBuckets:  Object.entries(model.table)
            .filter(([, v]) => v.total >= 20)
            .sort((a, b) => b[1].winRate - a[1].winRate)
            .slice(0, 10)
            .map(([k, v]) => ({ bucket: k, winRate: v.winRate, n: v.total })),
    };
}

// ── CLI runner ────────────────────────────────────────────────────────────────
if (require.main === module) {
    const { pool } = require('../config/database');
    (async () => {
        const model = await train();
        if (model) {
            console.log('[EVOLVE] Top 10 buckets by win rate (min 20 samples):');
            Object.entries(model.table)
                .filter(([, v]) => v.total >= 20)
                .sort((a, b) => b[1].winRate - a[1].winRate)
                .slice(0, 10)
                .forEach(([k, v]) => {
                    console.log(`  ${k}: ${(v.winRate * 100).toFixed(1)}% (n=${v.total})`);
                });
        }
        await pool.end();
    })();
}

module.exports = { getScoreBoost, train, getModelSnapshot };
