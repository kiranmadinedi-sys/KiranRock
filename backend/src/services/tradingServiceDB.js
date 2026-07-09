const { transaction } = require('../config/database');
const accountDb = require('./tradingAccountDatabaseService');
const holdingsDb = require('./holdingsDatabaseService');
const tradesDb = require('./tradesDatabaseService');

/**
 * Trading Service - PostgreSQL Version
 * Handles buy/sell operations with database transactions
 */

/**
 * Get current market price for a symbol
 */
const getCurrentPrice = async (symbol) => {
    try {
        const dataProvider = require('./dataProvider');
        const q = await dataProvider.getQuote(symbol);
        return q.price || null;
    } catch (error) {
        console.error(`Error getting price for ${symbol}:`, error.message);
        throw new Error(`Unable to get current price for ${symbol}`);
    }
};

/**
 * Execute a buy order
 */
const executeBuyOrder = async (userId, symbol, quantity, executedBy = 'MANUAL', aiScore = null, sector = null, notes = null, fillPrice = null, entryRegime = null, atr = null) => {
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
        const commission = totalCost * 0.001; // 0.1% commission
        const totalWithCommission = totalCost + commission;

        // When fillPrice is supplied the broker already executed the trade — skip the internal
        // balance check (Alpaca enforced funds at submission) and just record the fill.
        const brokerConfirmed = fillPrice != null;

        // Execute in transaction
        return await transaction(async (client) => {
            if (!brokerConfirmed) {
                // Paper / manual orders: enforce internal virtual balance
                const accountResult = await client.query(
                    'SELECT balance FROM trading_accounts WHERE user_id = $1',
                    [userId]
                );

                if (!accountResult.rows[0]) {
                    throw new Error('Trading account not found');
                }

                const balance = parseFloat(accountResult.rows[0].balance);

                if (balance < totalWithCommission) {
                    throw new Error(
                        `Insufficient funds. Need $${totalWithCommission.toFixed(2)}, have $${balance.toFixed(2)}`
                    );
                }

                await client.query(
                    'UPDATE trading_accounts SET balance = balance - $1 WHERE user_id = $2',
                    [totalWithCommission, userId]
                );
            }
            
            // Get existing holding
            const holdingResult = await client.query(
                'SELECT * FROM holdings WHERE user_id = $1 AND symbol = $2',
                [userId, symbol.toUpperCase()]
            );
            
            const existingHolding = holdingResult.rows[0];
            
            if (existingHolding) {
                // Update existing holding
                const totalQuantity = existingHolding.quantity + quantity;
                const totalCostBasis = (existingHolding.average_price * existingHolding.quantity) + totalCost;
                const newAveragePrice = totalCostBasis / totalQuantity;
                
                await client.query(`
                    UPDATE holdings 
                    SET quantity = $1, 
                        average_price = $2,
                        current_price = $3,
                        market_value = $4,
                        gain_loss = $5,
                        gain_loss_percent = $6,
                        sector = COALESCE($7, sector)
                    WHERE user_id = $8 AND symbol = $9
                `, [
                    totalQuantity,
                    newAveragePrice,
                    currentPrice,
                    totalQuantity * currentPrice,
                    (currentPrice - newAveragePrice) * totalQuantity,
                    ((currentPrice - newAveragePrice) / newAveragePrice) * 100,
                    sector,
                    userId,
                    symbol.toUpperCase()
                ]);
            } else {
                // Create new holding — store ATR at entry for ATR-aware trailing stops
                await client.query(`
                    INSERT INTO holdings (
                        user_id, symbol, quantity, average_price, current_price,
                        market_value, gain_loss, gain_loss_percent,
                        peak_price, sector, atr
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                `, [
                    userId,
                    symbol.toUpperCase(),
                    quantity,
                    currentPrice,
                    currentPrice,
                    quantity * currentPrice,
                    0,
                    0,
                    currentPrice,
                    sector,
                    atr
                ]);
            }
            
            // Record trade — use fillPrice if supplied (bracket), else currentPrice (market)
            const recordedPrice = fillPrice || currentPrice;
            // Derive entry_regime and slippage from the notes JSON if not passed directly
            let _entryRegime = entryRegime;
            let _slippagePct = null;
            if (notes) {
                try {
                    const n = typeof notes === 'string' ? JSON.parse(notes) : notes;
                    if (!_entryRegime && n.regime) _entryRegime = n.regime;
                    if (n.signalPrice && recordedPrice) {
                        _slippagePct = parseFloat(((recordedPrice - n.signalPrice) / n.signalPrice * 100).toFixed(4));
                    }
                } catch (_) {}
            }
            const tradeResult = await client.query(`
                INSERT INTO trades (
                    user_id, symbol, action, quantity, price, total,
                    commission, executed_by, ai_score, sector, notes,
                    entry_regime, slippage_pct
                ) VALUES ($1, $2, 'BUY', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                RETURNING *
            `, [
                userId,
                symbol.toUpperCase(),
                quantity,
                recordedPrice,
                recordedPrice * quantity,
                commission,
                executedBy,
                aiScore,
                sector,
                notes,
                _entryRegime,
                _slippagePct
            ]);

            // Persist buy lot for FIFO accounting
            try {
                await client.query(`
                    INSERT INTO trade_lots (trade_id, user_id, symbol, quantity, remaining_quantity, price, commission)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                `, [tradeResult.rows[0].id, userId, symbol.toUpperCase(), quantity, quantity, currentPrice, commission]);
            } catch (err) {
                // If trade_lots table not found, log and continue
                console.warn('trade_lots insert failed:', err.message);
            }
            
            return {
                success: true,
                trade: tradeResult.rows[0],
                symbol: symbol.toUpperCase(),
                quantity,
                price: currentPrice,
                total: totalCost,
                commission,
                totalWithCommission
            };
        });
        
    } catch (error) {
        console.error(`Error executing buy order:`, error);
        throw error;
    }
};

/**
 * Execute a sell order
 */
const executeSellOrder = async (userId, symbol, quantity, executedBy = 'MANUAL', notes = null, fillPrice = null) => {
    try {
        if (quantity <= 0 || !Number.isInteger(quantity)) {
            throw new Error('Quantity must be a positive integer');
        }

        // Use broker-confirmed fill price when available; fall back to live quote only when needed.
        // This prevents a second price fetch from failing (Alpaca returning 0 for thin symbols)
        // and causing the DB transaction to abort after the broker order already executed.
        const currentPrice = fillPrice || await getCurrentPrice(symbol);
        if (!currentPrice) {
            throw new Error('Unable to fetch current price');
        }
        
        const totalProceeds = currentPrice * quantity;
        const commission = totalProceeds * 0.001; // 0.1% commission
        const netProceeds = totalProceeds - commission;
        
        // Execute in transaction
        return await transaction(async (client) => {
            // Get holding
            const holdingResult = await client.query(
                'SELECT * FROM holdings WHERE user_id = $1 AND symbol = $2',
                [userId, symbol.toUpperCase()]
            );
            
            if (!holdingResult.rows[0]) {
                throw new Error(`You don't own any shares of ${symbol}`);
            }
            
            const holding = holdingResult.rows[0];
            
            if (holding.quantity < quantity) {
                throw new Error(
                    `Insufficient shares. You have ${holding.quantity} shares, trying to sell ${quantity}`
                );
            }
            
            // Calculate profit/loss
            const profitLoss = (currentPrice - holding.average_price) * quantity;
            const profitLossPercent = ((currentPrice - holding.average_price) / holding.average_price) * 100;
            
            // Add proceeds to account
            await client.query(
                'UPDATE trading_accounts SET balance = balance + $1 WHERE user_id = $2',
                [netProceeds, userId]
            );
            
            // Update or delete holding
            const remainingQuantity = holding.quantity - quantity;
            
            if (remainingQuantity === 0) {
                await client.query(
                    'DELETE FROM holdings WHERE user_id = $1 AND symbol = $2',
                    [userId, symbol.toUpperCase()]
                );
            } else {
                await client.query(`
                    UPDATE holdings 
                    SET quantity = $1,
                        current_price = $2,
                        market_value = $3,
                        gain_loss = $4,
                        gain_loss_percent = $5
                    WHERE user_id = $6 AND symbol = $7
                `, [
                    remainingQuantity,
                    currentPrice,
                    remainingQuantity * currentPrice,
                    (currentPrice - holding.average_price) * remainingQuantity,
                    profitLossPercent,
                    userId,
                    symbol.toUpperCase()
                ]);
            }
            
            // Record trade — include realized P/L computed above
            const tradeResult = await client.query(`
                INSERT INTO trades (
                    user_id, symbol, action, quantity, price, total,
                    commission, executed_by, notes, pnl, pnl_percent
                ) VALUES ($1, $2, 'SELL', $3, $4, $5, $6, $7, $8, $9, $10)
                RETURNING *
            `, [
                userId,
                symbol.toUpperCase(),
                quantity,
                currentPrice,
                totalProceeds,
                commission,
                executedBy,
                notes,
                parseFloat(profitLoss.toFixed(4)),
                parseFloat(profitLossPercent.toFixed(4))
            ]);

            // Consume buy lots (FIFO) for this sell
            try {
                let remainingToMatch = quantity;
                const lotsRes = await client.query(`
                    SELECT id, remaining_quantity, price, commission
                    FROM trade_lots
                    WHERE user_id = $1 AND symbol = $2 AND remaining_quantity > 0
                    ORDER BY created_at ASC
                `, [userId, symbol.toUpperCase()]);

                for (const lot of lotsRes.rows) {
                    if (remainingToMatch <= 0) break;
                    const matchQty = Math.min(remainingToMatch, lot.remaining_quantity);
                    const newRemaining = lot.remaining_quantity - matchQty;
                    await client.query(`UPDATE trade_lots SET remaining_quantity = $1 WHERE id = $2`, [newRemaining, lot.id]);
                    remainingToMatch -= matchQty;
                }
                // If remainingToMatch > 0, sells exceeded buys — leave as-is (shouldn't happen)
            } catch (err) {
                console.warn('trade_lots consume failed:', err.message);
            }
            
            return {
                success: true,
                trade: tradeResult.rows[0],
                symbol: symbol.toUpperCase(),
                quantity,
                price: currentPrice,
                total: totalProceeds,
                commission,
                netProceeds,
                profitLoss,
                profitLossPercent
            };
        });
        
    } catch (error) {
        console.error(`Error executing sell order:`, error);
        throw error;
    }
};

/**
 * Get portfolio summary
 */
const getPortfolioSummary = async (userId) => {
    try {
        const account = await accountDb.getTradingAccount(userId);
        const holdings = await holdingsDb.getUserHoldings(userId);
        
        let totalMarketValue = 0;
        let totalGainLoss = 0;
        let totalInvested = 0;
        
        // Update current prices
        for (const holding of holdings) {
            try {
                const currentPrice = await getCurrentPrice(holding.symbol);
                const marketValue = holding.quantity * currentPrice;
                const gainLoss = marketValue - (holding.average_price * holding.quantity);
                const gainLossPercent = (gainLoss / (holding.average_price * holding.quantity)) * 100;
                
                holding.current_price = currentPrice;
                holding.market_value = marketValue;
                holding.gain_loss = gainLoss;
                holding.gain_loss_percent = gainLossPercent;
                
                totalMarketValue += marketValue;
                totalGainLoss += gainLoss;
                totalInvested += holding.average_price * holding.quantity;
            } catch (error) {
                console.error(`Error updating price for ${holding.symbol}:`, error.message);
            }
        }
        
        const totalPortfolioValue = parseFloat(account.balance) + totalMarketValue;
        const totalGainLossPercent = totalInvested > 0 ? (totalGainLoss / totalInvested) * 100 : 0;
        
        return {
            balance: parseFloat(account.balance),
            holdings,
            totalHoldings: holdings.length,
            totalMarketValue,
            totalInvested,
            totalGainLoss,
            totalGainLossPercent,
            totalPortfolioValue
        };
    } catch (error) {
        console.error('Error getting portfolio summary:', error);
        throw error;
    }
};

module.exports = {
    getCurrentPrice,
    executeBuyOrder,
    executeSellOrder,
    getPortfolioSummary
};
