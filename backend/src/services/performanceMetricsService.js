const { query } = require('../config/database');
const { logger } = require('../utils/logger');

/**
 * Performance Metrics Database Service
 * Tracks AI trading performance metrics
 */

/**
 * Initialize performance metrics table
 */
async function initializePerformanceTable() {
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS ai_performance_metrics (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(255) NOT NULL REFERENCES users(id),
            date DATE NOT NULL DEFAULT CURRENT_DATE,
            
            -- Trade counts
            total_trades INTEGER DEFAULT 0,
            buy_trades INTEGER DEFAULT 0,
            sell_trades INTEGER DEFAULT 0,
            winning_trades INTEGER DEFAULT 0,
            losing_trades INTEGER DEFAULT 0,
            
            -- Financial metrics
            total_profit_loss DECIMAL(15, 2) DEFAULT 0,
            total_fees DECIMAL(15, 2) DEFAULT 0,
            largest_win DECIMAL(15, 2) DEFAULT 0,
            largest_loss DECIMAL(15, 2) DEFAULT 0,
            
            -- Performance ratios
            win_rate DECIMAL(5, 2) DEFAULT 0,
            average_win DECIMAL(15, 2) DEFAULT 0,
            average_loss DECIMAL(15, 2) DEFAULT 0,
            profit_factor DECIMAL(10, 2) DEFAULT 0,
            
            -- Risk metrics
            max_drawdown DECIMAL(10, 2) DEFAULT 0,
            max_drawdown_percent DECIMAL(5, 2) DEFAULT 0,
            sharpe_ratio DECIMAL(10, 4) DEFAULT 0,
            
            -- Market context
            avg_vix_level DECIMAL(6, 2),
            market_regime VARCHAR(50),
            
            -- Timestamps
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            
            UNIQUE(user_id, date)
        );

        CREATE INDEX IF NOT EXISTS idx_performance_user_date ON ai_performance_metrics(user_id, date DESC);
        CREATE INDEX IF NOT EXISTS idx_performance_user ON ai_performance_metrics(user_id);
    `;

    try {
        await query(createTableQuery);
        logger.info('Performance metrics table initialized');
    } catch (error) {
        logger.error('Failed to initialize performance metrics table', { error: error.message });
    }
}

/**
 * Record trade performance
 */
async function recordTradePerformance(userId, trade) {
    const { action, symbol, quantity, price, profit_loss, fees } = trade;

    try {
        const today = new Date().toISOString().split('T')[0];

        // Insert or update today's metrics
        await query(`
            INSERT INTO ai_performance_metrics (user_id, date, total_trades, buy_trades, sell_trades)
            VALUES ($1, $2, 1, $3, $4)
            ON CONFLICT (user_id, date)
            DO UPDATE SET
                total_trades = ai_performance_metrics.total_trades + 1,
                buy_trades = ai_performance_metrics.buy_trades + $3,
                sell_trades = ai_performance_metrics.sell_trades + $4,
                updated_at = NOW()
        `, [userId, today, action === 'BUY' ? 1 : 0, action === 'SELL' ? 1 : 0]);

        // If it's a sell trade, update P&L metrics
        if (action === 'SELL' && profit_loss !== undefined) {
            const isWin = profit_loss > 0;

            await query(`
                UPDATE ai_performance_metrics
                SET
                    winning_trades = winning_trades + $1,
                    losing_trades = losing_trades + $2,
                    total_profit_loss = total_profit_loss + $3,
                    total_fees = total_fees + $4,
                    largest_win = CASE WHEN $5 > largest_win THEN $5 ELSE largest_win END,
                    largest_loss = CASE WHEN $6 < largest_loss THEN $6 ELSE largest_loss END,
                    updated_at = NOW()
                WHERE user_id = $7 AND date = $8
            `, [
                isWin ? 1 : 0,
                isWin ? 0 : 1,
                profit_loss,
                fees || 0,
                isWin ? profit_loss : 0,
                isWin ? 0 : profit_loss,
                userId,
                today
            ]);

            // Recalculate performance ratios
            await updatePerformanceRatios(userId, today);
        }

        logger.info('Trade performance recorded', { userId, action, symbol });
    } catch (error) {
        logger.error('Failed to record trade performance', { error: error.message, userId });
    }
}

/**
 * Update performance ratios (win rate, profit factor, etc.)
 */
async function updatePerformanceRatios(userId, date) {
    try {
        const result = await query(`
            SELECT
                winning_trades,
                losing_trades,
                total_profit_loss,
                total_trades
            FROM ai_performance_metrics
            WHERE user_id = $1 AND date = $2
        `, [userId, date]);

        if (result.rows.length === 0) return;

        const { winning_trades, losing_trades, total_profit_loss, total_trades } = result.rows[0];

        // Calculate win rate
        const winRate = total_trades > 0 ? (winning_trades / (winning_trades + losing_trades)) * 100 : 0;

        // Compute average win/loss from same-day metrics row
        // (trades table has no profit_loss column — use what was recorded in this row)
        const avgWinResult  = await query(`
            SELECT CASE WHEN winning_trades > 0
                        THEN total_profit_loss / winning_trades
                        ELSE 0 END AS avg_win
            FROM ai_performance_metrics
            WHERE user_id = $1 AND date = $2
        `, [userId, date]);

        const avgLossResult = await query(`
            SELECT CASE WHEN losing_trades > 0
                        THEN (total_profit_loss - GREATEST(total_profit_loss, 0)) / losing_trades
                        ELSE 0 END AS avg_loss
            FROM ai_performance_metrics
            WHERE user_id = $1 AND date = $2
        `, [userId, date]);

        const avgWin = avgWinResult.rows[0]?.avg_win || 0;
        const avgLoss = avgLossResult.rows[0]?.avg_loss || 0;

        // Calculate profit factor
        const totalWins = winning_trades * avgWin;
        const totalLosses = Math.abs(losing_trades * avgLoss);
        const profitFactor = totalLosses > 0 ? totalWins / totalLosses : 0;

        // Update ratios
        await query(`
            UPDATE ai_performance_metrics
            SET
                win_rate = $1,
                average_win = $2,
                average_loss = $3,
                profit_factor = $4,
                updated_at = NOW()
            WHERE user_id = $5 AND date = $6
        `, [winRate, avgWin, avgLoss, profitFactor, userId, date]);

        logger.info('Performance ratios updated', { userId, winRate, profitFactor });
    } catch (error) {
        logger.error('Failed to update performance ratios', { error: error.message, userId });
    }
}

/**
 * Get daily performance summary
 */
async function getDailyPerformance(userId, date = null) {
    const targetDate = date || new Date().toISOString().split('T')[0];

    try {
        const result = await query(`
            SELECT * FROM ai_performance_metrics
            WHERE user_id = $1 AND date = $2
        `, [userId, targetDate]);

        return result.rows[0] || null;
    } catch (error) {
        logger.error('Failed to get daily performance', { error: error.message, userId });
        return null;
    }
}

/**
 * Get weekly performance summary
 */
async function getWeeklyPerformance(userId) {
    try {
        const result = await query(`
            SELECT
                SUM(total_trades) as total_trades,
                SUM(winning_trades) as winning_trades,
                SUM(losing_trades) as losing_trades,
                SUM(total_profit_loss) as total_profit_loss,
                AVG(win_rate) as avg_win_rate,
                MAX(largest_win) as largest_win,
                MIN(largest_loss) as largest_loss,
                AVG(sharpe_ratio) as avg_sharpe_ratio
            FROM ai_performance_metrics
            WHERE user_id = $1
            AND date >= CURRENT_DATE - INTERVAL '7 days'
        `, [userId]);

        return result.rows[0];
    } catch (error) {
        logger.error('Failed to get weekly performance', { error: error.message, userId });
        return null;
    }
}

/**
 * Get monthly performance summary
 */
async function getMonthlyPerformance(userId) {
    try {
        const result = await query(`
            SELECT
                SUM(total_trades) as total_trades,
                SUM(winning_trades) as winning_trades,
                SUM(losing_trades) as losing_trades,
                SUM(total_profit_loss) as total_profit_loss,
                AVG(win_rate) as avg_win_rate,
                MAX(largest_win) as largest_win,
                MIN(largest_loss) as largest_loss,
                AVG(sharpe_ratio) as avg_sharpe_ratio
            FROM ai_performance_metrics
            WHERE user_id = $1
            AND date >= CURRENT_DATE - INTERVAL '30 days'
        `, [userId]);

        return result.rows[0];
    } catch (error) {
        logger.error('Failed to get monthly performance', { error: error.message, userId });
        return null;
    }
}

/**
 * Calculate Sharpe ratio (risk-adjusted return)
 */
async function calculateSharpeRatio(userId, days = 30) {
    try {
        const result = await query(`
            SELECT total_profit_loss, date
            FROM ai_performance_metrics
            WHERE user_id = $1
            AND date >= CURRENT_DATE - INTERVAL '${days} days'
            ORDER BY date
        `, [userId]);

        if (result.rows.length < 2) {
            return 0;
        }

        const returns = result.rows.map(r => parseFloat(r.total_profit_loss));
        const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
        
        // Calculate standard deviation
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
        const stdDev = Math.sqrt(variance);

        // Sharpe ratio = (avgReturn - riskFreeRate) / stdDev
        const riskFreeRate = 0.04 / 252; // 4% annual rate, daily
        const sharpeRatio = stdDev > 0 ? (avgReturn - riskFreeRate) / stdDev : 0;

        return sharpeRatio;
    } catch (error) {
        logger.error('Failed to calculate Sharpe ratio', { error: error.message, userId });
        return 0;
    }
}

/**
 * Update daily loss (for circuit breaker)
 */
async function updateDailyLoss(userId, additionalLoss) {
    try {
        const today = new Date().toISOString().split('T')[0];

        await query(`
            INSERT INTO ai_performance_metrics (user_id, date, total_profit_loss)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id, date)
            DO UPDATE SET
                total_profit_loss = ai_performance_metrics.total_profit_loss + $3,
                updated_at = NOW()
        `, [userId, today, additionalLoss]);

    } catch (error) {
        logger.error('Failed to update daily loss', { error: error.message, userId });
    }
}

/**
 * Get today's total loss (for circuit breaker)
 */
async function getTodayLoss(userId) {
    try {
        const today = new Date().toISOString().split('T')[0];

        const result = await query(`
            SELECT COALESCE(total_profit_loss, 0) as loss
            FROM ai_performance_metrics
            WHERE user_id = $1 AND date = $2
        `, [userId, today]);

        return parseFloat(result.rows[0]?.loss || 0);
    } catch (error) {
        logger.error('Failed to get today loss', { error: error.message, userId });
        return 0;
    }
}

/**
 * Get Kelly Criterion inputs from ai_performance_metrics (aggregated daily data).
 * Uses last 90 days of recorded metrics. Returns null if < minTrades history.
 *
 * Trades table has no profit_loss column — we rely on the metrics table which
 * is populated by recordTradePerformance() at sell time.
 */
async function getKellyMetrics(userId, minTrades = 10) {
    try {
        const result = await query(`
            SELECT
                SUM(winning_trades)  AS wins,
                SUM(losing_trades)   AS losses,
                SUM(winning_trades + losing_trades) AS total,
                AVG(average_win)     AS avg_win,
                AVG(average_loss)    AS avg_loss
            FROM ai_performance_metrics
            WHERE user_id = $1
              AND date >= CURRENT_DATE - INTERVAL '90 days'
        `, [userId]);

        const row   = result.rows[0];
        const total = parseInt(row.total || 0);
        if (total < minTrades) return null;

        const wins    = parseInt(row.wins || 0);
        const winRate = total > 0 ? (wins / total) * 100 : 0;
        const avgWin  = parseFloat(row.avg_win  || 0);
        const avgLoss = parseFloat(row.avg_loss || 0); // stored as negative

        return { winRate, avgWin, avgLoss, totalTrades: total };
    } catch (error) {
        logger.error('Failed to get Kelly metrics', { error: error.message, userId });
        return null;
    }
}

/**
 * Get consecutive losing days from ai_performance_metrics (reading newest first).
 * A "loss day" is any day where total_profit_loss < 0.
 * Returns 0 if the most recent trading day was profitable.
 */
async function getConsecutiveLosses(userId) {
    try {
        const result = await query(`
            SELECT total_profit_loss
            FROM ai_performance_metrics
            WHERE user_id = $1
            ORDER BY date DESC
            LIMIT 20
        `, [userId]);

        let streak = 0;
        for (const row of result.rows) {
            if (parseFloat(row.total_profit_loss) < 0) {
                streak++;
            } else {
                break;
            }
        }
        return streak;
    } catch (error) {
        logger.error('Failed to get consecutive losses', { error: error.message, userId });
        return 0;
    }
}

/**
 * Get all data needed for the live performance scorecard.
 */
async function getDailyScorecardData(userId) {
    try {
        const today = new Date().toISOString().split('T')[0];

        const [daily, weekly, sharpe, streak, kelly] = await Promise.all([
            getDailyPerformance(userId, today),
            getWeeklyPerformance(userId),
            calculateSharpeRatio(userId, 30),
            getConsecutiveLosses(userId),
            getKellyMetrics(userId)
        ]);

        // Peak equity from max cumulative P&L for drawdown calculation
        const peakResult = await query(`
            SELECT MAX(running_total) AS peak
            FROM (
                SELECT SUM(total_profit_loss) OVER (ORDER BY date) AS running_total
                FROM ai_performance_metrics
                WHERE user_id = $1
            ) sub
        `, [userId]);

        const currentResult = await query(`
            SELECT COALESCE(SUM(total_profit_loss), 0) AS total
            FROM ai_performance_metrics
            WHERE user_id = $1
        `, [userId]);

        const peak   = parseFloat(peakResult.rows[0]?.peak  || 0);
        const current = parseFloat(currentResult.rows[0]?.total || 0);
        const currentDrawdownPct = peak > 0 ? ((current - peak) / peak) * 100 : 0;

        // Trades today (trade_date is the actual column name in the trades table)
        const tradesTodayResult = await query(`
            SELECT COUNT(*) AS count FROM trades
            WHERE user_id = $1 AND trade_date = $2
        `, [userId, today]);
        const tradesToday = parseInt(tradesTodayResult.rows[0]?.count || 0);

        // Win rate last 20 closed days from metrics table (no profit_loss column in trades)
        const last20Result = await query(`
            SELECT
                COUNT(*) FILTER (WHERE total_profit_loss > 0) AS wins,
                COUNT(*) AS total
            FROM (
                SELECT total_profit_loss
                FROM ai_performance_metrics
                WHERE user_id = $1
                ORDER BY date DESC LIMIT 20
            ) t
        `, [userId]);
        const l20 = last20Result.rows[0] || {};
        const winRateLast20 = parseInt(l20.total) > 0
            ? (parseInt(l20.wins) / parseInt(l20.total)) * 100 : null;

        return {
            today: {
                date:        today,
                pnl:         parseFloat(daily?.total_profit_loss || 0),
                trades:      tradesToday,
                wins:        parseInt(daily?.winning_trades || 0),
                losses:      parseInt(daily?.losing_trades  || 0)
            },
            rolling30d: {
                sharpeRatio:       sharpe,
                totalPnl:          parseFloat(weekly?.total_profit_loss || 0),
                winRateLast20Pct:  winRateLast20
            },
            risk: {
                currentDrawdownPct,
                consecutiveLosses:  streak,
                circuitBreakerActive: streak >= 5
            },
            kelly: kelly ? {
                winRate:    kelly.winRate,
                avgWin:     kelly.avgWin,
                avgLoss:    kelly.avgLoss,
                totalTrades: kelly.totalTrades
            } : null
        };
    } catch (error) {
        logger.error('Failed to get daily scorecard', { error: error.message, userId });
        return null;
    }
}

module.exports = {
    initializePerformanceTable,
    recordTradePerformance,
    updatePerformanceRatios,
    getDailyPerformance,
    getWeeklyPerformance,
    getMonthlyPerformance,
    calculateSharpeRatio,
    updateDailyLoss,
    getTodayLoss,
    getKellyMetrics,
    getConsecutiveLosses,
    getDailyScorecardData
};
