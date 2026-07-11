const { query } = require('../config/database');

let schemaReadyPromise = null;

function ensureSchema() {
    if (!schemaReadyPromise) {
        schemaReadyPromise = (async () => {
            await query(`
                CREATE TABLE IF NOT EXISTS portfolio_snapshots (
                    id BIGSERIAL PRIMARY KEY,
                    user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
                    total_portfolio_value DECIMAL(15, 2) NOT NULL,
                    total_holdings_value DECIMAL(15, 2) NOT NULL DEFAULT 0,
                    cash_balance DECIMAL(15, 2) NOT NULL DEFAULT 0,
                    total_cost_basis DECIMAL(15, 2) NOT NULL DEFAULT 0,
                    total_unrealized_pl DECIMAL(15, 2) NOT NULL DEFAULT 0,
                    total_realized_pl DECIMAL(15, 2) NOT NULL DEFAULT 0,
                    overall_pl DECIMAL(15, 2) NOT NULL DEFAULT 0,
                    captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    metadata JSONB DEFAULT '{}'::jsonb
                )
            `);
            await query(`
                CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_user_time
                ON portfolio_snapshots(user_id, captured_at DESC)
            `);
        })().catch((error) => {
            schemaReadyPromise = null;
            throw error;
        });
    }

    return schemaReadyPromise;
}

async function getLatestSnapshot(userId) {
    await ensureSchema();
    const result = await query(`
        SELECT id,
               total_portfolio_value AS "totalPortfolioValue",
               total_holdings_value AS "totalHoldingsValue",
               cash_balance AS "cashBalance",
               total_cost_basis AS "totalCostBasis",
               total_unrealized_pl AS "totalUnrealizedPL",
               total_realized_pl AS "totalRealizedPL",
               overall_pl AS "overallPL",
               captured_at AS "capturedAt"
        FROM portfolio_snapshots
        WHERE user_id = $1
        ORDER BY captured_at DESC
        LIMIT 1
    `, [userId]);

    return result.rows[0] || null;
}

async function savePortfolioSnapshot(userId, summary, options = {}) {
    await ensureSchema();

    const minIntervalMinutes = Number.isFinite(options.minIntervalMinutes)
        ? options.minIntervalMinutes
        : 15;

    const latestSnapshot = await getLatestSnapshot(userId);
    const snapshotValue = Number(summary.totalPortfolioValue || 0);
    const latestValue = latestSnapshot ? Number(latestSnapshot.totalPortfolioValue || 0) : null;
    const latestCapturedAt = latestSnapshot ? new Date(latestSnapshot.capturedAt).getTime() : null;

    if (
        latestSnapshot &&
        Number.isFinite(latestCapturedAt) &&
        (Date.now() - latestCapturedAt) < (minIntervalMinutes * 60 * 1000) &&
        latestValue === snapshotValue
    ) {
        return latestSnapshot;
    }

    const result = await query(`
        INSERT INTO portfolio_snapshots (
            user_id,
            total_portfolio_value,
            total_holdings_value,
            cash_balance,
            total_cost_basis,
            total_unrealized_pl,
            total_realized_pl,
            overall_pl,
            metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING id,
                  total_portfolio_value AS "totalPortfolioValue",
                  total_holdings_value AS "totalHoldingsValue",
                  cash_balance AS "cashBalance",
                  total_cost_basis AS "totalCostBasis",
                  total_unrealized_pl AS "totalUnrealizedPL",
                  total_realized_pl AS "totalRealizedPL",
                  overall_pl AS "overallPL",
                  captured_at AS "capturedAt"
    `, [
        userId,
        summary.totalPortfolioValue || 0,
        summary.totalHoldingsValue || 0,
        summary.cashBalance || 0,
        summary.totalCostBasis || 0,
        summary.totalUnrealizedPL || 0,
        summary.totalRealizedPL || 0,
        summary.overallPL || 0,
        JSON.stringify({ source: options.source || 'portfolio-summary' })
    ]);

    return result.rows[0] || null;
}

async function getSnapshotsInRange(userId, startDate, endDate) {
    await ensureSchema();
    const result = await query(`
        SELECT total_portfolio_value AS "totalPortfolioValue",
               total_holdings_value AS "totalHoldingsValue",
               cash_balance AS "cashBalance",
               total_cost_basis AS "totalCostBasis",
               total_unrealized_pl AS "totalUnrealizedPL",
               total_realized_pl AS "totalRealizedPL",
               overall_pl AS "overallPL",
               captured_at AS "capturedAt"
        FROM portfolio_snapshots
        WHERE user_id = $1
          AND captured_at >= $2
          AND captured_at <= $3
        ORDER BY captured_at ASC
    `, [userId, startDate, endDate]);

    return result.rows;
}

/** Nearest snapshot strictly before `date`, regardless of how large the gap is — used to
 *  give outlier detection a reference point even when there's a real multi-hour/day gap
 *  in snapshot history right before the requested range (2026-07-11). */
async function getNearestSnapshotBefore(userId, date) {
    await ensureSchema();
    const result = await query(`
        SELECT total_portfolio_value AS "totalPortfolioValue",
               captured_at AS "capturedAt"
        FROM portfolio_snapshots
        WHERE user_id = $1
          AND captured_at < $2
        ORDER BY captured_at DESC
        LIMIT 1
    `, [userId, date]);
    return result.rows[0] || null;
}

module.exports = {
    ensureSchema,
    getNearestSnapshotBefore,
    getLatestSnapshot,
    savePortfolioSnapshot,
    getSnapshotsInRange
};