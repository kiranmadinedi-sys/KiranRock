/**
 * SONAR Service — Smart Money & Insider Activity Tracker (PANTHEON)
 *
 * Calculates a 0–1 "smart money" score by combining:
 *   A. Insider transactions (weight 0.7) — SEC Form 4 filings via:
 *        1. Finnhub (primary, free plan works for insider data)
 *        2. SEC EDGAR (free, official, fallback when Finnhub fails)
 *   B. Institutional ownership (weight 0.3) — Finnhub (paid plan)
 *        Falls back to neutral 0.5 when unavailable.
 *   C. Form 8-K material events — SEC EDGAR (free, official)
 *        Applied as a post-score modifier: [-0.20, +0.15]
 *        Catastrophic items (bankruptcy 1.03, restatement 4.02) floor the score.
 *
 * Enhanced scoring beyond raw net-buy/sell:
 *   - CEO / CFO purchases carry 2× weight (highest conviction)
 *   - Director / VP purchases carry 1.5× weight
 *   - Cluster buy (3+ distinct insiders buying in 30d) → +15% boost
 *   - Large single trade (> $500K open-market buy) → +10% boost
 *   - Recency weighting: last 30d = 1.0×, 30–90d = 0.6×, 90–180d = 0.3×
 *
 * The score feeds into PANTHEON Step 12 (±8 pts on the AI score).
 */

const finnhubConnector = require('../connectors/finnhubConnector');
const secEdgarConnector = require('../connectors/secEdgarConnector');
const cacheService = require('./cacheService');
const { logger } = require('../utils/logger');

const SONAR_CACHE_TTL            = 6 * 60 * 60 * 1000;  // 6 h — refreshes intraday
const INSTITUTIONAL_WEIGHT       = 0.30;
const INSIDER_WEIGHT             = 0.70;

// Open-market transaction codes we trust as genuine conviction signals
const BUY_CODES  = new Set(['P']);           // open-market purchase
const SELL_CODES = new Set(['S']);           // open-market sale
const SKIP_CODES = new Set(['M', 'G', 'W', 'A', 'F', 'U', 'J', 'C']);  // options/gifts/etc

// Form 8-K item signals — only items with clear directional meaning are mapped.
// Ambiguous items (2.01 acquisitions, 5.02 officer changes, 8.01 catch-all) are omitted
// to avoid false signals.
const ITEM_8K_SIGNALS = {
    // ── Bearish ───────────────────────────────────────────────────────────────
    '1.02': -0.25,   // Termination of material definitive agreement
    '1.03': -1.00,   // Bankruptcy or receivership — catastrophic floor trigger
    '2.05': -0.35,   // Costs associated with exit activities (layoffs, restructuring)
    '2.06': -0.35,   // Material impairments / write-downs
    '4.01': -0.20,   // Changes in registrant's certifying accountant (auditor swap)
    '4.02': -0.80,   // Non-reliance on previously issued financial statements (restatement)
    // ── Bullish ───────────────────────────────────────────────────────────────
    '1.01': +0.20,   // Entry into a material definitive agreement (new deal / partnership)
    '7.01': +0.10,   // Regulation FD disclosure (guidance updates, investor-day signals)
};

class SonarService {

    async getSmartMoneyScore(symbol) {
        const cacheKey = `sonar_v3_${symbol}`;
        const cached = cacheService.get(cacheKey);
        if (cached !== null) return cached;

        try {
            const [ownershipData, insiderData, form8kData] = await Promise.all([
                finnhubConnector.getInstitutionalOwnership(symbol).catch(() => null),
                this._fetchInsiderTransactions(symbol),
                secEdgarConnector.getRecentForm8K(symbol).catch(() => [])
            ]);

            const ownershipScore   = this.calculateOwnershipScore(ownershipData);
            const transactionScore = this.calculateTransactionScore(insiderData, symbol);

            const baseScore = (ownershipScore   * INSTITUTIONAL_WEIGHT) +
                              (transactionScore * INSIDER_WEIGHT);

            const safeBase  = isNaN(baseScore) ? 0.5 : Math.max(0, Math.min(1, baseScore));
            const modifier  = this.calculate8KModifier(form8kData, symbol);
            const finalScore = Math.max(0.05, Math.min(0.95, safeBase + modifier));

            cacheService.set(cacheKey, finalScore, SONAR_CACHE_TTL);
            logger.info(
                `[SONAR] ${symbol}: ${finalScore.toFixed(2)} ` +
                `(ownership ${ownershipScore.toFixed(2)}, insider ${transactionScore.toFixed(2)}, ` +
                `8K modifier ${modifier >= 0 ? '+' : ''}${modifier.toFixed(2)})`
            );
            return finalScore;

        } catch (err) {
            logger.error(`[SONAR] Error for ${symbol}: ${err.message}`);
            return 0.5;
        }
    }

    /**
     * Try Finnhub first (works on free plan for insider data).
     * Fall back to SEC EDGAR on null/error.
     */
    async _fetchInsiderTransactions(symbol) {
        try {
            const fh = await finnhubConnector.getInsiderTransactions(symbol);
            if (fh && fh.length > 0) return fh;
        } catch { /* fall through */ }

        // SEC EDGAR fallback — free, official, always available
        return secEdgarConnector.getInsiderTransactions(symbol).catch(() => []);
    }

    // ── Institutional ownership ───────────────────────────────────────────────

    calculateOwnershipScore(ownershipData) {
        if (!ownershipData || !Array.isArray(ownershipData) || ownershipData.length === 0) {
            return 0.5;   // neutral — Finnhub paid-plan gate; don't penalise
        }
        try {
            const totalOwnership = ownershipData.reduce((s, h) => s + (Number(h.share) || 0), 0);
            const latestDate     = Math.max(...ownershipData.map(d => new Date(d.reportDate || 0).getTime()));
            const latestHoldings = ownershipData.filter(d => new Date(d.reportDate || 0).getTime() === latestDate);
            const netChange      = latestHoldings.reduce((s, h) => s + (Number(h.change) || 0), 0);
            const totalShares    = latestHoldings.reduce((s, h) => s + (Number(h.share) || 0), 0);

            const ownershipValueScore = Math.min(totalOwnership / 80, 1.0);
            const changeRatio         = totalShares > 0 ? netChange / (totalShares * 0.1) : 0;
            const changeScore         = Math.max(-1, Math.min(1, changeRatio));
            const changeValueScore    = (changeScore + 1) / 2;

            const score = (ownershipValueScore * 0.4) + (changeValueScore * 0.6);
            return isNaN(score) ? 0.5 : Math.max(0, Math.min(1, score));
        } catch {
            return 0.5;
        }
    }

    // ── Insider transactions (enhanced) ───────────────────────────────────────

    calculateTransactionScore(txData, symbol = '') {
        if (!txData || !Array.isArray(txData) || txData.length === 0) {
            return 0.5;
        }

        const now     = Date.now();
        const MS_30D  = 30  * 24 * 60 * 60 * 1000;
        const MS_90D  = 90  * 24 * 60 * 60 * 1000;
        const MS_180D = 180 * 24 * 60 * 60 * 1000;

        let weightedBuyValue  = 0;
        let weightedSellValue = 0;
        const recentBuyers    = new Set();   // distinct insiders who bought in 30d

        for (const tx of txData) {
            const code  = (tx.transactionCode || '').trim();
            if (SKIP_CODES.has(code)) continue;
            if (!BUY_CODES.has(code) && !SELL_CODES.has(code)) continue;

            const shares = Math.abs(Number(tx.change) || Number(tx.share) || 0);
            const price  = Number(tx.price) || Number(tx.transactionPrice) || 0;
            if (shares === 0) continue;

            const dollarValue = tx.dollarValue ?? (shares * price);
            const filingMs    = new Date(tx.filingDate || tx.transactionDate || 0).getTime();
            const ageMs       = now - filingMs;

            // Recency weight
            let recency = 0;
            if      (ageMs <= MS_30D)  recency = 1.0;
            else if (ageMs <= MS_90D)  recency = 0.6;
            else if (ageMs <= MS_180D) recency = 0.3;
            else continue;  // older than 6 months — ignore

            // Insider role weight
            const title  = (tx.insiderTitle || tx.officerTitle || '').toLowerCase();
            const isCEO  = title.includes('chief executive') || title.includes('ceo') || title.includes('president');
            const isCFO  = title.includes('chief financial') || title.includes('cfo');
            const isExec = title.includes('chief') || title.includes('officer') || tx.isOfficer;
            const isDir  = tx.isDirector;

            let roleWeight = 1.0;
            if (isCEO || isCFO)   roleWeight = 2.0;
            else if (isExec)      roleWeight = 1.5;
            else if (isDir)       roleWeight = 1.2;

            // Large-trade bonus (open-market buys > $500K)
            const largeTradeBonus = (BUY_CODES.has(code) && dollarValue >= 500_000) ? 1.2 : 1.0;

            const effectiveValue = dollarValue * recency * roleWeight * largeTradeBonus;

            if (BUY_CODES.has(code)) {
                weightedBuyValue += effectiveValue;
                if (ageMs <= MS_30D && tx.insiderName) {
                    recentBuyers.add(tx.insiderName);
                }
            } else {
                weightedSellValue += effectiveValue;
            }
        }

        const totalWeighted = weightedBuyValue + weightedSellValue;
        if (totalWeighted === 0) return 0.5;

        const netScore = (weightedBuyValue - weightedSellValue) / totalWeighted;  // -1 to +1
        let score      = (netScore + 1) / 2;                                       //  0 to  1

        // Cluster buy boost: 3+ distinct insiders buying in last 30d
        if (recentBuyers.size >= 3) {
            score = Math.min(1, score * 1.15);
            logger.info(`[SONAR] ${symbol}: cluster buy — ${recentBuyers.size} insiders bought in last 30d`);
        } else if (recentBuyers.size >= 2) {
            score = Math.min(1, score * 1.08);
        }

        return isNaN(score) ? 0.5 : Math.max(0, Math.min(1, score));
    }

    // ── Form 8-K material event modifier ─────────────────────────────────────

    /**
     * Returns a score adjustment in [-0.20, +0.15] based on recent 8-K filings.
     * Catastrophic items (bankruptcy 1.03, restatement 4.02) return extreme
     * negatives that floor the final score to 0.05 regardless of other signals.
     *
     * @param {Array<{filingDate: string, items: string[]}>} form8kData
     * @param {string} symbol
     * @returns {number}
     */
    calculate8KModifier(form8kData, symbol = '') {
        if (!form8kData || form8kData.length === 0) return 0;

        const now    = Date.now();
        const MS_30D = 30 * 24 * 60 * 60 * 1000;
        const MS_90D = 90 * 24 * 60 * 60 * 1000;

        let rawSignal          = 0;
        let hasSignal          = false;
        let bankruptcyDetected = false;
        let restatementDetected = false;

        for (const filing of form8kData) {
            const ageMs = now - new Date(filing.filingDate || 0).getTime();
            if (ageMs > MS_90D || ageMs < 0) continue;

            // Recency weight: last 30d carries full weight, 30-90d carries half
            const recency = ageMs <= MS_30D ? 1.0 : 0.5;

            for (const item of (filing.items || [])) {
                const signal = ITEM_8K_SIGNALS[item];
                if (signal === undefined) continue;

                hasSignal   = true;
                rawSignal  += signal * recency;

                if (item === '1.03') bankruptcyDetected   = true;
                if (item === '4.02') restatementDetected  = true;
            }
        }

        if (!hasSignal) return 0;

        // Catastrophic events override everything else
        if (bankruptcyDetected) {
            logger.warn(`[SONAR] ${symbol}: 8-K Item 1.03 (bankruptcy) — forcing score floor`);
            return -0.90;   // drives final score to ≤ 0.05
        }
        if (restatementDetected) {
            logger.warn(`[SONAR] ${symbol}: 8-K Item 4.02 (restatement) — large negative modifier`);
            return Math.min(-0.35, rawSignal);
        }

        // Normal case: clamp to [-0.20, +0.15] — bad news hurts more than good news helps
        const modifier = Math.max(-0.20, Math.min(0.15, rawSignal));

        if (modifier !== 0) {
            logger.info(
                `[SONAR] ${symbol}: 8-K modifier ${modifier >= 0 ? '+' : ''}${modifier.toFixed(2)} ` +
                `from ${form8kData.length} recent filing(s)`
            );
        }

        return modifier;
    }
}

module.exports = new SonarService();
