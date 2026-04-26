/**
 * Personalized Stock Recommendation Engine
 * Provides tailored recommendations based on user profile, risk tolerance, and market conditions
 */

const { pool } = require('../config/database');

/**
 * Generate personalized recommendations for a user
 */
async function generatePersonalizedRecommendations(userId, weeklyPredictions, options = {}) {
    const {
        maxRecommendations = 10,
        riskTolerance = 'moderate' // conservative, moderate, aggressive
    } = options;

    try {
        // Get user portfolio and preferences
        const userProfile = await getUserProfile(userId);
        const userHoldings = await getUserHoldings(userId);
        
        // Analyze current portfolio
        const portfolioAnalysis = analyzePortfolio(userHoldings);
        
        // Generate recommendations based on multiple factors
        const recommendations = [];
        
        // 1. Top-rated stocks matching risk profile
        const topPicks = filterByRiskTolerance(weeklyPredictions, riskTolerance);
        
        // 2. Diversification opportunities
        const diversificationPicks = findDiversificationOpportunities(
            userHoldings,
            weeklyPredictions,
            portfolioAnalysis
        );
        
        // 3. Sector rotation plays
        const rotationPicks = findSectorRotationPlays(
            weeklyPredictions,
            portfolioAnalysis
        );
        
        // 4. High conviction plays
        const highConvictionPicks = findHighConvictionPlays(weeklyPredictions);
        
        // 5. Portfolio rebalancing suggestions
        const rebalancingSuggestions = generateRebalancingSuggestions(
            userHoldings,
            weeklyPredictions
        );
        
        // Combine and rank all recommendations
        const allRecommendations = [
            ...topPicks.map(p => ({ ...p, category: 'Top Rated', priority: 1 })),
            ...diversificationPicks.map(p => ({ ...p, category: 'Diversification', priority: 2 })),
            ...rotationPicks.map(p => ({ ...p, category: 'Sector Rotation', priority: 2 })),
            ...highConvictionPicks.map(p => ({ ...p, category: 'High Conviction', priority: 1 })),
        ];
        
        // Remove duplicates and rank
        const uniqueRecommendations = deduplicateAndRank(allRecommendations);
        
        // Add portfolio actions
        const portfolioActions = rebalancingSuggestions;
        
        return {
            recommendations: uniqueRecommendations.slice(0, maxRecommendations),
            portfolioActions,
            portfolioAnalysis,
            riskProfile: {
                tolerance: riskTolerance,
                currentExposure: portfolioAnalysis.riskScore,
                recommendation: getRiskRecommendation(portfolioAnalysis.riskScore, riskTolerance)
            },
            summary: generateRecommendationSummary(uniqueRecommendations, portfolioActions)
        };
        
    } catch (error) {
        console.error('[Recommendations] Error generating recommendations:', error);
        throw error;
    }
}

/**
 * Get user profile and preferences
 */
async function getUserProfile(userId) {
    const client = await pool.connect();
    try {
        const result = await client.query(
            'SELECT * FROM users WHERE id = $1',
            [userId]
        );
        return result.rows[0] || null;
    } finally {
        client.release();
    }
}

/**
 * Get user holdings
 */
async function getUserHoldings(userId) {
    const client = await pool.connect();
    try {
        const result = await client.query(
            'SELECT * FROM holdings WHERE user_id = $1',
            [userId]
        );
        return result.rows;
    } finally {
        client.release();
    }
}

/**
 * Analyze portfolio composition
 */
function analyzePortfolio(holdings) {
    if (!holdings || holdings.length === 0) {
        return {
            totalValue: 0,
            sectorExposure: {},
            riskScore: 50,
            diversificationScore: 0,
            topHoldings: []
        };
    }
    
    const totalValue = holdings.reduce((sum, h) => 
        sum + (parseFloat(h.quantity) * parseFloat(h.average_price)), 0
    );
    
    // Calculate sector exposure
    const sectorExposure = {};
    holdings.forEach(h => {
        const sector = h.sector || 'Unknown';
        const value = parseFloat(h.quantity) * parseFloat(h.average_price);
        sectorExposure[sector] = (sectorExposure[sector] || 0) + value;
    });
    
    // Convert to percentages
    Object.keys(sectorExposure).forEach(sector => {
        sectorExposure[sector] = (sectorExposure[sector] / totalValue) * 100;
    });
    
    // Calculate diversification score (0-100, higher is better)
    const uniqueSectors = Object.keys(sectorExposure).length;
    const concentrationRisk = Math.max(...Object.values(sectorExposure));
    const diversificationScore = Math.min(100, (uniqueSectors * 10) + (100 - concentrationRisk));
    
    // Calculate portfolio risk score
    const riskScore = calculatePortfolioRisk(holdings);
    
    // Top holdings
    const sortedHoldings = [...holdings].sort((a, b) => {
        const aValue = parseFloat(a.quantity) * parseFloat(a.average_price);
        const bValue = parseFloat(b.quantity) * parseFloat(b.average_price);
        return bValue - aValue;
    });
    
    return {
        totalValue,
        sectorExposure,
        riskScore,
        diversificationScore,
        topHoldings: sortedHoldings.slice(0, 5),
        holdingsCount: holdings.length
    };
}

/**
 * Calculate portfolio risk score
 */
function calculatePortfolioRisk(holdings) {
    if (!holdings || holdings.length === 0) return 50;
    
    // Simple risk calculation based on volatility and concentration
    const concentrationRisk = holdings.length < 5 ? 20 : holdings.length < 10 ? 10 : 0;
    const baseRisk = 50;
    
    return Math.min(100, baseRisk + concentrationRisk);
}

/**
 * Filter predictions by risk tolerance
 */
function filterByRiskTolerance(predictions, riskTolerance) {
    const riskThresholds = {
        conservative: { maxRisk: 40, minConfidence: 75, minScore: 70 },
        moderate: { maxRisk: 60, minConfidence: 65, minScore: 65 },
        aggressive: { maxRisk: 100, minConfidence: 50, minScore: 60 }
    };
    
    const threshold = riskThresholds[riskTolerance] || riskThresholds.moderate;
    
    return predictions
        .filter(p => 
            (p.riskAnalysis?.riskScore || 50) <= threshold.maxRisk &&
            p.prediction.confidence >= threshold.minConfidence &&
            p.totalScore >= threshold.minScore &&
            (p.prediction.signal === 'Buy' || p.prediction.signal === 'Strong Buy')
        )
        .slice(0, 5);
}

/**
 * Find diversification opportunities
 */
function findDiversificationOpportunities(holdings, predictions, portfolioAnalysis) {
    const { sectorExposure } = portfolioAnalysis;
    const existingSymbols = new Set(holdings.map(h => h.symbol));
    
    // Find underrepresented sectors
    const allSectors = [...new Set(predictions.map(p => p.sector))];
    const underweightSectors = allSectors.filter(sector => 
        (sectorExposure[sector] || 0) < 15 // Less than 15% exposure
    );
    
    // Find top stocks in underweight sectors
    const diversificationPicks = predictions
        .filter(p => 
            underweightSectors.includes(p.sector) &&
            !existingSymbols.has(p.symbol) &&
            p.totalScore >= 65 &&
            (p.prediction.signal === 'Buy' || p.prediction.signal === 'Strong Buy')
        )
        .slice(0, 3);
    
    return diversificationPicks.map(p => ({
        ...p,
        reason: `Diversify into ${p.sector} sector (currently ${(sectorExposure[p.sector] || 0).toFixed(1)}% of portfolio)`
    }));
}

/**
 * Find sector rotation plays
 */
function findSectorRotationPlays(predictions, portfolioAnalysis) {
    // Get predictions grouped by sector
    const sectorPerformance = {};
    
    predictions.forEach(p => {
        if (!sectorPerformance[p.sector]) {
            sectorPerformance[p.sector] = {
                stocks: [],
                avgScore: 0,
                avgMomentum: 0
            };
        }
        sectorPerformance[p.sector].stocks.push(p);
    });
    
    // Calculate sector averages
    Object.keys(sectorPerformance).forEach(sector => {
        const stocks = sectorPerformance[sector].stocks;
        sectorPerformance[sector].avgScore = 
            stocks.reduce((sum, s) => sum + s.totalScore, 0) / stocks.length;
        sectorPerformance[sector].avgMomentum = 
            stocks.reduce((sum, s) => sum + s.componentScores.momentum, 0) / stocks.length;
    });
    
    // Find sectors with high momentum
    const hotSectors = Object.entries(sectorPerformance)
        .filter(([sector, data]) => data.avgMomentum > 70 && data.avgScore > 65)
        .sort((a, b) => b[1].avgScore - a[1].avgScore)
        .slice(0, 2);
    
    // Get top stock from each hot sector
    const rotationPicks = hotSectors.flatMap(([sector, data]) => {
        const topStock = data.stocks
            .filter(s => s.prediction.signal === 'Buy' || s.prediction.signal === 'Strong Buy')
            .sort((a, b) => b.totalScore - a.totalScore)[0];
        
        return topStock ? [{
            ...topStock,
            reason: `Strong sector momentum in ${sector} (avg score: ${data.avgScore.toFixed(0)})`
        }] : [];
    });
    
    return rotationPicks;
}

/**
 * Find high conviction plays
 */
function findHighConvictionPlays(predictions) {
    return predictions
        .filter(p => 
            p.prediction.signal === 'Strong Buy' &&
            p.prediction.confidence >= 80 &&
            (p.riskAnalysis?.riskScore || 50) < 50 &&
            parseFloat(p.rewardRiskRatio || 0) > 1.5
        )
        .slice(0, 3)
        .map(p => ({
            ...p,
            reason: `High conviction: ${p.prediction.confidence}% confidence, ${p.rewardRiskRatio}x reward/risk`
        }));
}

/**
 * Generate rebalancing suggestions
 */
function generateRebalancingSuggestions(holdings, predictions) {
    const suggestions = [];
    const predictionMap = new Map(predictions.map(p => [p.symbol, p]));
    
    holdings.forEach(holding => {
        const prediction = predictionMap.get(holding.symbol);
        
        if (!prediction) return;
        
        // Suggest selling if avoid signal or high risk
        if (prediction.prediction.signal === 'Avoid' || 
            (prediction.riskAnalysis?.riskScore || 0) > 75) {
            suggestions.push({
                action: 'SELL',
                symbol: holding.symbol,
                currentValue: parseFloat(holding.quantity) * parseFloat(holding.average_price),
                reason: prediction.prediction.signal === 'Avoid' 
                    ? 'Weak technicals and fundamentals'
                    : `High risk (${prediction.riskAnalysis.riskScore}/100)`,
                urgency: 'high',
                prediction
            });
        }
        
        // Suggest trimming if overbought or taking profits
        else if (prediction.componentScores.technical < 40 || 
                 parseFloat(prediction.prediction.expectedMove) < -3) {
            const profitPct = ((parseFloat(prediction.currentPrice) - parseFloat(holding.average_price)) / 
                              parseFloat(holding.average_price)) * 100;
            
            if (profitPct > 20) {
                suggestions.push({
                    action: 'TRIM',
                    symbol: holding.symbol,
                    currentValue: parseFloat(holding.quantity) * parseFloat(holding.average_price),
                    reason: `Take profits (${profitPct.toFixed(1)}% gain), technical weakness detected`,
                    urgency: 'medium',
                    suggestedAmount: 0.5, // Trim 50%
                    prediction
                });
            }
        }
        
        // Suggest holding if good signal
        else if (prediction.prediction.signal === 'Buy' || 
                 prediction.prediction.signal === 'Strong Buy' ||
                 prediction.prediction.signal === 'Hold') {
            // No action needed, but could suggest adding
            if (prediction.prediction.signal === 'Strong Buy' && 
                prediction.prediction.confidence > 75) {
                suggestions.push({
                    action: 'ADD',
                    symbol: holding.symbol,
                    currentValue: parseFloat(holding.quantity) * parseFloat(holding.average_price),
                    reason: `Strong buy signal, ${prediction.prediction.confidence}% confidence`,
                    urgency: 'low',
                    suggestedAmount: 0.25, // Add 25% more
                    prediction
                });
            }
        }
    });
    
    return suggestions;
}

/**
 * Deduplicate and rank recommendations
 */
function deduplicateAndRank(recommendations) {
    const seen = new Set();
    const unique = [];
    
    recommendations.forEach(rec => {
        if (!seen.has(rec.symbol)) {
            seen.add(rec.symbol);
            unique.push(rec);
        }
    });
    
    // Rank by priority, then score, then confidence
    return unique.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
        return b.prediction.confidence - a.prediction.confidence;
    });
}

/**
 * Get risk recommendation
 */
function getRiskRecommendation(portfolioRisk, riskTolerance) {
    const toleranceMap = {
        conservative: 35,
        moderate: 50,
        aggressive: 65
    };
    
    const targetRisk = toleranceMap[riskTolerance] || 50;
    const diff = portfolioRisk - targetRisk;
    
    if (Math.abs(diff) < 10) {
        return 'Portfolio risk is well-aligned with your risk tolerance';
    } else if (diff > 10) {
        return 'Portfolio is riskier than target. Consider reducing exposure to high-risk positions';
    } else {
        return 'Portfolio is conservative. Consider adding growth positions for better returns';
    }
}

/**
 * Generate summary
 */
function generateRecommendationSummary(recommendations, actions) {
    const buyCount = recommendations.filter(r => 
        r.prediction.signal === 'Buy' || r.prediction.signal === 'Strong Buy'
    ).length;
    
    const sellCount = actions.filter(a => a.action === 'SELL').length;
    const trimCount = actions.filter(a => a.action === 'TRIM').length;
    const addCount = actions.filter(a => a.action === 'ADD').length;
    
    return {
        newOpportunities: buyCount,
        portfolioAdjustments: {
            sells: sellCount,
            trims: trimCount,
            adds: addCount
        },
        topCategories: [...new Set(recommendations.map(r => r.category))],
        message: `${buyCount} new opportunities identified. ${sellCount + trimCount} position adjustments recommended.`
    };
}

module.exports = {
    generatePersonalizedRecommendations
};
