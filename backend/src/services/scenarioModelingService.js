/**
 * Options Scenario Modeling Service
 * Models how Greeks change with price movements and time decay
 * Critical for risk management and strategy planning
 */

/**
 * Calculate how option Greeks change with price movements
 * @param {Object} option - Base option with Greeks
 * @param {number} priceChange - Percentage price change (-10 to +10)
 * @returns {Object} New Greeks after price change
 */
function modelPriceChange(option, priceChange) {
    const {
        stockPrice,
        strikePrice,
        daysToExpiration,
        volatility,
        riskFreeRate = 0.05,
        optionType,
        delta,
        gamma,
        theta,
        vega
    } = option;

    // Calculate new stock price
    const newStockPrice = stockPrice * (1 + priceChange / 100);
    
    // Calculate time to expiry in years
    const T = daysToExpiration / 365;
    
    // Recalculate d1 and d2 with new price
    const d1 = (Math.log(newStockPrice / strikePrice) + (riskFreeRate + volatility * volatility / 2) * T) / (volatility * Math.sqrt(T));
    const d2 = d1 - volatility * Math.sqrt(T);
    
    // Normal CDF helper
    const normalCDF = (x) => {
        const t = 1 / (1 + 0.2316419 * Math.abs(x));
        const d = 0.3989423 * Math.exp(-x * x / 2);
        const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
        return x > 0 ? 1 - prob : prob;
    };
    
    const normalPDF = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
    
    // Calculate new Greeks
    const newDelta = optionType === 'call' ? normalCDF(d1) : normalCDF(d1) - 1;
    const newGamma = normalPDF(d1) / (newStockPrice * volatility * Math.sqrt(T));
    const newTheta = (-(newStockPrice * normalPDF(d1) * volatility) / (2 * Math.sqrt(T)) - 
                      (optionType === 'call' ? 1 : -1) * riskFreeRate * strikePrice * Math.exp(-riskFreeRate * T) * 
                      normalCDF(optionType === 'call' ? d2 : -d2)) / 365;
    const newVega = newStockPrice * normalPDF(d1) * Math.sqrt(T) / 100;
    
    // Calculate new option price
    const newPrice = optionType === 'call' ?
        newStockPrice * normalCDF(d1) - strikePrice * Math.exp(-riskFreeRate * T) * normalCDF(d2) :
        strikePrice * Math.exp(-riskFreeRate * T) * normalCDF(-d2) - newStockPrice * normalCDF(-d1);
    
    // Calculate P/L
    const originalPrice = optionType === 'call' ?
        stockPrice * normalCDF((Math.log(stockPrice / strikePrice) + (riskFreeRate + volatility * volatility / 2) * T) / (volatility * Math.sqrt(T))) -
        strikePrice * Math.exp(-riskFreeRate * T) * normalCDF((Math.log(stockPrice / strikePrice) + (riskFreeRate + volatility * volatility / 2) * T) / (volatility * Math.sqrt(T)) - volatility * Math.sqrt(T)) :
        strikePrice * Math.exp(-riskFreeRate * T) * normalCDF(-((Math.log(stockPrice / strikePrice) + (riskFreeRate + volatility * volatility / 2) * T) / (volatility * Math.sqrt(T)) - volatility * Math.sqrt(T))) -
        stockPrice * normalCDF(-((Math.log(stockPrice / strikePrice) + (riskFreeRate + volatility * volatility / 2) * T) / (volatility * Math.sqrt(T))));
    
    const profitLoss = newPrice - originalPrice;
    const profitLossPercent = (profitLoss / originalPrice) * 100;
    
    return {
        priceChange: `${priceChange > 0 ? '+' : ''}${priceChange}%`,
        newStockPrice: newStockPrice.toFixed(2),
        newOptionPrice: newPrice.toFixed(2),
        profitLoss: profitLoss.toFixed(2),
        profitLossPercent: profitLossPercent.toFixed(2) + '%',
        newDelta: newDelta.toFixed(4),
        deltaChange: (newDelta - delta).toFixed(4),
        newGamma: newGamma.toFixed(4),
        gammaChange: (newGamma - gamma).toFixed(4),
        newTheta: newTheta.toFixed(4),
        thetaChange: (newTheta - theta).toFixed(4),
        newVega: newVega.toFixed(4),
        vegaChange: (newVega - vega).toFixed(4)
    };
}

/**
 * Calculate theta decay over multiple days
 * @param {Object} option - Base option with Greeks
 * @param {number} days - Number of days forward
 * @returns {Object} Greeks after time decay
 */
function modelThetaDecay(option, days) {
    const {
        stockPrice,
        strikePrice,
        daysToExpiration,
        volatility,
        riskFreeRate = 0.05,
        optionType,
        theta
    } = option;

    const scenarios = [];
    
    for (let day = 1; day <= days; day++) {
        const newDaysToExp = Math.max(1, daysToExpiration - day);
        const T = newDaysToExp / 365;
        
        if (T <= 0) break;
        
        const d1 = (Math.log(stockPrice / strikePrice) + (riskFreeRate + volatility * volatility / 2) * T) / (volatility * Math.sqrt(T));
        const d2 = d1 - volatility * Math.sqrt(T);
        
        const normalCDF = (x) => {
            const t = 1 / (1 + 0.2316419 * Math.abs(x));
            const d = 0.3989423 * Math.exp(-x * x / 2);
            const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
            return x > 0 ? 1 - prob : prob;
        };
        
        const newPrice = optionType === 'call' ?
            stockPrice * normalCDF(d1) - strikePrice * Math.exp(-riskFreeRate * T) * normalCDF(d2) :
            strikePrice * Math.exp(-riskFreeRate * T) * normalCDF(-d2) - stockPrice * normalCDF(-d1);
        
        // Cumulative theta decay
        const decayAmount = theta * day;
        
        scenarios.push({
            day,
            daysToExpiration: newDaysToExp,
            estimatedPrice: newPrice.toFixed(2),
            thetaDecay: decayAmount.toFixed(2),
            percentLoss: ((decayAmount / option.lastPrice) * 100).toFixed(2) + '%'
        });
    }
    
    return scenarios;
}

/**
 * Generate comprehensive scenario matrix
 * @param {Object} option - Base option data
 * @returns {Object} Complete scenario analysis
 */
function generateScenarioMatrix(option) {
    const priceScenarios = [-10, -5, -2, 0, 2, 5, 10];
    const timeScenarios = [1, 7, 14, 30];
    
    // Price movement scenarios
    const priceMatrix = priceScenarios.map(change => 
        modelPriceChange(option, change)
    );
    
    // Theta decay scenarios
    const thetaDecayMatrix = timeScenarios.map(days => ({
        days,
        scenarios: modelThetaDecay(option, days)
    }));
    
    // Combined scenario (price + time)
    const combinedMatrix = [];
    for (const priceChange of [-5, 0, 5]) {
        for (const days of [7, 14, 30]) {
            const newDaysToExp = Math.max(1, option.daysToExpiration - days);
            const newStockPrice = option.stockPrice * (1 + priceChange / 100);
            const T = newDaysToExp / 365;
            
            const d1 = (Math.log(newStockPrice / option.strikePrice) + 
                       (option.riskFreeRate || 0.05 + option.volatility * option.volatility / 2) * T) / 
                       (option.volatility * Math.sqrt(T));
            const d2 = d1 - option.volatility * Math.sqrt(T);
            
            const normalCDF = (x) => {
                const t = 1 / (1 + 0.2316419 * Math.abs(x));
                const d = 0.3989423 * Math.exp(-x * x / 2);
                const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
                return x > 0 ? 1 - prob : prob;
            };
            
            const newPrice = option.optionType === 'call' ?
                newStockPrice * normalCDF(d1) - option.strikePrice * Math.exp(-(option.riskFreeRate || 0.05) * T) * normalCDF(d2) :
                option.strikePrice * Math.exp(-(option.riskFreeRate || 0.05) * T) * normalCDF(-d2) - newStockPrice * normalCDF(-d1);
            
            const profitLoss = newPrice - option.lastPrice;
            
            combinedMatrix.push({
                priceChange: `${priceChange > 0 ? '+' : ''}${priceChange}%`,
                daysElapsed: days,
                newPrice: newPrice.toFixed(2),
                profitLoss: profitLoss.toFixed(2),
                profitLossPercent: ((profitLoss / option.lastPrice) * 100).toFixed(2) + '%'
            });
        }
    }
    
    return {
        symbol: option.symbol,
        strike: option.strike,
        expiration: option.expiration,
        type: option.optionType,
        currentPrice: option.lastPrice,
        currentStockPrice: option.stockPrice,
        priceScenarios: priceMatrix,
        thetaDecayScenarios: thetaDecayMatrix[0]?.scenarios || [],
        combinedScenarios: combinedMatrix,
        riskMetrics: calculateRiskMetrics(option, priceMatrix)
    };
}

/**
 * Calculate risk metrics from scenarios
 */
function calculateRiskMetrics(option, priceScenarios) {
    const profitLosses = priceScenarios.map(s => parseFloat(s.profitLoss));
    const maxProfit = Math.max(...profitLosses);
    const maxLoss = Math.min(...profitLosses);
    const breakeven = priceScenarios.find(s => Math.abs(parseFloat(s.profitLoss)) < 0.1);
    
    return {
        maxProfit: maxProfit.toFixed(2),
        maxLoss: maxLoss.toFixed(2),
        riskRewardRatio: (Math.abs(maxProfit / maxLoss)).toFixed(2),
        breakeven: breakeven ? breakeven.priceChange : 'N/A'
    };
}

module.exports = {
    modelPriceChange,
    modelThetaDecay,
    generateScenarioMatrix,
    calculateRiskMetrics
};
