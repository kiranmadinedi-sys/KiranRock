const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const marketScreenerService = require('./marketScreenerService');
const tradingServiceDB = require('./tradingServiceDB');
const userDb = require('./userDatabaseService');
const accountDb = require('./tradingAccountDatabaseService');
const holdingsDb = require('./holdingsDatabaseService');
const tradesDb = require('./tradesDatabaseService');
const { query } = require('../config/database');

/**
 * Enhanced AI Trading Bot Service - PostgreSQL Version
 * Automatically analyzes ALL available stocks and trades autonomously
 */

// Default risk management configuration
const DEFAULT_RISK_CONFIG = {
    // Position sizing
    maxPositionSize: 0.15,        // Max 15% in single stock
    minPositionSize: 0.02,        // Min 2% per position
    maxPortfolioRisk: 0.60,       // Max 60% invested (40% cash reserve)
    
    // Entry/Exit rules
    minBuyScore: 65,              // Min AI score to buy
    stopLoss: -0.12,              // Sell at 12% loss
    trailingStopPercent: 0.08,    // Trail stop 8% from peak
    takeProfitPercent: 0.25,      // Take profit at 25% gain
    partialTakeProfitPercent: 0.15, // Sell 50% at 15% gain
    
    // Risk limits
    maxOpenPositions: 25,         // Max number of holdings
    minMarketCap: 5000000000,     // Min $5B market cap
    maxDailyTrades: 10,           // Max trades per day
    
    // Volatility management
    maxVix: 30,                   // Don't buy if VIX > 30
    reducePositionsVix: 25,       // Reduce exposure if VIX > 25
    
    // Diversification
    maxSectorAllocation: 0.35,    // Max 35% per sector
    preferredSectors: ['Technology', 'Healthcare', 'Financials', 'Consumer']
};

/**
 * Get user's risk configuration from database
 */
async function getUserRiskConfig(userId) {
    try {
        const result = await query(
            'SELECT * FROM risk_configs WHERE user_id = $1',
            [userId]
        );
        
        if (result.rows[0]) {
            const dbConfig = result.rows[0];
            return {
                maxPositionSize: parseFloat(dbConfig.max_position_size),
                minPositionSize: parseFloat(dbConfig.min_position_size),
                maxPortfolioRisk: parseFloat(dbConfig.max_portfolio_risk),
                minBuyScore: dbConfig.min_buy_score,
                stopLoss: parseFloat(dbConfig.stop_loss),
                trailingStopPercent: parseFloat(dbConfig.trailing_stop_percent),
                takeProfitPercent: parseFloat(dbConfig.take_profit_percent),
                partialTakeProfitPercent: parseFloat(dbConfig.partial_take_profit_percent),
                maxOpenPositions: dbConfig.max_open_positions,
                minMarketCap: dbConfig.min_market_cap,
                maxDailyTrades: dbConfig.max_daily_trades,
                maxVix: parseFloat(dbConfig.max_vix),
                reducePositionsVix: parseFloat(dbConfig.reduce_positions_vix),
                maxSectorAllocation: parseFloat(dbConfig.max_sector_allocation)
            };
        }
        
        return DEFAULT_RISK_CONFIG;
    } catch (err) {
        console.error('Error getting risk config:', err);
        return DEFAULT_RISK_CONFIG;
    }
}

/**
 * Check if market is open (NYSE hours: 9:30 AM - 4:00 PM ET, Mon-Fri)
 */
function isMarketOpen() {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    
    // Weekend
    if (day === 0 || day === 6) {
        return false;
    }
    
    // Convert to ET (UTC-5)
    const etHour = (hour - 5 + 24) % 24;
    const etTime = etHour + minute / 60;
    
    // Market hours: 9:30 AM - 4:00 PM ET
    return etTime >= 9.5 && etTime < 16;
}

/**
 * Get current VIX level
 */
async function getVixLevel() {
    try {
        const quote = await yahooFinance.quote('^VIX');
        return quote.regularMarketPrice || 15;
    } catch (error) {
        console.log('[AI Bot] Could not fetch VIX, assuming normal level');
        return 15;
    }
}

/**
 * Analyze a single stock with AI scoring
 */
async function analyzeStockWithAI(symbol, vixLevel) {
    try {
        const quote = await yahooFinance.quoteSummary(symbol, {
            modules: ['price', 'summaryDetail', 'defaultKeyStatistics']
        });
        
        if (!quote || !quote.price || !quote.price.regularMarketPrice) {
            return null;
        }

        const price = quote.price.regularMarketPrice;
        const change = quote.price.regularMarketChangePercent || 0;
        const volume = quote.price.regularMarketVolume || 0;
        const avgVolume = quote.summaryDetail?.averageDailyVolume10Day || volume;
        const marketCap = quote.price.marketCap || 0;
        const sector = quote.summaryDetail?.sector || 'Unknown';

        // Technical indicators
        const volumeRatio = volume / avgVolume;
        const momentum = change / 100;
        
        // Scoring components
        let score = 50; // Base score
        
        // Momentum score (40% weight)
        if (momentum > 0.03) score += 20;      // Strong up > 3%
        else if (momentum > 0.01) score += 12; // Moderate up > 1%
        else if (momentum > 0) score += 5;     // Slight up
        else if (momentum > -0.01) score -= 5; // Slight down
        else if (momentum > -0.03) score -= 12; // Moderate down
        else score -= 20;                      // Strong down

        // Volume score (30% weight)
        if (volumeRatio > 2.0) score += 15;    // Very high volume
        else if (volumeRatio > 1.5) score += 10;
        else if (volumeRatio > 1.0) score += 5;
        else if (volumeRatio < 0.5) score -= 10; // Low volume

        // VIX impact (15% weight)
        if (vixLevel < 15) score += 7;         // Low volatility
        else if (vixLevel < 20) score += 3;
        else if (vixLevel > 30) score -= 15;   // High volatility
        else if (vixLevel > 25) score -= 8;

        // Market cap quality (15% weight)
        if (marketCap > 100e9) score += 7;     // Large cap > $100B
        else if (marketCap > 10e9) score += 5; // Mid cap > $10B
        else if (marketCap < 5e9) score -= 10; // Small cap < $5B

        // Normalize score to 0-100
        score = Math.max(0, Math.min(100, score));

        // Generate recommendation
        let recommendation = 'HOLD';
        if (score >= 75) recommendation = 'STRONG BUY';
        else if (score >= 65) recommendation = 'BUY';
        else if (score <= 25) recommendation = 'STRONG SELL';
        else if (score <= 35) recommendation = 'SELL';

        return {
            symbol,
            price,
            change,
            volume,
            volumeRatio: volumeRatio.toFixed(2),
            marketCap,
            sector,
            aiScore: Math.round(score),
            recommendation,
            confidence: Math.abs(score - 50) / 50 * 100,
            vixLevel,
            timestamp: new Date()
        };
    } catch (error) {
        console.error(`[AI Bot] Error analyzing ${symbol}:`, error.message);
        return null;
    }
}

/**
 * Scan entire market universe and find best opportunities
 */
async function scanMarketForOpportunities(userId, limit = 50) {
    console.log('[AI Bot] Scanning market for opportunities...');
    
    const vixLevel = await getVixLevel();
    const riskConfig = await getUserRiskConfig(userId);
    const universe = await marketScreenerService.getStockUniverse();
    
    console.log(`[AI Bot] Analyzing ${universe.length} stocks (VIX: ${vixLevel.toFixed(2)})`);
    
    // Filter by minimum market cap
    const qualified = universe.filter(stock => 
        stock.marketCap >= riskConfig.minMarketCap
    );
    
    console.log(`[AI Bot] ${qualified.length} stocks meet market cap requirement`);
    
    // Analyze all stocks in batches (reduced to prevent Yahoo Finance rate limiting)
    const opportunities = [];
    const batchSize = 5;  // Reduced from 20 to 5 to respect rate limits
    
    for (let i = 0; i < qualified.length; i += batchSize) {
        const batch = qualified.slice(i, i + batchSize);
        const results = await Promise.allSettled(
            batch.map(stock => analyzeStockWithAI(stock.symbol, vixLevel))
        );
        
        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value) {
                const analysis = result.value;
                const stockInfo = batch[index];
                
                // Only consider BUY or STRONG BUY with good score
                if (analysis.aiScore >= riskConfig.minBuyScore &&
                    (analysis.recommendation === 'BUY' || analysis.recommendation === 'STRONG BUY')) {
                    opportunities.push({
                        ...analysis,
                        sector: stockInfo.sector,
                        industry: stockInfo.industry
                    });
                }
            }
        });
        
        // Increased delay between batches to respect Yahoo Finance rate limits
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3 seconds between batches
        
        // Progress update
        if ((i + batchSize) % 100 === 0) {
            console.log(`[AI Bot] Analyzed ${Math.min(i + batchSize, qualified.length)}/${qualified.length} stocks, found ${opportunities.length} opportunities`);
        }
    }
    
    // Sort by AI score and return top opportunities
    opportunities.sort((a, b) => b.aiScore - a.aiScore);
    
    console.log(`[AI Bot] ✓ Found ${opportunities.length} buy opportunities, returning top ${limit}`);
    
    return opportunities.slice(0, limit);
}

/**
 * Execute autonomous trading for a user
 */
async function executeAutonomousTrading(userId) {
    try {
        console.log(`\n[AI Bot] Starting autonomous trading for user ${userId}`);
        
        // Check if market is open
        if (!isMarketOpen()) {
            console.log('[AI Bot] Market is closed, skipping trading');
            return { success: false, message: 'Market is closed' };
        }
        
        const riskConfig = await getUserRiskConfig(userId);
        const vixLevel = await getVixLevel();
        
        // Check VIX - reduce trading if too volatile
        if (vixLevel > riskConfig.maxVix) {
            console.log(`[AI Bot] VIX too high (${vixLevel.toFixed(2)}), skipping new purchases`);
            // Still check for stop-loss and exits
            await manageExistingPositions(userId);
            return { success: false, message: `Market too volatile (VIX: ${vixLevel.toFixed(2)})` };
        }
        
        // Get account and portfolio info
        const account = await accountDb.getTradingAccount(userId);
        const portfolio = await tradingServiceDB.getPortfolioSummary(userId);
        
        const availableBalance = parseFloat(account.balance);
        const currentHoldings = portfolio.holdings || [];
        const totalPortfolioValue = portfolio.totalPortfolioValue || availableBalance;
        
        console.log(`[AI Bot] Account Balance: $${availableBalance.toFixed(2)}, Holdings: ${currentHoldings.length}`);
        
        // Manage existing positions (stop-loss, take-profit, trailing stops)
        await manageExistingPositions(userId);
        
        // Calculate how much we can invest
        const maxInvestment = totalPortfolioValue * riskConfig.maxPortfolioRisk;
        const currentInvestment = currentHoldings.reduce((sum, h) => sum + (h.marketValue || 0), 0);
        const availableToInvest = Math.min(
            availableBalance,
            maxInvestment - currentInvestment
        );
        
        console.log(`[AI Bot] Can invest: $${availableToInvest.toFixed(2)}`);
        
        if (availableToInvest < 100 || currentHoldings.length >= riskConfig.maxOpenPositions) {
            console.log('[AI Bot] No capital available or max positions reached');
            return { success: true, message: 'Portfolio at capacity' };
        }
        
        // Scan market for best opportunities
        const opportunities = await scanMarketForOpportunities(userId, 30);
        
        if (opportunities.length === 0) {
            console.log('[AI Bot] No qualifying opportunities found');
            return { success: true, message: 'No opportunities meet criteria' };
        }
        
        // Filter out stocks we already own
        const ownedSymbols = currentHoldings.map(h => h.symbol);
        const newOpportunities = opportunities.filter(opp => !ownedSymbols.includes(opp.symbol));
        
        // Check sector diversification
        const sectorAllocations = {};
        currentHoldings.forEach(h => {
            const sector = h.sector || 'Unknown';
            sectorAllocations[sector] = (sectorAllocations[sector] || 0) + (h.marketValue || 0);
        });
        
        // Execute trades
        const trades = [];
        let remainingCapital = availableToInvest;
        
        for (const opportunity of newOpportunities) {
            if (trades.length >= riskConfig.maxDailyTrades) break;
            if (remainingCapital < 100) break;
            if (currentHoldings.length + trades.length >= riskConfig.maxOpenPositions) break;
            
            // Check sector limit
            const sector = opportunity.sector || 'Unknown';
            const sectorCurrent = sectorAllocations[sector] || 0;
            const sectorLimit = totalPortfolioValue * riskConfig.maxSectorAllocation;
            
            if (sectorCurrent >= sectorLimit) {
                console.log(`[AI Bot] Skipping ${opportunity.symbol} - sector ${sector} at limit`);
                continue;
            }
            
            // Calculate position size based on AI score and risk
            const basePosition = remainingCapital * riskConfig.minPositionSize;
            const maxPosition = Math.min(
                remainingCapital * riskConfig.maxPositionSize,
                sectorLimit - sectorCurrent
            );
            
            // Scale position size with AI score
            const scoreMultiplier = (opportunity.aiScore - riskConfig.minBuyScore) / (100 - riskConfig.minBuyScore);
            const positionSize = basePosition + (maxPosition - basePosition) * scoreMultiplier;
            
            const shares = Math.floor(positionSize / opportunity.price);
            
            if (shares > 0) {
                try {
                    console.log(`[AI Bot] BUY ${shares} shares of ${opportunity.symbol} @ $${opportunity.price.toFixed(2)} (Score: ${opportunity.aiScore})`);
                    
                    const result = await tradingServiceDB.executeBuyOrder(
                        userId, 
                        opportunity.symbol, 
                        shares,
                        'AI_BOT',
                        opportunity.aiScore,
                        opportunity.sector
                    );
                    
                    trades.push({
                        action: 'BUY',
                        symbol: opportunity.symbol,
                        shares,
                        price: result.price,
                        total: result.total,
                        aiScore: opportunity.aiScore,
                        sector: opportunity.sector
                    });
                    
                    remainingCapital -= result.totalWithCommission;
                    sectorAllocations[sector] = (sectorAllocations[sector] || 0) + result.total;
                    
                } catch (error) {
                    console.error(`[AI Bot] Error buying ${opportunity.symbol}:`, error.message);
                }
            }
        }
        
        console.log(`[AI Bot] ✓ Executed ${trades.length} trades, invested $${(availableToInvest - remainingCapital).toFixed(2)}`);
        
        return {
            success: true,
            tradesExecuted: trades.length,
            trades,
            capitalDeployed: availableToInvest - remainingCapital,
            opportunitiesFound: opportunities.length
        };
        
    } catch (error) {
        console.error('[AI Bot] Error in autonomous trading:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Manage existing positions (stop-loss, take-profit, trailing stops)
 */
async function manageExistingPositions(userId) {
    try {
        const holdings = await holdingsDb.getUserHoldings(userId);
        
        if (!holdings || holdings.length === 0) {
            return;
        }
        
        const riskConfig = await getUserRiskConfig(userId);
        
        for (const holding of holdings) {
            try {
                const currentPrice = await tradingServiceDB.getCurrentPrice(holding.symbol);
                if (!currentPrice) continue;
                
                const purchasePrice = holding.average_price;
                const changePercent = (currentPrice - purchasePrice) / purchasePrice;
                
                // Update peak price for trailing stop
                if (!holding.peak_price || currentPrice > holding.peak_price) {
                    await holdingsDb.updatePeakPrice(userId, holding.symbol, currentPrice);
                    holding.peak_price = currentPrice;
                }
                
                const trailingStopPrice = holding.peak_price * (1 - riskConfig.trailingStopPercent);
                
                let shouldSell = false;
                let reason = '';
                let sellQuantity = holding.quantity;
                
                // Hard stop-loss
                if (changePercent <= riskConfig.stopLoss) {
                    shouldSell = true;
                    reason = `Stop-loss triggered at ${(changePercent * 100).toFixed(2)}%`;
                }
                // Trailing stop
                else if (currentPrice <= trailingStopPrice) {
                    shouldSell = true;
                    const dropFromPeak = ((currentPrice - holding.peak_price) / holding.peak_price * 100).toFixed(2);
                    reason = `Trailing stop triggered: dropped ${dropFromPeak}% from peak`;
                }
                // Full take-profit
                else if (changePercent >= riskConfig.takeProfitPercent) {
                    shouldSell = true;
                    reason = `Take-profit target reached at ${(changePercent * 100).toFixed(2)}%`;
                }
                // Partial take-profit
                else if (changePercent >= riskConfig.partialTakeProfitPercent && !holding.partial_profit_taken) {
                    shouldSell = true;
                    sellQuantity = Math.floor(holding.quantity / 2);
                    reason = `Partial take-profit at ${(changePercent * 100).toFixed(2)}% (selling 50%)`;
                    await holdingsDb.markPartialProfitTaken(userId, holding.symbol, true);
                }
                
                if (shouldSell && sellQuantity > 0) {
                    console.log(`[AI Bot] SELL ${sellQuantity} shares of ${holding.symbol}: ${reason}`);
                    await tradingServiceDB.executeSellOrder(userId, holding.symbol, sellQuantity, 'AI_BOT', reason);
                }
                
            } catch (error) {
                console.error(`[AI Bot] Error managing ${holding.symbol}:`, error.message);
            }
        }
        
    } catch (error) {
        console.error('[AI Bot] Error managing positions:', error);
    }
}

module.exports = {
    executeAutonomousTrading,
    scanMarketForOpportunities,
    analyzeStockWithAI,
    isMarketOpen,
    getUserRiskConfig,
    manageExistingPositions
};
