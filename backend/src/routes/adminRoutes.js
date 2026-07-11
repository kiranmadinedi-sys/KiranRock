/**
 * Admin Routes — all-users overview (2026-07-11)
 *
 * Every route here is gated by protect + adminOnly (is_admin flag, set directly in the
 * DB — never self-service). Never returns password hashes or Alpaca credentials, even to
 * the admin — only account-level info, usage stats, and portfolio summaries.
 */
const express = require('express');
const router = express.Router();
const { protect, adminOnly } = require('../middleware/authMiddleware');
const { query } = require('../config/database');
const portfolioTrackingService = require('../services/portfolioTrackingService');
const { getLocationForIp } = require('../services/ipGeolocationService');
const { checkLiveReadiness } = require('../services/liveReadinessService');
const { logger } = require('../utils/logger');

router.use(protect, adminOnly);

/**
 * GET /api/admin/users
 * List every user with account + usage info — no credentials, no password hash.
 */
router.get('/users', async (req, res) => {
    try {
        const result = await query(`
            SELECT
                u.id, u.username, u.email, u.full_name, u.is_active, u.is_admin,
                u.ai_trading_enabled, u.created_at, u.last_login,
                u.alpaca_key_id IS NOT NULL AS has_own_alpaca_creds,
                u.alpaca_paper,
                COALESCE(t.trade_count, 0)      AS trade_count,
                t.last_trade_date,
                COALESCE(l.login_count_total, 0)  AS login_count_total,
                COALESCE(l.login_count_30d, 0)    AS login_count_30d,
                COALESCE(l.login_count_7d, 0)     AS login_count_7d,
                l.most_recent_ip
            FROM users u
            LEFT JOIN (
                SELECT user_id, COUNT(*) AS trade_count, MAX(trade_date) AS last_trade_date
                FROM trades
                WHERE action IN ('BUY', 'SELL')
                GROUP BY user_id
            ) t ON t.user_id = u.id
            LEFT JOIN (
                SELECT
                    user_id,
                    COUNT(*) AS login_count_total,
                    COUNT(*) FILTER (WHERE logged_in_at >= NOW() - INTERVAL '30 days') AS login_count_30d,
                    COUNT(*) FILTER (WHERE logged_in_at >= NOW() - INTERVAL '7 days')  AS login_count_7d,
                    (ARRAY_AGG(ip_address ORDER BY logged_in_at DESC))[1] AS most_recent_ip
                FROM login_history
                GROUP BY user_id
            ) l ON l.user_id = u.id
            ORDER BY u.created_at ASC
        `);

        const users = await Promise.all(result.rows.map(async r => {
            const location = r.most_recent_ip ? await getLocationForIp(r.most_recent_ip) : null;

            // Inline portfolio snapshot so the list itself is a full picture, not just a
            // directory — avoids a click-per-user round trip for the basics (deposited,
            // current value, return). Best-effort: a broker hiccup for one user shouldn't
            // break the whole admin list.
            let portfolio = null;
            try {
                const p = await portfolioTrackingService.getPortfolioSummary(r.id);
                portfolio = {
                    totalPortfolioValue: p.summary.totalPortfolioValue,
                    totalInvested: p.summary.totalInvested,
                    totalDeposited: p.account.totalDeposited,
                    totalWithdrawn: p.account.totalWithdrawn,
                    cashBalance: p.summary.cashBalance,
                    totalHoldingsValue: p.summary.totalHoldingsValue,
                    overallPL: p.summary.overallPL,
                    overallReturn: p.summary.overallReturn,
                    totalRealizedPL: p.summary.totalRealizedPL,
                    totalUnrealizedPL: p.summary.totalUnrealizedPL,
                    numberOfPositions: p.summary.numberOfPositions
                };
            } catch (portfolioErr) {
                logger.debug('[Admin] Portfolio fetch failed for user in list', { userId: r.id, error: portfolioErr.message });
            }

            // SENTINEL readiness — read-only. Same function this user's own live-readiness
            // page calls, just scoped to them individually. Lets you spot a systemic issue
            // (like this week's naked-short bugs) on an account you aren't watching as
            // closely as your own, without needing their login. Deliberately no action
            // endpoints wired up yet (e.g. acknowledge-blockers) — clearing a blocker
            // affects someone else's live trading, so that's a separate decision for later,
            // not bundled into this read-only view (2026-07-11).
            let readiness = null;
            try {
                const rd = await checkLiveReadiness(r.id);
                readiness = { ready: rd.ready, reason: rd.reason, blockers: rd.blockers, advisory: rd.advisory };
            } catch (readinessErr) {
                logger.debug('[Admin] Readiness fetch failed for user in list', { userId: r.id, error: readinessErr.message });
            }

            return {
                id: r.id,
                username: r.username,
                email: r.email,
                fullName: r.full_name,
                isActive: r.is_active,
                isAdmin: r.is_admin,
                aiTradingEnabled: r.ai_trading_enabled,
                createdAt: r.created_at,
                lastLogin: r.last_login,
                hasOwnAlpacaCreds: r.has_own_alpaca_creds,
                broker: r.has_own_alpaca_creds ? (r.alpaca_paper === false ? 'live' : 'paper') : 'shared-env',
                tradeCount: parseInt(r.trade_count) || 0,
                lastTradeDate: r.last_trade_date,
                // Login counts only reflect activity since login_history was added
                // (2026-07-11) — there's no way to backfill frequency from before that.
                loginCountTotal: parseInt(r.login_count_total) || 0,
                loginCount30d: parseInt(r.login_count_30d) || 0,
                loginCount7d: parseInt(r.login_count_7d) || 0,
                mostRecentIp: r.most_recent_ip,
                location,
                portfolio,
                readiness
            };
        }));

        res.json({ users });
    } catch (err) {
        logger.error('[Admin] Failed to list users', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/admin/users/:userId/portfolio
 * Portfolio summary for one user — reuses the same service every user's own /portfolio
 * page calls, so figures are guaranteed consistent with what that user sees themselves.
 */
router.get('/users/:userId/portfolio', async (req, res) => {
    try {
        const { userId } = req.params;
        const exists = await query('SELECT id FROM users WHERE id = $1', [userId]);
        if (exists.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const portfolio = await portfolioTrackingService.getPortfolioSummary(userId);
        res.json(portfolio);
    } catch (err) {
        logger.error('[Admin] Failed to fetch user portfolio', { userId: req.params.userId, error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/admin/users/:userId/deactivate
 * POST /api/admin/users/:userId/reactivate
 *
 * Soft delete only — sets is_active, which the AI trading bot already respects
 * (userDatabaseService's trading-user query filters WHERE is_active = true) and which
 * login now also checks (2026-07-11). Deliberately NOT a hard delete: this account's
 * users table has ON DELETE CASCADE across ~20 tables (trades, trade_decision_journal,
 * portfolio_snapshots, holdings, ...) — a real delete would permanently destroy someone's
 * entire trade history with no recovery, and wouldn't touch their actual Alpaca account,
 * orphaning any real position they still hold there. Deactivating is reversible and keeps
 * every record intact.
 */
router.post('/users/:userId/deactivate', async (req, res) => {
    try {
        const { userId } = req.params;
        if (userId === req.user.id) {
            return res.status(400).json({ error: "Can't deactivate your own admin account." });
        }
        const result = await query('UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id, username', [userId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        logger.warn('[Admin] User deactivated', { adminId: req.user.id, targetUserId: userId, username: result.rows[0].username });
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        logger.error('[Admin] Failed to deactivate user', { userId: req.params.userId, error: err.message });
        res.status(500).json({ error: err.message });
    }
});

router.post('/users/:userId/reactivate', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await query('UPDATE users SET is_active = true, updated_at = NOW() WHERE id = $1 RETURNING id, username', [userId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        logger.warn('[Admin] User reactivated', { adminId: req.user.id, targetUserId: userId, username: result.rows[0].username });
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        logger.error('[Admin] Failed to reactivate user', { userId: req.params.userId, error: err.message });
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
