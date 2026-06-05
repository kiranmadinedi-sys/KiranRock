const bcrypt = require('bcryptjs');
const { query } = require('../config/database');

const DEFAULT_AI_TRADING_SETTINGS = {
    stopLoss: 0.06,
    takeProfit: 0.3,
    minCashReserve: 0
};

let ensureSchemaPromise = null;

function normalizeAITradingSettings(updates = {}) {
    const numericFields = [
        'minCashReserve',
        'maxPositionSize',
        'rebalanceThreshold',
        'stopLoss',
        'takeProfit',
        'volatilityThreshold'
    ];

    return numericFields.reduce((normalized, field) => {
        if (updates[field] === undefined) {
            return normalized;
        }

        const parsed = parseFloat(updates[field]);
        if (Number.isFinite(parsed)) {
            normalized[field] = parsed;
        }

        return normalized;
    }, {});
}

async function ensureUserProfileSchema() {
    if (!ensureSchemaPromise) {
        ensureSchemaPromise = (async () => {
            await query(`
                ALTER TABLE users
                ADD COLUMN IF NOT EXISTS ai_trading_settings JSONB DEFAULT '{}'::jsonb
            `);

            await query(`
                CREATE TABLE IF NOT EXISTS ai_decisions (
                    id VARCHAR(100) PRIMARY KEY,
                    user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    decision JSONB NOT NULL
                )
            `);

            await query(`
                CREATE INDEX IF NOT EXISTS idx_ai_decisions_user_id
                ON ai_decisions(user_id)
            `);

            await query(`
                CREATE INDEX IF NOT EXISTS idx_ai_decisions_timestamp
                ON ai_decisions(timestamp)
            `);
        })().catch((error) => {
            ensureSchemaPromise = null;
            throw error;
        });
    }

    return ensureSchemaPromise;
}

async function getAITradingSettings(userId) {
    await ensureUserProfileSchema();

    const result = await query(
        'SELECT ai_trading_settings FROM users WHERE id = $1',
        [userId]
    );

    if (result.rows.length === 0) {
        throw new Error('User not found');
    }

    return {
        ...DEFAULT_AI_TRADING_SETTINGS,
        ...(result.rows[0].ai_trading_settings || {})
    };
}

async function updateAITradingSettings(userId, updates) {
    await ensureUserProfileSchema();

    const currentSettings = await getAITradingSettings(userId);
    const mergedSettings = {
        ...currentSettings,
        ...normalizeAITradingSettings(updates)
    };

    const result = await query(
        `UPDATE users
         SET ai_trading_settings = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING ai_trading_settings`,
        [JSON.stringify(mergedSettings), userId]
    );

    if (result.rows.length === 0) {
        throw new Error('User not found');
    }

    return {
        ...DEFAULT_AI_TRADING_SETTINGS,
        ...(result.rows[0].ai_trading_settings || {})
    };
}

/**
 * Get user profile information
 */
const getUserProfile = async (userId) => {
    try {
        await ensureUserProfileSchema();

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
        await ensureUserProfileSchema();

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
        await ensureUserProfileSchema();

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
        await ensureUserProfileSchema();

        const userResult = await query('SELECT id FROM users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) {
            throw new Error('User not found');
        }

        await query(`
            INSERT INTO trading_accounts (user_id, balance, initial_balance)
            VALUES ($1, $2, $2)
            ON CONFLICT (user_id) DO NOTHING
        `, [userId, 100000]);

        const accountResult = await query(
            'SELECT balance, initial_balance, created_at FROM trading_accounts WHERE user_id = $1',
            [userId]
        );

        const account = accountResult.rows[0];
        return {
            balance: parseFloat(account.balance),
            totalDeposited: parseFloat(account.initial_balance || account.balance),
            totalWithdrawn: 0,
            initializedAt: account.created_at
        };
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
        await ensureUserProfileSchema();

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
        await ensureUserProfileSchema();

        const decisionId = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
        const timestamp = decision.timestamp || new Date().toISOString();

        await query(
            `INSERT INTO ai_decisions (id, user_id, timestamp, decision)
             VALUES ($1, $2, $3, $4)`,
            [decisionId, userId, timestamp, JSON.stringify(decision)]
        );

        return {
            id: decisionId,
            timestamp,
            ...decision
        };
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
        await ensureUserProfileSchema();

        const parsedLimit = Math.max(1, Math.min(parseInt(limit, 10) || 20, 100));
        const result = await query(
            `SELECT id, timestamp, decision
             FROM ai_decisions
             WHERE user_id = $1
             ORDER BY timestamp DESC
             LIMIT $2`,
            [userId, parsedLimit]
        );

        return result.rows.map((row) => ({
            id: row.id,
            timestamp: row.timestamp,
            ...(row.decision || {})
        }));
    } catch (error) {
        console.error('Error getting AI decisions:', error);
        throw error;
    }
};

module.exports = {
    ensureUserProfileSchema,
    getAITradingSettings,
    updateAITradingSettings,
    getUserProfile,
    updateUserProfile,
    changePassword,
    initializeTradingAccount,
    toggleAITrading,
    logAIDecision,
    getAIDecisions
};
