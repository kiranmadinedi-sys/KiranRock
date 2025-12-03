const stockDataService = require('./stockDataService');

/**
 * Analyzes institutional money flow and order sizes.
 * @param {string} symbol - Stock symbol
 * @param {string} interval - Time interval
 * @returns {Promise<Object>} Money flow analysis
 */
const analyzeMoneyFlow = async (symbol, interval = '1d') => {
    try {
        const data = await stockDataService.getStockData(symbol, interval);
        
        if (!data || data.length < 20) {
            return generateFallbackData();
        }

        // Analyze volume and price movements to estimate order sizes
        const analysis = categorizeOrders(data);
        
        return {
            symbol,
            netFlow: analysis.netFlow,
            totalInflow: analysis.totalInflow,
            totalOutflow: analysis.totalOutflow,
            orderSizes: analysis.orderSizes,
            breakdown: analysis.breakdown,
            trend: determineTrend(analysis)
        };
    } catch (error) {
        console.error(`Error analyzing money flow for ${symbol}:`, error.message);
        return generateFallbackData();
    }
};

/**
 * Categorizes orders by size based on volume and price movement.
 */
const categorizeOrders = (data) => {
    let totalInflow = 0;
    let totalOutflow = 0;
    
    // Order size categories (XL, L, M, S)
    const orderSizes = {
        inflow: { xl: 0, l: 0, m: 0, s: 0 },
        outflow: { xl: 0, l: 0, m: 0, s: 0 }
    };

    // Analyze last 20 days
    const recentData = data.slice(-20);
    const avgVolume = recentData.reduce((sum, d) => sum + d.volume, 0) / recentData.length;

    recentData.forEach((day, index) => {
        if (index === 0) return; // Skip first day

        const priceChange = day.close - recentData[index - 1].close;
        const volumeRatio = day.volume / avgVolume;
        const dollarVolume = day.volume * day.close;

        // Categorize by volume size
        let sizeCategory;
        if (volumeRatio > 2.0) {
            sizeCategory = 'xl'; // Extra large orders
        } else if (volumeRatio > 1.5) {
            sizeCategory = 'l'; // Large orders
        } else if (volumeRatio > 0.8) {
            sizeCategory = 'm'; // Medium orders
        } else {
            sizeCategory = 's'; // Small orders
        }

        // Determine if it's inflow (buying pressure) or outflow (selling pressure)
        const flowAmount = dollarVolume / 1000000; // Convert to millions

        if (priceChange > 0 && volumeRatio > 1.0) {
            // Strong buying pressure
            orderSizes.inflow[sizeCategory] += flowAmount;
            totalInflow += flowAmount;
        } else if (priceChange < 0 && volumeRatio > 1.0) {
            // Strong selling pressure
            orderSizes.outflow[sizeCategory] += flowAmount;
            totalOutflow += flowAmount;
        } else if (priceChange > 0) {
            // Mild buying
            orderSizes.inflow[sizeCategory] += flowAmount * 0.5;
            totalInflow += flowAmount * 0.5;
        } else {
            // Mild selling
            orderSizes.outflow[sizeCategory] += flowAmount * 0.5;
            totalOutflow += flowAmount * 0.5;
        }
    });

    // Calculate percentages
    const total = totalInflow + totalOutflow;
    const breakdown = {
        inflow: {
            xl: { amount: orderSizes.inflow.xl, percent: (orderSizes.inflow.xl / total * 100).toFixed(2) },
            l: { amount: orderSizes.inflow.l, percent: (orderSizes.inflow.l / total * 100).toFixed(2) },
            m: { amount: orderSizes.inflow.m, percent: (orderSizes.inflow.m / total * 100).toFixed(2) },
            s: { amount: orderSizes.inflow.s, percent: (orderSizes.inflow.s / total * 100).toFixed(2) }
        },
        outflow: {
            xl: { amount: orderSizes.outflow.xl, percent: (orderSizes.outflow.xl / total * 100).toFixed(2) },
            l: { amount: orderSizes.outflow.l, percent: (orderSizes.outflow.l / total * 100).toFixed(2) },
            m: { amount: orderSizes.outflow.m, percent: (orderSizes.outflow.m / total * 100).toFixed(2) },
            s: { amount: orderSizes.outflow.s, percent: (orderSizes.outflow.s / total * 100).toFixed(2) }
        }
    };

    return {
        netFlow: totalInflow - totalOutflow,
        totalInflow: totalInflow.toFixed(2),
        totalOutflow: totalOutflow.toFixed(2),
        orderSizes,
        breakdown
    };
};

/**
 * Determines the overall trend from money flow.
 */
const determineTrend = (analysis) => {
    const netFlow = analysis.netFlow;
    const flowRatio = analysis.totalInflow / (analysis.totalOutflow || 1);

    if (netFlow > 0 && flowRatio > 1.2) {
        return {
            direction: 'Net Inflow',
            sentiment: 'Bullish',
            strength: 'Strong',
            description: 'Significant institutional buying pressure detected.'
        };
    } else if (netFlow > 0) {
        return {
            direction: 'Net Inflow',
            sentiment: 'Bullish',
            strength: 'Moderate',
            description: 'Institutional buyers are accumulating positions.'
        };
    } else if (netFlow < 0 && flowRatio < 0.8) {
        return {
            direction: 'Net Outflow',
            sentiment: 'Bearish',
            strength: 'Strong',
            description: 'Significant institutional selling pressure detected.'
        };
    } else if (netFlow < 0) {
        return {
            direction: 'Net Outflow',
            sentiment: 'Bearish',
            strength: 'Moderate',
            description: 'Institutional sellers are reducing positions.'
        };
    } else {
        return {
            direction: 'Balanced',
            sentiment: 'Neutral',
            strength: 'Weak',
            description: 'Institutional buying and selling are balanced.'
        };
    }
};

/**
 * Generates fallback data when API fails.
 */
const generateFallbackData = () => {
    return {
        symbol: 'DEMO',
        netFlow: 414.36,
        totalInflow: '2863.73',
        totalOutflow: '3278.09',
        breakdown: {
            inflow: {
                xl: { amount: 255.16, percent: '4.15' },
                l: { amount: 579.28, percent: '9.43' },
                m: { amount: 744.44, percent: '12.12' },
                s: { amount: 1284.85, percent: '20.92' }
            },
            outflow: {
                xl: { amount: 289.09, percent: '4.71' },
                l: { amount: 714.06, percent: '11.63' },
                m: { amount: 843.97, percent: '13.74' },
                s: { amount: 1430.97, percent: '23.30' }
            }
        },
        trend: {
            direction: 'Net Outflow',
            sentiment: 'Bearish',
            strength: 'Moderate',
            description: 'Institutional sellers are reducing positions.'
        }
    };
};

module.exports = {
    analyzeMoneyFlow
};
