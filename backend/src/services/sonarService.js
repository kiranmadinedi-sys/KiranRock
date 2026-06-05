const finnhubConnector = require('../connectors/finnhubConnector');
const cacheService = require('./cacheService');
const { logger } = require('../utils/logger');

const SONAR_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours — institutional data changes slowly

/**
 * @fileoverview
 * SONAR Service - The Institutional Tracker for the PANTHEON system.
 *
 * This service analyzes "smart money" movements by tracking institutional ownership
 * and significant insider transactions. It provides a score from 0 to 1 indicating
 * the level of smart money interest in a stock.
 */

const INSTITUTIONAL_OWNERSHIP_WEIGHT = 0.6;
const INSIDER_TRANSACTION_WEIGHT = 0.4;

class SonarService {
  /**
   * Calculates a "smart money" score based on institutional ownership and insider transactions.
   * @param {string} symbol The stock symbol to analyze.
   * @returns {Promise<number>} A score between 0 and 1.
   */
  async getSmartMoneyScore(symbol) {
    const cacheKey = `sonar_smart_money_${symbol}`;
    const cached = cacheService.get(cacheKey);
    if (cached !== null) return cached;

    try {
      const [ownershipData, transactionData] = await Promise.all([
        finnhubConnector.getInstitutionalOwnership(symbol),
        finnhubConnector.getInsiderTransactions(symbol)
      ]);

      const ownershipScore = this.calculateOwnershipScore(ownershipData);
      const transactionScore = this.calculateTransactionScore(transactionData);

      const finalScore = (ownershipScore * INSTITUTIONAL_OWNERSHIP_WEIGHT) +
                         (transactionScore * INSIDER_TRANSACTION_WEIGHT);

      cacheService.set(cacheKey, finalScore, SONAR_CACHE_TTL);
      logger.info(`[SONAR] ${symbol}: ${finalScore.toFixed(2)} (ownership ${ownershipScore.toFixed(2)}, insider ${transactionScore.toFixed(2)})`);
      return finalScore;

    } catch (error) {
      logger.error(`[SONAR] Error for ${symbol}: ${error.message}`);
      return 0.5; // neutral — don't penalise on API failure
    }
  }

  /**
   * Scores institutional ownership. Higher total ownership and recent increases are positive.
   * @param {Array<Object>} ownershipData - Data from Finnhub.
   * @returns {number} A score between 0 and 1.
   */
  calculateOwnershipScore(ownershipData) {
    if (!ownershipData || ownershipData.length === 0) {
      return 0.5; // Return a neutral score if no data
    }

    // Calculate total ownership percentage held by institutions
    const totalOwnership = ownershipData.reduce((sum, holder) => sum + holder.share, 0);
    
    // Calculate net change in shares in the most recent period
    const latestReportDate = Math.max(...ownershipData.map(d => new Date(d.reportDate).getTime()));
    const latestHoldings = ownershipData.filter(d => new Date(d.reportDate).getTime() === latestReportDate);
    const netChange = latestHoldings.reduce((sum, holder) => sum + holder.change, 0);

    // Normalize total ownership to a 0-1 scale (capping at 80% for max score)
    const ownershipValueScore = Math.min(totalOwnership / 80, 1.0);

    // Normalize net change to a -1 to 1 scale, then shift to 0-1
    // This is a simplified approach; a more complex model would look at % change
    const totalShares = latestHoldings.reduce((sum, holder) => sum + holder.share, 0);
    const changeScore = (totalShares > 0) ? Math.max(-1, Math.min(1, netChange / (totalShares * 0.1))) : 0; // Cap change at 10% of total shares
    const changeValueScore = (changeScore + 1) / 2; // Convert from [-1, 1] to [0, 1]

    // Combine scores, giving more weight to the recent change
    const finalScore = (ownershipValueScore * 0.4) + (changeValueScore * 0.6);
    return finalScore;
  }

  /**
   * Scores insider transactions. Net buying is positive.
   * @param {Array<Object>} transactionData - Data from Finnhub.
   * @returns {number} A score between 0 and 1.
   */
  calculateTransactionScore(transactionData) {
    if (!transactionData || transactionData.length === 0) {
      return 0.5; // Neutral score if no data
    }

    // Sum up the total value of buy vs. sell transactions
    let totalBuyValue = 0;
    let totalSellValue = 0;

    transactionData.forEach(tx => {
      // 'change' is the number of shares. 'P' is purchase, 'S' is sale.
      const value = tx.change * tx.price;
      if (tx.transactionCode.startsWith('P')) {
        totalBuyValue += value;
      } else if (tx.transactionCode.startsWith('S')) {
        totalSellValue += value;
      }
    });

    const netBuyValue = totalBuyValue - totalSellValue;
    const totalValue = totalBuyValue + totalSellValue;

    if (totalValue === 0) {
      return 0.5; // No transactions with value
    }

    // Normalize net value to a -1 to 1 scale, then shift to 0-1
    const score = netBuyValue / totalValue;
    const finalScore = (score + 1) / 2; // Convert from [-1, 1] to [0, 1]

    return finalScore;
  }
}

module.exports = new SonarService();
