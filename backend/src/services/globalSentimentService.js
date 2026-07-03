/**
 * ATLAS — Global Market Sentiment Service  (PANTHEON Step 22.9)
 *
 * Synthesises international market signals into a single 0–1 score and a
 * per-stock point adjustment (±8 pts, ±2 sector overlay = max ±10 pts).
 *
 * ┌─────────────────────┬────────┬──────────────────────────────────────────────┐
 * │ Component           │ Weight │ Logic                                        │
 * ├─────────────────────┼────────┼──────────────────────────────────────────────┤
 * │ Asia-Pacific        │  20%   │ Nikkei + Hang Seng + Sensex + ASX avg %      │
 * │ Europe              │  20%   │ DAX + FTSE avg %                              │
 * │ US Futures (ES/NQ)  │  25%   │ Pre-market or latest % — most direct signal  │
 * │ Dollar Index (inv.) │  15%   │ DXY rise = headwind for most stocks          │
 * │ Commodities         │  10%   │ Oil (growth proxy) + Gold (risk-off proxy)   │
 * │ VIX regime          │  10%   │ Level + VVIX early-warning penalty            │
 * └─────────────────────┴────────┴──────────────────────────────────────────────┘
 *
 * Sector overlays (±2 pts on top of base adjustment):
 *   Technology / Comm Services  → extra DXY sensitivity (large foreign revenue)
 *   Energy                      → extra Oil sensitivity
 *   Materials / Gold miners     → extra Gold sensitivity
 *   Financials                  → DXY inverted (dollar strength = bank tailwind)
 */

const globalMarketConnector = require('../connectors/globalMarketConnector');
const cacheService           = require('./cacheService');
const { logger }             = require('../utils/logger');

const CACHE_KEY = 'atlas_global_sentiment';
const CACHE_TTL = 15 * 60 * 1000;  // mirrors connector cache

// ── DB persistence helpers ────────────────────────────────────────────────────
// Saves sentiment to global_sentiment_cache so the value survives worker restarts.
// On startup, getGlobalSentiment() reads this before hitting Yahoo — no 90-second wait
// on the first nightly scan stock after an overnight restart.

async function _persistToDb(result) {
    try {
        const { query } = require('../config/database');
        await query(
            `INSERT INTO global_sentiment_cache
                (id, sentiment_label, global_score, base_adj, breakdown, raw_data, updated_at)
             VALUES (1, $1, $2, $3, $4, $5, NOW())
             ON CONFLICT (id) DO UPDATE SET
                sentiment_label = EXCLUDED.sentiment_label,
                global_score    = EXCLUDED.global_score,
                base_adj        = EXCLUDED.base_adj,
                breakdown       = EXCLUDED.breakdown,
                raw_data        = EXCLUDED.raw_data,
                updated_at      = NOW()`,
            [
                result.label,
                result.globalScore,
                result.baseAdj,
                JSON.stringify(result.breakdown || {}),
                JSON.stringify(result.rawData   || {}),
            ]
        );
    } catch { /* non-fatal — DB write failure must never block the caller */ }
}

async function _loadFromDb() {
    try {
        const { query } = require('../config/database');
        const res = await query(
            `SELECT sentiment_label, global_score, base_adj, breakdown, raw_data, updated_at
             FROM global_sentiment_cache WHERE id = 1`
        );
        if (!res.rows.length) return null;
        const row = res.rows[0];
        // Only use DB row if it's fresher than the in-memory TTL
        if (Date.now() - new Date(row.updated_at).getTime() > CACHE_TTL) return null;
        return {
            globalScore: parseFloat(row.global_score),
            label:       row.sentiment_label,
            baseAdj:     parseInt(row.base_adj, 10),
            breakdown:   row.breakdown   || {},
            rawData:     row.raw_data    || {},
        };
    } catch {
        return null;
    }
}

// Sector multipliers for DXY / Oil / Gold overlays
// Values > 1 = more sensitive to that macro factor
const SECTOR_OVERLAY = {
    'Technology':              { dxyMult: 1.6, oilMult: 0.4, goldMult: 0.4, dxyInvert: false },
    'Communication Services':  { dxyMult: 1.5, oilMult: 0.4, goldMult: 0.4, dxyInvert: false },
    'Consumer Discretionary':  { dxyMult: 1.2, oilMult: 1.0, goldMult: 0.4, dxyInvert: false },
    'Consumer Staples':        { dxyMult: 1.2, oilMult: 1.2, goldMult: 0.4, dxyInvert: false },
    'Healthcare':              { dxyMult: 1.1, oilMult: 0.4, goldMult: 0.4, dxyInvert: false },
    'Financials':              { dxyMult: 0.5, oilMult: 0.4, goldMult: 0.4, dxyInvert: true  }, // banks like strong dollar
    'Energy':                  { dxyMult: 0.7, oilMult: 2.5, goldMult: 0.4, dxyInvert: false },
    'Materials':               { dxyMult: 0.7, oilMult: 0.8, goldMult: 2.5, dxyInvert: false },
    'Real Estate':             { dxyMult: 0.8, oilMult: 0.4, goldMult: 0.4, dxyInvert: false },
    'Utilities':               { dxyMult: 0.8, oilMult: 0.8, goldMult: 0.4, dxyInvert: false },
    'Industrials':             { dxyMult: 1.0, oilMult: 1.3, goldMult: 0.4, dxyInvert: false },
};

const DEFAULT_OVERLAY = { dxyMult: 1.0, oilMult: 0.8, goldMult: 0.8, dxyInvert: false };

// ── Pure helpers ──────────────────────────────────────────────────────────────

function _safe(val) {
    return val !== null && val !== undefined && Number.isFinite(val) ? val : null;
}

/**
 * Linear mapping: pct → [0, 1] where 0 = pct ≤ -threshold, 1 = pct ≥ +threshold.
 * pct = 0 → 0.5 (neutral).
 */
function _pctToScore(pct, threshold) {
    if (pct === null) return null;
    return Math.max(0, Math.min(1, (pct / threshold + 1) / 2));
}

/** Average of non-null values. Returns null when all are null. */
function _avg(vals) {
    const valid = vals.filter(v => v !== null);
    return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

// ── Core calculation ──────────────────────────────────────────────────────────

async function getGlobalSentiment() {
    // 1. In-memory (fastest — within same process lifetime)
    const cached = cacheService.get(CACHE_KEY);
    if (cached !== null) return cached;

    // 2. DB fallback — survives worker restarts, avoids 90s Yahoo wait on first call
    const dbCached = await _loadFromDb();
    if (dbCached !== null) {
        cacheService.set(CACHE_KEY, dbCached, CACHE_TTL);
        logger.debug('[ATLAS] Sentiment loaded from DB cache');
        return dbCached;
    }

    try {
        const d = await globalMarketConnector.fetchGlobalQuotes();

        // 1. Asia-Pacific session
        const asia = _avg([
            _pctToScore(_safe(d['^N225']?.changePercent),  1.5),
            _pctToScore(_safe(d['^HSI']?.changePercent),   1.5),
            _pctToScore(_safe(d['^BSESN']?.changePercent), 1.2),
            _pctToScore(_safe(d['^AXJO']?.changePercent),  1.2),
        ]);

        // 2. European session
        const europe = _avg([
            _pctToScore(_safe(d['^GDAXI']?.changePercent), 1.5),
            _pctToScore(_safe(d['^FTSE']?.changePercent),  1.2),
        ]);

        // 3. US Futures — prefer pre-market pct when available (before 9:30 AM ET)
        const esPct = _safe(d['ES=F']?.preMarketPct) ?? _safe(d['ES=F']?.changePercent);
        const nqPct = _safe(d['NQ=F']?.preMarketPct) ?? _safe(d['NQ=F']?.changePercent);
        const futures = _avg([
            _pctToScore(esPct, 0.8),   // tight threshold — ES is most direct signal
            _pctToScore(nqPct, 1.0),
        ]);

        // 4. Dollar Index — INVERTED (dollar strength = headwind for most equities)
        const dxyPct   = _safe(d['DX=F']?.changePercent);
        const dollar   = dxyPct !== null ? _pctToScore(-dxyPct, 0.5) : null;

        // 5. Commodities
        const oilPct   = _safe(d['CL=F']?.changePercent);
        const goldPct  = _safe(d['GC=F']?.changePercent);
        // Mild oil rise = growth signal (+). Gold rise = risk-off, mildly negative.
        // Extreme oil surge (>3%) = inflation signal, revert to negative.
        let oilScore = null;
        if (oilPct !== null) {
            if (oilPct > 3.0) {
                oilScore = 0.35; // sharp oil spike — inflation fear
            } else {
                oilScore = _pctToScore(oilPct, 2.0); // mild rise = 0.5+, mild fall = 0.5-
            }
        }
        const goldScore = goldPct !== null ? _pctToScore(-goldPct * 0.6, 1.0) : null; // gold up = mild negative
        const commodities = _avg([oilScore, goldScore]);

        // 6. VIX regime (inverted — high VIX = bearish environment)
        const vixLevel  = _safe(d['^VIX']?.price);
        const vvixLevel = _safe(d['^VVIX']?.price);
        let vixScore = null;
        if (vixLevel !== null) {
            // VIX 12 → 1.0 (complacent), VIX 30 → 0.0 (fear), VIX 21 → 0.5 (neutral)
            vixScore = Math.max(0, Math.min(1, (30 - vixLevel) / 18));
        }
        // VVIX > 100 signals expectations of large VIX moves — further penalty
        if (vixScore !== null && vvixLevel !== null && vvixLevel > 100) {
            const vvixPenalty = Math.min(0.20, (vvixLevel - 100) / 250);
            vixScore = Math.max(0, vixScore - vvixPenalty);
        }

        // 7. Weighted composite
        const components = [
            { value: asia,        weight: 0.20, label: 'Asia'    },
            { value: europe,      weight: 0.20, label: 'Europe'  },
            { value: futures,     weight: 0.25, label: 'Futures' },
            { value: dollar,      weight: 0.15, label: 'DXY'     },
            { value: commodities, weight: 0.10, label: 'Commod'  },
            { value: vixScore,    weight: 0.10, label: 'VIX'     },
        ];

        let totalW = 0, weightedSum = 0;
        for (const c of components) {
            if (c.value !== null) {
                weightedSum += c.value * c.weight;
                totalW      += c.weight;
            }
        }
        const globalScore = totalW > 0
            ? Math.max(0, Math.min(1, weightedSum / totalW))
            : 0.5;

        // 8. Label + base adjustment
        let label, baseAdj;
        if      (globalScore >= 0.75) { label = 'STRONG_BULLISH'; baseAdj = +8; }
        else if (globalScore >= 0.60) { label = 'BULLISH';        baseAdj = +4; }
        else if (globalScore >= 0.40) { label = 'NEUTRAL';        baseAdj =  0; }
        else if (globalScore >= 0.25) { label = 'BEARISH';        baseAdj = -4; }
        else                          { label = 'RISK_OFF';       baseAdj = -8; }

        const result = {
            globalScore,
            label,
            baseAdj,
            breakdown: {
                asia:        asia        !== null ? +asia.toFixed(3)        : null,
                europe:      europe      !== null ? +europe.toFixed(3)      : null,
                futures:     futures     !== null ? +futures.toFixed(3)     : null,
                dollar:      dollar      !== null ? +dollar.toFixed(3)      : null,
                commodities: commodities !== null ? +commodities.toFixed(3) : null,
                vix:         vixScore    !== null ? +vixScore.toFixed(3)    : null,
            },
            rawData: {
                nikkeiPct:  _safe(d['^N225']?.changePercent),
                hsiPct:     _safe(d['^HSI']?.changePercent),
                sensexPct:  _safe(d['^BSESN']?.changePercent),
                daxPct:     _safe(d['^GDAXI']?.changePercent),
                ftsePct:    _safe(d['^FTSE']?.changePercent),
                esFutPct:   esPct,
                nqFutPct:   nqPct,
                dxyPct,
                oilPct,
                goldPct,
                vixLevel,
                vvixLevel,
            },
        };

        cacheService.set(CACHE_KEY, result, CACHE_TTL);
        // Persist to DB so next restart skips the 90s Yahoo fetch
        _persistToDb(result);

        logger.info(
            `[ATLAS] Global: ${label} score=${globalScore.toFixed(2)} adj=${baseAdj >= 0 ? '+' : ''}${baseAdj}`,
            {
                asia:    asia?.toFixed(2),
                europe:  europe?.toFixed(2),
                futures: futures?.toFixed(2),
                dxy:     dollar?.toFixed(2),
                vixLvl:  vixLevel?.toFixed(1),
                ES_pct:  esPct?.toFixed(2),
            }
        );

        return result;

    } catch (err) {
        logger.warn('[ATLAS] Sentiment calculation failed', { error: err.message });
        return _neutral();
    }
}

/**
 * Returns the score-point adjustment for a specific stock sector.
 * Base adjustment ± sector-specific overlay for DXY / Oil / Gold.
 *
 * @param {string} sector
 * @returns {Promise<{ adj: number, label: string, reason: string, globalScore: number }>}
 */
async function getScoreAdjustment(sector = '') {
    try {
        const sentiment = await getGlobalSentiment();
        const { baseAdj, rawData, label, globalScore } = sentiment;

        const ov = SECTOR_OVERLAY[sector] || DEFAULT_OVERLAY;
        const { dxyPct, oilPct, goldPct } = rawData;

        let sectorBonus = 0;
        const reasons   = [label];

        // ── DXY overlay ──────────────────────────────────────────────────────────
        if (dxyPct !== null && ov.dxyMult >= 1.1) {
            // High-sensitivity sectors: dollar rise hurts (unless financials which like it)
            const dxyDir = ov.dxyInvert ? dxyPct : -dxyPct;  // financials: positive when dollar rises
            if      (dxyDir >  0.5) { sectorBonus += 2; reasons.push(`DXY+${(dxyDir).toFixed(1)}% (${sector} tailwind)`); }
            else if (dxyDir < -0.5) { sectorBonus -= 2; reasons.push(`DXY${(dxyDir).toFixed(1)}% (${sector} headwind)`); }
        }

        // ── Oil overlay ──────────────────────────────────────────────────────────
        if (oilPct !== null && ov.oilMult >= 2.0) {
            if      (oilPct >  1.5) { sectorBonus += 2; reasons.push(`Oil+${oilPct.toFixed(1)}% (Energy tailwind)`); }
            else if (oilPct < -2.0) { sectorBonus -= 2; reasons.push(`Oil${oilPct.toFixed(1)}% (Energy headwind)`); }
        }

        // ── Gold overlay ─────────────────────────────────────────────────────────
        if (goldPct !== null && ov.goldMult >= 2.0) {
            if      (goldPct >  1.0) { sectorBonus += 2; reasons.push(`Gold+${goldPct.toFixed(1)}% (Materials tailwind)`); }
            else if (goldPct < -1.0) { sectorBonus -= 2; reasons.push(`Gold${goldPct.toFixed(1)}% (Materials headwind)`); }
        }

        const adj = Math.max(-10, Math.min(10, baseAdj + sectorBonus));
        return {
            adj,
            label,
            reason:      reasons.join(', '),
            globalScore,
            breakdown:   sentiment.breakdown,
            rawData:     sentiment.rawData,
        };

    } catch {
        return { adj: 0, label: 'NEUTRAL', reason: 'error', globalScore: 0.5, breakdown: {}, rawData: {} };
    }
}

function _neutral() {
    return { globalScore: 0.5, label: 'NEUTRAL', baseAdj: 0, breakdown: {}, rawData: {} };
}

function invalidateCache() {
    cacheService.delete(CACHE_KEY);
    logger.info('[ATLAS] Cache invalidated by VIX spike monitor');
}

module.exports = { getGlobalSentiment, getScoreAdjustment, invalidateCache };
