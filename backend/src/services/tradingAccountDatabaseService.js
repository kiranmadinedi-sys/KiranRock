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

module.exports = {
    getTradingAccount,
    updateBalance,
    addFunds,
    withdrawFunds,
    setInitialBalance
};
