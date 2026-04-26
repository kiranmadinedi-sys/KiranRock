const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcryptjs');
const { query } = require('../config/database');

const USERS_FILE = path.join(__dirname, '../../users.json');

/**
 * Get user profile information
 */
const getUserProfile = async (userId) => {
    try {
        // Get user from PostgreSQL database
        const userResult = await query(
            'SELECT id, username, email, full_name, phone, created_at, ai_trading_enabled FROM users WHERE id = $1',
            [userId]
        );
        
        if (userResult.rows.length === 0) {
            throw new Error('User not found');
        }
        
        const user = userResult.rows[0];
        
        // Get trading account balance
        const accountResult = await query(
            'SELECT balance FROM trading_accounts WHERE user_id = $1',
            [userId]
        );
        
        const tradingAccount = accountResult.rows[0] || {
            balance: 100000
        };
        
        // Split full_name into firstName and lastName
        const nameParts = (user.full_name || '').split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';
        
        return {
            id: user.id,
            username: user.username,
            firstName: firstName,
            lastName: lastName,
            email: user.email || '',
            phone: user.phone || '',
            createdAt: user.created_at,
            aiTradingEnabled: user.ai_trading_enabled === true,
            tradingAccount: {
                balance: parseFloat(tradingAccount.balance),
                totalDeposited: 0,
                totalWithdrawn: 0
            }
        };
    } catch (error) {
        console.error('Error getting user profile:', error);
        throw error;
    }
};

/**
 * Update user profile information
 */
const updateUserProfile = async (userId, updates) => {
    try {
        // Combine firstName and lastName into full_name
        const fullName = [updates.firstName || '', updates.lastName || ''].filter(Boolean).join(' ');
        
        // Update user in PostgreSQL
        await query(
            'UPDATE users SET full_name = $1, email = $2, phone = $3, updated_at = NOW() WHERE id = $4',
            [fullName || null, updates.email || null, updates.phone || null, userId]
        );
        
        return getUserProfile(userId);
    } catch (error) {
        console.error('Error updating user profile:', error);
        throw error;
    }
};

/**
 * Change user password
 */
const changePassword = async (userId, currentPassword, newPassword) => {
    try {
        // Get current password from PostgreSQL
        const userResult = await query(
            'SELECT password FROM users WHERE id = $1',
            [userId]
        );
        
        if (userResult.rows.length === 0) {
            throw new Error('User not found');
        }
        
        const user = userResult.rows[0];
        
        // Verify current password
        const isValid = await bcrypt.compare(currentPassword, user.password);
        if (!isValid) {
            throw new Error('Current password is incorrect');
        }
        
        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        // Update password in PostgreSQL
        await query(
            'UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2',
            [hashedPassword, userId]
        );
        
        return { success: true, message: 'Password changed successfully' };
    } catch (error) {
        console.error('Error changing password:', error);
        throw error;
    }
};

/**
 * Initialize trading account if not exists
 */
const initializeTradingAccount = async (userId) => {
    try {
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const userIndex = users.findIndex(u => u.id === userId);
        
        if (userIndex === -1) {
            throw new Error('User not found');
        }
        
        if (!users[userIndex].tradingAccount) {
            users[userIndex].tradingAccount = {
                balance: 100000, // Default $100k
                totalDeposited: 100000,
                totalWithdrawn: 0,
                initializedAt: new Date().toISOString()
            };
            
            await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
        }
        
        return users[userIndex].tradingAccount;
    } catch (error) {
        console.error('Error initializing trading account:', error);
        throw error;
    }
};

/**
 * Toggle AI Trading on/off
 */
const toggleAITrading = async (userId, enabled) => {
    try {
        // Update in PostgreSQL database
        const result = await query(
            'UPDATE users SET ai_trading_enabled = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, ai_trading_enabled, updated_at',
            [enabled, userId]
        );
        
        if (result.rows.length === 0) {
            throw new Error('User not found');
        }
        
        const user = result.rows[0];
        
        console.log(`[Profile] AI Trading ${enabled ? 'enabled' : 'disabled'} for user ${user.username} (${userId})`);
        
        return {
            aiTradingEnabled: user.ai_trading_enabled,
            toggledAt: user.updated_at
        };
    } catch (error) {
        console.error('Error toggling AI trading:', error);
        throw error;
    }
};

/**
 * Log AI trading decision
 */
const logAIDecision = async (userId, decision) => {
    try {
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const userIndex = users.findIndex(u => u.id === userId);
        
        if (userIndex === -1) {
            throw new Error('User not found');
        }
        
        if (!users[userIndex].aiDecisions) {
            users[userIndex].aiDecisions = [];
        }
        
        users[userIndex].aiDecisions.unshift({
            id: `ai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            timestamp: new Date().toISOString(),
            ...decision
        });
        
        // Keep only last 100 decisions
        if (users[userIndex].aiDecisions.length > 100) {
            users[userIndex].aiDecisions = users[userIndex].aiDecisions.slice(0, 100);
        }
        
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
        
        return decision;
    } catch (error) {
        console.error('Error logging AI decision:', error);
        throw error;
    }
};

/**
 * Get AI trading decisions log
 */
const getAIDecisions = async (userId, limit = 20) => {
    try {
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const user = users.find(u => u.id === userId);
        
        if (!user) {
            throw new Error('User not found');
        }
        
        return user.aiDecisions?.slice(0, limit) || [];
    } catch (error) {
        console.error('Error getting AI decisions:', error);
        throw error;
    }
};

module.exports = {
    getUserProfile,
    updateUserProfile,
    changePassword,
    initializeTradingAccount,
    toggleAITrading,
    logAIDecision,
    getAIDecisions
};
