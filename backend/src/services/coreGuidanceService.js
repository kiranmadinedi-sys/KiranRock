/**
 * Core guidance (2026-10-26): rule-based alerts that tell the user what to consider doing with core,
 * built so each rule can EARN autonomy later.
 *
 * Autonomy ladder (RULES[x].level):
 *   1 alert            — message + suggested action; actionable ones become an approval request (one tap)
 *   2 one-tap          — same, user decision recorded (approved / ignored / expired)
 *   3 auto on paper    — only after the scorecard shows the suggestion beat "do nothing" (not yet)
 *   4 auto on live     — only after a clean paper run AND the user's approval popup (not yet)
 * Every alert is stored with the suggested symbol's price and SPY at alert time; getScorecard()
 * compares what happened afterwards by rule and by the user's decision. No rule is automatic today.
 *
 * Rules: idle_cash, opportunity, drift, concentration, stay_calm. Selling is never suggested as an
 * automatic action — a "story changed" review stays the user's call.
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const RULES = {
    idle_cash:     { label: 'Idle cash',          level: 1, actionable: true },
    opportunity:   { label: 'Opportunity',        level: 1, actionable: true },
    drift:         { label: 'Drift above target', level: 1, actionable: false },
    concentration: { label: 'Sector concentration', level: 1, actionable: false },
    stay_calm:     { label: 'Stay calm',          level: 0, actionable: false },
};
const IDLE_DAYS = 10;           // trading days cash must sit above reserve + buffer
const IDLE_BUFFER_PCT = 5;
const DRIFT_PP = 10;            // holding this many points above its target
const SECTOR_LIMIT_PCT = 35;    // one sector > 35% of the account (single stocks, core + swing)
const OPP_TARGET_PCT = 5;
const OPP_COOLDOWN_DAYS = 14;

let _ready = false;
async function ensureTables() {
    if (_ready) return;
    await query(`CREATE TABLE IF NOT EXISTS core_guidance_alerts (
        id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, rule TEXT NOT NULL, alert_key TEXT NOT NULL,
        title TEXT NOT NULL, message TEXT NOT NULL, suggestion JSONB, status TEXT NOT NULL DEFAULT 'open',
        approval_id INT, symbol TEXT, price_at NUMERIC, spy_at NUMERIC,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_core_guidance_user_time ON core_guidance_alerts (user_id, created_at DESC)`);
    await query(`CREATE TABLE IF NOT EXISTS core_cash_history (
        user_id TEXT NOT NULL, day DATE NOT NULL, cash_pct NUMERIC NOT NULL, reserve_pct NUMERIC NOT NULL, PRIMARY KEY (user_id, day))`);
    _ready = true;
}

// ── pure rule logic (unit-tested) ────────────────────────────────────────────

/** history: [{cashPct, reservePct}] newest last. Fires when the last IDLE_DAYS all sat above the line. */
function idleCashRule(history, { equity, totalTargetPct, maxTotalPct = 80 }) {
    if (history.length < IDLE_DAYS) return null;
    const recent = history.slice(-IDLE_DAYS);
    if (!recent.every(h => h.cashPct > h.reservePct + IDLE_BUFFER_PCT)) return null;
    const last = recent[recent.length - 1];
    const excessPct = Math.floor(last.cashPct - last.reservePct - IDLE_BUFFER_PCT);
    const room = Math.max(0, maxTotalPct - totalTargetPct);
    const addPct = Math.min(excessPct, room);
    if (addPct < 2) return null;
    return { addPct, excessUsd: Math.round(equity * excessPct / 100), days: IDLE_DAYS };
}

/** holdings: [{symbol, targetPct, currentPct}] — buy-only core never sells, so this is information. */
function driftRule(holdings) {
    return holdings.filter(h => h.targetPct > 0 && h.currentPct != null && h.currentPct >= h.targetPct + DRIFT_PP);
}

/** positions: [{symbol, value, sector}] (ETFs have sector null). */
function concentrationRule(positions, equity) {
    const by = {};
    for (const p of positions) if (p.sector) by[p.sector] = (by[p.sector] || 0) + p.value;
    return Object.entries(by).map(([sector, v]) => ({ sector, pct: v / equity * 100 })).filter(x => x.pct > SECTOR_LIMIT_PCT);
}

// ── context ──────────────────────────────────────────────────────────────────

async function _price(symbol) {
    const q = await require('./dataProvider').getQuote(symbol).catch(() => null);
    return q?.price || null;
}

async function _create(userId, rule, key, title, message, { suggestion = null, symbol = null, approval = null } = {}) {
    const dup = await query(
        `SELECT 1 FROM core_guidance_alerts WHERE user_id = $1 AND rule = $2 AND alert_key = $3 AND created_at > NOW() - INTERVAL '14 days'`,
        [String(userId), rule, key]);
    if (dup.rows.length) return null;
    let approvalId = null;
    if (approval) {
        const { request } = await require('./approvalService').createRequest({ userId, ...approval });
        approvalId = request?.id || null;
    }
    const [px, spy] = await Promise.all([symbol ? _price(symbol) : null, _price('SPY')]);
    const r = await query(
        `INSERT INTO core_guidance_alerts (user_id, rule, alert_key, title, message, suggestion, status, approval_id, symbol, price_at, spy_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [String(userId), rule, key, title, message, suggestion ? JSON.stringify(suggestion) : null,
         RULES[rule].actionable ? 'open' : 'info', approvalId, symbol, px, spy]);
    return r.rows[0];
}

async function _sectorOf(symbol) {
    const r = await query(`SELECT sector FROM daily_universe_analysis WHERE symbol = $1 AND sector IS NOT NULL AND sector <> 'Unknown'
                           ORDER BY analysis_date DESC LIMIT 1`, [symbol]).catch(() => ({ rows: [] }));
    const s = r.rows[0]?.sector || null;
    // Broad-market funds (SPY, IWM) are diversification, not concentration. Sector ETFs (XLE, SOXL)
    // keep their sector — that IS concentrated exposure.
    return s && !/broad market/i.test(s) ? s : null;
}

/** Evaluate every rule for one account. Returns the new alerts. */
async function evaluateUser(userId, now = new Date()) {
    await ensureTables();
    const core = require('./coreHoldingsService');
    const status = await core.getStatus(userId);
    if (!status.equity) return [];
    const uid = String(userId);
    const day = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const cashPct = (status.cash ?? 0) / status.equity * 100;
    const reservePct = status.settings.cashReservePct;
    await query(`INSERT INTO core_cash_history (user_id, day, cash_pct, reserve_pct) VALUES ($1,$2,$3,$4)
                 ON CONFLICT (user_id, day) DO UPDATE SET cash_pct = EXCLUDED.cash_pct, reserve_pct = EXCLUDED.reserve_pct`,
        [uid, day, cashPct, reservePct]);
    const created = [];
    const isPaper = (await require('./userDatabaseService').getUserAlpacaCredentials(userId)).isPaper !== false;

    // 1. idle cash (skipped where the paper cash sweep already puts it to work)
    if (!status.addons?.sweep?.enabled) {
        const hist = (await query(`SELECT cash_pct::float AS "cashPct", reserve_pct::float AS "reservePct" FROM core_cash_history
                                   WHERE user_id = $1 ORDER BY day DESC LIMIT $2`, [uid, IDLE_DAYS])).rows.reverse();
        const idle = idleCashRule(hist, { equity: status.equity, totalTargetPct: status.totalTargetPct, maxTotalPct: status.limits.maxTotalPct });
        if (idle) {
            const spy = status.holdings.find(h => h.symbol === 'SPY');
            const newPct = (spy?.targetPct || 0) + idle.addPct;
            const a = await _create(uid, 'idle_cash', `SPY:${newPct}`, `About $${idle.excessUsd.toLocaleString()} has sat idle for ${idle.days} trading days`,
                `Cash stayed above your ${reservePct}% reserve + ${IDLE_BUFFER_PCT}% buffer for ${idle.days} trading days. Suggestion: raise SPY's core target to ${newPct}% so that cash goes to work. Approving changes only the target; core still keeps the reserve and never sells.`,
                { suggestion: { action: 'set_target', symbol: 'SPY', targetPct: newPct }, symbol: 'SPY',
                  approval: { kind: 'core_target', key: `SPY:${newPct}`, title: `Raise SPY core target to ${newPct}%`,
                              message: `Idle cash above the reserve for ${idle.days} trading days (~$${idle.excessUsd.toLocaleString()}).`, payload: { symbol: 'SPY', targetPct: newPct } } });
            if (a) created.push(a);
        }
    }

    // 2. opportunity from the watchlist
    const wl = await require('./coreWatchlistService').getWatchlist(userId).catch(() => []);
    const roomPct = status.limits.maxTotalPct - status.totalTargetPct;
    for (const w of wl.filter(x => x.status === 'Dip — valuation OK' && !x.inCore && x.date === day)) {
        if (roomPct < OPP_TARGET_PCT) break;
        const a = await _create(uid, 'opportunity', w.symbol, `${w.symbol}: dip with reasonable valuation`,
            `${w.symbol} is ${Number(w.ddPct).toFixed(0)}% below its 52-week high, ${w.reasons?.[1] || 'valuation checked'}, no earnings in the next 5 days and no strongly bearish news. Suggestion: add it to core at ${OPP_TARGET_PCT}%. Our 2020–2026 test found dips alone don't beat buying any day — this is about owning a company you want at a sensible price, not a timing edge.`,
            { suggestion: { action: 'add', symbol: w.symbol, targetPct: OPP_TARGET_PCT }, symbol: w.symbol,
              approval: { kind: 'core_add', key: `${w.symbol}:${OPP_TARGET_PCT}`, title: `Add ${w.symbol} to core at ${OPP_TARGET_PCT}%`,
                          message: `From core guidance: ${w.symbol} −${Number(w.ddPct).toFixed(0)}% from its high, valuation around or below its usual P/E.`,
                          payload: { symbol: w.symbol, targetPct: OPP_TARGET_PCT } } });
        if (a) created.push(a);
    }

    // 3. drift above target (information — core never buys above target and never sells)
    for (const h of driftRule(status.holdings)) {
        const a = await _create(uid, 'drift', `${h.symbol}:${Math.floor(h.currentPct / 5) * 5}`, `${h.symbol} is ${h.currentPct}% of the account vs a ${h.targetPct}% target`,
            `${h.symbol} has grown well past its target. Core won't buy more of it, and nothing is sold automatically. If you want less concentration, raise other targets or rebalance by hand — selling may be taxable.`,
            { symbol: h.symbol });
        if (a) created.push(a);
    }

    // 4. sector concentration across core + swing (single stocks; ETFs have no sector here)
    const positions = await require('./brokerService').getPositions(userId).catch(() => []);
    const withSector = [];
    for (const p of positions) {
        withSector.push({ symbol: String(p.symbol).toUpperCase(), value: parseFloat(p.marketValue || 0), sector: await _sectorOf(String(p.symbol).toUpperCase()) });
    }
    for (const c of concentrationRule(withSector, status.equity)) {
        const names = withSector.filter(p => p.sector === c.sector).map(p => p.symbol).join(', ');
        const a = await _create(uid, 'concentration', `${c.sector}:${Math.floor(c.pct / 5) * 5}`, `${c.sector} is ${c.pct.toFixed(0)}% of the account`,
            `Across core and swing positions (${names}), one sector is above ${SECTOR_LIMIT_PCT}% of the account. A single bad news day for that sector hits all of them at once. Consider pausing new buys in ${c.sector}.`);
        if (a) created.push(a);
    }

    // 5. stay calm: a core stock reports soon
    for (const h of status.holdings.filter(x => x.qty > 0 && !['SPY', 'SGOV', 'QQQ', 'VOO', 'IVV', 'VTI'].includes(x.symbol))) {
        let date = null;
        try { date = await require('../utils/finnhubEarnings').nextEarningsDate(h.symbol, 4, now); } catch (_) { /* skip */ }
        if (!date) continue;
        const a = await _create(uid, 'stay_calm', `${h.symbol}:${date}`, `${h.symbol} reports earnings on ${date}`,
            `${h.symbol} is a long-term core holding. Core holds through earnings — a big move either way on the day is normal and is not a reason to act. Nothing will be sold automatically.`,
            { symbol: h.symbol });
        if (a) created.push(a);
    }

    if (created.length) {
        const info = created.filter(a => !a.approval_id);
        if (info.length) {
            const text = `🧭 *Core guidance*\n\n${info.map(a => `• *${a.title}*\n${a.message}`).join('\n\n')}`;
            await require('./telegramAlertService').sendMessage(userId, text).catch(() => {});
        }
        await require('./reportArchiveService').save({ kind: 'core_guidance', title: `Core guidance — ${created.length} new`,
            body: created.map(a => `• ${a.title}\n${a.message}${a.approval_id ? '\n(approval requested)' : ''}`).join('\n\n'), userId: uid });
    }
    logger.info('[CoreGuidance] Evaluated', { userId: uid, isPaper, created: created.map(a => a.rule) });
    return created;
}

/** 10:20 AM ET trading days, after the watchlist check. */
async function runDaily(now = new Date()) {
    try {
        const day = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
        if (dow === 0 || dow === 6 || require('../utils/marketCalendar').isTradingHoliday(now)) return { skipped: 'not a trading day' };
        await ensureTables();
        const ids = (await query(`SELECT user_id FROM core_settings WHERE enabled`)).rows.map(r => r.user_id);
        const out = {};
        for (const u of ids) {
            out[u] = (await evaluateUser(u, now).catch(err => { logger.warn('[CoreGuidance] User failed', { userId: u, error: err.message }); return []; })).length;
        }
        return out;
    } catch (err) {
        logger.warn('[CoreGuidance] Daily run failed', { error: err.message });
        return { error: err.message };
    }
}

/** Called by approvalService.decide — keeps each alert's decision in sync with its approval request. */
async function recordDecision(approvalId, status) {
    await ensureTables();
    await query(`UPDATE core_guidance_alerts SET status = $2, decided_at = NOW() WHERE approval_id = $1 AND status = 'open'`,
        [approvalId, status === 'approved' ? 'approved' : status === 'rejected' ? 'ignored' : status]);
}

async function listAlerts(userId, limit = 50) {
    await ensureTables();
    return (await query(`SELECT id, rule, title, message, status, symbol, created_at, decided_at FROM core_guidance_alerts
                         WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [String(userId), limit])).rows;
}

/**
 * Scorecard: for actionable alerts old enough, the suggested symbol's return vs SPY over 1 and 3
 * months, by rule and decision. This record — not the alert count — decides any future autonomy.
 */
async function getScorecard(userId = null) {
    await ensureTables();
    const at = (sym, date) => `(SELECT close FROM daily_bars b WHERE b.symbol = ${sym} AND (b.timestamp AT TIME ZONE 'UTC')::date >= ${date} ORDER BY b.timestamp LIMIT 1)`;
    const out = {};
    for (const [label, days] of [['1m', 30], ['3m', 91]]) {
        const r = await query(
            `SELECT rule, status, COUNT(*)::int AS n, AVG(ret)::float * 100 AS avg_pct, AVG(spy)::float * 100 AS spy_pct
             FROM (SELECT a.rule, a.status,
                          ${at('a.symbol', `a.created_at::date + ${days}`)} / a.price_at - 1 AS ret,
                          ${at("'SPY'", `a.created_at::date + ${days}`)} / a.spy_at - 1 AS spy
                   FROM core_guidance_alerts a
                   WHERE a.price_at > 0 AND a.spy_at > 0 AND a.created_at::date <= CURRENT_DATE - ${days}
                         ${userId ? 'AND a.user_id = $1' : ''}) x
             WHERE ret IS NOT NULL AND spy IS NOT NULL GROUP BY rule, status ORDER BY rule, status`, userId ? [String(userId)] : []);
        out[label] = r.rows;
    }
    const counts = (await query(`SELECT rule, status, COUNT(*)::int AS n FROM core_guidance_alerts ${userId ? 'WHERE user_id = $1' : ''} GROUP BY rule, status`,
        userId ? [String(userId)] : [])).rows;
    return { rules: RULES, counts, outcomes: out };
}

module.exports = { RULES, idleCashRule, driftRule, concentrationRule, evaluateUser, runDaily, recordDecision, listAlerts, getScorecard, ensureTables };
