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

/**
 * Get Alpaca credentials for a user.
 * Returns their stored keys if set, otherwise falls back to process.env.
 * Secret key is always returned so brokerService can use it — never expose in API responses.
 */
async function getUserAlpacaCredentials(userId) {
    const result = await query(
        'SELECT alpaca_key_id, alpaca_secret_key, alpaca_paper FROM users WHERE id = $1',
        [userId]
    );
    const row = result.rows[0];
    if (row?.alpaca_key_id && row?.alpaca_secret_key) {
        return {
            keyId:     row.alpaca_key_id,
            secretKey: row.alpaca_secret_key,
            isPaper:   row.alpaca_paper !== false,
            source:    'user'
        };
    }
    // Fall back to shared .env credentials (paper trading default)
    return {
        keyId:     process.env.ALPACA_KEY_ID || null,
        secretKey: process.env.ALPACA_SECRET_KEY || null,
        isPaper:   (process.env.ALPACA_PAPER || 'true') !== 'false',
        source:    'env'
    };
}

/**
 * Save Alpaca credentials for a user.
 * Pass secretKey=null to keep the existing secret unchanged.
 */
async function saveUserAlpacaCredentials(userId, { keyId, secretKey, isPaper }) {
    const fields = ['alpaca_key_id = $1', 'alpaca_paper = $2', 'updated_at = NOW()'];
    const values = [keyId, isPaper !== false];
    if (secretKey) {
        fields.push(`alpaca_secret_key = $${values.length + 1}`);
        values.push(secretKey);
    }
    values.push(userId);
    const result = await query(
        `UPDATE users SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING alpaca_key_id, alpaca_paper`,
        values
    );
    // New credentials mean a different (or differently-typed, paper<->live) Alpaca
    // account — clear cached deposit/portfolio data from the OLD account so the
    // next fetch reads fresh, instead of serving the previous account's numbers
    // against this one for up to 24h (found 2026-08-20, see portfolioTrackingService.js).
    try { require('./portfolioTrackingService').clearUserCache(userId); } catch (_) {}
    return result.rows[0];
}

/**
 * Clear Alpaca credentials — user reverts to shared .env keys.
 */
async function clearUserAlpacaCredentials(userId) {
    await query(
        `UPDATE users SET alpaca_key_id = NULL, alpaca_secret_key = NULL, alpaca_paper = true WHERE id = $1`,
        [userId]
    );
    try { require('./portfolioTrackingService').clearUserCache(userId); } catch (_) {}
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
    toggleAITrading,
    getUserAlpacaCredentials,
    saveUserAlpacaCredentials,
    clearUserAlpacaCredentials
};
