const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

const findUserByUsername = async (username) => {
    try {
        const result = await query(
            'SELECT id, username, password, email, full_name, phone, ai_trading_enabled, created_at FROM users WHERE LOWER(username) = LOWER($1)',
            [username]
        );
        
        if (result.rows.length === 0) {
            return null;
        }
        
        const user = result.rows[0];
        return {
            id: user.id,
            username: user.username,
            password: user.password,
            email: user.email,
            firstName: user.full_name ? user.full_name.split(' ')[0] : '',
            lastName: user.full_name ? user.full_name.split(' ').slice(1).join(' ') : '',
            phone: user.phone,
            aiTradingEnabled: user.ai_trading_enabled,
            createdAt: user.created_at
        };
    } catch (error) {
        console.error('Error finding user by username:', error);
        return null;
    }
};

const findUserById = async (id) => {
    try {
        const result = await query(
            'SELECT id, username, password, email, full_name, phone, ai_trading_enabled, created_at FROM users WHERE id = $1',
            [id]
        );
        
        if (result.rows.length === 0) {
            return null;
        }
        
        const user = result.rows[0];
        return {
            id: user.id,
            username: user.username,
            password: user.password,
            email: user.email,
            firstName: user.full_name ? user.full_name.split(' ')[0] : '',
            lastName: user.full_name ? user.full_name.split(' ').slice(1).join(' ') : '',
            phone: user.phone,
            aiTradingEnabled: user.ai_trading_enabled,
            createdAt: user.created_at
        };
    } catch (error) {
        console.error('Error finding user by id:', error);
        return null;
    }
};

const findUserByEmail = async (email) => {
    try {
        const result = await query(
            'SELECT id, username, password, email, full_name, phone, ai_trading_enabled, created_at FROM users WHERE email = $1',
            [email]
        );
        
        if (result.rows.length === 0) {
            return null;
        }
        
        const user = result.rows[0];
        return {
            id: user.id,
            username: user.username,
            password: user.password,
            email: user.email,
            firstName: user.full_name ? user.full_name.split(' ')[0] : '',
            lastName: user.full_name ? user.full_name.split(' ').slice(1).join(' ') : '',
            phone: user.phone,
            aiTradingEnabled: user.ai_trading_enabled,
            createdAt: user.created_at
        };
    } catch (error) {
        console.error('Error finding user by email:', error);
        return null;
    }
};

const createUser = async (username, password, additionalData = {}) => {
    try {
        const userId = uuidv4();
        const fullName = `${additionalData.firstName || ''} ${additionalData.lastName || ''}`.trim();
        const normalizedUsername = username.toLowerCase();

        const result = await query(
            'INSERT INTO users (id, username, password, email, full_name, phone, ai_trading_enabled, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id, username, email, full_name, phone, created_at',
            [userId, normalizedUsername, password, additionalData.email || '', fullName, additionalData.phone || '', false]
        );
        
        const user = result.rows[0];
        
        // Create trading account for new user
        await query(
            'INSERT INTO trading_accounts (user_id, balance) VALUES ($1, $2)',
            [userId, 100000] // Default starting balance
        );
        
        return {
            id: user.id,
            username: user.username,
            password: password,
            email: user.email,
            firstName: additionalData.firstName || '',
            lastName: additionalData.lastName || '',
            phone: user.phone,
            createdAt: user.created_at
        };
    } catch (error) {
        console.error('Error creating user:', error);
        throw error;
    }
};

module.exports = {
    findUserByUsername,
    findUserById,
    findUserByEmail,
    createUser,
};
