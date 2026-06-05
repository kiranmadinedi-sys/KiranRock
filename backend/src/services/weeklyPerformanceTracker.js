/**
 * Weekly Predictions Performance Tracking
 * Tracks accuracy of predictions week-over-week
 */

const { pool } = require('../config/database');

/**
 * Save weekly predictions for performance tracking
 */
async function saveWeeklyPredictions(predictions) {
    const client = await pool.connect();
    
    try {
        const weekStart = new Date();
        weekStart.setHours(0, 0, 0, 0);
        
        for (const pred of predictions) {
            await client.query(
                `INSERT INTO weekly_prediction_history 
                (symbol, week_start, predicted_signal, predicted_move, confidence, 
                 total_score, target_price, current_price, rationale)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (symbol, week_start) 
                DO UPDATE SET
                    predicted_signal = $3,
                    predicted_move = $4,
                    confidence = $5,
                    total_score = $6,
                    target_price = $7,
                    current_price = $8,
                    rationale = $9,
                    updated_at = CURRENT_TIMESTAMP`,
                [
                    pred.symbol,
                    weekStart,
                    pred.prediction.signal,
                    parseFloat(pred.prediction.expectedMove),
                    pred.prediction.confidence,
                    pred.totalScore,
                    parseFloat(pred.prediction.targetPrice),
                    parseFloat(pred.currentPrice),
                    pred.rationale
                ]
            );
        }
        
        console.log(`[Performance Tracker] Saved ${predictions.length} predictions for week ${weekStart.toISOString()}`);
        
    } catch (error) {
        console.error('[Performance Tracker] Error saving predictions:', error);
    } finally {
        client.release();
    }
}

/**
 * Update actual results for last week's predictions
 */
async function updateActualResults() {
    const client = await pool.connect();
    
    try {
        const lastWeek = new Date();
        lastWeek.setDate(lastWeek.getDate() - 7);
        lastWeek.setHours(0, 0, 0, 0);
        
        // Get predictions that need updating
        const result = await client.query(
            `SELECT symbol, predicted_move, target_price, current_price
             FROM weekly_prediction_history
             WHERE week_start = $1 AND actual_move IS NULL`,
            [lastWeek]
        );
        
        console.log(`[Performance Tracker] Updating ${result.rows.length} predictions from last week`);
        
        const stockDataService = require('./stockDataService');
        
        for (const row of result.rows) {
            try {
                // Get current price
                const prices = await stockDataService.getStockData(row.symbol, '1d');
                if (prices.length === 0) continue;
                
                const currentPrice = prices[prices.length - 1].close;
                const startPrice = parseFloat(row.current_price);
                const actualMove = ((currentPrice - startPrice) / startPrice) * 100;
                const targetHit = actualMove >= parseFloat(row.predicted_move) * 0.8; // 80% of target
                
                await client.query(
                    `UPDATE weekly_prediction_history
                     SET actual_move = $1,
                         actual_price = $2,
                         target_hit = $3,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE symbol = $4 AND week_start = $5`,
                    [actualMove, currentPrice, targetHit, row.symbol, lastWeek]
                );
                
            } catch (error) {
                console.error(`[Performance Tracker] Error updating ${row.symbol}:`, error.message);
            }
        }
        
        console.log('[Performance Tracker] Update complete');
        
    } catch (error) {
        console.error('[Performance Tracker] Error updating results:', error);
    } finally {
        client.release();
    }
}

/**
 * Get performance stats for last N weeks
 */
async function getPerformanceStats(weeksBack = 4) {
    const client = await pool.connect();
    
    try {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - (weeksBack * 7));
        
        const result = await client.query(
            `SELECT 
                COUNT(*) as total_predictions,
                COUNT(CASE WHEN target_hit = true THEN 1 END) as hits,
                COUNT(CASE WHEN target_hit = false THEN 1 END) as misses,
                AVG(actual_move) as avg_actual_move,
                AVG(predicted_move) as avg_predicted_move,
                AVG(confidence) as avg_confidence,
                AVG(CASE WHEN target_hit = true THEN actual_move ELSE 0 END) as avg_hit_return,
                AVG(CASE WHEN target_hit = false THEN actual_move ELSE 0 END) as avg_miss_return
             FROM weekly_prediction_history
             WHERE week_start >= $1 AND actual_move IS NOT NULL`,
            [startDate]
        );
        
        const row = result.rows[0];
        const hitRate = row.total_predictions > 0 
            ? (parseInt(row.hits) / parseInt(row.total_predictions)) * 100 
            : 0;
        
        // Get tier-specific performance
        const tierStats = await client.query(
            `SELECT 
                CASE 
                    WHEN total_score >= 80 THEN 'A'
                    WHEN total_score >= 70 THEN 'B'
                    WHEN total_score >= 60 THEN 'C'
                    ELSE 'D'
                END as tier,
                COUNT(*) as count,
                COUNT(CASE WHEN target_hit = true THEN 1 END) as hits,
                AVG(actual_move) as avg_return
             FROM weekly_prediction_history
             WHERE week_start >= $1 AND actual_move IS NOT NULL
             GROUP BY tier
             ORDER BY tier`,
            [startDate]
        );
        
        return {
            totalPredictions: parseInt(row.total_predictions),
            hits: parseInt(row.hits),
            misses: parseInt(row.misses),
            hitRate: hitRate.toFixed(1),
            avgActualMove: parseFloat(row.avg_actual_move || 0).toFixed(2),
            avgPredictedMove: parseFloat(row.avg_predicted_move || 0).toFixed(2),
            avgConfidence: parseFloat(row.avg_confidence || 0).toFixed(0),
            avgHitReturn: parseFloat(row.avg_hit_return || 0).toFixed(2),
            avgMissReturn: parseFloat(row.avg_miss_return || 0).toFixed(2),
            tierPerformance: tierStats.rows.map(t => ({
                tier: t.tier,
                count: parseInt(t.count),
                hits: parseInt(t.hits),
                hitRate: ((parseInt(t.hits) / parseInt(t.count)) * 100).toFixed(1),
                avgReturn: parseFloat(t.avg_return || 0).toFixed(2)
            })),
            weeksTracked: weeksBack
        };
        
    } catch (error) {
        console.error('[Performance Tracker] Error getting stats:', error);
        return null;
    } finally {
        client.release();
    }
}

/**
 * Get recent prediction outcomes
 */
async function getRecentOutcomes(limit = 10) {
    const client = await pool.connect();
    
    try {
        const result = await client.query(
            `SELECT symbol, predicted_signal, predicted_move, actual_move, 
                    confidence, target_hit, week_start
             FROM weekly_prediction_history
             WHERE actual_move IS NOT NULL
             ORDER BY week_start DESC, ABS(actual_move) DESC
             LIMIT $1`,
            [limit]
        );
        
        return result.rows.map(row => ({
            symbol: row.symbol,
            predictedSignal: row.predicted_signal,
            predictedMove: parseFloat(row.predicted_move).toFixed(2),
            actualMove: parseFloat(row.actual_move).toFixed(2),
            confidence: row.confidence,
            targetHit: row.target_hit,
            weekStart: row.week_start
        }));
        
    } catch (error) {
        console.error('[Performance Tracker] Error getting recent outcomes:', error);
        return [];
    } finally {
        client.release();
    }
}

module.exports = {
    saveWeeklyPredictions,
    updateActualResults,
    getPerformanceStats,
    getRecentOutcomes
};
