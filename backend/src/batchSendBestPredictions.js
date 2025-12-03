const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const stockDataService = require('./services/stockDataService');
const aiTradingBotService = require('./services/aiTradingBotService');
const telegramLogger = require('./telegramLogger');

// VIX symbol for Yahoo Finance
const VIX_SYMBOL = '^VIX';

async function fetchVIXData() {
    try {
        const quote = await yahooFinance.quote(VIX_SYMBOL);
        return {
            price: quote.regularMarketPrice,
            change: quote.regularMarketChangePercent,
            timestamp: new Date()
        };
    } catch (error) {
        console.error('Error fetching VIX data:', error.message);
        return null;
    }
}

async function analyzeAllStocksWithVIX() {
    // Get all tradable stocks
    const stocks = await stockDataService.searchSymbols('');
    const vixData = await fetchVIXData();
    const results = [];

    for (const symbol of stocks) {
        // Analyze with AI and all features, pass VIX data
        const analysis = await aiTradingBotService.analyzeStock(symbol, vixData);
        if (!analysis) continue;

        results.push({
            symbol,
            ...analysis,
            finalScore: analysis.aiScore,
            chartSignal: analysis.chartSignal
        });
    }

    // Sort by final score, pick top 5
    results.sort((a, b) => b.finalScore - a.finalScore);
    return { results, vixData };
}

async function sendBestPredictions() {
    const { results, vixData } = await analyzeAllStocksWithVIX();
    const topStocks = results.slice(0, 5);
    let message = `Best Performing Prediction Stocks for ${new Date().toLocaleDateString()}\n\n`;
    message += `VIX: ${vixData ? vixData.price : 'N/A'} (${vixData ? vixData.change : 'N/A'}%)\n\n`;
    topStocks.forEach((stock, idx) => {
        message += `${idx + 1}. ${stock.symbol} - Score: ${stock.finalScore} - Signal: ${stock.recommendation} - Chart Signal: ${stock.chartSignal}\n`;
    });
    await telegramLogger.sendTelegramMessage(message);
    console.log('Sent best predictions:', message);
}

// Run as batch job
if (require.main === module) {
    sendBestPredictions();
}

module.exports = { sendBestPredictions };
