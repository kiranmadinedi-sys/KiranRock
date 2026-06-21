const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const tradingAccountService = require('../services/tradingAccountService');
const tradingService = require('../services/tradingService');
const marketQuoteService = require('../services/marketQuoteService');
const brokerService = require('../services/brokerService');
const portfolioTrackingService = require('../services/portfolioTrackingService');
const ledgerService = require('../services/ledgerService');
const { analyzeStock } = require('../services/aiTradingBotService');
const { getNewsSentiment } = require('../services/newsSentimentService');

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
 * POST /api/trading/reset-balance
 * Reset trading account balance to a specified amount
 */
router.post('/reset-balance', async (req, res) => {
    try {
        const userDb = require('../services/userDatabaseService');
        const creds  = await userDb.getUserAlpacaCredentials(req.userId);
        if (creds.source === 'user' && creds.isPaper === false) {
            return res.status(403).json({ error: 'Cash balance is controlled by your live Alpaca account and cannot be overridden here.' });
        }
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

/**
 * POST /api/trading/clear-all
 * Clear all portfolio data (cash balance, holdings, trade history) - reset everything to zero
 */
router.post('/clear-all', async (req, res) => {
    try {
        const userDb = require('../services/userDatabaseService');
        const creds  = await userDb.getUserAlpacaCredentials(req.userId);
        if (creds.source === 'user' && creds.isPaper === false) {
            return res.status(403).json({ error: 'Cannot clear a live Alpaca account. Close positions directly on Alpaca, then reconciliation will sync the DB automatically.' });
        }
        await tradingAccountService.clearAllPortfolio(req.userId);
        await tradingService.clearAllHoldings(req.userId);
        res.json({ success: true, message: 'Portfolio cleared successfully. All balances and holdings reset to zero.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
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
        
        const result = await brokerService.executeManualBuyOrder(req.userId, symbol, quantity);
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
        
        const result = await brokerService.executeManualSellOrder(req.userId, symbol, quantity);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * GET /api/trading/history
 * Get trade history (all types: BUY, SELL, DEPOSIT, WITHDRAWAL)
 */
router.get('/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const trades = await tradingService.getTradeHistory(req.userId, limit);

        // Enrich open BUY trades with unrealized P/L using Alpaca live positions
        // (authoritative real-time prices) with Yahoo Finance as fallback.
        try {
            const holdings = await tradingService.getHoldings(req.userId);
            const holdingMap = {};
            for (const h of holdings) holdingMap[h.symbol] = h;

            // Try Alpaca live positions first — returns current_price + unrealizedPL direct from broker
            const priceMap = {};
            try {
                const livePositions = await brokerService.getPositions(req.userId);
                for (const p of livePositions) {
                    if (p.currentPrice) priceMap[p.symbol] = p.currentPrice;
                }
            } catch { /* fall through to Yahoo */ }

            // Fallback: Yahoo Finance for any symbol not covered by Alpaca
            const symbols = [...new Set(holdings.map(h => h.symbol))].filter(s => !priceMap[s]);
            await Promise.all(symbols.map(async sym => {
                try {
                    const p = await marketQuoteService.getCurrentPrice(sym);
                    if (p != null) priceMap[sym] = p;
                } catch { /* use stale holdingMap fallback below */ }
            }));

            for (const trade of trades) {
                if (trade.pnl != null) continue;          // already has realized P/L
                if (trade.type !== 'BUY') continue;       // only enrich open buy legs
                const h = holdingMap[trade.symbol];
                if (!h) continue;                          // position already closed
                const currentPrice = priceMap[trade.symbol] ?? h.currentPrice ?? h.averagePrice;
                if (!currentPrice) continue;
                const qty = trade.quantity || 0;
                const cost = (trade.price || 0) * qty;
                const value = currentPrice * qty;
                trade.unrealizedPL        = parseFloat((value - cost).toFixed(2));
                trade.unrealizedPLPercent = cost > 0
                    ? parseFloat(((value - cost) / cost * 100).toFixed(2))
                    : 0;
                trade.currentPrice = parseFloat(currentPrice.toFixed(2));
            }
        } catch { /* enrichment is best-effort — never break history */ }

        res.json({ trades });
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
        const userDb             = require('../services/userDatabaseService');
        const trailingStopSvc    = require('../services/trailingStopService');
        const [portfolio, creds] = await Promise.all([
            portfolioTrackingService.getPortfolioSummary(req.userId),
            userDb.getUserAlpacaCredentials(req.userId)
        ]);
        portfolio.isLiveAccount = creds.source === 'user' && creds.isPaper === false;

        // Merge Alpaca stop/target prices into each holding (non-blocking — fails gracefully)
        if (process.env.BROKER === 'alpaca' && (portfolio.holdings || []).length > 0) {
            try {
                const stopMap = await trailingStopSvc.getStopOrders(req.userId);
                portfolio.holdings = portfolio.holdings.map(h => {
                    const info = stopMap[(h.symbol || '').toUpperCase()];
                    return info ? { ...h, stopPrice: info.stopPrice, targetPrice: info.targetPrice, stopLocked: info.stopLocked } : h;
                });
            } catch { /* stop data is optional — never break the portfolio response */ }
        }

        res.json(portfolio);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/trading/ledger
 * Return ledger reconciliation (deposits, withdrawals, buys, sells, commissions)
 */
router.get('/ledger', async (req, res) => {
    try {
        const summary = await ledgerService.getLedgerSummary(req.userId);
        res.json(summary);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get full ledger trades (including deposits/withdrawals)
router.get('/ledger/trades', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 1000;
        const trades = await ledgerService.getLedgerTrades(req.userId, limit);
        res.json({ trades });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Export ledger CSV
router.get('/ledger/export', async (req, res) => {
    try {
        const csv = await ledgerService.getLedgerCSV(req.userId);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="ledger.csv"');
        res.send(csv);
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
        const price = await marketQuoteService.getCurrentPrice(symbol);
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

/**
 * GET /api/trading/news-signals
 * Get AI trading signals enriched with news + X sentiment for a list of symbols.
 * Query params:
 *   symbols  - comma-separated list (default: AAPL,MSFT,GOOGL,NVDA,AMZN,TSLA,META,AMD)
 *
 * Returns per-symbol: aiScore, recommendation, newsSentiment, xPostCount, sentiment label
 */
router.get('/news-signals', async (req, res) => {
    try {
        const DEFAULT_SYMBOLS = 'AAPL,MSFT,GOOGL,NVDA,AMZN,TSLA,META,AMD,NFLX,JPM';
        const rawSymbols = String(req.query.symbols || DEFAULT_SYMBOLS);
        const symbols = rawSymbols
            .split(',')
            .map(s => s.trim().toUpperCase())
            .filter(s => /^[A-Z]{1,5}$/.test(s))
            .slice(0, 15); // hard cap: 15 symbols per request

        if (symbols.length === 0) {
            return res.status(400).json({ error: 'No valid symbols provided' });
        }

        // Fetch sentiment for all symbols in parallel
        const sentimentResults = await Promise.allSettled(symbols.map(sym => getNewsSentiment(sym)));
        const sentimentMap = {};
        sentimentResults.forEach((res, i) => {
            sentimentMap[symbols[i]] = res.status === 'fulfilled' ? res.value : null;
        });

        // Analyze each symbol (uses pre-loaded sentiment — no extra API calls)
        const signalResults = await Promise.allSettled(
            symbols.map(sym => analyzeStock(sym, null, sentimentMap[sym]))
        );

        const signals = signalResults
            .map((result, i) => {
                if (result.status !== 'fulfilled' || !result.value) return null;
                const a = result.value;
                return {
                    symbol: a.symbol,
                    price: a.price,
                    change: a.change,
                    aiScore: a.aiScore,
                    recommendation: a.recommendation,
                    chartSignal: a.chartSignal,
                    confidence: a.confidence,
                    newsSentimentImpact: a.newsSentimentImpact,
                    newsSentiment: a.newsSentiment,
                    vix: a.vix,
                    timestamp: a.timestamp
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.aiScore - a.aiScore);

        res.json({
            signals,
            symbolCount: signals.length,
            xEnabled: signals.some(s => (s.newsSentiment?.xPostCount || 0) > 0),
            generatedAt: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
