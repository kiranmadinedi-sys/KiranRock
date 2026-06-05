const { query } = require('../config/database');

const getPortfolioByUserId = async (userId) => {
    try {
        const result = await query(
            `SELECT id, symbol, quantity, average_price as "purchasePrice", 
                    purchase_date as "addedAt", current_price as "currentPrice",
                    market_value as "marketValue", gain_loss as "gainLoss",
                    gain_loss_percent as "gainLossPercent"
             FROM holdings 
             WHERE user_id = $1 
             ORDER BY purchase_date DESC`,
            [userId]
        );
        
        return result.rows.map(row => ({
            id: row.id.toString(),
            symbol: row.symbol,
            quantity: parseInt(row.quantity),
            purchasePrice: parseFloat(row.purchasePrice),
            addedAt: row.addedAt,
            currentPrice: row.currentPrice ? parseFloat(row.currentPrice) : null,
            marketValue: row.marketValue ? parseFloat(row.marketValue) : null,
            gainLoss: row.gainLoss ? parseFloat(row.gainLoss) : null,
            gainLossPercent: row.gainLossPercent ? parseFloat(row.gainLossPercent) : null
        }));
    } catch (error) {
        console.error('Error getting portfolio:', error);
        return [];
    }
};

const addHolding = async (userId, symbol, quantity, purchasePrice) => {
    try {
        const result = await query(
            `INSERT INTO holdings (user_id, symbol, quantity, average_price, purchase_date) 
             VALUES ($1, $2, $3, $4, NOW()) 
             RETURNING id, symbol, quantity, average_price as "purchasePrice", purchase_date as "addedAt"`,
            [userId, symbol.toUpperCase(), parseInt(quantity), parseFloat(purchasePrice)]
        );
        
        if (result.rows.length === 0) {
            return null;
        }
        
        const holding = result.rows[0];
        return {
            id: holding.id.toString(),
            symbol: holding.symbol,
            quantity: parseInt(holding.quantity),
            purchasePrice: parseFloat(holding.purchasePrice),
            addedAt: holding.addedAt
        };
    } catch (error) {
        console.error('Error adding holding:', error);
        return null;
    }
};

const deleteHolding = async (userId, holdingId) => {
    try {
        const result = await query(
            'DELETE FROM holdings WHERE id = $1 AND user_id = $2 RETURNING id',
            [holdingId, userId]
        );
        
        return result.rows.length > 0;
    } catch (error) {
        console.error('Error deleting holding:', error);
        return false;
    }
};

module.exports = { getPortfolioByUserId, addHolding, deleteHolding };
