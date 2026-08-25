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

        // Persist Sharpe ratio (rolling 30-day)
        const sharpe = await calculateSharpeRatio(userId, 30);
        if (sharpe !== 0) {
            await query(`
                UPDATE ai_performance_metrics
                SET sharpe_ratio = $1, updated_at = NOW()
                WHERE user_id = $2 AND date = $3
            `, [sharpe, userId, date]);
        }

        logger.info('Performance ratios updated', { userId, winRate, profitFactor, sharpe });
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
 * Get this week's total P&L (Monday–today) for the weekly loss limit circuit breaker.
 */
async function getWeeklyLoss(userId) {
    try {
        const result = await query(`
            SELECT COALESCE(SUM(total_profit_loss), 0) AS weekly_pnl
            FROM ai_performance_metrics
            WHERE user_id = $1
              AND date >= date_trunc('week', CURRENT_DATE)
        `, [userId]);
        return parseFloat(result.rows[0]?.weekly_pnl || 0);
    } catch (error) {
        logger.error('Failed to get weekly loss', { error: error.message, userId });
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
            SELECT date, total_profit_loss
            FROM ai_performance_metrics
            WHERE user_id = $1
            ORDER BY date DESC
            LIMIT 20
        `, [userId]);

        // A row here is only ever written as a side-effect of a completed trade
        // (updateDailyLoss), not a scheduled daily snapshot — there is no "flat $0 day"
        // row for a day nothing traded. That makes this streak a permanent deadlock for
        // any account that stops trading while mid-streak: the 0.5x/0x sizing penalty
        // this feeds shrinks positions below the $100 minimum notional, which stops
        // trades, which stops new rows from ever being written, which leaves the same
        // stale streak in place forever with no way to complete the trade that would
        // reset it. Confirmed live 2026-08-25: anilboddu1's most recent row was from
        // 2026-07-23 — a full month stale — and was still actively halving today's
        // position sizes to $38 on a stock that scored 100. A losing streak that old
        // is no longer a meaningful "trading badly right now" signal, so treat it as
        // expired rather than let ancient data indefinitely suppress a healthy account.
        const STALE_DAYS = 10;
        if (result.rows.length > 0) {
            const mostRecentDate = new Date(result.rows[0].date);
            const ageDays = (Date.now() - mostRecentDate.getTime()) / 86400000;
            if (ageDays > STALE_DAYS) {
                logger.info('[CircuitBreaker] Loss streak expired — most recent data is stale', {
                    userId, ageDays: Math.round(ageDays), mostRecentDate: result.rows[0].date
                });
                return 0;
            }
        }

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

/**
 * MAE/MFE analytics — retroactive computation from ohlcv_cache joined with trade pairs.
 * MAE (Max Adverse Excursion): furthest price went against entry before close.
 * MFE (Max Favorable Excursion): furthest price went in our favor before close.
 * Profit Capture: realised PnL as % of MFE — shows if targets are too ambitious.
 */
async function getMaeMfeMetrics(userId) {
    try {
        const result = await query(`
            WITH trade_pairs AS (
                SELECT DISTINCT ON (b.id)
                    b.id          AS buy_id,
                    b.symbol,
                    b.price       AS buy_price,
                    b.trade_date  AS buy_date,
                    s.price       AS sell_price,
                    s.trade_date  AS sell_date,
                    (s.price - b.price) / NULLIF(b.price, 0) * 100  AS realized_pnl_pct
                FROM trades b
                JOIN trades s
                    ON  s.symbol   = b.symbol
                    AND s.user_id  = b.user_id
                    AND s.action   = 'SELL'
                    AND s.trade_date >= b.trade_date
                WHERE b.user_id    = $1
                  AND b.action     = 'BUY'
                  AND b.executed_by LIKE 'ALPACA%'
                ORDER BY b.id, s.trade_date ASC
            ),
            excursions AS (
                SELECT
                    tp.buy_id,
                    tp.buy_price,
                    tp.sell_price,
                    tp.realized_pnl_pct,
                    MIN(oc.low)  AS lowest_low,
                    MAX(oc.high) AS highest_high
                FROM trade_pairs tp
                JOIN ohlcv_cache oc
                    ON  oc.symbol = tp.symbol
                    AND oc.date  >= tp.buy_date::date
                    AND oc.date  <= tp.sell_date::date
                GROUP BY tp.buy_id, tp.buy_price, tp.sell_price, tp.realized_pnl_pct
            )
            SELECT
                COUNT(*)                                                                AS sample_size,
                ROUND(AVG((lowest_low  - buy_price) / NULLIF(buy_price, 0) * 100)::numeric, 2)  AS avg_mae_pct,
                ROUND(AVG((highest_high - buy_price) / NULLIF(buy_price, 0) * 100)::numeric, 2) AS avg_mfe_pct,
                ROUND(AVG(
                    CASE WHEN (highest_high - buy_price) > 0
                    THEN realized_pnl_pct / ((highest_high - buy_price) / NULLIF(buy_price, 0) * 100) * 100
                    ELSE NULL END
                )::numeric, 1)                                                          AS avg_profit_capture_pct,
                ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY
                    (lowest_low - buy_price) / NULLIF(buy_price, 0) * 100
                )::numeric, 2)                                                          AS median_mae_pct,
                ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY
                    (highest_high - buy_price) / NULLIF(buy_price, 0) * 100
                )::numeric, 2)                                                          AS median_mfe_pct
            FROM excursions
            WHERE lowest_low IS NOT NULL
        `, [userId]);

        const row = result.rows[0] || {};
        const sampleSize = parseInt(row.sample_size || 0);
        if (sampleSize === 0) return { available: false, reason: 'No matched trades with OHLCV history' };

        return {
            available:            true,
            sampleSize,
            avgMaePct:            parseFloat(row.avg_mae_pct    || 0),
            avgMfePct:            parseFloat(row.avg_mfe_pct    || 0),
            medianMaePct:         parseFloat(row.median_mae_pct || 0),
            medianMfePct:         parseFloat(row.median_mfe_pct || 0),
            avgProfitCapturePct:  row.avg_profit_capture_pct != null
                                    ? parseFloat(row.avg_profit_capture_pct) : null,
        };
    } catch (error) {
        logger.error('Failed to get MAE/MFE metrics', { error: error.message, userId });
        return { available: false, reason: error.message };
    }
}

/**
 * Advanced metrics derived from the trades table:
 *   - Average hold time (hours) from BUY→SELL pairs
 *   - Time-of-day win rate breakdown (by entry hour)
 *   - Slippage stats (signal_price in notes JSON vs recorded fill price)
 *   - MAE/MFE excursion analytics
 */
async function getAdvancedMetrics(userId) {
    try {
        // ── Hold time (hours) ────────────────────────────────────────────────
        const holdResult = await query(`
            WITH buys AS (
                SELECT id, symbol, price AS buy_price, trade_date AS buy_date
                FROM trades
                WHERE user_id = $1 AND action = 'BUY'
                  AND executed_by LIKE 'ALPACA%'
            ),
            sells AS (
                SELECT symbol, price AS sell_price, trade_date AS sell_date
                FROM trades
                WHERE user_id = $1 AND action = 'SELL'
            ),
            matched AS (
                SELECT DISTINCT ON (b.id)
                    EXTRACT(EPOCH FROM (s.sell_date - b.buy_date)) / 3600 AS hold_hours,
                    (s.sell_price - b.buy_price) * 1 AS pnl_dir
                FROM buys b
                JOIN sells s ON s.symbol = b.symbol AND s.sell_date >= b.buy_date
                ORDER BY b.id, s.sell_date ASC
            )
            SELECT
                ROUND(AVG(hold_hours)::numeric, 1)                                             AS avg_hold_hours,
                ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY hold_hours)::numeric, 1)    AS median_hold_hours,
                ROUND(MIN(hold_hours)::numeric, 1)                                             AS min_hold_hours,
                ROUND(MAX(hold_hours)::numeric, 1)                                             AS max_hold_hours,
                COUNT(*)                                                                        AS sample_size
            FROM matched
            WHERE hold_hours IS NOT NULL AND hold_hours >= 0
        `, [userId]);

        // ── Time-of-day win rate ─────────────────────────────────────────────
        const todResult = await query(`
            WITH buys AS (
                SELECT id, symbol, price AS buy_price,
                       EXTRACT(HOUR FROM trade_date AT TIME ZONE 'America/New_York') AS entry_hour
                FROM trades
                WHERE user_id = $1 AND action = 'BUY'
                  AND executed_by LIKE 'ALPACA%'
            ),
            sells AS (
                SELECT symbol, price AS sell_price, trade_date AS sell_date
                FROM trades
                WHERE user_id = $1 AND action = 'SELL'
            ),
            matched AS (
                SELECT DISTINCT ON (b.id)
                    b.entry_hour,
                    CASE WHEN s.sell_price > b.buy_price THEN 1 ELSE 0 END AS win
                FROM buys b
                JOIN sells s ON s.symbol = b.symbol AND s.sell_date >= (
                    SELECT trade_date FROM trades WHERE id = b.id LIMIT 1
                )
                ORDER BY b.id, s.sell_date ASC
            )
            SELECT
                entry_hour,
                COUNT(*)                                                        AS trades,
                SUM(win)                                                        AS wins,
                ROUND((SUM(win)::decimal / NULLIF(COUNT(*), 0)) * 100, 1)      AS win_rate_pct
            FROM matched
            WHERE entry_hour IS NOT NULL
            GROUP BY entry_hour
            ORDER BY entry_hour
        `, [userId]);

        // ── Slippage ─────────────────────────────────────────────────────────
        // signal_price is stored as JSON in the notes column: {"signalPrice": 123.45, ...}
        const slippageResult = await query(`
            SELECT
                price                                                               AS fill_price,
                notes
            FROM trades
            WHERE user_id = $1
              AND action = 'BUY'
              AND executed_by LIKE 'ALPACA%'
              AND notes IS NOT NULL
              AND notes LIKE '%signalPrice%'
            ORDER BY trade_date DESC
            LIMIT 200
        `, [userId]);

        let slippageStats = { avgSlippagePct: null, maxSlippagePct: null, sampleSize: 0 };
        if (slippageResult.rows.length > 0) {
            const slippages = slippageResult.rows.map(row => {
                try {
                    const meta = JSON.parse(row.notes);
                    const sig  = parseFloat(meta.signalPrice);
                    const fill = parseFloat(row.fill_price);
                    if (!sig || !fill || sig <= 0) return null;
                    return ((fill - sig) / sig) * 100;
                } catch { return null; }
            }).filter(s => s !== null);

            if (slippages.length > 0) {
                slippageStats = {
                    avgSlippagePct:  parseFloat((slippages.reduce((a, b) => a + b, 0) / slippages.length).toFixed(4)),
                    maxSlippagePct:  parseFloat(Math.max(...slippages).toFixed(4)),
                    minSlippagePct:  parseFloat(Math.min(...slippages).toFixed(4)),
                    sampleSize:      slippages.length,
                };
            }
        }

        const [hold, maeMfe] = [holdResult.rows[0] || {}, await getMaeMfeMetrics(userId)];
        return {
            holdTime: {
                avgHours:    parseFloat(hold.avg_hold_hours    || 0),
                medianHours: parseFloat(hold.median_hold_hours || 0),
                minHours:    parseFloat(hold.min_hold_hours    || 0),
                maxHours:    parseFloat(hold.max_hold_hours    || 0),
                sampleSize:  parseInt(hold.sample_size         || 0),
            },
            timeOfDay: todResult.rows.map(r => ({
                hour:       parseInt(r.entry_hour),
                trades:     parseInt(r.trades),
                wins:       parseInt(r.wins),
                winRatePct: parseFloat(r.win_rate_pct),
            })),
            slippage: slippageStats,
            maeMfe,
        };
    } catch (error) {
        logger.error('Failed to get advanced metrics', { error: error.message, userId });
        return { holdTime: null, timeOfDay: [], slippage: null, maeMfe: { available: false } };
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
    getWeeklyLoss,
    getKellyMetrics,
    getConsecutiveLosses,
    getDailyScorecardData,
    getAdvancedMetrics,
    getMaeMfeMetrics,
};
