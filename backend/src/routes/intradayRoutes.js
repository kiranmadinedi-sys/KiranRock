const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const intradayDb = require('../services/intradayDatabaseService');
const intradayScheduler = require('../services/intradayScheduler');
const intradayBot = require('../services/intradayTradingBot');

router.use(protect);

/**
 * GET /api/intraday/status
 */
router.get('/status', async (req, res) => {
    try {
        const config = await intradayDb.getConfig(req.userId);
        const positions = await intradayDb.getPositions(req.userId);
        const todayPnl = await intradayDb.getTodayPnl(req.userId);
        const tradesToday = await intradayDb.getTodayTradeCount(req.userId);
        const scheduler = intradayScheduler.getSchedulerStatus();

        res.json({
            enabled: config.enabled,
            config,
            openPositions: positions.length,
            positions,
            todayPnl,
            tradesToday,
            universe: intradayBot.UNIVERSE,
            scheduler
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/intraday/enable  { enabled: boolean }
 */
router.post('/enable', async (req, res) => {
    try {
        const { enabled } = req.body;
        const config = await intradayDb.updateConfig(req.userId, { enabled: !!enabled });
        res.json({ success: true, enabled: config.enabled });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/intraday/config
 */
router.put('/config', async (req, res) => {
    try {
        const config = await intradayDb.updateConfig(req.userId, req.body);
        res.json(config);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/intraday/positions
 */
router.get('/positions', async (req, res) => {
    try {
        const positions = await intradayDb.getPositions(req.userId);
        res.json(positions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/intraday/history?limit=50
 */
router.get('/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const trades = await intradayDb.getTradeHistory(req.userId, limit);
        res.json(trades);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/intraday/performance?period=week|month|all
 */
router.get('/performance', async (req, res) => {
    try {
        const period = req.query.period || 'week';
        const days = period === 'month' ? 30 : period === 'all' ? 3650 : 7;
        const trades = await intradayDb.getTradeHistory(req.userId, 1000);
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        const windowed = trades.filter(t => new Date(t.exit_time).getTime() >= cutoff);

        const wins = windowed.filter(t => parseFloat(t.pnl) > 0);
        const losses = windowed.filter(t => parseFloat(t.pnl) < 0);
        const totalPnl = windowed.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);

        res.json({
            period,
            totalTrades: windowed.length,
            wins: wins.length,
            losses: losses.length,
            winRate: windowed.length > 0 ? (wins.length / windowed.length) * 100 : 0,
            totalPnl
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/intraday/manual-scan
 */
router.post('/manual-scan', async (req, res) => {
    try {
        const result = await intradayScheduler.manualTrigger(req.userId);
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/intraday/close-position/:symbol
 */
router.post('/close-position/:symbol', async (req, res) => {
    try {
        const intradayBroker = require('../services/intradayBrokerService');
        const trade = await intradayBroker.sellIntraday(req.userId, req.params.symbol.toUpperCase(), { exitReason: 'manual-close' });
        if (!trade) return res.status(404).json({ error: 'Position not found' });
        res.json({ success: true, trade });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
