/**
 * Weekly accountability (2026-11-07) — the app answers for itself every Friday after the
 * close: what it cost to run this week (metered Gemini + subscriptions, from
 * costLedgerService) vs what the live accounts gained (Alpaca's own total P&L, which
 * excludes deposits/withdrawals and includes open positions — see dailyPnlTargetService).
 *
 * Paper accounts are left out of gains: no real money. Admin only — the report lists every
 * live account. Stored in weekly_accountability so the trend is visible week to week.
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');
const ledger = require('./costLedgerService');

let _ready = false;
async function ensureTable() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS weekly_accountability (
            week_end   DATE PRIMARY KEY,
            gains_usd  NUMERIC,
            spend_usd  NUMERIC,
            net_usd    NUMERIC,
            details    JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    _ready = true;
}

const money = v => (v == null ? 'n/a' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`);

/** Live-account gains for the last 5 trading days. deps.summaries is injectable for tests. */
async function _liveGains(now, deps) {
    const entries = deps.summaries ? await deps.summaries() : await require('./dailyPnlTargetService').buildAllSummaries({ now });
    const live = entries.filter(e => e.summary.isPaper === false).map(e => ({
        username: e.username,
        total: e.summary.total?.last5 ?? null,        // Alpaca profit_loss: closed + open + core
        realized: e.summary.last5?.total ?? null,       // closed swing trades only
        equity: e.summary.equity ?? null,
    }));
    const known = live.filter(a => a.total != null);
    return { accounts: live, totalUsd: known.length ? known.reduce((s, a) => s + a.total, 0) : null, missing: live.filter(a => a.total == null).map(a => a.username) };
}

/** Build (and store) the week ending on `now` (ET). Week = the 7 days ending today. */
async function buildWeek({ now = new Date(), deps = {} } = {}) {
    await ensureTable();
    const toDay = ledger._etDay(now);
    const fromDay = ledger._etDay(new Date(now.getTime() - 6 * 86400000));
    const spend = await (deps.spend || ledger.spend)(fromDay, toDay);
    const gains = await _liveGains(now, deps);
    const net = gains.totalUsd == null ? null : gains.totalUsd - spend.totalUsd;
    await query(
        `INSERT INTO weekly_accountability (week_end, gains_usd, spend_usd, net_usd, details) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (week_end) DO UPDATE SET gains_usd = EXCLUDED.gains_usd, spend_usd = EXCLUDED.spend_usd, net_usd = EXCLUDED.net_usd, details = EXCLUDED.details`,
        [toDay, gains.totalUsd, spend.totalUsd, net, JSON.stringify({ spend, gains })]);
    const history = (await query(
        `SELECT to_char(week_end, 'YYYY-MM-DD') AS week_end, gains_usd::float AS gains, spend_usd::float AS spend, net_usd::float AS net
         FROM weekly_accountability ORDER BY week_end DESC LIMIT 4`)).rows;
    return { fromDay, toDay, spend, gains, net, history };
}

function formatMessage(w) {
    const L = [`🧾 <b>Weekly accountability</b> — ${w.fromDay} → ${w.toDay}`, ''];
    L.push('<b>Gains — live accounts (real money, total P&amp;L incl. open positions):</b>');
    for (const a of w.gains.accounts) L.push(`  ${a.username}: ${money(a.total)} (closed trades ${money(a.realized)})`);
    if (!w.gains.accounts.length) L.push('  no live account traded this week');
    L.push(`  <b>Total: ${money(w.gains.totalUsd)}</b>`, '');
    L.push('<b>Cost to run the app:</b>');
    for (const m of w.spend.metered) L.push(`  ${m.service}: $${m.usd.toFixed(2)} (${m.calls} calls)`);
    for (const s of w.spend.subscriptions.filter(x => x.monthly_usd > 0)) L.push(`  ${s.service}: $${s.periodUsd.toFixed(2)} ($${s.monthly_usd}/mo)`);
    L.push(`  <b>Total: $${w.spend.totalUsd.toFixed(2)}</b>`);
    if (w.spend.unknownPrices.length) L.push(`  ⚠️ price not set (counted as $0): ${w.spend.unknownPrices.join(', ')}`);
    L.push('');
    if (w.net == null) L.push('<b>Net:</b> n/a (live P&amp;L unavailable)');
    else L.push(`<b>Net: ${money(w.net)}</b> — ${w.net >= 0 ? '✅ the app paid for itself this week' : '❌ the app cost more than it made this week'}`);
    if (w.history.length > 1) {
        L.push('', '<b>Last weeks (gains / cost / net):</b>');
        for (const h of w.history) L.push(`  ${h.week_end}: ${money(h.gains)} / $${(h.spend ?? 0).toFixed(2)} / ${money(h.net)}`);
    }
    return L.join('\n');
}

/** Friday after the close. Never throws. */
async function runWeekly({ now = new Date() } = {}) {
    try {
        const w = await buildWeek({ now });
        const text = formatMessage(w);
        await require('./telegramAlertService').sendAdminMessage(text, 'HTML').catch(() => {});
        await require('./reportArchiveService').save({ kind: 'accountability', title: `Weekly accountability — ${w.toDay}`, body: text, format: 'html', adminOnly: true }).catch(() => {});
        logger.info('[Accountability] Weekly report', { gains: w.gains.totalUsd, spend: +w.spend.totalUsd.toFixed(2), net: w.net });
        return w;
    } catch (err) {
        logger.warn('[Accountability] Weekly report failed', { error: err.message });
        return null;
    }
}

module.exports = { buildWeek, formatMessage, runWeekly, ensureTable };
