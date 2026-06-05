const express = require('express');
const router = express.Router();
const { protect: authenticateToken } = require('../middleware/authMiddleware');
const ollamaService = require('../services/ollamaService');
const { query } = require('../config/database');
const marketRegimeService = require('../services/marketRegimeService');
const precomputedUniverseService = require('../services/precomputedUniverseService');
const { logger } = require('../utils/logger');

/**
 * AI Enquiry Service
 * Handles natural language questions about stocks and market data
 * Uses local Ollama LLM for processing
 */

// POST /api/enquiry - Ask AI questions about stocks and market
router.post('/enquiry', authenticateToken, async (req, res) => {
    try {
        const { question } = req.body;
        const userId = req.user?.id;

        if (!question || typeof question !== 'string') {
            return res.status(400).json({ error: 'Question is required' });
        }

        logger.info('[Enquiry] Processing question', { userId, questionLength: question.length });

        // Get current market context
        const marketContext = await getMarketContext();

        // Get user's portfolio context if available
        const userContext = await getUserContext(userId);

        // Preprocess and normalize the question
        const normalizedQuestion = preprocessQuestion(question);

        // Prepare the prompt with context
        const systemPrompt = buildSystemPrompt(marketContext, userContext);
        const userPrompt = normalizedQuestion;

        // Use Ollama service to generate response
        const response = await ollamaService.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ]);

        logger.info('[Enquiry] Response generated', { userId, responseLength: response?.length || 0 });

        res.json({
            answer: response,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('[Enquiry] Error processing question', {
            error: error.message,
            userId: req.user?.id
        });

        // Check if Ollama service is available
        if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed')) {
            return res.status(503).json({
                error: 'AI service is currently unavailable. Please ensure Ollama is running.',
                suggestion: 'Run: ollama serve'
            });
        }

        res.status(500).json({
            error: 'Failed to process your question. Please try again.',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * Preprocess and normalize user questions for better understanding
 * Handles common spelling mistakes and stock symbol corrections
 */
function preprocessQuestion(question) {
    if (!question || typeof question !== 'string') return question;

    let normalized = question.toLowerCase().trim();

    // Common stock symbol corrections
    const symbolCorrections = {
        'aple': 'AAPL', 'apple': 'AAPL', 'appl': 'AAPL',
        'tesla': 'TSLA', 'teslas': 'TSLA', 'tslaa': 'TSLA',
        'microsoft': 'MSFT', 'msf': 'MSFT', 'microsft': 'MSFT',
        'google': 'GOOGL', 'googel': 'GOOGL', 'gogle': 'GOOGL',
        'amazon': 'AMZN', 'amzn': 'AMZN', 'amazn': 'AMZN',
        'nvidia': 'NVDA', 'nvda': 'NVDA', 'nvdia': 'NVDA',
        'meta': 'META', 'facebook': 'META', 'fb': 'META',
        'palantir': 'PLTR', 'pltr': 'PLTR', 'palanteer': 'PLTR',
        'snowflake': 'SNOW', 'snow': 'SNOW',
        'advanced micro': 'AMD', 'amd': 'AMD',
        'intel': 'INTC', 'intc': 'INTC',
    };

    // Common trading term corrections
    const termCorrections = {
        'stonks': 'stocks',
        'stonk': 'stock',
        'mooning': 'rising rapidly',
        'diamond hands': 'holding long term',
        'paper hands': 'selling quickly',
        'hodl': 'hold',
        'tendies': 'profits',
        'bagholding': 'holding losing positions',
        'yolo': 'high risk trade',
        'dd': 'due diligence',
        'ath': 'all time high',
        'atl': 'all time low',
        'rn': 'right now',
        'wat': 'what',
        'shoud': 'should',
        'shld': 'should',
        'wud': 'would',
        'cud': 'could',
        'portoflio': 'portfolio',
        'porfolio': 'portfolio',
        'perfomance': 'performance',
        'recomendation': 'recommendation',
        'analisis': 'analysis',
        'analysys': 'analysis',
    };

    // Apply symbol corrections
    Object.entries(symbolCorrections).forEach(([wrong, correct]) => {
        const regex = new RegExp(`\\b${wrong}\\b`, 'gi');
        normalized = normalized.replace(regex, correct);
    });

    // Apply term corrections
    Object.entries(termCorrections).forEach(([wrong, correct]) => {
        const regex = new RegExp(`\\b${wrong}\\b`, 'gi');
        normalized = normalized.replace(regex, correct);
    });

    // Common question structure fixes
    normalized = normalized
        .replace(/\bwat\s+do\b/gi, 'what should')
        .replace(/\bwat\s+is\b/gi, 'what is')
        .replace(/\bhow\s+is\s+(\w+)\s+doing\b/gi, 'how is $1 performing')
        .replace(/\bis\s+(\w+)\s+good\s+buy\b/gi, 'is $1 a good buy')
        .replace(/\bshld\s+i\s+buy\b/gi, 'should I buy')
        .replace(/\bshld\s+i\s+sell\b/gi, 'should I sell')
        .replace(/\bbest\s+stonks\b/gi, 'best stocks');

    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

/**
 * Get current market context for AI responses
 */
async function getMarketContext() {
    try {
        const context = {};

        // Market regime
        const regime = await marketRegimeService.getMarketRegime();
        context.marketRegime = {
            regime: regime.regime,
            description: regime.description,
            vixLevel: regime.vixLevel,
            spy5dRangePct: regime.spy5dRangePct,
            atrExpansion: regime.atrExpansion
        };

        // Available signals
        const isAvailable = await precomputedUniverseService.isAvailable(5);
        if (isAvailable) {
            const signals = await precomputedUniverseService.loadCandidates({ minScore: 0, limit: 50 });
            const strongBuys = signals.filter(s => s._precomputedRec === 'STRONG BUY');
            const buys = signals.filter(s => s._precomputedRec === 'BUY');

            context.signals = {
                strongBuyCount: strongBuys.length,
                buyCount: buys.length,
                topStrongBuys: strongBuys.slice(0, 5).map(s => ({
                    symbol: s.symbol,
                    score: s._precomputedScore,
                    sector: s.sector
                })),
                topBuys: buys.slice(0, 5).map(s => ({
                    symbol: s.symbol,
                    score: s._precomputedScore,
                    sector: s.sector
                }))
            };
        } else {
            context.signals = { error: 'No recent nightly scan data available' };
        }

        return context;
    } catch (error) {
        logger.error('[Enquiry] Error getting market context', { error: error.message });
        return { error: 'Market data temporarily unavailable' };
    }
}

/**
 * Get user's portfolio and trading context
 */
async function getUserContext(userId) {
    try {
        if (!userId) return {};

        const context = {};

        // User's account info
        const userAccount = await query(`
            SELECT u.username, ta.balance, ta.portfolio_value,
                   aic.max_positions, aic.min_score
            FROM users u
            JOIN trading_accounts ta ON ta.user_id = u.id
            LEFT JOIN ai_trading_configs aic ON aic.user_id = u.id
            WHERE u.id = $1
        `, [userId]);

        if (userAccount.rows.length > 0) {
            const account = userAccount.rows[0];
            context.account = {
                username: account.username,
                balance: parseFloat(account.balance),
                portfolioValue: parseFloat(account.portfolio_value || 0),
                maxPositions: account.max_positions,
                minScore: account.min_score
            };
        }

        // Current holdings
        const holdings = await query(`
            SELECT symbol, quantity, average_cost, market_value,
                   (market_value - (quantity * average_cost)) as unrealized_pnl
            FROM holdings
            WHERE user_id = $1 AND quantity > 0
            ORDER BY market_value DESC
        `, [userId]);

        if (holdings.rows.length > 0) {
            context.holdings = holdings.rows.map(h => ({
                symbol: h.symbol,
                quantity: parseFloat(h.quantity),
                avgCost: parseFloat(h.average_cost),
                marketValue: parseFloat(h.market_value),
                unrealizedPnl: parseFloat(h.unrealized_pnl)
            }));
        }

        return context;
    } catch (error) {
        logger.error('[Enquiry] Error getting user context', { error: error.message, userId });
        return {};
    }
}

/**
 * Build system prompt with current market and user context
 */
function buildSystemPrompt(marketContext, userContext) {
    return `You are a professional financial AI assistant for the KiranRock trading platform. You provide helpful, accurate, and actionable insights about stocks, trading, and market conditions.

IMPORTANT: You understand natural, conversational English including:
• Casual language and informal questions
• Spelling mistakes and typos (auto-correct them mentally)
• Incomplete sentences or fragmented thoughts
• Slang terms for stocks/trading (e.g., "stonks", "mooning", "diamond hands")
• Questions with grammatical errors
• Mixed-case or misspelled stock symbols

Examples you should understand:
• "how is aple doing?" → "How is AAPL (Apple) performing?"
• "shoud i buy tesla?" → "Should I buy TSLA (Tesla)?"
• "whats the best tech stonks rn" → "What are the best tech stocks right now?"
• "my portoflio down, wat do?" → "My portfolio is down, what should I do?"

CURRENT MARKET CONTEXT:
${marketContext.marketRegime ? `
• Market Regime: ${marketContext.marketRegime.regime}
• Market Description: ${marketContext.marketRegime.description}
• VIX Level: ${marketContext.marketRegime.vixLevel}
• Market Volatility: ${marketContext.marketRegime.atrExpansion < 0.85 ? 'Low/Contracting' : 'Normal/Expanding'}
` : '• Market data temporarily unavailable'}

AVAILABLE TRADING SIGNALS:
${marketContext.signals?.strongBuyCount ? `
• STRONG BUY signals: ${marketContext.signals.strongBuyCount}
• BUY signals: ${marketContext.signals.buyCount}
• Top STRONG BUY stocks: ${marketContext.signals.topStrongBuys.map(s => `${s.symbol} (${s.score})`).join(', ')}
` : '• No recent signals available'}

${userContext.account ? `
USER PORTFOLIO CONTEXT:
• Account Balance: $${userContext.account.balance.toLocaleString()}
• Portfolio Value: $${userContext.account.portfolioValue.toLocaleString()}
• Max Positions: ${userContext.account.maxPositions}
• Min Score Threshold: ${userContext.account.minScore}
` : ''}

${userContext.holdings ? `
CURRENT HOLDINGS:
${userContext.holdings.map(h => `• ${h.symbol}: ${h.quantity} shares @ $${h.avgCost.toFixed(2)} (P&L: ${h.unrealizedPnl >= 0 ? '+' : ''}$${h.unrealizedPnl.toFixed(2)})`).join('\\n')}
` : ''}

GUIDELINES:
• Provide clear, actionable insights
• Reference current market conditions when relevant
• Consider user's specific portfolio when giving advice
• Explain technical concepts in simple terms
• Include risk disclaimers for investment advice
• Use the available market data and signals in your responses
• Be concise but informative

Remember: This is for educational purposes. All investment decisions should consider individual risk tolerance and financial situation.`;
}

module.exports = router;