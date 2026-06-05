const { query } = require('../config/database');

const DEFAULT_GLOBAL_CONTROLS = {
    globalTradingEnabled: true,
    killSwitchReason: null,
    updatedAt: null
};

const RISK_CONFIG_FIELD_MAP = {
    maxPositionSize: 'max_position_size',
    minPositionSize: 'min_position_size',
    maxPortfolioRisk: 'max_portfolio_risk',
    minBuyScore: 'min_buy_score',
    stopLoss: 'stop_loss',
    trailingStopPercent: 'trailing_stop_percent',
    takeProfitPercent: 'take_profit_percent',
    partialTakeProfitPercent: 'partial_take_profit_percent',
    maxOpenPositions: 'max_open_positions',
    minMarketCap: 'min_market_cap',
    maxDailyTrades: 'max_daily_trades',
    maxVix: 'max_vix',
    reducePositionsVix: 'reduce_positions_vix',
    maxSectorAllocation: 'max_sector_allocation',
    dailyLossLimit: 'daily_loss_limit',
    maxOrderNotional: 'max_order_notional',
    maxGrossExposurePct: 'max_gross_exposure_pct',
    emergencyStopEnabled: 'emergency_stop_enabled'
};

let ensureSchemaPromise = null;

function normalizeRiskValue(key, value) {
    if (value === undefined) {
        return undefined;
    }

    if (key === 'emergencyStopEnabled') {
        return value === true || value === 'true';
    }

    if (key === 'minBuyScore' || key === 'maxOpenPositions' || key === 'maxDailyTrades') {
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    if (key === 'minMarketCap') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
    }

    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed)) {
        return undefined;
    }

    if (key === 'dailyLossLimit') {
        return parsed > 0 ? -Math.abs(parsed) : parsed;
    }

    return parsed;
}

function mapRiskConfigRow(row) {
    if (!row) {
        return null;
    }

    return {
        maxPositionSize: parseFloat(row.max_position_size),
        minPositionSize: parseFloat(row.min_position_size),
        maxPortfolioRisk: parseFloat(row.max_portfolio_risk),
        minBuyScore: row.min_buy_score,
        stopLoss: parseFloat(row.stop_loss),
        trailingStopPercent: parseFloat(row.trailing_stop_percent),
        takeProfitPercent: parseFloat(row.take_profit_percent),
        partialTakeProfitPercent: parseFloat(row.partial_take_profit_percent),
        maxOpenPositions: row.max_open_positions,
        minMarketCap: Number(row.min_market_cap),
        maxDailyTrades: row.max_daily_trades,
        maxVix: parseFloat(row.max_vix),
        reducePositionsVix: parseFloat(row.reduce_positions_vix),
        maxSectorAllocation: parseFloat(row.max_sector_allocation),
        dailyLossLimit: parseFloat(row.daily_loss_limit),
        maxOrderNotional: parseFloat(row.max_order_notional),
        maxGrossExposurePct: parseFloat(row.max_gross_exposure_pct ?? 0.75),
        emergencyStopEnabled: row.emergency_stop_enabled === true
    };
}

async function ensurePhase0Schema() {
    if (!ensureSchemaPromise) {
        ensureSchemaPromise = (async () => {
            await query(`
                CREATE TABLE IF NOT EXISTS system_controls (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    global_trading_enabled BOOLEAN NOT NULL DEFAULT true,
                    kill_switch_reason TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            await query(`
                INSERT INTO system_controls (id, global_trading_enabled)
                VALUES (1, true)
                ON CONFLICT (id) DO NOTHING
            `);

            await query(`
                ALTER TABLE risk_configs
                ADD COLUMN IF NOT EXISTS daily_loss_limit DECIMAL(12, 2) DEFAULT -1000
            `);

            await query(`
                ALTER TABLE risk_configs
                ADD COLUMN IF NOT EXISTS max_order_notional DECIMAL(12, 2) DEFAULT 5000
            `);

            await query(`
                ALTER TABLE risk_configs
                ADD COLUMN IF NOT EXISTS emergency_stop_enabled BOOLEAN DEFAULT false
            `);
        })().catch((error) => {
            ensureSchemaPromise = null;
            throw error;
        });
    }

    return ensureSchemaPromise;
}

async function getGlobalTradingControl() {
    await ensurePhase0Schema();

    const result = await query(`
        SELECT global_trading_enabled, kill_switch_reason, updated_at
        FROM system_controls
        WHERE id = 1
    `);

    if (!result.rows[0]) {
        return DEFAULT_GLOBAL_CONTROLS;
    }

    return {
        globalTradingEnabled: result.rows[0].global_trading_enabled === true,
        killSwitchReason: result.rows[0].kill_switch_reason,
        updatedAt: result.rows[0].updated_at
    };
}

async function getUserTradingControls(userId) {
    await ensurePhase0Schema();

    const result = await query(`
        SELECT
            u.id,
            u.ai_trading_enabled,
            COALESCE(rc.emergency_stop_enabled, false) AS emergency_stop_enabled,
            COALESCE(rc.daily_loss_limit, -1000) AS daily_loss_limit,
            COALESCE(rc.max_order_notional, 5000) AS max_order_notional
        FROM users u
        LEFT JOIN risk_configs rc ON rc.user_id = u.id
        WHERE u.id = $1
    `, [userId]);

    if (!result.rows[0]) {
        throw new Error('User not found');
    }

    const row = result.rows[0];
    return {
        userId: row.id,
        aiTradingEnabled: row.ai_trading_enabled === true,
        emergencyStopEnabled: row.emergency_stop_enabled === true,
        dailyLossLimit: parseFloat(row.daily_loss_limit),
        maxOrderNotional: parseFloat(row.max_order_notional)
    };
}

async function upsertRiskConfig(userId, updates) {
    await ensurePhase0Schema();

    const normalizedEntries = Object.entries(RISK_CONFIG_FIELD_MAP)
        .map(([apiField, dbField]) => [dbField, normalizeRiskValue(apiField, updates[apiField])])
        .filter(([, value]) => value !== undefined);

    if (normalizedEntries.length === 0) {
        const current = await query('SELECT * FROM risk_configs WHERE user_id = $1', [userId]);
        return mapRiskConfigRow(current.rows[0]);
    }

    const columns = ['user_id', ...normalizedEntries.map(([dbField]) => dbField)];
    const values = [userId, ...normalizedEntries.map(([, value]) => value)];
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    const updateAssignments = normalizedEntries
        .map(([dbField]) => `${dbField} = EXCLUDED.${dbField}`)
        .join(', ');

    const result = await query(`
        INSERT INTO risk_configs (${columns.join(', ')})
        VALUES (${placeholders.join(', ')})
        ON CONFLICT (user_id) DO UPDATE SET ${updateAssignments}
        RETURNING *
    `, values);

    return mapRiskConfigRow(result.rows[0]);
}

async function getRecentTradingLogs(userId, limit = 50) {
    const parsedLimit = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
    const result = await query(`
        SELECT id, timestamp, success, trades_executed, capital_deployed, opportunities_found, message, trades_detail
        FROM ai_trading_logs
        WHERE user_id = $1
        ORDER BY timestamp DESC
        LIMIT $2
    `, [userId, parsedLimit]);

    return result.rows;
}

module.exports = {
    ensurePhase0Schema,
    getGlobalTradingControl,
    getUserTradingControls,
    upsertRiskConfig,
    getRecentTradingLogs,
    mapRiskConfigRow
};