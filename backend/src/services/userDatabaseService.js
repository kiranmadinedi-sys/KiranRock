const { query, transaction } = require('../config/database');
const bcrypt = require('bcrypt');

/**
 * User Database Service
 * Handles all user-related database operations
 */

// Get user by username
async function getUserByUsername(username) {
    const result = await query(
        'SELECT * FROM users WHERE username = $1',
        [username]
    );
    return result.rows[0];
}

// Get user by ID
async function getUserById(userId) {
    const result = await query(
        'SELECT * FROM users WHERE id = $1',
        [userId]
    );
    return result.rows[0];
}

// Get all users
async function getAllUsers() {
    const result = await query('SELECT * FROM users ORDER BY created_at DESC');
    return result.rows;
}

// Create new user
async function createUser(userData) {
    const { id, username, password, email, fullName, phone, telegramChatId } = userData;
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    return await transaction(async (client) => {
        // Insert user
        const userResult = await client.query(`
            INSERT INTO users (id, username, password, email, full_name, phone, telegram_chat_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
        `, [id, username, hashedPassword, email, fullName, phone, telegramChatId]);
        
        const user = userResult.rows[0];
        
        // Create trading account
        await client.query(`
            INSERT INTO trading_accounts (user_id, balance, initial_balance)
            VALUES ($1, $2, $3)
        `, [user.id, 0, 0]);
        
        // Create default risk config
        await client.query(`
            INSERT INTO risk_configs (user_id) VALUES ($1)
        `, [user.id]);
        
        return user;
    });
}

// Update user
async function updateUser(userId, updates) {
    const fields = [];
    const values = [];
    let paramIndex = 1;
    
    if (updates.email !== undefined) {
        fields.push(`email = $${paramIndex++}`);
        values.push(updates.email);
    }
    if (updates.fullName !== undefined) {
        fields.push(`full_name = $${paramIndex++}`);
        values.push(updates.fullName);
    }
    if (updates.phone !== undefined) {
        fields.push(`phone = $${paramIndex++}`);
        values.push(updates.phone);
    }
    if (updates.aiTradingEnabled !== undefined) {
        fields.push(`ai_trading_enabled = $${paramIndex++}`);
        values.push(updates.aiTradingEnabled);
    }
    if (updates.telegramChatId !== undefined) {
        fields.push(`telegram_chat_id = $${paramIndex++}`);
        values.push(updates.telegramChatId);
    }
    
    if (fields.length === 0) {
        return await getUserById(userId);
    }
    
    values.push(userId);
    const result = await query(
        `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        values
    );
    
    return result.rows[0];
}

// Update last login
async function updateLastLogin(userId) {
    await query(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
        [userId]
    );
}

// Verify password
async function verifyPassword(username, password) {
    const user = await getUserByUsername(username);
    if (!user) return null;
    
    const isValid = await bcrypt.compare(password, user.password);
    return isValid ? user : null;
}

// Get users with AI trading enabled
async function getUsersWithAITradingEnabled() {
    const result = await query(
        'SELECT * FROM users WHERE ai_trading_enabled = true AND is_active = true'
    );
    return result.rows;
}

// Toggle AI trading
async function toggleAITrading(userId, enabled) {
    const result = await query(
        'UPDATE users SET ai_trading_enabled = $1 WHERE id = $2 RETURNING *',
        [enabled, userId]
    );
    return result.rows[0];
}

module.exports = {
    getUserByUsername,
    getUserById,
    getAllUsers,
    createUser,
    updateUser,
    updateLastLogin,
    verifyPassword,
    getUsersWithAITradingEnabled,
    toggleAITrading
};
