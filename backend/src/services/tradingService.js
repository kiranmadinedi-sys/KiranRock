const fs = require('fs').promises;
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

const USERS_FILE = path.join(__dirname, '../../users.json');

/**
 * Get current market price for a symbol
 */
const getCurrentPrice = async (symbol) => {
    try {
        const quote = await yahooFinance.quote(symbol);
        return quote.regularMarketPrice || quote.price || null;
    } catch (error) {
        console.error(`Error getting price for ${symbol}:`, error.message);
        throw new Error(`Unable to get current price for ${symbol}`);
    }
};

/**
 * Execute a buy order
 */
const executeBuyOrder = async (userId, symbol, quantity) => {
    try {
        if (quantity <= 0 || !Number.isInteger(quantity)) {
            throw new Error('Quantity must be a positive integer');
        }
        
        // Get current price
        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            throw new Error('Unable to fetch current price');
        }
        
        const totalCost = currentPrice * quantity;
        
        // Read users file
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const userIndex = users.findIndex(u => u.id === userId);
        
        if (userIndex === -1) {
            throw new Error('User not found');
        }
        
        // Initialize trading account if needed
        if (!users[userIndex].tradingAccount) {
            users[userIndex].tradingAccount = {
                balance: 100000,
                totalDeposited: 100000,
                totalWithdrawn: 0
            };
        }
        
        const account = users[userIndex].tradingAccount;
        
        // Check sufficient funds
        if (account.balance < totalCost) {
            throw new Error(`Insufficient funds. Need $${totalCost.toFixed(2)}, have $${account.balance.toFixed(2)}`);
        }
        
        // Deduct funds
        account.balance -= totalCost;
        
        // Initialize trades array
        if (!users[userIndex].trades) {
            users[userIndex].trades = [];
        }
        
        // Create trade record
        const trade = {
            id: `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            symbol: symbol.toUpperCase(),
            type: 'BUY',
            quantity,
            price: currentPrice,
            totalCost,
            timestamp: new Date().toISOString(),
            status: 'executed'
        };
        
        users[userIndex].trades.push(trade);
        
        // Update or add to portfolio holdings
        if (!users[userIndex].holdings) {
            users[userIndex].holdings = [];
        }
        
        const holdingIndex = users[userIndex].holdings.findIndex(h => h.symbol === symbol.toUpperCase());
        
        if (holdingIndex >= 0) {
            // Update existing holding
            const holding = users[userIndex].holdings[holdingIndex];
            const totalShares = holding.quantity + quantity;
            const totalValue = (holding.quantity * holding.averagePrice) + totalCost;
            holding.averagePrice = totalValue / totalShares;
            holding.quantity = totalShares;
            holding.lastUpdated = new Date().toISOString();
        } else {
            // Create new holding
            users[userIndex].holdings.push({
                symbol: symbol.toUpperCase(),
                quantity,
                averagePrice: currentPrice,
                firstPurchaseDate: new Date().toISOString(),
                lastUpdated: new Date().toISOString()
            });
        }
        
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
        
        return {
            success: true,
            trade,
            newBalance: account.balance,
            message: `Successfully bought ${quantity} shares of ${symbol.toUpperCase()} at $${currentPrice.toFixed(2)}`
        };
        
    } catch (error) {
        console.error('Error executing buy order:', error);
        throw error;
    }
};

/**
 * Execute a sell order
 */
const executeSellOrder = async (userId, symbol, quantity) => {
    try {
        if (quantity <= 0 || !Number.isInteger(quantity)) {
            throw new Error('Quantity must be a positive integer');
        }
        
        // Get current price
        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            throw new Error('Unable to fetch current price');
        }
        
        const totalProceeds = currentPrice * quantity;
        
        // Read users file
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const userIndex = users.findIndex(u => u.id === userId);
        
        if (userIndex === -1) {
            throw new Error('User not found');
        }
        
        // Initialize holdings if needed
        if (!users[userIndex].holdings) {
            users[userIndex].holdings = [];
        }
        
        // Check if user has the stock
        const holdingIndex = users[userIndex].holdings.findIndex(h => h.symbol === symbol.toUpperCase());
        
        if (holdingIndex === -1) {
            throw new Error(`You don't own any shares of ${symbol.toUpperCase()}`);
        }
        
        const holding = users[userIndex].holdings[holdingIndex];
        
        if (holding.quantity < quantity) {
            throw new Error(`Insufficient shares. You have ${holding.quantity} shares, trying to sell ${quantity}`);
        }
        
        // Calculate profit/loss
        const costBasis = holding.averagePrice * quantity;
        const profitLoss = totalProceeds - costBasis;
        const profitLossPercent = (profitLoss / costBasis) * 100;
        
        // Initialize trading account if needed
        if (!users[userIndex].tradingAccount) {
            users[userIndex].tradingAccount = {
                balance: 0,
                totalDeposited: 0,
                totalWithdrawn: 0
            };
        }
        
        // Add proceeds to balance
        users[userIndex].tradingAccount.balance += totalProceeds;
        
        // Update holding
        holding.quantity -= quantity;
        holding.lastUpdated = new Date().toISOString();
        
        // Remove holding if quantity is 0
        if (holding.quantity === 0) {
            users[userIndex].holdings.splice(holdingIndex, 1);
        }
        
        // Initialize trades array
        if (!users[userIndex].trades) {
            users[userIndex].trades = [];
        }
        
        // Create trade record
        const trade = {
            id: `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            symbol: symbol.toUpperCase(),
            type: 'SELL',
            quantity,
            price: currentPrice,
            totalProceeds,
            costBasis,
            profitLoss,
            profitLossPercent,
            timestamp: new Date().toISOString(),
            status: 'executed'
        };
        
        users[userIndex].trades.push(trade);
        
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
        
        return {
            success: true,
            trade,
            newBalance: users[userIndex].tradingAccount.balance,
            profitLoss,
            profitLossPercent,
            message: `Successfully sold ${quantity} shares of ${symbol.toUpperCase()} at $${currentPrice.toFixed(2)}. ${profitLoss >= 0 ? 'Profit' : 'Loss'}: $${Math.abs(profitLoss).toFixed(2)} (${profitLossPercent.toFixed(2)}%)`
        };
        
    } catch (error) {
        console.error('Error executing sell order:', error);
        throw error;
    }
};

/**
 * Get user's trade history
 */
const getTradeHistory = async (userId, limit = 50) => {
    try {
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const user = users.find(u => u.id === userId);
        
        if (!user) {
            throw new Error('User not found');
        }
        
        const trades = user.trades || [];
        
        // Sort by timestamp descending
        const sortedTrades = trades.sort((a, b) => 
            new Date(b.timestamp) - new Date(a.timestamp)
        );
        
        return sortedTrades.slice(0, limit);
    } catch (error) {
        console.error('Error getting trade history:', error);
        throw error;
    }
};

/**
 * Get user's current holdings
 */
const getHoldings = async (userId) => {
    try {
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const user = users.find(u => u.id === userId);
        
        if (!user) {
            throw new Error('User not found');
        }
        
        return user.holdings || [];
    } catch (error) {
        console.error('Error getting holdings:', error);
        throw error;
    }
};

module.exports = {
    executeBuyOrder,
    executeSellOrder,
    getTradeHistory,
    getHoldings,
    getCurrentPrice
};
