const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const tradingAccountService = require('../services/tradingAccountService');

/**
 * POST /api/trading/reset-balance
 * Reset trading account balance to a specified amount
 */
router.post('/reset-balance', async (req, res) => {
    try {
        const { amount } = req.body;
        if (typeof amount !== 'number' || amount < 0) {
            return res.status(400).json({ error: 'Invalid reset amount' });
        }
        const result = await tradingAccountService.resetBalance(req.userId, amount);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
const tradingService = require('../services/tradingService');
const portfolioTrackingService = require('../services/portfolioTrackingService');

// All routes require authentication
router.use(protect);

/**
 * GET /api/trading/account
 * Get trading account balance and info
 */
router.get('/account', async (req, res) => {
    try {
        const account = await tradingAccountService.getTradingAccount(req.userId);
        res.json(account);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/trading/deposit
 * Deposit virtual funds
 */
router.post('/deposit', async (req, res) => {
    try {
        const { amount } = req.body;
        
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid deposit amount' });
        }
        
        const result = await tradingAccountService.depositFunds(req.userId, parseFloat(amount));
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /api/trading/withdraw
 * Withdraw virtual funds
 */
router.post('/withdraw', async (req, res) => {
    try {
        const { amount } = req.body;
        
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid withdrawal amount' });
        }
        
        const result = await tradingAccountService.withdrawFunds(req.userId, parseFloat(amount));
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /api/trading/buy
 * Execute a buy order
 */
router.post('/buy', async (req, res) => {
    try {
        const { symbol, quantity } = req.body;
        
        if (!symbol || !quantity) {
            return res.status(400).json({ error: 'Symbol and quantity are required' });
        }
        
        if (quantity <= 0 || !Number.isInteger(quantity)) {
            return res.status(400).json({ error: 'Quantity must be a positive integer' });
        }
        
        const result = await tradingService.executeBuyOrder(req.userId, symbol, quantity);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /api/trading/sell
 * Execute a sell order
 */
router.post('/sell', async (req, res) => {
    try {
        const { symbol, quantity } = req.body;
        
        if (!symbol || !quantity) {
            return res.status(400).json({ error: 'Symbol and quantity are required' });
        }
        
        if (quantity <= 0 || !Number.isInteger(quantity)) {
            return res.status(400).json({ error: 'Quantity must be a positive integer' });
        }
        
        const result = await tradingService.executeSellOrder(req.userId, symbol, quantity);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * GET /api/trading/history
 * Get trade history
 */
router.get('/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const trades = await tradingService.getTradeHistory(req.userId, limit);
        res.json(trades);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/trading/holdings
 * Get current holdings
 */
router.get('/holdings', async (req, res) => {
    try {
        const holdings = await tradingService.getHoldings(req.userId);
        res.json(holdings);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/trading/portfolio
 * Get complete portfolio summary with valuations
 */
router.get('/portfolio', async (req, res) => {
    try {
        const portfolio = await portfolioTrackingService.getPortfolioSummary(req.userId);
        res.json(portfolio);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/trading/performance
 * Get performance analytics
 */
router.get('/performance', async (req, res) => {
    try {
        const analytics = await portfolioTrackingService.getPerformanceAnalytics(req.userId);
        res.json(analytics);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/trading/risk
 * Get risk metrics
 */
router.get('/risk', async (req, res) => {
    try {
        const risk = await portfolioTrackingService.getRiskMetrics(req.userId);
        res.json(risk);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/trading/transactions
 * Get account transaction history (deposits/withdrawals)
 */
router.get('/transactions', async (req, res) => {
    try {
        const transactions = await tradingAccountService.getTransactionHistory(req.userId);
        res.json(transactions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/trading/quote/:symbol
 * Get current price for a symbol
 */
router.get('/quote/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const price = await tradingService.getCurrentPrice(symbol);
        res.json({ symbol, price });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/trading/portfolio-history
 * Get portfolio value history for charting
 */
router.get('/portfolio-history', async (req, res) => {
    try {
        const range = req.query.range || '1D';
        const history = await portfolioTrackingService.getPortfolioHistory(req.userId, range);
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
