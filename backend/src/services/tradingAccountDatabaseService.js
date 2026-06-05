const { query, transaction } = require('../config/database');

/**
 * Trading Account Database Service
 * Handles trading account balance and transactions
 */

// Get trading account
async function getTradingAccount(userId) {
    const result = await query(
        'SELECT * FROM trading_accounts WHERE user_id = $1',
        [userId]
    );
    return result.rows[0];
}

// Update balance
async function updateBalance(userId, newBalance) {
    const result = await query(`
        UPDATE trading_accounts
        SET balance = $1
        WHERE user_id = $2
        RETURNING *
    `, [newBalance, userId]);
    
    return result.rows[0];
}

// Add funds
async function addFunds(userId, amount) {
    return await transaction(async (client) => {
        const result = await client.query(`
            UPDATE trading_accounts
            SET balance = balance + $1
            WHERE user_id = $2
            RETURNING *
        `, [amount, userId]);
        
        // Log the transaction
        await client.query(`
            INSERT INTO trades (user_id, symbol, action, quantity, price, total, notes, executed_by)
            VALUES ($1, 'CASH', 'DEPOSIT', 1, $2, $2, 'Funds added to account', 'SYSTEM')
        `, [userId, amount]);
        
        return result.rows[0];
    });
}

// Withdraw funds
async function withdrawFunds(userId, amount) {
    return await transaction(async (client) => {
        const account = await client.query(
            'SELECT balance FROM trading_accounts WHERE user_id = $1',
            [userId]
        );
        
        if (!account.rows[0] || account.rows[0].balance < amount) {
            throw new Error('Insufficient funds');
        }
        
        const result = await client.query(`
            UPDATE trading_accounts
            SET balance = balance - $1
            WHERE user_id = $2
            RETURNING *
        `, [amount, userId]);
        
        // Log the transaction
        await client.query(`
            INSERT INTO trades (user_id, symbol, action, quantity, price, total, notes, executed_by)
            VALUES ($1, 'CASH', 'WITHDRAWAL', 1, $2, $2, 'Funds withdrawn from account', 'SYSTEM')
        `, [userId, amount]);
        
        return result.rows[0];
    });
}

// Set initial balance
async function setInitialBalance(userId, amount) {
    const result = await query(`
        UPDATE trading_accounts
        SET balance = $1, initial_balance = $1
        WHERE user_id = $2
        RETURNING *
    `, [amount, userId]);
    
    return result.rows[0];
}

/**
 * Recompute cash balance from trade history.
 * Useful when the balance column drifts to $0 due to sync issues.
 * Formula: initial_balance + SELL proceeds - BUY costs - commissions
 */
async function syncBalanceFromHistory(userId) {
    const account = await getTradingAccount(userId);
    if (!account) throw new Error(`No trading account for user ${userId}`);

    const initialBalance = parseFloat(account.initial_balance || 0);

    const result = await query(`
        SELECT
            COALESCE(SUM(CASE WHEN action = 'BUY'  THEN -(total + commission) ELSE 0 END), 0) +
            COALESCE(SUM(CASE WHEN action = 'SELL' THEN  (total - commission) ELSE 0 END), 0) +
            COALESCE(SUM(CASE WHEN action = 'DEPOSIT' THEN total ELSE 0 END), 0) +
            COALESCE(SUM(CASE WHEN action = 'WITHDRAWAL' THEN -total ELSE 0 END), 0)
            AS net_cash_flow
        FROM trades
        WHERE user_id = $1
          AND action IN ('BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL')
    `, [userId]);

    const netFlow = parseFloat(result.rows[0]?.net_cash_flow || 0);
    const recomputedBalance = Math.max(0, initialBalance + netFlow);

    await query(`
        UPDATE trading_accounts
        SET balance = $1, updated_at = NOW()
        WHERE user_id = $2
    `, [recomputedBalance, userId]);

    return { userId, initialBalance, netFlow, recomputedBalance };
}

module.exports = {
    getTradingAccount,
    updateBalance,
    addFunds,
    withdrawFunds,
    setInitialBalance,
    syncBalanceFromHistory
};
