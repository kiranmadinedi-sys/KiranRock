const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const stockFeedService = require('../services/stockFeedService');
const stockSignalTelegramScheduler = require('../services/stockSignalTelegramScheduler');
const newsMonitoringService = require('../services/newsMonitoringService');

router.use(protect);

router.use((req, res, next) => {
    res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    next();
});

router.get('/', async (req, res) => {
    try {
        const { limit, popupOnly, includeStaleNews } = req.query;
        const result = await stockFeedService.getStockFeed({
            userId: req.userId,
            limit: Number.parseInt(limit, 10) || 25,
            popupOnly: popupOnly === 'true',
            includeStaleNews: includeStaleNews === 'true'
        });
        res.json(result);
    } catch (error) {
        console.error('[Stock Feed API] Error fetching feed:', error);
        res.status(500).json({ error: 'Failed to fetch stock feed' });
    }
});

router.get('/preferences', async (req, res) => {
    try {
        const preferences = await stockFeedService.getPopupPreferences(req.userId);
        res.json({ preferences });
    } catch (error) {
        console.error('[Stock Feed API] Error fetching preferences:', error);
        res.status(500).json({ error: 'Failed to fetch popup preferences' });
    }
});

router.put('/preferences', async (req, res) => {
    try {
        const preferences = await stockFeedService.updatePopupPreferences(req.userId, req.body || {});
        res.json({ success: true, preferences });
    } catch (error) {
        console.error('[Stock Feed API] Error saving preferences:', error);
        res.status(500).json({ error: 'Failed to save popup preferences' });
    }
});

router.get('/scheduler/status', async (req, res) => {
    try {
        res.json({ scheduler: stockSignalTelegramScheduler.getSchedulerStatus() });
    } catch (error) {
        console.error('[Stock Feed API] Error fetching scheduler status:', error);
        res.status(500).json({ error: 'Failed to fetch scheduler status' });
    }
});

router.get('/news-monitor/status', async (req, res) => {
    try {
        const status = await newsMonitoringService.getMonitoringStatus();
        res.json({ status });
    } catch (error) {
        console.error('[Stock Feed API] Error fetching news monitor status:', error);
        res.status(500).json({ error: 'Failed to fetch news monitor status' });
    }
});

router.post('/news-monitor/run', async (req, res) => {
    try {
        const alerts = await newsMonitoringService.monitorNews();
        const status = await newsMonitoringService.getMonitoringStatus();
        res.json({ success: true, createdCount: alerts.length, status });
    } catch (error) {
        console.error('[Stock Feed API] Error running news monitor:', error);
        res.status(500).json({ error: 'Failed to run news monitor' });
    }
});

router.post('/scheduler/run', async (req, res) => {
    try {
        const result = await stockSignalTelegramScheduler.processUserSignals(req.userId);
        res.json({ success: true, result });
    } catch (error) {
        console.error('[Stock Feed API] Error running user signal cycle:', error);
        res.status(500).json({ error: 'Failed to run signal cycle' });
    }
});

router.put('/:id/read', async (req, res) => {
    try {
        await stockFeedService.markFeedItemRead({
            itemId: req.params.id,
            type: req.body?.type,
            userId: req.userId
        });
        res.json({ success: true });
    } catch (error) {
        console.error('[Stock Feed API] Error marking item as read:', error);
        res.status(500).json({ error: 'Failed to update feed item' });
    }
});

module.exports = router;