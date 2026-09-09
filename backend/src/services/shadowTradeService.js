/**
 * Shadow Trade Service
 * ================================================
 * Answers the question trade_rejection_log alone can't: not just "why was
 * this blocked," but "what would have happened if it hadn't been." For any
 * rejected candidate with a genuinely tradeable score (>= SHADOW_TRADE_MIN_SCORE,
 * gated in enhancedAITradingBot.js's _recordRejection), tracks the price
 * forward as if the trade had been taken — max favorable/adverse excursion
 * and 5/10/20-trading-day returns from the price at the moment it was
 * rejected — so each risk gate can eventually be judged on real evidence
 * instead of a hunch.
 *
 * Added 2026-09-07, prompted by a ChatGPT review of PANTHEON's architecture
 * that (correctly, independent of the codebase) identified this as the
 * highest-leverage next step: know whether a gate is protecting the account
 * or quietly costing it money before tuning it either direction.
 */

'use strict';

const cron       = require('node-cron');
const { query }  = require('../config/database');
const { logger } = require('../utils/logger');
const { computeForwardMetrics, barsAfter, TRACK_TRADING_DAYS } = require('../utils/forwardReturnCalculator');

const CRON_TZ           = { timezone: 'America/New_York' };

let job = null;

async function _ensureSchema() {
    await query(`
        CREATE TABLE IF NOT EXISTS shadow_trades (
            id                SERIAL PRIMARY KEY,
            symbol            TEXT NOT NULL,
            user_id           TEXT NOT NULL,
            rejection_date    DATE NOT NULL,
            rejection_reason  TEXT NOT NULL,
            rejection_detail  TEXT,
            ai_score          NUMERIC,
            entry_price_ref   NUMERIC NOT NULL,
            stop_price_ref    NUMERIC,
            target_price_ref  NUMERIC,
            sector            TEXT,
            setup_family      TEXT,
            regime            TEXT,
            mfe_pct           NUMERIC,
            mae_pct           NUMERIC,
            return_5d_pct     NUMERIC,
            return_10d_pct    NUMERIC,
            return_20d_pct    NUMERIC,
            rejected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_checked_at   TIMESTAMPTZ,
            closed_at         TIMESTAMPTZ,
            UNIQUE (symbol, user_id, rejection_date)
        )
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_shadow_trades_open
            ON shadow_trades (symbol) WHERE closed_at IS NULL
    `);
    // Table may already exist from before `regime` was added (2026-09-07) — without
    // this, every shadow trade recorded before today would be missing the one
    // dimension needed for the eventual Gate x Score Bucket x Regime x 20D-Return
    // analysis, and there'd be no way to backfill it after the fact.
    await query(`ALTER TABLE shadow_trades ADD COLUMN IF NOT EXISTS regime TEXT`);
}

/**
 * Record (or refresh, if the same symbol/user/day rejects again intraday) a
 * shadow trade. Only called for rejections that already cleared the score bar
 * — see _recordRejection in enhancedAITradingBot.js.
 */
async function recordShadowTrade(opportunity, userId, reason, detail) {
    await _ensureSchema();

    const entryPrice = opportunity.entry || opportunity.price;
    if (!entryPrice || entryPrice <= 0) return; // nothing to track price movement from

    const today = new Date().toISOString().slice(0, 10);
    await query(`
        INSERT INTO shadow_trades
            (symbol, user_id, rejection_date, rejection_reason, rejection_detail,
             ai_score, entry_price_ref, stop_price_ref, target_price_ref,
             sector, setup_family, regime)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (symbol, user_id, rejection_date) DO UPDATE SET
            rejection_reason = EXCLUDED.rejection_reason,
            rejection_detail = EXCLUDED.rejection_detail,
            ai_score         = EXCLUDED.ai_score,
            regime           = EXCLUDED.regime
    `, [
        opportunity.symbol, String(userId), today, reason, detail || null,
        opportunity.aiScore || opportunity.confidence || null,
        entryPrice, opportunity.stop || null, opportunity.target || null,
        opportunity.sector || null, opportunity.setupFamily || null,
        opportunity.regime || null
    ]);
}

/**
 * Update forward MFE/MAE/return metrics for every still-open shadow trade,
 * then close out any that have run their full tracking window.
 */
async function updateShadowTrades() {
    await _ensureSchema();

    const open = await query(`
        SELECT id, symbol, entry_price_ref, rejected_at
        FROM shadow_trades
        WHERE closed_at IS NULL
    `);

    let updated = 0, closed = 0, failed = 0;

    for (const row of open.rows) {
        try {
            const dataProvider = require('./dataProvider');
            const daysElapsed = Math.floor((Date.now() - new Date(row.rejected_at).getTime()) / 86400000);
            // Fetch enough bars to cover the full tracking window plus buffer for
            // weekends/holidays between rejection and now.
            const bars = await dataProvider.getBars(row.symbol, '1d', Math.max(TRACK_TRADING_DAYS + 10, daysElapsed + 5));
            if (!bars || bars.length === 0) { failed++; continue; }

            // Only bars strictly after the rejection matter for MFE/MAE/returns.
            const rejectedAtMs = new Date(row.rejected_at).getTime();
            const barsSince = barsAfter(bars, rejectedAtMs);
            if (barsSince.length === 0) continue; // no new bar yet (rejected today)

            const entry = parseFloat(row.entry_price_ref);
            const metrics = computeForwardMetrics(barsSince, entry);
            if (!metrics) continue;

            await query(`
                UPDATE shadow_trades
                SET mfe_pct = $1, mae_pct = $2,
                    return_5d_pct  = COALESCE($3, return_5d_pct),
                    return_10d_pct = COALESCE($4, return_10d_pct),
                    return_20d_pct = COALESCE($5, return_20d_pct),
                    last_checked_at = NOW(),
                    closed_at = CASE WHEN $6 THEN NOW() ELSE closed_at END
                WHERE id = $7
            `, [
                metrics.mfePct, metrics.maePct,
                metrics.return5dPct, metrics.return10dPct, metrics.return20dPct,
                metrics.shouldClose, row.id
            ]);

            updated++;
            if (metrics.shouldClose) closed++;
        } catch (err) {
            failed++;
            logger.debug('[ShadowTrade] Update failed', { symbol: row.symbol, err: err.message });
        }
    }

    logger.info('[ShadowTrade] Daily update complete', { checked: open.rows.length, updated, closed, failed });
    return { checked: open.rows.length, updated, closed, failed };
}

/**
 * The actual payoff: is each gate protecting the account or costing it money?
 * Aggregates closed (fully-tracked) shadow trades by rejection reason.
 *
 * missed_upside_pct / avoided_downside_pct are the sum of positive / |negative|
 * 20-day returns among that gate's shadow trades — "how much upside this gate
 * kept us out of" vs. "how much loss this gate kept us out of." Deliberately
 * kept in percentage points, not dollars: a shadow trade has no real position
 * size behind it, so a dollar figure would be manufactured precision, not a
 * real number. net_gate_value_pct = avoided − missed; positive means the gate
 * is earning its keep so far, negative means it's more often blocking winners
 * than losers.
 */
async function getShadowTradeAttribution({ days = 90 } = {}) {
    await _ensureSchema();
    const res = await query(`
        SELECT rejection_reason,
               COUNT(*)::int AS n,
               ROUND(AVG(mfe_pct)::numeric, 2)        AS avg_mfe_pct,
               ROUND(AVG(mae_pct)::numeric, 2)        AS avg_mae_pct,
               ROUND(AVG(return_5d_pct)::numeric, 2)  AS avg_return_5d_pct,
               ROUND(AVG(return_10d_pct)::numeric, 2) AS avg_return_10d_pct,
               ROUND(AVG(return_20d_pct)::numeric, 2) AS avg_return_20d_pct,
               COUNT(*) FILTER (WHERE return_20d_pct > 0)::int AS would_have_won,
               ROUND(COALESCE(SUM(return_20d_pct) FILTER (WHERE return_20d_pct > 0), 0)::numeric, 1) AS missed_upside_pct,
               ROUND(COALESCE(SUM(ABS(return_20d_pct)) FILTER (WHERE return_20d_pct < 0), 0)::numeric, 1) AS avoided_downside_pct
        FROM shadow_trades
        WHERE closed_at IS NOT NULL
          AND rejected_at >= NOW() - ($1 || ' days')::interval
        GROUP BY rejection_reason
        ORDER BY n DESC
    `, [days]);
    return res.rows.map(r => ({
        ...r,
        net_gate_value_pct: Number((parseFloat(r.avoided_downside_pct) - parseFloat(r.missed_upside_pct)).toFixed(1))
    }));
}

/**
 * Per-gate breakdown for Gate Alpha Attribution specifically — deliberately a
 * SEPARATE query from getShadowTradeAttribution above, not a shared one. That
 * function's closed_at-only gating is a real, intentional choice for the
 * original counterfactual-value report (avoid noisy early reads); changing it
 * would silently change an already-shipped report's meaning. This one is not
 * gated on closed_at (2026-09-08 feedback round) so 5D/10D reads show up as
 * soon as they exist rather than waiting on the slowest (20D) checkpoint —
 * n_5d/n_10d/n_20d tell the caller how mature each number actually is.
 */
async function getRejectedAttributionProgressive({ days = 90 } = {}) {
    await _ensureSchema();
    const res = await query(`
        SELECT rejection_reason,
               COUNT(*)::int AS n,
               COUNT(*) FILTER (WHERE return_5d_pct  IS NOT NULL)::int AS n_5d,
               COUNT(*) FILTER (WHERE return_10d_pct IS NOT NULL)::int AS n_10d,
               COUNT(*) FILTER (WHERE return_20d_pct IS NOT NULL)::int AS n_20d,
               ROUND(AVG(mfe_pct)::numeric, 2)        AS avg_mfe_pct,
               ROUND(AVG(mae_pct)::numeric, 2)        AS avg_mae_pct,
               ROUND(AVG(return_5d_pct)::numeric, 2)  AS avg_return_5d_pct,
               ROUND(AVG(return_10d_pct)::numeric, 2) AS avg_return_10d_pct,
               ROUND(AVG(return_20d_pct)::numeric, 2) AS avg_return_20d_pct,
               COUNT(*) FILTER (WHERE return_20d_pct > 0)::int AS would_have_won
        FROM shadow_trades
        WHERE rejected_at >= NOW() - ($1 || ' days')::interval
        GROUP BY rejection_reason
        ORDER BY n DESC
    `, [days]);
    return res.rows;
}

/**
 * Gate Alpha Attribution — the actual payoff of both trackers combined. Answers
 * "are the gates selecting the RIGHT candidates, not just fewer of them?" by
 * comparing real executed BUYs' forward returns against each gate's rejected
 * population's forward returns, same time windows, same underlying math
 * (forwardReturnCalculator.js) on both sides. Added 2026-09-08 per a ChatGPT
 * review's follow-up: knowing 10/163 STRONG BUY candidates became trades only
 * tells you the gates are selective, not that they're selecting well — this
 * is the actual test of that.
 */
async function getGateAlphaAttribution({ days = 90 } = {}) {
    const tradeForwardTrackingService = require('./tradeForwardTrackingService');
    const [actualBuy, rejectedByGate] = await Promise.all([
        tradeForwardTrackingService.getActualBuyAttribution({ days }),
        getRejectedAttributionProgressive({ days })
    ]);
    return { actualBuy, rejectedByGate };
}

// Maturity labels — 2026-09-08 feedback round: don't make the reader wait for
// the slowest (20D) checkpoint to see ANY signal. Each checkpoint's own count
// (n_5d/n_10d/n_20d) decides whether it's shown at all and how much weight to
// put on it, independent of the other two.
const MATURITY_LABEL = { 5: 'preliminary', 10: 'accumulating', 20: 'maturing' };

/**
 * One "N% (label, n=X)" fragment for a single checkpoint, or null if that
 * checkpoint has no data yet — the caller omits it entirely rather than
 * printing a misleading blank.
 */
function _fmtCheckpoint(avgPct, n, window) {
    if (!n || n === 0 || avgPct === null || avgPct === undefined) return null;
    const sign = parseFloat(avgPct) >= 0 ? '+' : '';
    return `${sign}${avgPct}% ${window}D (${MATURITY_LABEL[window]}, n=${n})`;
}

/**
 * Renders getGateAlphaAttribution()'s result into the Telegram-ready format
 * requested alongside the feature: one line for Actual BUY, one per gate, plus
 * a Gate Value delta (rejected − Actual BUY) per checkpoint so the reader
 * doesn't have to do that subtraction themselves — that delta is the actual
 * answer to "is this gate adding alpha or just reducing trade frequency."
 */
function formatGateAlphaAttribution({ actualBuy, rejectedByGate }, days) {
    const lines = [`📊 *Gate Alpha Attribution* (last ${days} days)`, ''];

    const buyCheckpoints = actualBuy ? {
        5:  _fmtCheckpoint(actualBuy.avg_return_5d_pct,  actualBuy.n_5d,  5),
        10: _fmtCheckpoint(actualBuy.avg_return_10d_pct, actualBuy.n_10d, 10),
        20: _fmtCheckpoint(actualBuy.avg_return_20d_pct, actualBuy.n_20d, 20),
    } : { 5: null, 10: null, 20: null };
    const buyHasAny = buyCheckpoints[5] || buyCheckpoints[10] || buyCheckpoints[20];

    if (buyHasAny) {
        const parts = [buyCheckpoints[5], buyCheckpoints[10], buyCheckpoints[20]].filter(Boolean);
        lines.push(`*Actual BUY* — ${actualBuy.n} tracked, ${parts.join(' / ')}`);
    } else {
        lines.push('*Actual BUY* — insufficient sample, nothing tracked long enough yet');
    }
    lines.push('');

    if (rejectedByGate.length === 0) {
        lines.push('_No rejected candidates tracked yet in this window._');
    } else {
        for (const g of rejectedByGate) {
            const gateCheckpoints = {
                5:  _fmtCheckpoint(g.avg_return_5d_pct,  g.n_5d,  5),
                10: _fmtCheckpoint(g.avg_return_10d_pct, g.n_10d, 10),
                20: _fmtCheckpoint(g.avg_return_20d_pct, g.n_20d, 20),
            };
            const parts = [gateCheckpoints[5], gateCheckpoints[10], gateCheckpoints[20]].filter(Boolean);
            if (parts.length === 0) {
                lines.push(`*Rejected — ${g.rejection_reason}* — ${g.n} tracked, insufficient sample yet`);
                continue;
            }
            lines.push(`*Rejected — ${g.rejection_reason}* — ${g.n} tracked, ${parts.join(' / ')}`);

            // Gate Value: this gate's rejected population minus Actual BUY, per
            // checkpoint where BOTH sides have data. Positive means the gate is
            // rejecting candidates that would have UNDERPERFORMED what actually
            // got bought (working as intended); negative means it's rejecting
            // candidates that would have OUTPERFORMED (costing real upside).
            const deltaParts = [];
            for (const w of [5, 10, 20]) {
                const gateAvg = g[`avg_return_${w}d_pct`];
                const buyAvg  = actualBuy?.[`avg_return_${w}d_pct`];
                const gateN   = g[`n_${w}d`];
                const buyN    = actualBuy?.[`n_${w}d`];
                if (!gateN || !buyN || gateAvg === null || buyAvg === null) continue;
                const delta = Number((parseFloat(gateAvg) - parseFloat(buyAvg)).toFixed(2));
                deltaParts.push(`${delta >= 0 ? '+' : ''}${delta}pp ${w}D`);
            }
            if (deltaParts.length > 0) {
                lines.push(`   Gate Value vs Actual BUY: ${deltaParts.join(' / ')}`);
            }
        }
        lines.push('');
        lines.push(
            '_Gate Value = this gate\'s rejected candidates\' return minus Actual BUY\'s. Positive means the ' +
            'gate is correctly filtering out weaker setups; negative means it\'s blocking candidates that would ' +
            'have outperformed what was actually bought — worth a closer look, not an immediate change. Early ' +
            'checkpoints (5D/10D) are preliminary; treat 20D as the more reliable read once it has a real sample._'
        );
    }

    return lines.join('\n');
}

function startShadowTradeScheduler() {
    if (job) {
        logger.warn('[ShadowTrade] Scheduler already running');
        return;
    }

    // 6:00 PM ET, after the missed-opportunity monitor's 5:00 PM slot.
    job = cron.schedule('0 18 * * 1-5', async () => {
        logger.info('[ShadowTrade] Cron triggered — updating shadow trades');
        try {
            await updateShadowTrades();

            // Weekly attribution summary, Fridays only — enough new closed shadow
            // trades accumulate slowly; a daily alert would mostly repeat itself.
            const etDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date());
            if (etDay === 'Fri') {
                const attribution = await getShadowTradeAttribution({ days: 90 });
                if (attribution.length > 0) {
                    // "Counterfactual," not P&L, in every user-facing label here — a shadow
                    // trade was never actually taken, so none of this is real money gained
                    // or lost. Kept explicit per feedback: easy to misread "+1.1pp" next to
                    // a real Telegram P&L alert as if it were the same kind of number.
                    const lines = attribution.map(a =>
                        `• *${a.rejection_reason}* — ${a.n} tracked, avg MFE +${a.avg_mfe_pct}%, ` +
                        `avg MAE ${a.avg_mae_pct}%, avg 20d return ${a.avg_return_20d_pct > 0 ? '+' : ''}${a.avg_return_20d_pct}% ` +
                        `(${a.would_have_won}/${a.n} would have been profitable)\n` +
                        `   missed upside +${a.missed_upside_pct}pp · avoided downside ${a.avoided_downside_pct}pp · ` +
                        `counterfactual value ${a.net_gate_value_pct >= 0 ? '+' : ''}${a.net_gate_value_pct}pp`
                    );
                    const message =
                        `📊 *Shadow Trade Attribution* (last 90 days)\n\n` +
                        `Hypothetical outcomes only — none of this is real P&L. What happened to ` +
                        `candidates each gate blocked, had they been taken. Counterfactual value > 0 ` +
                        `means the gate is avoiding more loss than upside it's costing you so far — ` +
                        `still an early read, not a verdict:\n\n` +
                        lines.join('\n');
                    try {
                        const alertService = require('./telegramAlertService');
                        await alertService.sendAdminMessage(message);
                    } catch (err) {
                        logger.warn('[ShadowTrade] Attribution alert failed', { err: err.message });
                    }
                }

                // Gate Alpha Attribution — separate message, separate question. The
                // report above answers "was blocking this gate's picks worth it in
                // isolation"; this one answers "are the gates selecting the RIGHT
                // candidates compared to what actually got bought."
                try {
                    const gateAlpha = await getGateAlphaAttribution({ days: 90 });
                    if ((gateAlpha.actualBuy?.n > 0) || gateAlpha.rejectedByGate.length > 0) {
                        const alertService = require('./telegramAlertService');
                        await alertService.sendAdminMessage(formatGateAlphaAttribution(gateAlpha, 90));
                    }
                } catch (err) {
                    logger.warn('[ShadowTrade] Gate Alpha Attribution alert failed', { err: err.message });
                }
            }
        } catch (err) {
            logger.error('[ShadowTrade] Cron job failed', { error: err.message });
        }
    }, CRON_TZ);

    logger.info('[ShadowTrade] Scheduler started — daily update 6:00 PM ET, attribution summary Fridays');
}

function stopShadowTradeScheduler() {
    if (job) {
        job.stop();
        job = null;
        logger.info('[ShadowTrade] Scheduler stopped');
    }
}

module.exports = {
    recordShadowTrade,
    updateShadowTrades,
    getShadowTradeAttribution,
    getRejectedAttributionProgressive,
    getGateAlphaAttribution,
    formatGateAlphaAttribution,
    startShadowTradeScheduler,
    stopShadowTradeScheduler,
};
