const sageService = require('./sageService');
const riskConfig = require('../config/riskConfig');
const { logger } = require('../utils/logger');

/**
 * @fileoverview
 * SCALE Service - The Bet Calculator for the PANTHEON system.
 *
 * This service implements the Kelly Criterion formula to determine the optimal
 * fraction of capital to allocate to a given trade. It uses historical performance
 * metrics from the SAGE service and applies several safety constraints defined
 * in the central risk configuration.
 */

class PositionSizingService {
  /**
   * Calculates the optimal position size as a fraction of total capital
   * using the Kelly Criterion.
   *
   * @param {number} confidenceScore - A score from 0 to 1 representing the AI's
   *                                   confidence in this specific trade. This can
   *                                   be used to moderate the Kelly fraction.
   * @param {string|null} userId - Scopes the Kelly win-rate/win-loss-ratio inputs to this
   *                                account's own trade history (falling back to a live-only
   *                                blended pool, then defaults — see sageService). Omit only
   *                                for the legacy global-blend behavior.
   * @returns {Promise<number>} The calculated fraction of capital to allocate (e.g., 0.05 for 5%).
   */
  async getKellyFraction(confidenceScore = 1.0, userId = null) {
    const { winProbability, winLossRatio } = await sageService.getStrategyMetrics(userId);

    if (winLossRatio <= 0) {
      logger.warn('[SCALE] Win/Loss ratio is zero or negative. Cannot calculate Kelly. Defaulting to minimum size.');
      return riskConfig.minPositionSize;
    }

    // Calculate the full Kelly Criterion fraction.
    // Kelly % = W – [(1 – W) / R]
    // W = Win Probability
    // R = Win/Loss Ratio
    const kellyFraction = winProbability - (1 - winProbability) / winLossRatio;

    logger.info(`[SCALE] Raw Kelly Fraction calculated: ${kellyFraction.toFixed(4)} (W: ${winProbability}, R: ${winLossRatio})`);

    // --- Safety Checks and Constraints ---

    // 1. If Kelly is negative or zero, it suggests no edge.
    // PANTHEON: return minimum size rather than 0 so the bot is not fully paralysed
    // while historical data is sparse or win-rate is temporarily below 50%.
    if (kellyFraction <= 0) {
      logger.info('[SCALE] Kelly fraction is not positive — using minimum position size as floor.');
      return riskConfig.minPositionSize;
    }

    // 2. Moderate the Kelly fraction by the AI's confidence in this specific trade.
    const adjustedFraction = kellyFraction * confidenceScore;
    logger.info(`[SCALE] Fraction adjusted for confidence (${confidenceScore.toFixed(2)}): ${adjustedFraction.toFixed(4)}`);

    // 3. Apply a "Fractional Kelly" approach to be more conservative.
    // We only bet a fraction of the recommended Kelly amount.
    const fractionalKelly = adjustedFraction * riskConfig.kellyFraction;
    logger.info(`[SCALE] Applying conservative Kelly fraction (${riskConfig.kellyFraction}): ${fractionalKelly.toFixed(4)}`);

    // 4. Enforce hard limits from the risk configuration.
    // The final position size cannot be smaller than the minimum or larger than the maximum.
    const finalFraction = Math.max(
      riskConfig.minPositionSize,
      Math.min(riskConfig.maxPositionSize, fractionalKelly)
    );

    logger.info(`[SCALE] Final position size fraction after applying constraints: ${finalFraction.toFixed(4)}`);

    return finalFraction;
  }
}

module.exports = new PositionSizingService();
