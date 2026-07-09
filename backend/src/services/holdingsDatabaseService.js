const { query, transaction } = require('../config/database');

/**
 * Holdings Database Service
 * Manages user portfolio holdings
 */

// Get all holdings for a user
async function getUserHoldings(userId) {
    const result = await query(
        'SELECT * FROM holdings WHERE user_id = $1 AND quantity > 0 ORDER BY symbol',
        [userId]
    );
    return result.rows;
}

// Get specific holding
async function getHolding(userId, symbol) {
    const result = await query(
        'SELECT * FROM holdings WHERE user_id = $1 AND symbol = $2',
        [userId, symbol]
    );
    return result.rows[0];
}

// Add or update holding
async function upsertHolding(userId, holdingData) {
    const {
        symbol, quantity, averagePrice, currentPrice,
        marketValue, gainLoss, gainLossPercent,
        peakPrice, partialProfitTaken, sector
    } = holdingData;
    
    const result = await query(`
        INSERT INTO holdings (
            user_id, symbol, quantity, average_price, current_price,
            market_value, gain_loss, gain_loss_percent,
            peak_price, partial_profit_taken, sector
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (user_id, symbol) DO UPDATE SET
            quantity = EXCLUDED.quantity,
            average_price = EXCLUDED.average_price,
            current_price = EXCLUDED.current_price,
            market_value = EXCLUDED.market_value,
            gain_loss = EXCLUDED.gain_loss,
            gain_loss_percent = EXCLUDED.gain_loss_percent,
            peak_price = EXCLUDED.peak_price,
            partial_profit_taken = EXCLUDED.partial_profit_taken,
            sector = EXCLUDED.sector
        RETURNING *
    `, [
        userId, symbol, quantity, averagePrice, currentPrice,
        marketValue, gainLoss, gainLossPercent,
        peakPrice, partialProfitTaken, sector
    ]);
    
    return result.rows[0];
}

// Update holding quantity (for buy/sell)
async function updateHoldingQuantity(userId, symbol, quantityChange, newAveragePrice) {
    return await transaction(async (client) => {
        const holding = await client.query(
            'SELECT * FROM holdings WHERE user_id = $1 AND symbol = $2',
            [userId, symbol]
        );
        
        if (holding.rows.length === 0 && quantityChange > 0) {
            // New holding
            const result = await client.query(`
                INSERT INTO holdings (user_id, symbol, quantity, average_price, peak_price)
                VALUES ($1, $2, $3, $4, $4)
                RETURNING *
            `, [userId, symbol, quantityChange, newAveragePrice]);
            return result.rows[0];
        } else if (holding.rows.length > 0) {
            const newQuantity = holding.rows[0].quantity + quantityChange;
            
            if (newQuantity <= 0) {
                // Remove holding
                await client.query(
                    'DELETE FROM holdings WHERE user_id = $1 AND symbol = $2',
                    [userId, symbol]
                );
                return null;
            } else {
                // Update holding
                const result = await client.query(`
                    UPDATE holdings
                    SET quantity = $1, average_price = $2
                    WHERE user_id = $3 AND symbol = $4
                    RETURNING *
                `, [newQuantity, newAveragePrice, userId, symbol]);
                return result.rows[0];
            }
        }
        
        return null;
    });
}

// Update peak price
async function updatePeakPrice(userId, symbol, peakPrice) {
    const result = await query(`
        UPDATE holdings
        SET peak_price = $1
        WHERE user_id = $2 AND symbol = $3
        RETURNING *
    `, [peakPrice, userId, symbol]);
    
    return result.rows[0];
}

// Persist a re-score result for quality score decay tracking
async function updateRescoreState(userId, symbol, score, streak) {
    const result = await query(`
        UPDATE holdings
        SET last_rescore_score = $1, last_rescore_at = NOW(), low_score_streak = $2
        WHERE user_id = $3 AND symbol = $4
        RETURNING *
    `, [score, streak, userId, symbol]);

    return result.rows[0];
}

// Mark partial profit taken
async function markPartialProfitTaken(userId, symbol, taken = true) {
    const result = await query(`
        UPDATE holdings
        SET partial_profit_taken = $1
        WHERE user_id = $2 AND symbol = $3
        RETURNING *
    `, [taken, userId, symbol]);
    
    return result.rows[0];
}

// Update current prices for all holdings
async function updateCurrentPrices(userId, priceUpdates) {
    const promises = priceUpdates.map(({ symbol, currentPrice, marketValue, gainLoss, gainLossPercent }) =>
        query(`
            UPDATE holdings
            SET current_price = $1, market_value = $2, gain_loss = $3, gain_loss_percent = $4
            WHERE user_id = $5 AND symbol = $6
        `, [currentPrice, marketValue, gainLoss, gainLossPercent, userId, symbol])
    );
    
    await Promise.all(promises);
}

// Delete holding
async function deleteHolding(userId, symbol) {
    await query(
        'DELETE FROM holdings WHERE user_id = $1 AND symbol = $2',
        [userId, symbol]
    );
}

module.exports = {
    getUserHoldings,
    getHolding,
    upsertHolding,
    updateHoldingQuantity,
    updatePeakPrice,
    updateRescoreState,
    markPartialProfitTaken,
    updateCurrentPrices,
    deleteHolding
};
