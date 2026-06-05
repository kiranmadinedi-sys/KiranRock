const { query } = require('../config/database');
const marketQuoteService = require('./marketQuoteService');

/**
 * Check if a symbol is a chronic loser for a user (≥3 losing trades in last 30 days,
 * loss rate ≥60%). Blocks impulsive manual buys into known losing setups.
 * Returns { blocked: bool, lossRate: number, tradeCount: number }
 */
async function checkManualTradeGuard(userId, symbol) {
    try {
        const since = new Date();
        since.setDate(since.getDate() - 30);
        const res = await query(`
            WITH buy_avg AS (
                SELECT user_id, symbol, AVG(price) AS avg_buy_price
                FROM trades WHERE action = 'BUY' AND trade_date >= $3
                GROUP BY user_id, symbol
            ),
            pnl_trades AS (
                SELECT CASE WHEN (s.total - b.avg_buy_price * s.quantity) <= 0 THEN 1 ELSE 0 END AS loss
                FROM trades s
                JOIN buy_avg b ON s.user_id = b.user_id AND s.symbol = b.symbol
                WHERE s.action = 'SELL' AND s.user_id = $1
                  AND s.symbol = $2 AND s.trade_date >= $3
            )
            SELECT COUNT(*) AS total_trades,
                   SUM(loss) AS total_losses
            FROM pnl_trades
        `, [userId, symbol.toUpperCase(), since.toISOString().split('T')[0]]);

        const row = res.rows[0];
        const total = parseInt(row?.total_trades || 0);
        const losses = parseInt(row?.total_losses || 0);
        if (total >= 3) {
            const lossRate = losses / total;
            if (lossRate >= 0.60) {
                return { blocked: true, lossRate: Math.round(lossRate * 100), tradeCount: total };
            }
        }
        return { blocked: false, lossRate: 0, tradeCount: total };
    } catch {
        return { blocked: false, lossRate: 0, tradeCount: 0 };
    }
}

/**
 * Get current market price for a symbol
 */
const getCurrentPrice = async (symbol) => {
    return marketQuoteService.getCurrentPrice(symbol);
};

/**
 * Execute a buy order
 */
const executeBuyOrder = async (userId, symbol, quantity) => {
    try {
        if (quantity <= 0 || !Number.isInteger(quantity)) {
            throw new Error('Quantity must be a positive integer');
        }

        // IMPROVEMENT: block manual buys into chronically losing symbols
        const guard = await checkManualTradeGuard(userId, symbol);
        if (guard.blocked) {
            throw new Error(
                `Trade blocked: ${symbol.toUpperCase()} has a ${guard.lossRate}% loss rate over your last ${guard.tradeCount} trades in 30 days. ` +
                `This symbol is flagged as a chronic loser. Review your strategy before re-entering.`
            );
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
const getTradeHistory = async (userId, limit = 100) => {
    try {
        const result = await query(
            `SELECT id, symbol, action as type, quantity, price, total,
                    trade_date as timestamp, notes, executed_by,
                    ai_score, sector, status, pnl, pnl_percent
             FROM trades
             WHERE user_id = $1
             ORDER BY trade_date DESC
             LIMIT $2`,
            [userId, limit]
        );

        return result.rows.map(trade => {
            const type = (trade.type || '').toUpperCase();
            const total = parseFloat(trade.total) || 0;
            return {
                id: trade.id.toString(),
                symbol: trade.symbol,
                type,
                quantity: parseFloat(trade.quantity) || 0,
                price: parseFloat(trade.price) || 0,
                total,
                totalCost:     type === 'BUY'        ? total : undefined,
                totalProceeds: type === 'SELL'       ? total : undefined,
                depositAmount: type === 'DEPOSIT'    ? total : undefined,
                withdrawAmount:type === 'WITHDRAWAL' ? total : undefined,
                timestamp:   trade.timestamp,
                notes:       trade.notes,
                executedBy:  trade.executed_by,
                aiScore:     trade.ai_score  != null ? parseFloat(trade.ai_score)  : null,
                sector:      trade.sector,
                status:      trade.status,
                pnl:         trade.pnl       != null ? parseFloat(trade.pnl)       : null,
                pnlPercent:  trade.pnl_percent != null ? parseFloat(trade.pnl_percent) : null,
                profitLoss:  trade.pnl       != null ? parseFloat(trade.pnl)       : 0
            };
        });
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
