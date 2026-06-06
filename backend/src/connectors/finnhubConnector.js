const axios = require('axios');
const { logger } = require('../utils/logger');

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const BASE_URL = 'https://finnhub.io/api/v1';

if (!FINNHUB_API_KEY) {
  logger.warn('FINNHUB_API_KEY is not set. FinnhubConnector will not be able to fetch data.');
}

// Track whether this key has hit a 403 (paid-plan endpoint) — disable silently after first hit
let _ownershipDisabled = false;
let _insiderDisabled = false;

/**
 * @fileoverview
 * Connector for the Finnhub API.
 * Provides methods to fetch financial data not available through other APIs,
 * specifically focusing on institutional ownership and insider transactions.
 */
class FinnhubConnector {
  constructor() {
    this.api = axios.create({
      baseURL: BASE_URL,
      params: {
        token: FINNHUB_API_KEY,
      },
    });
  }

  /**
   * Fetches institutional ownership data for a given symbol.
   * @param {string} symbol The stock symbol.
   * @returns {Promise<Array<Object>|null>} A promise that resolves to an array of ownership data or null on error.
   */
  async getInstitutionalOwnership(symbol) {
    if (!FINNHUB_API_KEY || _ownershipDisabled) return null;
    try {
      const response = await this.api.get('/stock/ownership', { params: { symbol } });
      return response.data.ownership || [];
    } catch (error) {
      const status = error.response?.status;
      if (status === 403) {
        _ownershipDisabled = true;
        logger.warn('[FinnhubConnector] /stock/ownership returned 403 — requires paid plan. Disabling for this session.');
      } else {
        logger.warn(`[FinnhubConnector] institutional ownership fetch failed for ${symbol}: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Fetches insider transactions for a given symbol.
   * @param {string} symbol The stock symbol.
   * @returns {Promise<Array<Object>|null>} A promise that resolves to an array of transaction data or null on error.
   */
  async getInsiderTransactions(symbol) {
    if (!FINNHUB_API_KEY || _insiderDisabled) return null;
    try {
      // Finnhub API requires a date range for insider transactions.
      // We'll fetch data for the last 6 months.
      const to = new Date();
      const from = new Date();
      from.setMonth(from.getMonth() - 6);
      
      const fromDate = from.toISOString().split('T')[0];
      const toDate = to.toISOString().split('T')[0];

      const response = await this.api.get('/stock/insider-transactions', {
        params: { symbol, from: fromDate, to: toDate },
      });
      // Normalize: Finnhub uses `transactionPrice`; sonarService expects `price`
      return (response.data.data || []).map(tx => ({
          ...tx,
          price: tx.transactionPrice ?? tx.price ?? 0
      }));
    } catch (error) {
      const status = error.response?.status;
      if (status === 403) {
        _insiderDisabled = true;
        logger.warn('[FinnhubConnector] /stock/insider-transactions returned 403 — requires paid plan. Disabling for this session.');
      } else {
        logger.warn(`[FinnhubConnector] insider transactions fetch failed for ${symbol}: ${error.message}`);
      }
      return null;
    }
  }
}

module.exports = new FinnhubConnector();
