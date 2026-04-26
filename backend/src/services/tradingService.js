const { query } = require('../config/database');
const yfClient = require('../utils/yfClient');

/**
 * Get current market price for a symbol
 */
const getCurrentPrice = async (symbol) => {
    try {
        const quote = await yfClient.quote(symbol);
        return (quote && (quote.regularMarketPrice || quote.price || quote?.price?.regularMarketPrice)) || null;
    } catch (error) {
        console.error(`Error getting price for ${symbol}:`, error && error.message ? error.message : error);
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
        
        // Get user's trading account
        const accountResult = await query(
            'SELECT id, balance FROM trading_accounts WHERE user_id = $1',
            [userId]
        );
        
        if (accountResult.rows.length === 0) {
            throw new Error('Trading account not found');
        }
        
        const account = accountResult.rows[0];
        const currentBalance = parseFloat(account.balance);
        
        // Check sufficient funds
        if (currentBalance < totalCost) {
            throw new Error(`Insufficient funds. Need $${totalCost.toFixed(2)}, have $${currentBalance.toFixed(2)}`);
        }
        
        // Deduct funds from trading account
        const newBalance = currentBalance - totalCost;
        await query(
            'UPDATE trading_accounts SET balance = $1, updated_at = NOW() WHERE user_id = $2',
            [newBalance, userId]
        );
        
        // Create trade record
        const tradeResult = await query(
            `INSERT INTO trades (user_id, symbol, action, quantity, price, total, trade_date, executed_by, notes) 
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8) 
             RETURNING id, symbol, action as type, quantity, price, total as "totalCost", trade_date as timestamp`,
            [userId, symbol.toUpperCase(), 'BUY', quantity, currentPrice, totalCost, 'USER', 'Buy order']
        );
        
        const trade = tradeResult.rows[0];
        
        // Update or add to holdings
        const holdingResult = await query(
            'SELECT id, quantity, average_price FROM holdings WHERE user_id = $1 AND symbol = $2',
            [userId, symbol.toUpperCase()]
        );
        
        if (holdingResult.rows.length > 0) {
            // Update existing holding
            const holding = holdingResult.rows[0];
            const totalShares = parseFloat(holding.quantity) + quantity;
            const totalValue = (parseFloat(holding.quantity) * parseFloat(holding.average_price)) + totalCost;
            const newAveragePrice = totalValue / totalShares;
            
            await query(
                'UPDATE holdings SET quantity = $1, average_price = $2, updated_at = NOW() WHERE id = $3',
                [totalShares, newAveragePrice, holding.id]
            );
        } else {
            // Create new holding
            await query(
                'INSERT INTO holdings (user_id, symbol, quantity, average_price, purchase_date) VALUES ($1, $2, $3, $4, NOW())',
                [userId, symbol.toUpperCase(), quantity, currentPrice]
            );
        }
        
        return {
            success: true,
            trade: {
                id: trade.id.toString(),
                symbol: trade.symbol,
                type: 'BUY',
                quantity: parseInt(trade.quantity),
                price: parseFloat(trade.price),
                totalCost: parseFloat(trade.totalCost),
                timestamp: trade.timestamp
            },
            newBalance,
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
        
        // Check if user has the stock
        const holdingResult = await query(
            'SELECT id, quantity, average_price FROM holdings WHERE user_id = $1 AND symbol = $2',
            [userId, symbol.toUpperCase()]
        );
        
        if (holdingResult.rows.length === 0) {
            throw new Error(`You don't own any shares of ${symbol.toUpperCase()}`);
        }
        
        const holding = holdingResult.rows[0];
        const currentQuantity = parseFloat(holding.quantity);
        const averagePrice = parseFloat(holding.average_price);
        
        if (currentQuantity < quantity) {
            throw new Error(`Insufficient shares. You have ${currentQuantity} shares, trying to sell ${quantity}`);
        }
        
        // Calculate profit/loss
        const costBasis = averagePrice * quantity;
        const profitLoss = totalProceeds - costBasis;
        const profitLossPercent = (profitLoss / costBasis) * 100;
        
        // Get trading account
        const accountResult = await query(
            'SELECT id, balance FROM trading_accounts WHERE user_id = $1',
            [userId]
        );
        
        if (accountResult.rows.length === 0) {
            throw new Error('Trading account not found');
        }
        
        const account = accountResult.rows[0];
        const newBalance = parseFloat(account.balance) + totalProceeds;
        
        // Add proceeds to balance
        await query(
            'UPDATE trading_accounts SET balance = $1, updated_at = NOW() WHERE user_id = $2',
            [newBalance, userId]
        );
        
        // Update holding
        const newQuantity = currentQuantity - quantity;
        
        if (newQuantity === 0) {
            // Remove holding if quantity is 0
            await query('DELETE FROM holdings WHERE id = $1', [holding.id]);
        } else {
            // Update quantity
            await query(
                'UPDATE holdings SET quantity = $1, updated_at = NOW() WHERE id = $2',
                [newQuantity, holding.id]
            );
        }
        
        // Create trade record
        const tradeResult = await query(
            `INSERT INTO trades (user_id, symbol, action, quantity, price, total, trade_date, executed_by, notes) 
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8) 
             RETURNING id, symbol, action as type, quantity, price, total as "totalProceeds", trade_date as timestamp, notes`,
            [userId, symbol.toUpperCase(), 'SELL', quantity, currentPrice, totalProceeds, 'USER', `P/L: $${profitLoss.toFixed(2)} (${profitLossPercent.toFixed(2)}%)`]
        );
        
        const trade = tradeResult.rows[0];
        
        return {
            success: true,
            trade: {
                id: trade.id.toString(),
                symbol: trade.symbol,
                type: 'SELL',
                quantity: parseInt(trade.quantity),
                price: parseFloat(trade.price),
                totalProceeds: parseFloat(trade.totalProceeds),
                costBasis,
                profitLoss,
                profitLossPercent,
                timestamp: trade.timestamp
            },
            newBalance,
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
        const result = await query(
            `SELECT id, symbol, action as type, quantity, price, total, 
                    trade_date as timestamp, notes 
             FROM trades 
             WHERE user_id = $1 AND action IN ('BUY', 'SELL')
             ORDER BY trade_date DESC 
             LIMIT $2`,
            [userId, limit]
        );
        
        return result.rows.map(trade => ({
            id: trade.id.toString(),
            symbol: trade.symbol,
            type: trade.type.toUpperCase(),
            quantity: parseInt(trade.quantity),
            price: parseFloat(trade.price),
            totalCost: trade.type === 'BUY' ? parseFloat(trade.total) : undefined,
            totalProceeds: trade.type === 'SELL' ? parseFloat(trade.total) : undefined,
            timestamp: trade.timestamp,
            notes: trade.notes
        }));
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
        const result = await query(
            `SELECT id, symbol, quantity, average_price as "averagePrice", current_price as "currentPrice",
                    market_value as "marketValue", gain_loss as "gainLoss", gain_loss_percent as "gainLossPercent",
                    purchase_date as "firstPurchaseDate", updated_at as "lastUpdated"
             FROM holdings 
             WHERE user_id = $1 
             ORDER BY purchase_date DESC`,
            [userId]
        );
        
        return result.rows.map(holding => ({
            id: holding.id.toString(),
            symbol: holding.symbol,
            quantity: parseFloat(holding.quantity),
            averagePrice: parseFloat(holding.averagePrice),
            currentPrice: holding.currentPrice !== null && holding.currentPrice !== undefined ? parseFloat(holding.currentPrice) : null,
            marketValue: holding.marketValue !== null && holding.marketValue !== undefined ? parseFloat(holding.marketValue) : null,
            gainLoss: holding.gainLoss !== null && holding.gainLoss !== undefined ? parseFloat(holding.gainLoss) : null,
            gainLossPercent: holding.gainLossPercent !== null && holding.gainLossPercent !== undefined ? parseFloat(holding.gainLossPercent) : null,
            firstPurchaseDate: holding.firstPurchaseDate,
            lastUpdated: holding.lastUpdated
        }));
    } catch (error) {
        console.error('Error getting holdings:', error);
        throw error;
    }
};

/**
 * Clear all holdings and trade history
 */
const clearAllHoldings = async (userId) => {
    try {
        // Clear holdings
        await query('DELETE FROM holdings WHERE user_id = $1', [userId]);
        
        // Clear trade history (buy/sell only, keep deposits/withdrawals)
        await query(
            "DELETE FROM trades WHERE user_id = $1 AND action IN ('BUY', 'SELL')",
            [userId]
        );
        
        return { success: true, message: 'Holdings cleared successfully' };
    } catch (error) {
        console.error('Error clearing holdings:', error);
        throw error;
    }
};

module.exports = {
    executeBuyOrder,
    executeSellOrder,
    getTradeHistory,
    getHoldings,
    getCurrentPrice,
    clearAllHoldings
};
