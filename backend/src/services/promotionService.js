/**
 * Automatic promotion (2026-10-17, the user's rule): improvements move up on evidence —
 *   test log → PAPER account (automatic) → LIVE account (only after the owner approves).
 *
 * Runs Saturdays after the market study:
 *   1. Judge each logged test method (selection_experiment_picks) against 'control' on
 *      the same days with real prices (history_bars): entry next open, 5 trading days.
 *      PASS = at least MIN_DAYS scan days, ≥ +1.0pp per pick over control, and a win
 *      rate not lower than control's (the Phase 1 rule agreed 2026-10-08).
 *   2. The best passing method becomes the paper account's method automatically.
 *   3. Once it has run on paper for a week and still passes, each live account gets an
 *      approval request (Telegram + website popup) — nothing changes until approved.
 *   4. Core holdings: once the paper account's core has run cleanly for a week (positions
 *      held, never sold, no stop orders on them), live accounts get an approval request.
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const MIN_DAYS = 15;
const MIN_EDGE_PP = 1.0;
const PAPER_SOAK_DAYS = 7;
const KMADINED = 'ca632c53-8798-46f4-be94-29be0fede7f2';

const idList = (v, dflt = '') => (v ?? dflt).split(',').map(s => s.trim()).filter(Boolean);
const paperUsers = () => idList(process.env.SELECTION_EXPERIMENT_USER_IDS);
const liveApprovalUsers = () => idList(process.env.LIVE_APPROVAL_USER_IDS, KMADINED);
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = v => (v == null ? null : Math.round(v * 100) / 100);
const LABEL = { control: 'Current (AI score)', oversold: 'Oversold', steady: 'Steady trend', insider: 'Insider cluster', oil: 'Oil → energy tilt', sector: 'Sector strength' };

/** Per-method results vs control on the same scan days. */
async function evaluateArms() {
    const r = await query(`
        WITH p AS (SELECT DISTINCT scan_date AS d, arm, symbol FROM selection_experiment_picks),
             b AS (SELECT symbol, d, o, c, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY d) rn
                   FROM history_bars WHERE symbol IN (SELECT symbol FROM p)),
             s AS (SELECT p.d, p.arm, p.symbol, MIN(b.rn) AS rn FROM p JOIN b ON b.symbol = p.symbol AND b.d > p.d GROUP BY 1, 2, 3)
        SELECT s.d::text AS d, s.arm, (e5.c / e1.o - 1) * 100 AS r5
        FROM s JOIN b e1 ON e1.symbol = s.symbol AND e1.rn = s.rn
               JOIN b e5 ON e5.symbol = s.symbol AND e5.rn = s.rn + 4
        WHERE e1.o > 0`);
    const daily = {}; // arm -> day -> [returns]
    for (const row of r.rows) {
        const v = Math.max(-40, Math.min(40, +row.r5));
        ((daily[row.arm] ||= {})[row.d] ||= []).push(v);
    }
    const control = daily.control || {};
    const out = {};
    for (const [arm, days] of Object.entries(daily)) {
        if (arm === 'control') continue;
        const shared = Object.keys(days).filter(d => control[d]);
        const diffs = shared.map(d => avg(days[d]) - avg(control[d]));
        const armPicks = shared.flatMap(d => days[d]), ctlPicks = shared.flatMap(d => control[d]);
        const win = a => (a.length ? a.filter(x => x > 0).length / a.length * 100 : null);
        const edge = r2(avg(diffs));
        const res = {
            arm, days: shared.length, edgePp: edge,
            winPct: r2(win(armPicks)), controlWinPct: r2(win(ctlPicks)),
            daysBeat: diffs.filter(x => x > 0).length,
        };
        res.passes = res.days >= MIN_DAYS && edge >= MIN_EDGE_PP && res.winPct >= res.controlWinPct;
        res.status = res.passes ? 'pass' : res.days < MIN_DAYS ? `needs ${MIN_DAYS - res.days} more days` : 'not better';
        out[arm] = res;
    }
    return out;
}

/** Paper core healthy for a week? Positions held, never sold, no stop orders on them. */
async function paperCoreHealthy(paperId) {
    const core = require('./coreHoldingsService');
    const settings = await core.getSettings(paperId);
    if (!settings.enabled) return { ok: false, why: 'core not enabled on paper' };
    const since = await query(`SELECT updated_at FROM core_settings WHERE user_id = $1`, [String(paperId)]);
    const enabledAt = since.rows[0]?.updated_at ? new Date(since.rows[0].updated_at) : null;
    if (!enabledAt || Date.now() - enabledAt.getTime() < PAPER_SOAK_DAYS * 86400000) return { ok: false, why: 'paper core running for less than a week' };
    const rows = await core.getCoreRows(paperId);
    const summary = await core.coreSummary(paperId);
    if (!summary || !summary.value) return { ok: false, why: 'no core positions bought yet on paper' };
    const syms = rows.map(r => r.symbol);
    const sold = await query(`SELECT COUNT(*)::int AS n FROM trades WHERE user_id = $1 AND action = 'SELL' AND symbol = ANY($2) AND trade_date >= $3`,
        [paperId, syms, enabledAt]);
    if (sold.rows[0].n > 0) return { ok: false, why: `a core position was sold on paper (${sold.rows[0].n} sells) — investigate first` };
    const orders = await require('./brokerService').getOpenOrders(paperId).catch(() => null);
    if (!orders) return { ok: false, why: 'could not read paper orders' };
    const stops = orders.filter(o => o.side === 'sell' && syms.includes(String(o.symbol).toUpperCase()));
    if (stops.length) return { ok: false, why: `sell/stop orders found on core symbols (${stops.map(o => o.symbol).join(', ')}) — investigate first` };
    return { ok: true, rows, value: summary.value };
}

async function runWeeklyPromotion(now = new Date()) {
    const strategy = require('./strategySettingsService');
    const approvals = require('./approvalService');
    const core = require('./coreHoldingsService');
    const lines = [];

    // 1-2. methods
    const arms = await evaluateArms();
    const passing = Object.values(arms).filter(a => a.passes).sort((a, b) => b.edgePp - a.edgePp);
    for (const a of Object.values(arms)) {
        lines.push(`${a.passes ? '✅' : '⏳'} ${LABEL[a.arm] || a.arm}: ${a.days} days, ${a.edgePp >= 0 ? '+' : ''}${a.edgePp ?? 'n/a'}pp vs current, win ${a.winPct ?? '–'}% vs ${a.controlWinPct ?? '–'}% — ${a.status}`);
    }
    const best = passing[0]?.arm || null;
    for (const paperId of paperUsers()) {
        const current = await strategy.getSelectionMethod(paperId);
        if (best && best !== current) {
            await strategy.setSelectionMethod(paperId, best, 'auto-promotion');
            lines.push(`🧪 Paper account switched to "${LABEL[best]}" (was "${LABEL[current] || current}").`);
            logger.info('[Promotion] Paper method promoted', { paperId, from: current, to: best });
        }
    }

    // 3. live approval once the winner has soaked on paper for a week and still passes
    if (best) {
        const soaked = [];
        for (const paperId of paperUsers()) {
            const row = await strategy.getSettingsRow(paperId);
            if (row?.method === best && Date.now() - new Date(row.updated_at).getTime() >= PAPER_SOAK_DAYS * 86400000) soaked.push(paperId);
        }
        if (soaked.length) {
            const a = arms[best];
            for (const liveId of liveApprovalUsers()) {
                if (await strategy.getSelectionMethod(liveId) === best) continue;
                const { created } = await approvals.createRequest({
                    userId: liveId, kind: 'selection_method', key: best,
                    title: `Use "${LABEL[best]}" stock picking on your live account`,
                    message: `Over ${a.days} trading days it beat the current method by ${a.edgePp >= 0 ? '+' : ''}${a.edgePp} points per pick (win rate ${a.winPct}% vs ${a.controlWinPct}%), and it has run on the paper account for at least a week. Approving changes only which stocks are bought first; sizing, stops and limits stay the same.`,
                    payload: { method: best, evidence: a },
                });
                if (created) lines.push(`🔔 Approval requested: "${LABEL[best]}" for a live account.`);
            }
        }
    }

    // 4. core holdings
    for (const paperId of paperUsers()) {
        const health = await paperCoreHealthy(paperId).catch(err => ({ ok: false, why: err.message }));
        if (!health.ok) { lines.push(`⏳ Core holdings on live: ${health.why}.`); continue; }
        const holdings = health.rows.filter(r => r.targetPct > 0).map(r => ({ symbol: r.symbol, targetPct: r.targetPct }));
        const { cashReservePct } = await core.getSettings(paperId);
        for (const liveId of liveApprovalUsers()) {
            const s = await core.getSettings(liveId);
            if (s.enabled) continue;
            let equityTxt = '';
            try {
                const eq = (await require('./brokerService').getAccountInfo(liveId)).portfolioValue;
                equityTxt = ` On your ~$${Math.round(eq).toLocaleString()} account that is ${holdings.map(h => `${h.symbol} ~$${Math.round(eq * h.targetPct / 100).toLocaleString()}`).join(', ')}.`;
            } catch (_) { /* amounts are shown on the Core page anyway */ }
            const { created } = await approvals.createRequest({
                userId: liveId, kind: 'core_enable', key: holdings.map(h => `${h.symbol}:${h.targetPct}`).join(','),
                title: `Enable Core Holdings: ${holdings.map(h => `${h.symbol} ${h.targetPct}%`).join(' + ')}`,
                message: `Core has run cleanly on the paper account for a week (held, never sold, no stops placed on it).${equityTxt} Buys start after 10:00 AM ET on the next trading day, keep ${cashReservePct}% cash free for swing trading, and never sell automatically. Core moves with the market (worst drops since 2023: S&P −19%, Nasdaq −23%).`,
                payload: { holdings, cashReservePct },
            });
            if (created) lines.push('🔔 Approval requested: enable Core Holdings on a live account.');
        }
    }

    const { sendAdminMessage } = require('./telegramAlertService');
    await sendAdminMessage(`<b>🚦 Weekly promotion check</b>\n${lines.join('\n') || 'Nothing to report yet.'}\n\n<i>Paper changes are automatic; live changes need your approval.</i>`, 'HTML')
        .catch(err => logger.warn('[Promotion] Telegram send failed', { error: err.message }));
    logger.info('[Promotion] Weekly promotion check done', { arms, best });
    return { arms, best, lines };
}

module.exports = { evaluateArms, paperCoreHealthy, runWeeklyPromotion, MIN_DAYS, MIN_EDGE_PP };
