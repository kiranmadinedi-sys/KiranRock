/**
 * Weekly Trading Report Service
 *
 * Generates a per-user trading performance report for the most recent complete
 * Monday–Friday week (or the current partial week if requested mid-week).
 * Reports are stored in trading_performance_reports for the Performance page.
 *
 * Auto-generation is triggered every Friday at ~5:30 PM ET by the worker scheduler.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');
const { logger } = require('../utils/logger');
const axios = require('axios');

// ─── Schema ensure ────────────────────────────────────────────────────────────

async function ensureSchema() {
    await query(`
        CREATE TABLE IF NOT EXISTS trading_performance_reports (
            id           SERIAL PRIMARY KEY,
            user_id      VARCHAR(50) NOT NULL,
            week_start   DATE NOT NULL,
            week_end     DATE NOT NULL,
            report_data  JSONB NOT NULL,
            generated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (user_id, week_start)
        )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_tpr_user_week ON trading_performance_reports(user_id, week_start DESC)`);
}

// ─── Market context (SPY/QQQ/IWM weekly returns) ────────────────────────────

async function fetchMarketContext(weekStart, weekEnd) {
    try {
        const symbols = ['SPY', 'QQQ', 'IWM'];
        const result = {};
        const apiKey = process.env.POLYGON_API_KEY || process.env.FIN_MODELING_KEY || '';
        if (!apiKey) return { spy: null, qqq: null, iwm: null };

        for (const sym of symbols) {
            try {
                const url = `https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/week/${weekStart}/${weekEnd}?apiKey=${apiKey}`;
                const r = await axios.get(url, { timeout: 5000 });
                const bars = r.data?.results || [];
                if (bars.length > 0) {
                    const open  = bars[0].o;
                    const close = bars[bars.length - 1].c;
                    result[sym.toLowerCase()] = parseFloat(((close - open) / open * 100).toFixed(2));
                } else {
                    result[sym.toLowerCase()] = null;
                }
            } catch (_) {
                result[sym.toLowerCase()] = null;
            }
        }
        return result;
    } catch (_) {
        return { spy: null, qqq: null, iwm: null };
    }
}

// ─── Core report builder ─────────────────────────────────────────────────────

async function buildReport(userId, weekStart, weekEnd) {
    const ws = weekStart; // 'YYYY-MM-DD'
    const we = weekEnd;   // 'YYYY-MM-DD'

    // 1. Closed trades this week
    const closedRes = await query(`
        SELECT symbol, action, price, quantity, pnl, pnl_percent, ai_score, sector, trade_date, notes, executed_by
        FROM trades
        WHERE user_id=$1
          AND action='SELL'
          AND status='CLOSED'
          AND trade_date >= $2
          AND trade_date <= $3
        ORDER BY trade_date ASC
    `, [userId, ws, we]);

    // 2. Open buys this week
    const buysRes = await query(`
        SELECT symbol, price, quantity, ai_score, sector, trade_date, notes
        FROM trades
        WHERE user_id=$1
          AND action='BUY'
          AND trade_date >= $2
          AND trade_date <= $3
        ORDER BY trade_date ASC
    `, [userId, ws, we]);

    // 3. Current open holdings
    const holdingsRes = await query(`
        SELECT symbol, quantity, average_price, current_price, gain_loss, gain_loss_percent, sector, purchase_date
        FROM holdings
        WHERE user_id=$1 AND quantity > 0
        ORDER BY gain_loss_percent DESC
    `, [userId]);

    // 4. Account cash (from trading_accounts or Alpaca)
    const cashRes = await query(`SELECT balance FROM trading_accounts WHERE user_id=$1`, [userId]);
    const cashBalance = parseFloat(cashRes.rows[0]?.balance || 0);

    // 5. Score bucket analytics from trades (all-time, not just this week — more meaningful)
    const bucketRes = await query(`
        WITH bucketed AS (
            SELECT
                CASE
                    WHEN ai_score >= 95 THEN '95-100'
                    WHEN ai_score >= 90 THEN '90-94'
                    WHEN ai_score >= 85 THEN '85-89'
                    WHEN ai_score >= 80 THEN '80-84'
                    WHEN ai_score IS NOT NULL THEN '< 80'
                    ELSE 'No Score'
                END AS bucket,
                CASE
                    WHEN ai_score >= 95 THEN 95
                    WHEN ai_score >= 90 THEN 90
                    WHEN ai_score >= 85 THEN 85
                    WHEN ai_score >= 80 THEN 80
                    WHEN ai_score IS NOT NULL THEN 0
                    ELSE -1
                END AS sort_key,
                pnl, pnl_percent
            FROM trades
            WHERE user_id=$1 AND action='SELL' AND status='CLOSED'
        )
        SELECT
            bucket,
            sort_key,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE pnl > 0) AS wins,
            ROUND(AVG(pnl_percent)::numeric, 2) AS avg_return,
            ROUND(SUM(pnl)::numeric, 2) AS total_pnl
        FROM bucketed
        GROUP BY bucket, sort_key
        ORDER BY sort_key DESC NULLS LAST
    `, [userId]);

    // ─── Compute summary metrics ───────────────────────────────────────────
    const closedTrades = closedRes.rows;
    const openHoldings = holdingsRes.rows;

    const realizedPnl = closedTrades.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
    const wins        = closedTrades.filter(t => parseFloat(t.pnl || 0) > 0).length;
    const losses      = closedTrades.filter(t => parseFloat(t.pnl || 0) < 0).length;
    const winRate     = closedTrades.length > 0 ? Math.round(wins / closedTrades.length * 100) : 0;
    const avgWin      = wins > 0
        ? closedTrades.filter(t => parseFloat(t.pnl) > 0).reduce((s, t) => s + parseFloat(t.pnl), 0) / wins
        : 0;
    const avgLoss     = losses > 0
        ? closedTrades.filter(t => parseFloat(t.pnl) < 0).reduce((s, t) => s + parseFloat(t.pnl), 0) / losses
        : 0;
    const profitFactor = Math.abs(avgLoss) > 0 ? Math.abs(avgWin / avgLoss) : null;

    const bestTrade = closedTrades.reduce((best, t) =>
        parseFloat(t.pnl || 0) > parseFloat(best.pnl || -Infinity) ? t : best,
        closedTrades[0] || null
    );
    const worstTrade = closedTrades.reduce((worst, t) =>
        parseFloat(t.pnl || 0) < parseFloat(worst.pnl || Infinity) ? t : worst,
        closedTrades[0] || null
    );

    const unrealizedPnl = openHoldings.reduce((s, h) => s + parseFloat(h.gain_loss || 0), 0);

    // ─── Market context ────────────────────────────────────────────────────
    const marketCtx = await fetchMarketContext(ws, we);
    const spyReturn = marketCtx.spy;

    // ─── Alpha capture per open position ───────────────────────────────────
    const positionsWithAlpha = openHoldings.map(h => {
        const entryPrice   = parseFloat(h.average_price || 0);
        const currentPrice = parseFloat(h.current_price || entryPrice);
        const stockReturn  = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice * 100) : null;
        const alpha        = stockReturn != null && spyReturn != null ? parseFloat((stockReturn - spyReturn).toFixed(2)) : null;
        return {
            symbol:        h.symbol,
            sector:        h.sector || 'Unknown',
            qty:           parseFloat(h.quantity),
            entryPrice,
            currentPrice,
            gainLoss:      parseFloat(h.gain_loss || 0),
            gainLossPct:   parseFloat(h.gain_loss_percent || 0) * 100,
            stockReturn,
            alpha,
            since:         h.purchase_date
        };
    });

    const validAlphas   = positionsWithAlpha.filter(p => p.alpha != null);
    const avgAlpha      = validAlphas.length > 0
        ? parseFloat((validAlphas.reduce((s, p) => s + p.alpha, 0) / validAlphas.length).toFixed(2))
        : null;
    const beatingSpyCount = validAlphas.filter(p => p.alpha > 0).length;

    // ─── Score bucket ──────────────────────────────────────────────────────
    const scoreBuckets = bucketRes.rows.map(r => ({
        bucket:    r.bucket,
        total:     parseInt(r.total),
        wins:      parseInt(r.wins),
        winRate:   r.total > 0 ? Math.round(parseInt(r.wins) / parseInt(r.total) * 100) : 0,
        avgReturn: parseFloat(r.avg_return) || 0,
        totalPnl:  parseFloat(r.total_pnl) || 0,
    }));

    // ─── Insights ──────────────────────────────────────────────────────────
    const insights = [];

    if (positionsWithAlpha.length > 0 && spyReturn != null) {
        insights.push(`${beatingSpyCount} of ${positionsWithAlpha.length} open positions are outperforming SPY (${spyReturn > 0 ? '+' : ''}${spyReturn}% this week)`);
    }
    if (avgAlpha != null) {
        const sign = avgAlpha >= 0 ? '+' : '';
        insights.push(`Average alpha vs SPY: ${sign}${avgAlpha.toFixed(2)}% per position`);
    }
    if (closedTrades.length > 0) {
        const avgStopPct = closedTrades.filter(t => parseFloat(t.pnl_percent) < 0)
            .reduce((s, t, _, arr) => s + parseFloat(t.pnl_percent) / arr.length, 0);
        if (!isNaN(avgStopPct) && avgStopPct !== 0) {
            insights.push(`Average exit on losing trades: ${avgStopPct.toFixed(1)}% (target: better than -7%)`);
        }
        if (profitFactor != null) {
            insights.push(`Profit factor this week: ${profitFactor.toFixed(2)}x (>1 = profitable, >2 = excellent)`);
        }
    }

    // High score bucket insight
    const topBucket = scoreBuckets.find(b => b.bucket === '95-100');
    if (topBucket && topBucket.total >= 2) {
        insights.push(`Score 95-100 trades: ${topBucket.winRate}% win rate across ${topBucket.total} closed positions`);
    }

    if (insights.length === 0) {
        insights.push('No closed trades this week — open positions building.');
    }

    // ─── Assemble report ───────────────────────────────────────────────────
    const fmt = n => parseFloat(parseFloat(n || 0).toFixed(2));
    return {
        weekDates:  `${ws} to ${we}`,
        weekStart:  ws,
        weekEnd:    we,
        summary: {
            totalBuys:    buysRes.rows.length,
            totalSells:   closedTrades.length,
            totalTrades:  buysRes.rows.length + closedTrades.length,
            realizedPnl:  fmt(realizedPnl),
            unrealizedPnl: fmt(unrealizedPnl),
            cashBalance:  fmt(cashBalance),
            openPositions: openHoldings.length,
            winRate,
            wins,
            losses,
            avgWin:       fmt(avgWin),
            avgLoss:      fmt(avgLoss),
            profitFactor: profitFactor ? parseFloat(profitFactor.toFixed(2)) : null,
            bestTrade:    bestTrade ? { symbol: bestTrade.symbol, pnl: fmt(bestTrade.pnl), pct: parseFloat(parseFloat(bestTrade.pnl_percent || 0).toFixed(2)) } : null,
            worstTrade:   worstTrade ? { symbol: worstTrade.symbol, pnl: fmt(worstTrade.pnl), pct: parseFloat(parseFloat(worstTrade.pnl_percent || 0).toFixed(2)) } : null,
        },
        marketContext: {
            spy: marketCtx.spy,
            qqq: marketCtx.qqq,
            iwm: marketCtx.iwm,
        },
        alphaCapture: {
            avgAlpha,
            beatingSpyCount,
            totalPositions: positionsWithAlpha.length,
            spyWeeklyReturn: spyReturn,
        },
        closedTrades: closedTrades.map(t => ({
            symbol:    t.symbol,
            price:     parseFloat(t.price),
            quantity:  parseFloat(t.quantity),
            pnl:       fmt(t.pnl),
            pnlPct:    parseFloat(parseFloat(t.pnl_percent || 0).toFixed(2)),
            aiScore:   t.ai_score ? parseInt(t.ai_score) : null,
            sector:    t.sector || 'Unknown',
            date:      t.trade_date,
            executor:  t.executed_by,
        })),
        newBuys: buysRes.rows.map(t => ({
            symbol:   t.symbol,
            price:    parseFloat(t.price),
            quantity: parseFloat(t.quantity),
            aiScore:  t.ai_score ? parseInt(t.ai_score) : null,
            sector:   t.sector || 'Unknown',
            date:     t.trade_date,
        })),
        openPositions: positionsWithAlpha,
        scoreBuckets,
        insights,
    };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate and persist the weekly report for a user.
 * If a report for this week already exists, it is overwritten (idempotent).
 */
async function generateWeeklyReport(userId, weekStart, weekEnd) {
    await ensureSchema();
    try {
        const reportData = await buildReport(userId, weekStart, weekEnd);
        await query(`
            INSERT INTO trading_performance_reports (user_id, week_start, week_end, report_data, generated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (user_id, week_start)
            DO UPDATE SET report_data=EXCLUDED.report_data, generated_at=NOW()
        `, [userId, weekStart, weekEnd, JSON.stringify(reportData)]);
        logger.info('[WeeklyReport] Generated report', { userId, weekStart, weekEnd });
        return reportData;
    } catch (err) {
        logger.error('[WeeklyReport] Failed to generate report', { userId, weekStart, err: err.message });
        throw err;
    }
}

/**
 * Get the most recent stored weekly report for a user.
 * If no stored report exists, generates one on the fly for the current week.
 */
async function getLatestReport(userId) {
    await ensureSchema();
    const r = await query(`
        SELECT report_data, week_start, week_end, generated_at
        FROM trading_performance_reports
        WHERE user_id=$1
        ORDER BY week_start DESC
        LIMIT 1
    `, [userId]);
    if (r.rows.length > 0) {
        return {
            ...r.rows[0].report_data,
            generatedAt: r.rows[0].generated_at,
            weekStart:   r.rows[0].week_start,
            weekEnd:     r.rows[0].week_end,
        };
    }
    // No stored report — generate current week on-the-fly (not persisted)
    const { weekStart, weekEnd } = currentWeekRange();
    return buildReport(userId, weekStart, weekEnd);
}

/**
 * Get paginated list of stored weekly reports for a user (for history view).
 */
async function getReportHistory(userId, limit = 12) {
    await ensureSchema();
    const r = await query(`
        SELECT id, week_start, week_end, generated_at,
               report_data->'summary' AS summary
        FROM trading_performance_reports
        WHERE user_id=$1
        ORDER BY week_start DESC
        LIMIT $2
    `, [userId, limit]);
    return r.rows.map(row => ({
        id:          row.id,
        weekStart:   row.week_start,
        weekEnd:     row.week_end,
        generatedAt: row.generated_at,
        summary:     row.summary,
    }));
}

/**
 * Get a specific historical report by id.
 */
async function getReportById(userId, reportId) {
    await ensureSchema();
    const r = await query(`
        SELECT report_data, week_start, week_end, generated_at
        FROM trading_performance_reports
        WHERE user_id=$1 AND id=$2
    `, [userId, reportId]);
    if (r.rows.length === 0) return null;
    return {
        ...r.rows[0].report_data,
        generatedAt: r.rows[0].generated_at,
        weekStart:   r.rows[0].week_start,
        weekEnd:     r.rows[0].week_end,
    };
}

/** Returns Mon–Fri dates for the most recently completed trading week. */
function lastWeekRange() {
    const now  = new Date();
    const day  = now.getDay(); // 0=Sun,1=Mon...6=Sat
    // How many days back to last Friday close
    const daysToFri = day === 0 ? 2 : (day === 6 ? 1 : day + 2);
    const friday    = new Date(now);
    friday.setDate(now.getDate() - daysToFri);
    const monday    = new Date(friday);
    monday.setDate(friday.getDate() - 4);
    return {
        weekStart: monday.toISOString().slice(0, 10),
        weekEnd:   friday.toISOString().slice(0, 10),
    };
}

/** Returns Mon–Fri dates for the current (potentially partial) week. */
function currentWeekRange() {
    const now  = new Date();
    const day  = now.getDay(); // 0=Sun...6=Sat
    const daysFromMon = day === 0 ? 6 : day - 1;
    const monday = new Date(now);
    monday.setDate(now.getDate() - daysFromMon);
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    return {
        weekStart: monday.toISOString().slice(0, 10),
        weekEnd:   friday.toISOString().slice(0, 10),
    };
}

/**
 * Called by the worker on Friday evening (ET).
 * Generates and stores reports for all active AI trading users.
 */
async function generateFridayReportsForAllUsers() {
    logger.info('[WeeklyReport] Friday auto-generation starting');
    const { weekStart, weekEnd } = currentWeekRange();
    const users = await query(`
        SELECT id, username FROM users WHERE ai_trading_enabled=true
    `);
    let generated = 0, failed = 0;
    for (const user of users.rows) {
        try {
            await generateWeeklyReport(user.id, weekStart, weekEnd);
            generated++;
        } catch (e) {
            logger.error('[WeeklyReport] Failed for user', { userId: user.id, err: e.message });
            failed++;
        }
    }
    logger.info('[WeeklyReport] Friday auto-generation complete', { generated, failed, weekStart, weekEnd });
    return { generated, failed, weekStart, weekEnd };
}

module.exports = {
    generateWeeklyReport,
    getLatestReport,
    getReportHistory,
    getReportById,
    generateFridayReportsForAllUsers,
    currentWeekRange,
    lastWeekRange,
};
