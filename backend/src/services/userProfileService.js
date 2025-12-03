const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcryptjs');

const USERS_FILE = path.join(__dirname, '../../users.json');

/**
 * Get user profile information
 */
const getUserProfile = async (userId) => {
    try {
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const user = users.find(u => u.id === userId);
        
        if (!user) {
            throw new Error('User not found');
        }
        
        return {
            id: user.id,
            username: user.username,
            firstName: user.firstName || '',
            lastName: user.lastName || '',
            email: user.email || '',
            phone: user.phone || '',
            createdAt: user.createdAt || new Date().toISOString(),
            aiTradingEnabled: user.aiTradingEnabled || false,
            tradingAccount: user.tradingAccount || {
                balance: 100000, // Default $100k paper money
                totalDeposited: 100000,
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
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const userIndex = users.findIndex(u => u.id === userId);
        
        if (userIndex === -1) {
            throw new Error('User not found');
        }
        
        // Update allowed fields only
        const allowedFields = ['firstName', 'lastName', 'email', 'phone'];
        allowedFields.forEach(field => {
            if (updates[field] !== undefined) {
                users[userIndex][field] = updates[field];
            }
        });
        
        users[userIndex].updatedAt = new Date().toISOString();
        
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
        
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
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const userIndex = users.findIndex(u => u.id === userId);
        
        if (userIndex === -1) {
            throw new Error('User not found');
        }
        
        // Verify current password
        const isValid = await bcrypt.compare(currentPassword, users[userIndex].password);
        if (!isValid) {
            throw new Error('Current password is incorrect');
        }
        
        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        users[userIndex].password = hashedPassword;
        users[userIndex].passwordChangedAt = new Date().toISOString();
        
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
        
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
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const userIndex = users.findIndex(u => u.id === userId);
        
        if (userIndex === -1) {
            throw new Error('User not found');
        }
        
        users[userIndex].aiTradingEnabled = enabled;
        users[userIndex].aiTradingToggledAt = new Date().toISOString();
        
        // Initialize AI decision log if enabling for first time
        if (enabled && !users[userIndex].aiDecisions) {
            users[userIndex].aiDecisions = [];
        }
        
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
        
        return {
            aiTradingEnabled: users[userIndex].aiTradingEnabled,
            toggledAt: users[userIndex].aiTradingToggledAt
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
