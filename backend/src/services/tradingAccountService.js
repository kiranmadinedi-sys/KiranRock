/**
 * Reset trading account balance to a specified amount
 */
const resetBalance = async (userId, amount) => {
    try {
        // Get or create trading account
        let accountResult = await query(
            'SELECT id FROM trading_accounts WHERE user_id = $1',
            [userId]
        );
        
        if (accountResult.rows.length === 0) {
            // Create new trading account
            await query(
                'INSERT INTO trading_accounts (user_id, balance) VALUES ($1, $2)',
                [userId, amount]
            );
        } else {
            // Update existing balance
            await query(
                'UPDATE trading_accounts SET balance = $1, updated_at = NOW() WHERE user_id = $2',
                [amount, userId]
            );
        }
        
        // Clear all previous deposit/withdrawal transactions
        await query(
            "DELETE FROM trades WHERE user_id = $1 AND symbol IN ('DEPOSIT', 'WITHDRAWAL')",
            [userId]
        );
        
        // Record new initial deposit if amount > 0
        if (amount > 0) {
            await query(
                `INSERT INTO trades (user_id, symbol, action, quantity, price, total, trade_date, executed_by, notes) 
                 VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8)`,
                [userId, 'DEPOSIT', 'DEPOSIT', 1, amount, amount, 'SYSTEM', 'Balance reset']
            );
        }
        
        return { success: true, newBalance: amount };
    } catch (error) {
        console.error('Error resetting balance:', error);
        throw error;
    }
};
const { query } = require('../config/database');

/**
 * Get trading account balance and info
 */
const getTradingAccount = async (userId) => {
    try {
        // Get trading account from database
        const result = await query(
            'SELECT id, user_id, balance, created_at, updated_at FROM trading_accounts WHERE user_id = $1',
            [userId]
        );
        
        if (result.rows.length === 0) {
            // Create new trading account with default balance
            const insertResult = await query(
                'INSERT INTO trading_accounts (user_id, balance) VALUES ($1, $2) RETURNING id, user_id, balance, created_at, updated_at',
                [userId, 100000]
            );
            return {
                balance: insertResult.rows[0].balance,
                totalDeposited: 100000,
                totalWithdrawn: 0,
                deposits: [],
                withdrawals: []
            };
        }
        
        const account = result.rows[0];
        
        // Get transaction history
        const deposits = await query(
            'SELECT total as amount, trade_date as timestamp FROM trades WHERE user_id = $1 AND symbol = $2 ORDER BY trade_date DESC',
            [userId, 'DEPOSIT']
        );
        
        const withdrawals = await query(
            'SELECT total as amount, trade_date as timestamp FROM trades WHERE user_id = $1 AND symbol = $2 ORDER BY trade_date DESC',
            [userId, 'WITHDRAWAL']
        );
        
        const totalDeposited = deposits.rows.reduce((sum, d) => sum + parseFloat(d.amount), 0);
        const totalWithdrawn = withdrawals.rows.reduce((sum, w) => sum + parseFloat(w.amount), 0);
        
        return {
            balance: parseFloat(account.balance),
            totalDeposited,
            totalWithdrawn,
            deposits: deposits.rows.map(d => ({
                amount: parseFloat(d.amount),
                timestamp: d.timestamp,
                type: 'deposit'
            })),
            withdrawals: withdrawals.rows.map(w => ({
                amount: parseFloat(w.amount),
                timestamp: w.timestamp,
                type: 'withdrawal'
            }))
        };
    } catch (error) {
        console.error('Error getting trading account:', error);
        throw error;
    }
};

/**
 * Deposit virtual funds
 */
const depositFunds = async (userId, amount) => {
    try {
        if (amount <= 0) {
            throw new Error('Deposit amount must be positive');
        }
        
        // Get or create trading account
        let accountResult = await query(
            'SELECT id, balance FROM trading_accounts WHERE user_id = $1',
            [userId]
        );
        
        if (accountResult.rows.length === 0) {
            // Create new trading account
            accountResult = await query(
                'INSERT INTO trading_accounts (user_id, balance) VALUES ($1, $2) RETURNING id, balance',
                [userId, 0]
            );
        }
        
        const account = accountResult.rows[0];
        const newBalance = parseFloat(account.balance) + amount;
        
        // Update balance
        await query(
            'UPDATE trading_accounts SET balance = $1, updated_at = NOW() WHERE user_id = $2',
            [newBalance, userId]
        );
        
        // Record deposit transaction
        const depositResult = await query(
            `INSERT INTO trades (user_id, symbol, action, quantity, price, total, trade_date, executed_by, notes) 
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8) 
             RETURNING id, total as amount, trade_date as timestamp`,
            [userId, 'DEPOSIT', 'DEPOSIT', 1, amount, amount, 'USER', 'Account deposit']
        );
        
        const deposit = depositResult.rows[0];
        
        return {
            success: true,
            transaction: {
                id: deposit.id.toString(),
                amount: parseFloat(deposit.amount),
                timestamp: deposit.timestamp,
                type: 'deposit'
            },
            newBalance
        };
    } catch (error) {
        console.error('Error depositing funds:', error);
        throw error;
    }
};

/**
 * Withdraw virtual funds
 */
const withdrawFunds = async (userId, amount) => {
    try {
        if (amount <= 0) {
            throw new Error('Withdrawal amount must be positive');
        }
        
        // Get trading account
        const accountResult = await query(
            'SELECT id, balance FROM trading_accounts WHERE user_id = $1',
            [userId]
        );
        
        if (accountResult.rows.length === 0) {
            throw new Error('Trading account not found');
        }
        
        const account = accountResult.rows[0];
        const currentBalance = parseFloat(account.balance);
        
        if (currentBalance < amount) {
            throw new Error('Insufficient funds');
        }
        
        const newBalance = currentBalance - amount;
        
        // Update balance
        await query(
            'UPDATE trading_accounts SET balance = $1, updated_at = NOW() WHERE user_id = $2',
            [newBalance, userId]
        );
        
        // Record withdrawal transaction
        const withdrawalResult = await query(
            `INSERT INTO trades (user_id, symbol, action, quantity, price, total, trade_date, executed_by, notes) 
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8) 
             RETURNING id, total as amount, trade_date as timestamp`,
            [userId, 'WITHDRAWAL', 'WITHDRAWAL', 1, amount, amount, 'USER', 'Account withdrawal']
        );
        
        const withdrawal = withdrawalResult.rows[0];
        
        return {
            success: true,
            transaction: {
                id: withdrawal.id.toString(),
                amount: parseFloat(withdrawal.amount),
                timestamp: withdrawal.timestamp,
                type: 'withdrawal'
            },
            newBalance
        };
    } catch (error) {
        console.error('Error withdrawing funds:', error);
        throw error;
    }
};

/**
 * Get account transaction history
 */
const getTransactionHistory = async (userId) => {
    try {
        // Get all deposit and withdrawal transactions
        const result = await query(
            `SELECT id, total as amount, trade_date as timestamp, 
                    CASE WHEN symbol = 'DEPOSIT' THEN 'deposit' ELSE 'withdrawal' END as type 
             FROM trades 
             WHERE user_id = $1 AND symbol IN ('DEPOSIT', 'WITHDRAWAL')
             ORDER BY trade_date DESC`,
            [userId]
        );
        
        return result.rows.map(row => ({
            id: row.id.toString(),
            amount: parseFloat(row.amount),
            timestamp: row.timestamp,
            type: row.type
        }));
    } catch (error) {
        console.error('Error getting transaction history:', error);
        throw error;
    }
};

/**
 * Clear all portfolio data - reset everything to zero
 */
const clearAllPortfolio = async (userId) => {
    try {
        // Reset trading account balance to zero
        await query(
            'UPDATE trading_accounts SET balance = $1, updated_at = NOW() WHERE user_id = $2',
            [0, userId]
        );
        
        // Clear all transactions
        await query(
            'DELETE FROM trades WHERE user_id = $1',
            [userId]
        );
        
        // Clear all holdings
        await query(
            'DELETE FROM holdings WHERE user_id = $1',
            [userId]
        );
        
        return { success: true, message: 'Portfolio cleared successfully' };
    } catch (error) {
        console.error('Error clearing portfolio:', error);
        throw error;
    }
};

module.exports = {
    getTradingAccount,
    depositFunds,
    withdrawFunds,
    getTransactionHistory,
    resetBalance,
    clearAllPortfolio
};
