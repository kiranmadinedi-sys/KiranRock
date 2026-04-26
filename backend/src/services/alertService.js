const { query } = require('../config/database');

const getAlertsByUserId = async (userId) => {
    try {
        const result = await query(
            'SELECT id, symbol, target_price as "targetPrice", created_at as "createdAt", triggered FROM alerts WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
        );
        
        return result.rows.map(alert => ({
            id: alert.id.toString(),
            symbol: alert.symbol,
            targetPrice: parseFloat(alert.targetPrice),
            createdAt: alert.createdAt,
            triggered: alert.triggered
        }));
    } catch (error) {
        console.error('Error getting alerts:', error);
        return [];
    }
};

const addAlert = async (userId, symbol, targetPrice) => {
    try {
        const result = await query(
            'INSERT INTO alerts (user_id, symbol, target_price, created_at, triggered) VALUES ($1, $2, $3, NOW(), $4) RETURNING id, symbol, target_price as "targetPrice", created_at as "createdAt", triggered',
            [userId, symbol.toUpperCase(), parseFloat(targetPrice), false]
        );
        
        if (result.rows.length === 0) {
            return null;
        }
        
        const alert = result.rows[0];
        return {
            id: alert.id.toString(),
            symbol: alert.symbol,
            targetPrice: parseFloat(alert.targetPrice),
            createdAt: alert.createdAt,
            triggered: alert.triggered
        };
    } catch (error) {
        console.error('Error adding alert:', error);
        return null;
    }
};

const deleteAlert = async (userId, alertId) => {
    try {
        const result = await query(
            'DELETE FROM alerts WHERE id = $1 AND user_id = $2 RETURNING id',
            [alertId, userId]
        );
        
        return result.rows.length > 0;
    } catch (error) {
        console.error('Error deleting alert:', error);
        return false;
    }
};

module.exports = { getAlertsByUserId, addAlert, deleteAlert };
