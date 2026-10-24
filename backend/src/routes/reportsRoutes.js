/**
 * Reports — read-only history of archived reports (2026-10-24). Each user sees their own
 * reports plus platform-wide ones; admin-only reports need is_admin.
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const archive = require('../services/reportArchiveService');

router.use(protect);

router.get('/', async (req, res) => {
    try {
        const rows = await archive.list(req.userId, req.user?.is_admin, { kind: req.query.kind || null, limit: req.query.limit });
        res.json({ kinds: archive.KINDS, reports: rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const r = await archive.get(req.userId, req.user?.is_admin, req.params.id);
        if (!r) return res.status(404).json({ error: 'Not found' });
        res.json(r);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
