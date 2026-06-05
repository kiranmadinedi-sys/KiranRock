const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const LOOKBACK_DAYS = 180;
const MIN_SAMPLE_SIZE = 5;

async function ensureTradeIntelligenceSchema() {
    await query(`
        CREATE TABLE IF NOT EXISTS trade_decision_journal (
            id BIGSERIAL PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            bot_type VARCHAR(20) NOT NULL,
            symbol VARCHAR(20) NOT NULL,
            setup_family VARCHAR(80),
            strategy_family VARCHAR(80),
            regime VARCHAR(20),
            decision_phase VARCHAR(20) NOT NULL,
            score DECIMAL(8, 2),
            score_adjustment DECIMAL(8, 2) DEFAULT 0,
            size_multiplier DECIMAL(8, 4) DEFAULT 1,
            expectancy DECIMAL(10, 4),
            confidence DECIMAL(8, 4),
            entry_price DECIMAL(12, 4),
            exit_price DECIMAL(12, 4),
            pnl DECIMAL(12, 2),
            pnl_percent DECIMAL(8, 2),
            trade_ref_type VARCHAR(30),
            trade_ref_id VARCHAR(100),
            metadata JSONB DEFAULT '{}'::jsonb,
            opened_at TIMESTAMP DEFAULT NOW(),
            closed_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            CHECK (bot_type IN ('stock', 'options')),
            CHECK (decision_phase IN ('CANDIDATE', 'EXECUTED', 'CLOSED'))
        );

        CREATE INDEX IF NOT EXISTS idx_trade_decision_journal_user_created
        ON trade_decision_journal(user_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_trade_decision_journal_lookup
        ON trade_decision_journal(bot_type, strategy_family, setup_family, regime, decision_phase);

        CREATE INDEX IF NOT EXISTS idx_trade_decision_journal_ref
        ON trade_decision_journal(trade_ref_type, trade_ref_id);

        CREATE INDEX IF NOT EXISTS idx_trade_decision_journal_symbol_open
        ON trade_decision_journal(user_id, bot_type, symbol, decision_phase, opened_at DESC);
    `);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function normalizeNumber(value, fallback = null) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeBotTypeFilter(value) {
    if (!value) return null;
    const normalized = String(value).trim().toLowerCase();
    return ['stock', 'options'].includes(normalized) ? normalized : null;
}

function normalizeTextFilter(value) {
    if (!value) return null;
    const normalized = String(value).trim();
    return normalized ? normalized : null;
}

function buildJournalWhereClause({ timestampColumn, botTypeIndex, regimeIndex, closedOnly = false }) {
    const clauses = [
        'user_id = $1',
        `${timestampColumn} >= NOW() - ($2 * INTERVAL '1 day')`
    ];

    if (closedOnly) {
        clauses.push("decision_phase = 'CLOSED'");
    }

    if (botTypeIndex) {
        clauses.push(`bot_type = $${botTypeIndex}`);
    }

    if (regimeIndex) {
        clauses.push(`regime = $${regimeIndex}`);
    }

    return clauses.join('\n               AND ');
}

function buildAdjustment(stats) {
    const sampleSize = Number(stats?.sample_size || 0);
    const winRate = normalizeNumber(stats?.win_rate, 0);
    const avgReturn = normalizeNumber(stats?.avg_return, 0);
    const expectancy = normalizeNumber(stats?.expectancy, avgReturn);

    if (sampleSize < MIN_SAMPLE_SIZE) {
        return {
            sampleSize,
            winRate,
            avgReturn,
            expectancy,
            confidence: 0,
            scoreAdjustment: 0,
            sizeMultiplier: 1,
            source: 'insufficient-data'
        };
    }

    const confidence = clamp(sampleSize / 20, 0, 1);
    const edge = clamp((avgReturn / 12) + ((winRate - 50) / 25), -1.5, 1.5);
    const weightedEdge = edge * confidence;

    return {
        sampleSize,
        winRate,
        avgReturn,
        expectancy,
        confidence: Number(confidence.toFixed(2)),
        scoreAdjustment: Number(clamp(weightedEdge * 4, -6, 6).toFixed(2)),
        sizeMultiplier: Number(clamp(1 + (weightedEdge * 0.12), 0.7, 1.25).toFixed(3)),
        source: 'journal'
    };
}

async function fetchExpectancyStats({ botType, strategyFamily, setupFamily, regime }) {
    const exact = await query(
        `SELECT
            COUNT(*)::int AS sample_size,
            AVG(CASE WHEN pnl > 0 THEN 100.0 ELSE 0 END) AS win_rate,
            AVG(COALESCE(pnl_percent, 0)) AS avg_return,
            AVG(COALESCE(pnl_percent, 0)) AS expectancy
         FROM trade_decision_journal
         WHERE bot_type = $1
           AND decision_phase = 'CLOSED'
           AND strategy_family = $2
           AND setup_family = $3
           AND regime = $4
           AND closed_at >= NOW() - ($5 * INTERVAL '1 day')`,
        [botType, strategyFamily, setupFamily, regime, LOOKBACK_DAYS]
    );

    if (Number(exact.rows[0]?.sample_size || 0) >= MIN_SAMPLE_SIZE) {
        return { stats: exact.rows[0], source: 'exact' };
    }

    const fallback = await query(
        `SELECT
            COUNT(*)::int AS sample_size,
            AVG(CASE WHEN pnl > 0 THEN 100.0 ELSE 0 END) AS win_rate,
            AVG(COALESCE(pnl_percent, 0)) AS avg_return,
            AVG(COALESCE(pnl_percent, 0)) AS expectancy
         FROM trade_decision_journal
         WHERE bot_type = $1
           AND decision_phase = 'CLOSED'
           AND strategy_family = $2
           AND closed_at >= NOW() - ($3 * INTERVAL '1 day')`,
        [botType, strategyFamily, LOOKBACK_DAYS]
    );

    return { stats: fallback.rows[0], source: 'strategy-fallback' };
}

async function getExpectancyAdjustment(context) {
    try {
        await ensureTradeIntelligenceSchema();
        const { botType, strategyFamily, setupFamily, regime } = context;
        const { stats, source } = await fetchExpectancyStats({ botType, strategyFamily, setupFamily, regime });
        return {
            ...buildAdjustment(stats),
            lookupSource: source
        };
    } catch (error) {
        logger.error('[TradeIntelligence] Failed to compute expectancy adjustment', {
            error: error.message,
            context
        });
        return {
            sampleSize: 0,
            winRate: 0,
            avgReturn: 0,
            expectancy: 0,
            confidence: 0,
            scoreAdjustment: 0,
            sizeMultiplier: 1,
            source: 'error'
        };
    }
}

async function recordCandidate(userId, candidate) {
    try {
        await ensureTradeIntelligenceSchema();
        await query(
            `INSERT INTO trade_decision_journal (
                user_id, bot_type, symbol, setup_family, strategy_family, regime,
                decision_phase, score, score_adjustment, size_multiplier, expectancy,
                confidence, metadata
             ) VALUES (
                $1, $2, $3, $4, $5, $6,
                'CANDIDATE', $7, $8, $9, $10,
                $11, $12::jsonb
             )`,
            [
                userId,
                candidate.botType,
                candidate.symbol,
                candidate.setupFamily || null,
                candidate.strategyFamily || null,
                candidate.regime || null,
                normalizeNumber(candidate.score),
                normalizeNumber(candidate.scoreAdjustment, 0),
                normalizeNumber(candidate.sizeMultiplier, 1),
                normalizeNumber(candidate.expectancy),
                normalizeNumber(candidate.confidence),
                JSON.stringify(candidate.metadata || {})
            ]
        );
    } catch (error) {
        logger.error('[TradeIntelligence] Failed to record candidate', {
            userId,
            symbol: candidate.symbol,
            error: error.message
        });
    }
}

async function recordExecution(userId, execution) {
    try {
        await ensureTradeIntelligenceSchema();
        await query(
            `INSERT INTO trade_decision_journal (
                user_id, bot_type, symbol, setup_family, strategy_family, regime,
                decision_phase, score, score_adjustment, size_multiplier, expectancy,
                confidence, entry_price, trade_ref_type, trade_ref_id, metadata
             ) VALUES (
                $1, $2, $3, $4, $5, $6,
                'EXECUTED', $7, $8, $9, $10,
                $11, $12, $13, $14, $15::jsonb
             )`,
            [
                userId,
                execution.botType,
                execution.symbol,
                execution.setupFamily || null,
                execution.strategyFamily || null,
                execution.regime || null,
                normalizeNumber(execution.score),
                normalizeNumber(execution.scoreAdjustment, 0),
                normalizeNumber(execution.sizeMultiplier, 1),
                normalizeNumber(execution.expectancy),
                normalizeNumber(execution.confidence),
                normalizeNumber(execution.entryPrice),
                execution.tradeRefType || null,
                execution.tradeRefId ? String(execution.tradeRefId) : null,
                JSON.stringify(execution.metadata || {})
            ]
        );
    } catch (error) {
        logger.error('[TradeIntelligence] Failed to record execution', {
            userId,
            symbol: execution.symbol,
            error: error.message
        });
    }
}

async function closeExecutionByRef(userId, closure) {
    try {
        await ensureTradeIntelligenceSchema();
        await query(
            `UPDATE trade_decision_journal
             SET decision_phase = 'CLOSED',
                 exit_price = $1,
                 pnl = $2,
                 pnl_percent = $3,
                 closed_at = NOW(),
                 updated_at = NOW(),
                 metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
             WHERE user_id = $5
               AND trade_ref_type = $6
               AND trade_ref_id = $7
               AND decision_phase = 'EXECUTED'`,
            [
                normalizeNumber(closure.exitPrice),
                normalizeNumber(closure.pnl),
                normalizeNumber(closure.pnlPercent),
                JSON.stringify(closure.metadata || {}),
                userId,
                closure.tradeRefType,
                String(closure.tradeRefId)
            ]
        );
    } catch (error) {
        logger.error('[TradeIntelligence] Failed to close execution by ref', {
            userId,
            error: error.message,
            closure
        });
    }
}

async function closeLatestOpenExecution(userId, closure) {
    try {
        await ensureTradeIntelligenceSchema();
        await query(
            `WITH target AS (
                SELECT id
                FROM trade_decision_journal
                WHERE user_id = $1
                  AND bot_type = $2
                  AND symbol = $3
                  AND decision_phase = 'EXECUTED'
                ORDER BY opened_at DESC, id DESC
                LIMIT 1
             )
             UPDATE trade_decision_journal journal
             SET decision_phase = 'CLOSED',
                 exit_price = $4,
                 pnl = $5,
                 pnl_percent = $6,
                 closed_at = NOW(),
                 updated_at = NOW(),
                 metadata = COALESCE(journal.metadata, '{}'::jsonb) || $7::jsonb
             FROM target
             WHERE journal.id = target.id`,
            [
                userId,
                closure.botType,
                closure.symbol,
                normalizeNumber(closure.exitPrice),
                normalizeNumber(closure.pnl),
                normalizeNumber(closure.pnlPercent),
                JSON.stringify(closure.metadata || {})
            ]
        );
    } catch (error) {
        logger.error('[TradeIntelligence] Failed to close latest execution', {
            userId,
            error: error.message,
            closure
        });
    }
}

async function getTradeIntelligenceSummary(userId, options = {}) {
    const lookbackDays = Math.max(7, Math.min(Number(options.days) || LOOKBACK_DAYS, 365));
    const comparisonWindowDays = Math.max(7, Math.min(Number(options.compareDays) || Math.min(45, Math.max(14, Math.floor(lookbackDays / 2))), 90));
    const botType = normalizeBotTypeFilter(options.botType);
    const regime = normalizeTextFilter(options.regime);
    await ensureTradeIntelligenceSchema();

    const summaryParams = [userId, lookbackDays];
    const botTypeIndex = botType ? summaryParams.push(botType) : null;
    const regimeIndex = regime ? summaryParams.push(regime) : null;

    const createdWhere = buildJournalWhereClause({
        timestampColumn: 'created_at',
        botTypeIndex,
        regimeIndex
    });
    const closedWhere = buildJournalWhereClause({
        timestampColumn: 'closed_at',
        botTypeIndex,
        regimeIndex,
        closedOnly: true
    });

    const regimeOptionsParams = [userId, lookbackDays];
    const regimeOptionsBotTypeIndex = botType ? regimeOptionsParams.push(botType) : null;
    const regimeOptionsWhere = buildJournalWhereClause({
        timestampColumn: 'closed_at',
        botTypeIndex: regimeOptionsBotTypeIndex,
        regimeIndex: null,
        closedOnly: true
    });

    const edgeParams = [userId, comparisonWindowDays, comparisonWindowDays * 2];
    const edgeBotTypeIndex = botType ? edgeParams.push(botType) : null;
    const edgeRegimeIndex = regime ? edgeParams.push(regime) : null;
    const edgeClauses = [
        'user_id = $1',
        "decision_phase = 'CLOSED'",
        'closed_at >= NOW() - ($3 * INTERVAL \'1 day\')'
    ];
    if (edgeBotTypeIndex) {
        edgeClauses.push(`bot_type = $${edgeBotTypeIndex}`);
    }
    if (edgeRegimeIndex) {
        edgeClauses.push(`regime = $${edgeRegimeIndex}`);
    }
    const edgeWhere = edgeClauses.join('\n               AND ');

    const [
        overviewResult,
        botBreakdownResult,
        setupPerformanceResult,
        strategyPerformanceResult,
        regimePerformanceResult,
        recentClosuresResult,
        availableRegimesResult,
        currentEdgeResult
    ] = await Promise.all([
        query(
            `SELECT
                COUNT(*) FILTER (WHERE decision_phase = 'CANDIDATE')::int AS candidate_count,
                COUNT(*) FILTER (WHERE decision_phase = 'EXECUTED')::int AS executed_count,
                COUNT(*) FILTER (WHERE decision_phase = 'CLOSED')::int AS closed_count,
                ROUND(AVG(CASE WHEN decision_phase = 'CLOSED' AND pnl > 0 THEN 100.0 ELSE 0 END), 2) AS closed_win_rate,
                ROUND(AVG(CASE WHEN decision_phase = 'CLOSED' THEN pnl_percent END), 2) AS avg_closed_return,
                ROUND(AVG(CASE WHEN decision_phase = 'CLOSED' THEN expectancy END), 2) AS avg_expectancy,
                ROUND(AVG(CASE WHEN decision_phase IN ('CANDIDATE', 'EXECUTED') THEN score_adjustment END), 2) AS avg_score_adjustment,
                ROUND(AVG(CASE WHEN decision_phase IN ('CANDIDATE', 'EXECUTED') THEN size_multiplier END), 3) AS avg_size_multiplier,
                ROUND(SUM(CASE WHEN decision_phase = 'CLOSED' THEN pnl ELSE 0 END), 2) AS total_closed_pnl
             FROM trade_decision_journal
             WHERE ${createdWhere}`,
            summaryParams
        ),
        query(
            `SELECT
                bot_type AS "botType",
                COUNT(*) FILTER (WHERE decision_phase = 'CLOSED')::int AS "closedCount",
                ROUND(AVG(CASE WHEN decision_phase = 'CLOSED' AND pnl > 0 THEN 100.0 ELSE 0 END), 2) AS "winRate",
                ROUND(AVG(CASE WHEN decision_phase = 'CLOSED' THEN pnl_percent END), 2) AS "avgReturn",
                ROUND(SUM(CASE WHEN decision_phase = 'CLOSED' THEN pnl ELSE 0 END), 2) AS "totalPnl"
             FROM trade_decision_journal
                         WHERE ${createdWhere}
             GROUP BY bot_type
             ORDER BY bot_type ASC`,
                        summaryParams
        ),
        query(
            `SELECT
                bot_type AS "botType",
                strategy_family AS "strategyFamily",
                setup_family AS "setupFamily",
                regime,
                COUNT(*)::int AS trades,
                ROUND(AVG(CASE WHEN pnl > 0 THEN 100.0 ELSE 0 END), 2) AS "winRate",
                ROUND(AVG(pnl_percent), 2) AS "avgReturn",
                ROUND(AVG(expectancy), 2) AS expectancy,
                ROUND(SUM(COALESCE(pnl, 0)), 2) AS "totalPnl",
                ROUND(AVG(score_adjustment), 2) AS "avgScoreAdjustment",
                ROUND(AVG(size_multiplier), 3) AS "avgSizeMultiplier",
                MAX(closed_at) AS "lastClosedAt"
             FROM trade_decision_journal
                         WHERE ${closedWhere}
               AND strategy_family IS NOT NULL
               AND setup_family IS NOT NULL
             GROUP BY bot_type, strategy_family, setup_family, regime
             HAVING COUNT(*) >= 1
             ORDER BY expectancy DESC NULLS LAST, "winRate" DESC NULLS LAST, trades DESC
             LIMIT 12`,
                        summaryParams
        ),
        query(
            `SELECT
                bot_type AS "botType",
                strategy_family AS "strategyFamily",
                COUNT(*)::int AS trades,
                ROUND(AVG(CASE WHEN pnl > 0 THEN 100.0 ELSE 0 END), 2) AS "winRate",
                ROUND(AVG(pnl_percent), 2) AS "avgReturn",
                ROUND(AVG(expectancy), 2) AS expectancy,
                ROUND(SUM(COALESCE(pnl, 0)), 2) AS "totalPnl",
                ROUND(AVG(score_adjustment), 2) AS "avgScoreAdjustment",
                ROUND(AVG(size_multiplier), 3) AS "avgSizeMultiplier"
             FROM trade_decision_journal
                         WHERE ${closedWhere}
               AND strategy_family IS NOT NULL
             GROUP BY bot_type, strategy_family
             ORDER BY expectancy DESC NULLS LAST, trades DESC`,
                        summaryParams
        ),
        query(
            `SELECT
                regime,
                COUNT(*)::int AS trades,
                ROUND(AVG(CASE WHEN pnl > 0 THEN 100.0 ELSE 0 END), 2) AS "winRate",
                ROUND(AVG(pnl_percent), 2) AS "avgReturn",
                ROUND(SUM(COALESCE(pnl, 0)), 2) AS "totalPnl",
                ROUND(AVG(score_adjustment), 2) AS "avgScoreAdjustment",
                ROUND(AVG(size_multiplier), 3) AS "avgSizeMultiplier"
             FROM trade_decision_journal
                         WHERE ${closedWhere}
               AND regime IS NOT NULL
             GROUP BY regime
             ORDER BY trades DESC, regime ASC`,
                        summaryParams
        ),
        query(
            `SELECT
                bot_type AS "botType",
                symbol,
                strategy_family AS "strategyFamily",
                setup_family AS "setupFamily",
                regime,
                ROUND(pnl, 2) AS pnl,
                ROUND(pnl_percent, 2) AS "pnlPercent",
                ROUND(score, 2) AS score,
                ROUND(score_adjustment, 2) AS "scoreAdjustment",
                ROUND(size_multiplier, 3) AS "sizeMultiplier",
                closed_at AS "closedAt",
                metadata
             FROM trade_decision_journal
             WHERE ${closedWhere}
             ORDER BY closed_at DESC
             LIMIT 10`,
            summaryParams
        ),
        query(
            `SELECT DISTINCT regime
             FROM trade_decision_journal
             WHERE ${regimeOptionsWhere}
               AND regime IS NOT NULL
             ORDER BY regime ASC`,
            regimeOptionsParams
        ),
        query(
            `WITH setup_windows AS (
                SELECT
                    bot_type AS "botType",
                    strategy_family AS "strategyFamily",
                    setup_family AS "setupFamily",
                    regime,
                    COUNT(*) FILTER (
                        WHERE closed_at >= NOW() - ($2 * INTERVAL '1 day')
                    )::int AS "recentTrades",
                    COUNT(*) FILTER (
                        WHERE closed_at < NOW() - ($2 * INTERVAL '1 day')
                          AND closed_at >= NOW() - ($3 * INTERVAL '1 day')
                    )::int AS "priorTrades",
                    ROUND(AVG(CASE WHEN pnl > 0 THEN 100.0 ELSE 0 END) FILTER (
                        WHERE closed_at >= NOW() - ($2 * INTERVAL '1 day')
                    ), 2) AS "recentWinRate",
                    ROUND(AVG(CASE WHEN pnl > 0 THEN 100.0 ELSE 0 END) FILTER (
                        WHERE closed_at < NOW() - ($2 * INTERVAL '1 day')
                          AND closed_at >= NOW() - ($3 * INTERVAL '1 day')
                    ), 2) AS "priorWinRate",
                    ROUND(AVG(pnl_percent) FILTER (
                        WHERE closed_at >= NOW() - ($2 * INTERVAL '1 day')
                    ), 2) AS "recentAvgReturn",
                    ROUND(AVG(pnl_percent) FILTER (
                        WHERE closed_at < NOW() - ($2 * INTERVAL '1 day')
                          AND closed_at >= NOW() - ($3 * INTERVAL '1 day')
                    ), 2) AS "priorAvgReturn",
                    ROUND(SUM(COALESCE(pnl, 0)) FILTER (
                        WHERE closed_at >= NOW() - ($2 * INTERVAL '1 day')
                    ), 2) AS "recentTotalPnl",
                    ROUND(SUM(COALESCE(pnl, 0)) FILTER (
                        WHERE closed_at < NOW() - ($2 * INTERVAL '1 day')
                          AND closed_at >= NOW() - ($3 * INTERVAL '1 day')
                    ), 2) AS "priorTotalPnl"
                FROM trade_decision_journal
                WHERE ${edgeWhere}
                  AND strategy_family IS NOT NULL
                  AND setup_family IS NOT NULL
                GROUP BY bot_type, strategy_family, setup_family, regime
            )
            SELECT
                "botType",
                "strategyFamily",
                "setupFamily",
                regime,
                "recentTrades",
                "priorTrades",
                "recentWinRate",
                "priorWinRate",
                "recentAvgReturn",
                "priorAvgReturn",
                "recentTotalPnl",
                "priorTotalPnl",
                ROUND(COALESCE("recentAvgReturn", 0) - COALESCE("priorAvgReturn", 0), 2) AS "returnDelta",
                ROUND(COALESCE("recentWinRate", 0) - COALESCE("priorWinRate", 0), 2) AS "winRateDelta"
            FROM setup_windows
            WHERE "recentTrades" > 0 OR "priorTrades" > 0
            ORDER BY "returnDelta" DESC, "recentTrades" DESC, "recentWinRate" DESC NULLS LAST
            LIMIT 12`,
            edgeParams
        )
    ]);

    return {
        lookbackDays,
        comparisonWindowDays,
        filters: {
            botType: botType || 'all',
            regime: regime || 'all',
            availableBotTypes: ['all', 'stock', 'options'],
            availableRegimes: availableRegimesResult.rows
                .map((row) => row.regime)
                .filter(Boolean)
        },
        overview: overviewResult.rows[0] || {
            candidate_count: 0,
            executed_count: 0,
            closed_count: 0,
            closed_win_rate: 0,
            avg_closed_return: 0,
            avg_expectancy: 0,
            avg_score_adjustment: 0,
            avg_size_multiplier: 1,
            total_closed_pnl: 0
        },
        byBotType: botBreakdownResult.rows,
        topSetups: setupPerformanceResult.rows,
        strategyPerformance: strategyPerformanceResult.rows,
        regimePerformance: regimePerformanceResult.rows,
        recentClosures: recentClosuresResult.rows,
        currentEdge: currentEdgeResult.rows
    };
}

async function getTradeIntelligenceDrilldown(userId, options = {}) {
    const lookbackDays = Math.max(7, Math.min(Number(options.days) || LOOKBACK_DAYS, 365));
    const limit = Math.max(10, Math.min(Number(options.limit) || 50, 200));
    const botType = normalizeBotTypeFilter(options.botType);
    const regime = normalizeTextFilter(options.regime);
    const strategyFamily = normalizeTextFilter(options.strategyFamily);
    const setupFamily = normalizeTextFilter(options.setupFamily);
    const symbol = normalizeTextFilter(options.symbol);
    const sector = normalizeTextFilter(options.sector);

    await ensureTradeIntelligenceSchema();

    const params = [userId, lookbackDays];
    const conditions = [
        'user_id = $1',
        'created_at >= NOW() - ($2 * INTERVAL \'1 day\')'
    ];

    if (botType) {
        conditions.push(`bot_type = $${params.push(botType)}`);
    }
    if (regime) {
        conditions.push(`regime = $${params.push(regime)}`);
    }
    if (strategyFamily) {
        conditions.push(`strategy_family = $${params.push(strategyFamily)}`);
    }
    if (setupFamily) {
        conditions.push(`setup_family = $${params.push(setupFamily)}`);
    }
    if (symbol) {
        conditions.push(`symbol = $${params.push(symbol)}`);
    }
    if (sector) {
        conditions.push(`metadata->>'sector' = $${params.push(sector)}`);
    }

    const whereClause = conditions.join('\n               AND ');
    const detailParams = [...params, limit];

    const [summaryResult, phaseBreakdownResult, entriesResult] = await Promise.all([
        query(
            `SELECT
                COUNT(*)::int AS total_rows,
                COUNT(*) FILTER (WHERE decision_phase = 'CANDIDATE')::int AS candidate_count,
                COUNT(*) FILTER (WHERE decision_phase = 'EXECUTED')::int AS executed_count,
                COUNT(*) FILTER (WHERE decision_phase = 'CLOSED')::int AS closed_count,
                ROUND(AVG(CASE WHEN decision_phase = 'CLOSED' AND pnl > 0 THEN 100.0 ELSE 0 END), 2) AS closed_win_rate,
                ROUND(AVG(CASE WHEN decision_phase = 'CLOSED' THEN pnl_percent END), 2) AS avg_closed_return,
                ROUND(SUM(CASE WHEN decision_phase = 'CLOSED' THEN pnl ELSE 0 END), 2) AS total_closed_pnl,
                MAX(created_at) AS last_seen_at,
                MAX(closed_at) AS last_closed_at
             FROM trade_decision_journal
             WHERE ${whereClause}`,
            params
        ),
        query(
            `SELECT
                decision_phase AS phase,
                COUNT(*)::int AS count,
                ROUND(AVG(score), 2) AS avg_score,
                ROUND(AVG(score_adjustment), 2) AS avg_score_adjustment,
                ROUND(AVG(size_multiplier), 3) AS avg_size_multiplier,
                ROUND(AVG(expectancy), 2) AS avg_expectancy,
                ROUND(AVG(pnl_percent), 2) AS avg_return,
                ROUND(SUM(COALESCE(pnl, 0)), 2) AS total_pnl
             FROM trade_decision_journal
             WHERE ${whereClause}
             GROUP BY decision_phase
             ORDER BY CASE decision_phase
                WHEN 'CANDIDATE' THEN 1
                WHEN 'EXECUTED' THEN 2
                WHEN 'CLOSED' THEN 3
                ELSE 4
             END`,
            params
        ),
        query(
            `SELECT
                id,
                bot_type AS "botType",
                symbol,
                setup_family AS "setupFamily",
                strategy_family AS "strategyFamily",
                regime,
                decision_phase AS "decisionPhase",
                ROUND(score, 2) AS score,
                ROUND(score_adjustment, 2) AS "scoreAdjustment",
                ROUND(size_multiplier, 3) AS "sizeMultiplier",
                ROUND(expectancy, 2) AS expectancy,
                ROUND(confidence, 2) AS confidence,
                ROUND(entry_price, 4) AS "entryPrice",
                ROUND(exit_price, 4) AS "exitPrice",
                ROUND(pnl, 2) AS pnl,
                ROUND(pnl_percent, 2) AS "pnlPercent",
                trade_ref_type AS "tradeRefType",
                trade_ref_id AS "tradeRefId",
                metadata,
                opened_at AS "openedAt",
                closed_at AS "closedAt",
                created_at AS "createdAt"
             FROM trade_decision_journal
             WHERE ${whereClause}
             ORDER BY created_at DESC, id DESC
             LIMIT $${detailParams.length}`,
            detailParams
        )
    ]);

    return {
        lookbackDays,
        filters: {
            botType: botType || 'all',
            regime: regime || 'all',
            strategyFamily: strategyFamily || 'all',
            setupFamily: setupFamily || 'all',
            symbol: symbol || 'all',
            sector: sector || 'all',
            limit
        },
        summary: summaryResult.rows[0] || {
            total_rows: 0,
            candidate_count: 0,
            executed_count: 0,
            closed_count: 0,
            closed_win_rate: 0,
            avg_closed_return: 0,
            total_closed_pnl: 0,
            last_seen_at: null,
            last_closed_at: null
        },
        phaseBreakdown: phaseBreakdownResult.rows,
        entries: entriesResult.rows
    };
}

module.exports = {
    ensureTradeIntelligenceSchema,
    getExpectancyAdjustment,
    getTradeIntelligenceDrilldown,
    getTradeIntelligenceSummary,
    recordCandidate,
    recordExecution,
    closeExecutionByRef,
    closeLatestOpenExecution
};