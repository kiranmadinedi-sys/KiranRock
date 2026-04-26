const express = require('express');
const router = express.Router();
const autonomousOptionsBot = require('../services/autonomousOptionsBot');
const optionsBotScheduler = require('../services/optionsBotScheduler');
const { query } = require('../config/database');
const { protect } = require('../middleware/authMiddleware');

// All routes require authentication
router.use(protect);

/**
 * GET /api/options-bot/status
 * Get options bot status and configuration
 */
router.get('/status', async (req, res) => {
    try {
        console.log('[Options Bot API] Getting status for user:', req.userId);
        
        // Get user's bot config (create if doesn't exist)
        let configResult = await query(
            'SELECT * FROM options_bot_config WHERE user_id = $1',
            [req.userId]
        );
        
        // If no config exists, create default one
        if (configResult.rows.length === 0) {
            console.log('[Options Bot API] Creating default config for user:', req.userId);
            await query(
                `INSERT INTO options_bot_config (
                    user_id, enabled, scalping_enabled, swing_enabled, 
                    spreads_enabled, max_open_positions, max_daily_loss,
                    take_profit_percent, stop_loss_percent
                ) VALUES ($1, false, true, true, true, 5, 1000, 50, 30)`,
                [req.userId]
            );
            
            // Fetch the newly created config
            configResult = await query(
                'SELECT * FROM options_bot_config WHERE user_id = $1',
                [req.userId]
            );
        }
        
        // Get open positions count
        const positionsResult = await query(
            'SELECT COUNT(*) as count FROM options_trades WHERE user_id = $1 AND status = $2',
            [req.userId, 'OPEN']
        );
        
        // Get today's performance
        const today = new Date().toISOString().split('T')[0];
        const performanceResult = await query(
            'SELECT * FROM options_performance WHERE user_id = $1 AND date = $2',
            [req.userId, today]
        );
        
        const config = configResult.rows[0] || null;
        const openPositions = parseInt(positionsResult.rows[0].count) || 0;
        const todayPerformance = performanceResult.rows[0] || null;
        const schedulerStatus = optionsBotScheduler.getSchedulerStatus();
        
        // Get VIX with error handling
        let vixData = { value: 0, regime: 'unknown' };
        try {
            vixData = await autonomousOptionsBot.getVixLevel();
        } catch (vixError) {
            console.error('[Options Bot API] Error getting VIX:', vixError.message);
        }
        
        console.log('[Options Bot API] Status response:', {
            enabled: config?.enabled,
            openPositions,
            hasConfig: !!config
        });
        
        res.json({
            enabled: config?.enabled || false,
            config,
            openPositions,
            todayPerformance,
            scheduler: schedulerStatus,
            vix: vixData
        });
    } catch (error) {
        console.error('[Options Bot API] Error getting status:', error);
        res.status(500).json({ 
            error: error.message,
            details: error.stack,
            userId: req.userId 
        });
    }
});

/**
 * POST /api/options-bot/enable
 * Enable/disable options bot for user
 */
router.post('/enable', async (req, res) => {
    try {
        const { enabled } = req.body;
        
        // Check if config exists
        const existingConfig = await query(
            'SELECT id FROM options_bot_config WHERE user_id = $1',
            [req.userId]
        );
        
        if (existingConfig.rows.length === 0) {
            // Create default config
            await query(
                `INSERT INTO options_bot_config (user_id, enabled) 
                 VALUES ($1, $2)`,
                [req.userId, enabled]
            );
        } else {
            // Update existing
            await query(
                'UPDATE options_bot_config SET enabled = $1, updated_at = NOW() WHERE user_id = $2',
                [enabled, req.userId]
            );
        }
        
        res.json({ success: true, enabled });
    } catch (error) {
        console.error('[Options Bot API] Error enabling bot:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/options-bot/config
 * Update options bot configuration
 */
router.put('/config', async (req, res) => {
    try {
        const {
            scalping_enabled,
            swing_enabled,
            spreads_enabled,
            hedging_enabled,
            max_position_risk,
            max_account_risk,
            max_open_positions,
            max_daily_loss,
            take_profit_percent,
            stop_loss_percent,
            trailing_stop_percent,
            min_opportunity_score
        } = req.body;
        
        // Check if config exists
        const existingConfig = await query(
            'SELECT id FROM options_bot_config WHERE user_id = $1',
            [req.userId]
        );
        
        if (existingConfig.rows.length === 0) {
            // Create new config
            const result = await query(
                `INSERT INTO options_bot_config 
                 (user_id, scalping_enabled, swing_enabled, spreads_enabled, hedging_enabled,
                  max_position_risk, max_account_risk, max_open_positions, max_daily_loss,
                  take_profit_percent, stop_loss_percent, trailing_stop_percent, min_opportunity_score)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                 RETURNING *`,
                [req.userId, scalping_enabled, swing_enabled, spreads_enabled, hedging_enabled,
                 max_position_risk, max_account_risk, max_open_positions, max_daily_loss,
                 take_profit_percent, stop_loss_percent, trailing_stop_percent, min_opportunity_score]
            );
            return res.json(result.rows[0]);
        } else {
            // Update existing config
            const result = await query(
                `UPDATE options_bot_config SET
                 scalping_enabled = COALESCE($2, scalping_enabled),
                 swing_enabled = COALESCE($3, swing_enabled),
                 spreads_enabled = COALESCE($4, spreads_enabled),
                 hedging_enabled = COALESCE($5, hedging_enabled),
                 max_position_risk = COALESCE($6, max_position_risk),
                 max_account_risk = COALESCE($7, max_account_risk),
                 max_open_positions = COALESCE($8, max_open_positions),
                 max_daily_loss = COALESCE($9, max_daily_loss),
                 take_profit_percent = COALESCE($10, take_profit_percent),
                 stop_loss_percent = COALESCE($11, stop_loss_percent),
                 trailing_stop_percent = COALESCE($12, trailing_stop_percent),
                 min_opportunity_score = COALESCE($13, min_opportunity_score),
                 updated_at = NOW()
                 WHERE user_id = $1
                 RETURNING *`,
                [req.userId, scalping_enabled, swing_enabled, spreads_enabled, hedging_enabled,
                 max_position_risk, max_account_risk, max_open_positions, max_daily_loss,
                 take_profit_percent, stop_loss_percent, trailing_stop_percent, min_opportunity_score]
            );
            res.json(result.rows[0]);
        }
    } catch (error) {
        console.error('[Options Bot API] Error updating config:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/options-bot/positions
 * Get open options positions
 */
router.get('/positions', async (req, res) => {
    try {
        const result = await query(
            `SELECT * FROM options_trades 
             WHERE user_id = $1 AND status = 'OPEN' 
             ORDER BY entry_date DESC`,
            [req.userId]
        );
        
        res.json(result.rows);
    } catch (error) {
        console.error('[Options Bot API] Error getting positions:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/options-bot/history
 * Get closed options positions
 */
router.get('/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        
        const result = await query(
            `SELECT * FROM options_trades 
             WHERE user_id = $1 AND status = 'CLOSED' 
             ORDER BY exit_date DESC 
             LIMIT $2`,
            [req.userId, limit]
        );
        
        res.json(result.rows);
    } catch (error) {
        console.error('[Options Bot API] Error getting history:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/options-bot/performance
 * Get performance metrics
 */
router.get('/performance', async (req, res) => {
    try {
        const period = req.query.period || 'week'; // week, month, all
        
        let dateFilter = '';
        if (period === 'week') {
            dateFilter = "AND entry_date >= NOW() - INTERVAL '7 days'";
        } else if (period === 'month') {
            dateFilter = "AND entry_date >= NOW() - INTERVAL '30 days'";
        }
        
        const result = await query(
            `SELECT 
                COUNT(*) as total_trades,
                SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) as winning_trades,
                SUM(CASE WHEN profit_loss < 0 THEN 1 ELSE 0 END) as losing_trades,
                SUM(profit_loss) as total_pnl,
                AVG(CASE WHEN profit_loss > 0 THEN profit_loss ELSE NULL END) as avg_win,
                AVG(CASE WHEN profit_loss < 0 THEN profit_loss ELSE NULL END) as avg_loss,
                MAX(profit_loss) as best_trade,
                MIN(profit_loss) as worst_trade,
                ROUND(SUM(CASE WHEN profit_loss > 0 THEN 1.0 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 2) as win_rate
             FROM options_trades
             WHERE user_id = $1 AND status = 'CLOSED' ${dateFilter}`,
            [req.userId]
        );
        
        // Get strategy breakdown
        const strategyResult = await query(
            `SELECT strategy, COUNT(*) as trades, SUM(profit_loss) as pnl
             FROM options_trades
             WHERE user_id = $1 AND status = 'CLOSED' ${dateFilter}
             GROUP BY strategy`,
            [req.userId]
        );
        
        res.json({
            overall: result.rows[0],
            byStrategy: strategyResult.rows
        });
    } catch (error) {
        console.error('[Options Bot API] Error getting performance:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/options-bot/manual-scan
 * Manually trigger options scan (for testing)
 */
router.post('/manual-scan', async (req, res) => {
    try {
        // Run bot manually for this user
        await autonomousOptionsBot.executeAutonomousOptionsTrading(req.userId);
        
        res.json({ success: true, message: 'Manual scan completed' });
    } catch (error) {
        console.error('[Options Bot API] Error in manual scan:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/options-bot/close-position/:id
 * Manually close an options position
 */
router.post('/close-position/:id', async (req, res) => {
    try {
        const positionId = req.params.id;
        const { exitPrice, reason } = req.body;
        
        // Verify position belongs to user
        const positionResult = await query(
            'SELECT * FROM options_trades WHERE id = $1 AND user_id = $2 AND status = $3',
            [positionId, req.userId, 'OPEN']
        );
        
        if (positionResult.rows.length === 0) {
            return res.status(404).json({ error: 'Position not found or already closed' });
        }
        
        const position = positionResult.rows[0];
        const entryPrice = parseFloat(position.entry_price);
        const pnl = (exitPrice - entryPrice) * position.contracts * 100;
        const pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
        
        // Close position
        await query(
            `UPDATE options_trades 
             SET status = 'CLOSED', exit_price = $1, exit_date = NOW(), 
                 profit_loss = $2, profit_loss_percent = $3, exit_reason = $4
             WHERE id = $5`,
            [exitPrice, pnl, pnlPercent, reason || 'MANUAL_CLOSE', positionId]
        );
        
        res.json({ 
            success: true, 
            pnl, 
            pnlPercent,
            message: 'Position closed successfully' 
        });
    } catch (error) {
        console.error('[Options Bot API] Error closing position:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/options-bot/alerts
 * Get options alerts
 */
router.get('/alerts', async (req, res) => {
    try {
        const unreadOnly = req.query.unread === 'true';
        const limit = parseInt(req.query.limit) || 50;
        
        let query_str = `
            SELECT * FROM options_alerts 
            WHERE user_id = $1 ${unreadOnly ? 'AND read = false' : ''}
            ORDER BY created_at DESC 
            LIMIT $2
        `;
        
        const result = await query(query_str, [req.userId, limit]);
        
        res.json(result.rows);
    } catch (error) {
        console.error('[Options Bot API] Error getting alerts:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/options-bot/alerts/:id/read
 * Mark alert as read
 */
router.put('/alerts/:id/read', async (req, res) => {
    try {
        await query(
            'UPDATE options_alerts SET read = true WHERE id = $1 AND user_id = $2',
            [req.params.id, req.userId]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('[Options Bot API] Error marking alert as read:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
