const { logger } = require('../utils/logger');
const fs   = require('fs');
const path = require('path');

// Static fallback — used when HERMES is unavailable
const STATIC_STOCK_UNIVERSE = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../static-major-us-tickers.json'), 'utf8')
);

/**
 * Returns the full stock universe for backfill and analysis.
 * Primary source: HERMES (RS-sorted, up to 400 liquid stocks).
 * Fallback:       static-major-us-tickers.json (244 symbols).
 *
 * @returns {Promise<string[]>}
 */
async function getStockUniverse() {
    logger.info(`[StockUniverse] Using static universe: ${STATIC_STOCK_UNIVERSE.length} symbols`);
    return STATIC_STOCK_UNIVERSE;
}

module.exports = {
    getStockUniverse,
    STATIC_STOCK_UNIVERSE,
};
