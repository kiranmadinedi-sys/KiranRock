/**
 * Reset trading account balance to a specified amount
 */
const resetBalance = async (userId, amount) => {
    try {
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const userIndex = users.findIndex(u => u.id === userId);
        if (userIndex === -1) {
            throw new Error('User not found');
        }
        // Always ensure tradingAccount exists for the user
        if (!users[userIndex].tradingAccount) {
            users[userIndex].tradingAccount = {
                balance: 0,
                totalDeposited: 0,
                totalWithdrawn: 0,
                deposits: [],
                withdrawals: []
            };
        }
        // Only reset the balance for the specific user making the request
        users[userIndex].tradingAccount.balance = amount;
        users[userIndex].tradingAccount.totalDeposited = amount;
        users[userIndex].tradingAccount.totalWithdrawn = 0;
        users[userIndex].tradingAccount.deposits = [];
        users[userIndex].tradingAccount.withdrawals = [];
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
        return { success: true, newBalance: amount };
    } catch (error) {
        console.error('Error resetting balance:', error);
        throw error;
    }
};
const fs = require('fs').promises;
const path = require('path');

const USERS_FILE = path.join(__dirname, '../../users.json');

/**
 * Get trading account balance and info
 */
const getTradingAccount = async (userId) => {
    try {
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const user = users.find(u => u.id === userId);
        
        if (!user) {
            throw new Error('User not found');
        }
        
        // Initialize if doesn't exist
        if (!user.tradingAccount) {
            user.tradingAccount = {
                balance: 100000,
                totalDeposited: 100000,
                totalWithdrawn: 0,
                deposits: [],
                withdrawals: []
            };
        }
        
        return user.tradingAccount;
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
        
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const userIndex = users.findIndex(u => u.id === userId);
        
        if (userIndex === -1) {
            throw new Error('User not found');
        }
        
        // Initialize trading account if needed
        if (!users[userIndex].tradingAccount) {
            users[userIndex].tradingAccount = {
                balance: 0,
                totalDeposited: 0,
                totalWithdrawn: 0,
                deposits: [],
                withdrawals: []
            };
        }
        
        const account = users[userIndex].tradingAccount;
        
        // Add deposit
        const deposit = {
            id: Date.now().toString(),
            amount,
            timestamp: new Date().toISOString(),
            type: 'deposit'
        };
        
        account.balance += amount;
        account.totalDeposited += amount;
        
        if (!account.deposits) account.deposits = [];
        account.deposits.push(deposit);
        
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
        
        return {
            success: true,
            transaction: deposit,
            newBalance: account.balance
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
        
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const userIndex = users.findIndex(u => u.id === userId);
        
        if (userIndex === -1) {
            throw new Error('User not found');
        }
        
        const account = users[userIndex].tradingAccount;
        
        if (!account || account.balance < amount) {
            throw new Error('Insufficient funds');
        }
        
        // Add withdrawal
        const withdrawal = {
            id: Date.now().toString(),
            amount,
            timestamp: new Date().toISOString(),
            type: 'withdrawal'
        };
        
        account.balance -= amount;
        account.totalWithdrawn += amount;
        
        if (!account.withdrawals) account.withdrawals = [];
        account.withdrawals.push(withdrawal);
        
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
        
        return {
            success: true,
            transaction: withdrawal,
            newBalance: account.balance
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
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const user = users.find(u => u.id === userId);
        
        if (!user || !user.tradingAccount) {
            return [];
        }
        
        const deposits = user.tradingAccount.deposits || [];
        const withdrawals = user.tradingAccount.withdrawals || [];
        
        const all = [...deposits, ...withdrawals].sort((a, b) => 
            new Date(b.timestamp) - new Date(a.timestamp)
        );
        
        return all;
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
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const userIndex = users.findIndex(u => u.id === userId);
        
        if (userIndex === -1) {
            throw new Error('User not found');
        }
        
        // Reset trading account to zero
        users[userIndex].tradingAccount = {
            balance: 0,
            totalDeposited: 0,
            totalWithdrawn: 0,
            deposits: [],
            withdrawals: []
        };
        
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
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
