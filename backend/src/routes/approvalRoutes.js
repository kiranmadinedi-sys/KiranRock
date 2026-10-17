/**
 * Approval requests — API Routes (2026-10-17). The website polls GET /pending and shows
 * a popup; each user can only see and decide their own requests.
 */
const express = require('express');
const router = express.Router();
const approvals = require('./../services/approvalService');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);

/** GET /api/approvals/pending */
router.get('/pending', async (req, res) => {
    try {
        res.json({ requests: await approvals.listPending(req.userId) });
    } catch (error) {
        console.error('[Approvals API] Error listing:', error);
        res.status(500).json({ error: error.message });
    }
});

/** POST /api/approvals/:id/approve  and  /api/approvals/:id/reject */
for (const action of ['approve', 'reject']) {
    router.post(`/:id/${action}`, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
            res.json(await approvals.decide(req.userId, id, action === 'approve'));
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            console.error(`[Approvals API] Error on ${action}:`, error);
            res.status(500).json({ error: error.message });
        }
    });
}

module.exports = router;
