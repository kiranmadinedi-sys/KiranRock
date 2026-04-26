/**
 * Broker Abstraction Layer
 * =========================
 * Switch between brokers by changing BROKER in .env:
 *
 *   BROKER=simulated  — paper trades stored in our own PostgreSQL (default, works now)
 *   BROKER=alpaca     — real orders sent to Alpaca Markets (paper or live)
 *
 * SAFETY: BROKER=alpaca with ALPACA_PAPER=false = REAL MONEY.
 *         Only enable after 6 months of validated paper trading.
 *
 * All trading bot code calls brokerService — never tradingServiceDB directly.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { logger } = require('../utils/logger');

const BROKER = (process.env.BROKER || 'simulated').toLowerCase();
const BOT_ENABLED = process.env.BOT_ENABLED !== 'false';
const MAX_BOT_INVESTMENT = parseFloat(process.env.MAX_BOT_INVESTMENT_USD || '5000');

logger.info(`[Broker] Using broker: ${BROKER.toUpperCase()} | BotEnabled: ${BOT_ENABLED} | MaxInvestment: $${MAX_BOT_INVESTMENT}`);

// ─── SAFETY GATE ─────────────────────────────────────────────────────────────
function safetyCheck(symbol, quantity, estimatedPrice) {
    if (!BOT_ENABLED) {
        throw new Error('Bot is disabled. Set BOT_ENABLED=true in .env to enable trading.');
    }
    const estimatedCost = quantity * estimatedPrice;
    if (estimatedCost > MAX_BOT_INVESTMENT) {
        throw new Error(
            `Order rejected: estimated cost $${estimatedCost.toFixed(2)} exceeds MAX_BOT_INVESTMENT_USD $${MAX_BOT_INVESTMENT}`
        );
    }
}

// ─── SIMULATED BROKER (uses our DB) ──────────────────────────────────────────
const simulatedBroker = (() => {
    const tradingServiceDB = require('./tradingServiceDB');

    async function buyMarket(userId, symbol, quantity, meta = {}) {
        const price = await tradingServiceDB.getCurrentPrice(symbol);
        safetyCheck(symbol, quantity, price || 0);

        logger.info('[Broker:Simulated] BUY order', { symbol, quantity, estimatedPrice: price, meta });

        const result = await tradingServiceDB.executeBuyOrder(
            userId, symbol, quantity,
            meta.executedBy || 'AI_BOT',
            meta.aiScore    || null,
            meta.sector     || null
        );

        return {
            orderId:   `SIM-${Date.now()}`,
            symbol,
            side:      'buy',
            qty:       quantity,
            filledQty: quantity,
            filledAvgPrice: result.price,
            status:    'filled',
            total:     result.total,
            commission: result.commission,
            broker:    'simulated'
        };
    }

    async function sellMarket(userId, symbol, quantity, meta = {}) {
        logger.info('[Broker:Simulated] SELL order', { symbol, quantity, meta });

        const result = await tradingServiceDB.executeSellOrder(
            userId, symbol, quantity,
            meta.executedBy || 'AI_BOT',
            meta.reason     || ''
        );

        return {
            orderId:   `SIM-${Date.now()}`,
            symbol,
            side:      'sell',
            qty:       quantity,
            filledQty: quantity,
            filledAvgPrice: result.price,
            status:    'filled',
            total:     result.total,
            commission: result.commission,
            broker:    'simulated'
        };
    }

    async function getAccountInfo(userId) {
        const accountDb = require('./tradingAccountDatabaseService');
        const account = await accountDb.getTradingAccount(userId);
        return {
            cashBalance:    parseFloat(account.balance),
            portfolioValue: parseFloat(account.portfolio_value || account.balance),
            buyingPower:    parseFloat(account.balance),
            broker:         'simulated'
        };
    }

    async function getPositions(userId) {
        const holdingsDb = require('./holdingsDatabaseService');
        const holdings = await holdingsDb.getUserHoldings(userId);
        return holdings.map(h => ({
            symbol:       h.symbol,
            qty:          parseInt(h.quantity),
            avgEntryPrice: parseFloat(h.average_price),
            currentPrice:  parseFloat(h.current_price || h.average_price),
            marketValue:   parseFloat(h.market_value  || 0),
            unrealizedPL:  parseFloat(h.gain_loss     || 0)
        }));
    }

    return { buyMarket, sellMarket, getAccountInfo, getPositions, name: 'Simulated (Paper DB)' };
})();

// ─── ALPACA BROKER ────────────────────────────────────────────────────────────
const alpacaBroker = (() => {
    let alpaca = null;

    function getClient() {
        if (alpaca) return alpaca;
        if (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET_KEY) {
            throw new Error('Alpaca keys not set. Add ALPACA_KEY_ID and ALPACA_SECRET_KEY to .env');
        }
        const Alpaca = require('@alpacahq/alpaca-trade-api');
        const isPaper = process.env.ALPACA_PAPER !== 'false';
        alpaca = new Alpaca({
            keyId:     process.env.ALPACA_KEY_ID,
            secretKey: process.env.ALPACA_SECRET_KEY,
            paper:     isPaper
        });
        logger.info('[Broker:Alpaca] Client initialised', { paper: isPaper });
        return alpaca;
    }

    async function buyMarket(userId, symbol, quantity, meta = {}) {
        // Estimate price for safety check (use last trade price)
        const dataProvider = require('./dataProvider');
        const quote = await dataProvider.getQuote(symbol);
        safetyCheck(symbol, quantity, quote.price || 0);

        const client = getClient();
        const isPaper = process.env.ALPACA_PAPER !== 'false';

        logger.info('[Broker:Alpaca] Submitting BUY order', {
            symbol, quantity, paper: isPaper, estimatedPrice: quote.price
        });

        const order = await client.createOrder({
            symbol,
            qty:           quantity,
            side:          'buy',
            type:          'market',
            time_in_force: 'day'
        });

        // Wait for fill (poll up to 15 seconds)
        const filled = await waitForFill(client, order.id, 15000);

        // Mirror the trade in our DB for portfolio tracking
        const tradingServiceDB = require('./tradingServiceDB');
        await tradingServiceDB.executeBuyOrder(
            userId, symbol, quantity,
            `ALPACA_${isPaper ? 'PAPER' : 'LIVE'}`,
            meta.aiScore || null,
            meta.sector  || null
        );

        return {
            orderId:        order.id,
            symbol,
            side:           'buy',
            qty:            quantity,
            filledQty:      filled.filled_qty ? parseInt(filled.filled_qty) : quantity,
            filledAvgPrice: filled.filled_avg_price ? parseFloat(filled.filled_avg_price) : quote.price,
            status:         filled.status || 'submitted',
            broker:         isPaper ? 'alpaca-paper' : 'alpaca-live'
        };
    }

    async function sellMarket(userId, symbol, quantity, meta = {}) {
        const client = getClient();
        const isPaper = process.env.ALPACA_PAPER !== 'false';

        logger.info('[Broker:Alpaca] Submitting SELL order', { symbol, quantity, paper: isPaper });

        const order = await client.createOrder({
            symbol,
            qty:           quantity,
            side:          'sell',
            type:          'market',
            time_in_force: 'day'
        });

        const filled = await waitForFill(client, order.id, 15000);

        // Mirror in DB
        const tradingServiceDB = require('./tradingServiceDB');
        await tradingServiceDB.executeSellOrder(
            userId, symbol, quantity,
            `ALPACA_${isPaper ? 'PAPER' : 'LIVE'}`,
            meta.reason || ''
        );

        return {
            orderId:        order.id,
            symbol,
            side:           'sell',
            qty:            quantity,
            filledQty:      filled.filled_qty ? parseInt(filled.filled_qty) : quantity,
            filledAvgPrice: filled.filled_avg_price ? parseFloat(filled.filled_avg_price) : null,
            status:         filled.status || 'submitted',
            broker:         isPaper ? 'alpaca-paper' : 'alpaca-live'
        };
    }

    async function waitForFill(client, orderId, timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const order = await client.getOrder(orderId);
            if (['filled', 'partially_filled', 'canceled', 'rejected', 'expired'].includes(order.status)) {
                return order;
            }
            await new Promise(r => setTimeout(r, 500));
        }
        // Return whatever state we have — don't crash
        return await client.getOrder(orderId);
    }

    async function getAccountInfo(userId) {
        const client = getClient();
        const account = await client.getAccount();
        return {
            cashBalance:    parseFloat(account.cash),
            portfolioValue: parseFloat(account.portfolio_value),
            buyingPower:    parseFloat(account.buying_power),
            broker:         process.env.ALPACA_PAPER !== 'false' ? 'alpaca-paper' : 'alpaca-live'
        };
    }

    async function getPositions(userId) {
        const client = getClient();
        const positions = await client.getPositions();
        return positions.map(p => ({
            symbol:        p.symbol,
            qty:           parseInt(p.qty),
            avgEntryPrice: parseFloat(p.avg_entry_price),
            currentPrice:  parseFloat(p.current_price),
            marketValue:   parseFloat(p.market_value),
            unrealizedPL:  parseFloat(p.unrealized_pl)
        }));
    }

    return { buyMarket, sellMarket, getAccountInfo, getPositions, name: 'Alpaca Markets' };
})();

// ─── ACTIVE BROKER SELECTION ─────────────────────────────────────────────────
const BROKERS = { simulated: simulatedBroker, alpaca: alpacaBroker };
const activeBroker = BROKERS[BROKER] || simulatedBroker;

if (!BROKERS[BROKER]) {
    logger.warn(`[Broker] Unknown broker '${BROKER}', falling back to simulated`);
}

module.exports = {
    /**
     * Place a market buy order.
     * @param {string} userId
     * @param {string} symbol
     * @param {number} quantity  whole shares
     * @param {object} meta      { aiScore, sector, executedBy }
     */
    buyMarket:      (userId, symbol, quantity, meta) =>
                        activeBroker.buyMarket(userId, symbol, quantity, meta),

    /** Place a market sell order */
    sellMarket:     (userId, symbol, quantity, meta) =>
                        activeBroker.sellMarket(userId, symbol, quantity, meta),

    /** Get account cash/portfolio value */
    getAccountInfo: (userId) => activeBroker.getAccountInfo(userId),

    /** Get open positions */
    getPositions:   (userId) => activeBroker.getPositions(userId),

    brokerName:     activeBroker.name,
    brokerKey:      BROKER,
    isSimulated:    BROKER === 'simulated',
    isPaperAlpaca:  BROKER === 'alpaca' && process.env.ALPACA_PAPER !== 'false',
    isLive:         BROKER === 'alpaca' && process.env.ALPACA_PAPER === 'false'
};
