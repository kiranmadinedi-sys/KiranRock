const yfClient = require('../utils/yfClient');

async function getCurrentPrice(symbol) {
    try {
        const quote = await yfClient.quote(symbol);
        return (quote && (quote.regularMarketPrice || quote?.price?.regularMarketPrice || quote.price)) || null;
    } catch (error) {
        console.error(`Error getting price for ${symbol}:`, error && error.message ? error.message : error);
        throw new Error(`Unable to get current price for ${symbol}`);
    }
}

module.exports = {
    getCurrentPrice
};