/**
 * SONAR Service — Smart Money & Insider Activity Tracker (PANTHEON)
 *
 * Calculates a 0–1 "smart money" score by combining:
 *   A. Insider transactions (weight 0.7) — SEC Form 4 filings via:
 *        1. Finnhub (primary, free plan works for insider data)
 *        2. SEC EDGAR (free, official, fallback when Finnhub fails)
 *   B. Institutional ownership (weight 0.3) — Finnhub (paid plan)
 *        Falls back to neutral 0.5 when unavailable.
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

class SonarService {

    async getSmartMoneyScore(symbol) {
        const cacheKey = `sonar_v2_${symbol}`;
        const cached = cacheService.get(cacheKey);
        if (cached !== null) return cached;

        try {
            const [ownershipData, insiderData] = await Promise.all([
                finnhubConnector.getInstitutionalOwnership(symbol).catch(() => null),
                this._fetchInsiderTransactions(symbol)
            ]);

            const ownershipScore   = this.calculateOwnershipScore(ownershipData);
            const transactionScore = this.calculateTransactionScore(insiderData, symbol);

            const finalScore = (ownershipScore   * INSTITUTIONAL_WEIGHT) +
                               (transactionScore * INSIDER_WEIGHT);

            const safeScore = isNaN(finalScore) ? 0.5 : Math.max(0, Math.min(1, finalScore));

            cacheService.set(cacheKey, safeScore, SONAR_CACHE_TTL);
            logger.info(`[SONAR] ${symbol}: ${safeScore.toFixed(2)} (ownership ${ownershipScore.toFixed(2)}, insider ${transactionScore.toFixed(2)})`);
            return safeScore;

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
}

module.exports = new SonarService();
