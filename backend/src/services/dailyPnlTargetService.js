/**
 * Daily P&L target tracker — added 2026-09-20.
 *
 * Answers one question per account, in plain dollars: "how much did this account
 * actually make per trading day, and how does that compare to the target?" Built after
 * a review found the live accounts (~$8.85k combined equity) had realized about -$16 over
 * 30 days against an expectation of ~$100/day — a number worth measuring honestly every
 * week instead of judging by feel.
 *
 * Realized P&L only (closed SELLs) — never equity change, since equity also moves with
 * deposits/withdrawals and unrealized swings (a +$1,985 kmadined equity jump the same
 * month was almost entirely added capital, not gains).
 *
 * Privacy: each user's own report goes ONLY to their own chat (never cc'd around); the
 * combined all-accounts view goes to admin only — same lesson as the 2026-07-20
 * market-close broadcast leak.
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

// Capital-proportional targets (2026-10-17, agreed with the user): a fixed $15/day was ~50%/yr
// on kmadined's $7.5K and ~370%/yr on a $1K account — unreachable targets make every week look
// like a failure and push toward risk. Realistic = 8%/yr, stretch = 15%/yr, of each account's
// own equity, so the target grows as capital is added. (Built from the evidence: core in SPY
// ~8-10%/yr long run, SGOV ~3.8%, swing ~+0.25%/trade with the 'wide' exits if confirmed.)
const ANNUAL_TARGET_PCT  = parseFloat(process.env.ANNUAL_TARGET_PCT  || '8');
const ANNUAL_STRETCH_PCT = parseFloat(process.env.ANNUAL_STRETCH_PCT || '15');
const TRADING_DAYS_PER_YEAR = 252;
/** $ per trading day for an equity at an annual % — the per-account target. */
const targetPerDay = (equity, annualPct) => (equity > 0 ? equity * annualPct / 100 / TRADING_DAYS_PER_YEAR : 0);
// Kept for callers/tests that pass explicit dollar targets to formatCombinedMessage.
const DEFAULT_TARGET_USD  = parseFloat(process.env.DAILY_PNL_TARGET_USD  || '0');
const DEFAULT_STRETCH_USD = parseFloat(process.env.DAILY_PNL_STRETCH_USD || '0');

const money = n => `${n < 0 ? '-' : '+'}$${Math.abs(n).toFixed(2)}`;

/** ISO date keys (YYYY-MM-DD) for every weekday in [start, end], minus holidays. */
function tradingDayKeys(start, end, isHoliday = () => false) {
    const keys = [];
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    const stop = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
    while (d.getTime() <= stop) {
        const dow = d.getUTCDay();
        // Noon UTC is safely the same calendar day in ET for the holiday lookup.
        const probe = new Date(d.getTime() + 12 * 3600 * 1000);
        if (dow !== 0 && dow !== 6 && !isHoliday(probe)) keys.push(d.toISOString().slice(0, 10));
        d.setUTCDate(d.getUTCDate() + 1);
    }
    return keys;
}

/**
 * rows: [{ day: 'YYYY-MM-DD', pnl: number, trades: number }] (days with no closes are absent).
 * dayKeys: the trading days that make up the window (the denominator).
 */
function summarizeWindow(rows, dayKeys) {
    const byDay = new Map(rows.map(r => [r.day, r]));
    const daily = dayKeys.map(k => ({ day: k, pnl: byDay.get(k)?.pnl || 0, trades: byDay.get(k)?.trades || 0 }));
    const total = daily.reduce((s, d) => s + d.pnl, 0);
    const n = dayKeys.length;
    return {
        days: n,
        total,
        avgPerDay: n > 0 ? total / n : 0,
        greenDays: daily.filter(d => d.pnl > 0).length,
        redDays: daily.filter(d => d.pnl < 0).length,
        closedTrades: daily.reduce((s, d) => s + d.trades, 0),
        daily
    };
}

function _isHoliday(date) {
    try { return require('../utils/marketCalendar').isTradingHoliday(date); } catch (_) { return false; }
}

async function _realizedByDay(userId, sinceKey) {
    const res = await query(
        `SELECT to_char(DATE(trade_date), 'YYYY-MM-DD') AS day,
                COALESCE(SUM(pnl), 0)::float AS pnl, COUNT(*)::int AS trades
         FROM trades
         WHERE user_id = $1 AND action = 'SELL' AND status != 'VOIDED'
           AND pnl IS NOT NULL AND DATE(trade_date) >= $2::date
         GROUP BY 1 ORDER BY 1`,
        [userId, sinceKey]
    );
    return res.rows;
}

async function _cryptoByDay(userId, sinceKey) {
    try {
        const res = await query(
            `SELECT to_char(DATE(exit_time), 'YYYY-MM-DD') AS day,
                    COALESCE(SUM(pnl), 0)::float AS pnl, COUNT(*)::int AS trades
             FROM crypto_trades
             WHERE user_id = $1 AND pnl IS NOT NULL AND DATE(exit_time) >= $2::date
             GROUP BY 1 ORDER BY 1`,
            [userId, sinceKey]
        );
        return res.rows;
    } catch (_) { return []; } // crypto tables only exist once the feature has been enabled
}

/** Real Alpaca cash vs equity — idle-cash % is the single biggest lever on $/day. */
async function _fetchCashPct(userId) {
    try {
        const axios = require('axios');
        const userDb = require('./userDatabaseService');
        const c = await userDb.getUserAlpacaCredentials(userId);
        const base = c.isPaper !== false ? 'https://paper-api.alpaca.markets/v2' : 'https://api.alpaca.markets/v2';
        const a = (await axios.get(`${base}/account`, {
            headers: { 'APCA-API-KEY-ID': c.keyId, 'APCA-API-SECRET-KEY': c.secretKey }, timeout: 8000
        })).data;
        const equity = parseFloat(a.equity), cash = parseFloat(a.cash);
        return { equity, cash, cashPct: equity > 0 ? Math.round((cash / equity) * 100) : null, isPaper: c.isPaper !== false };
    } catch (err) {
        logger.debug('[DailyPnl] Alpaca account lookup failed', { userId, err: err.message });
        return null;
    }
}

/**
 * TOTAL P&L per trading day from Alpaca's own portfolio history (profit_loss excludes
 * deposits/withdrawals; includes closed trades, open positions and core holdings).
 * Returns { last5, last28 } sums, or null when unavailable.
 */
async function _fetchTotalPnl(userId) {
    try {
        const axios = require('axios');
        const userDb = require('./userDatabaseService');
        const c = await userDb.getUserAlpacaCredentials(userId);
        const base = c.isPaper !== false ? 'https://paper-api.alpaca.markets/v2' : 'https://api.alpaca.markets/v2';
        const h = (await axios.get(`${base}/account/portfolio/history`, {
            headers: { 'APCA-API-KEY-ID': c.keyId, 'APCA-API-SECRET-KEY': c.secretKey },
            params: { period: '1M', timeframe: '1D' }, timeout: 8000,
        })).data;
        const pl = (h.profit_loss || []).map(v => (v == null ? 0 : Number(v)));
        if (!pl.length) return null;
        const sum = a => a.reduce((x, y) => x + y, 0);
        return { last5: sum(pl.slice(-5)), last28: sum(pl.slice(-20)) };
    } catch (err) {
        logger.debug('[DailyPnl] Portfolio history lookup failed', { userId, err: err.message });
        return null;
    }
}

/** Build the numbers for one account. Injectable deps keep this testable. */
async function buildAccountSummary(userId, { now = new Date(), deps = {} } = {}) {
    const realized = deps.realizedByDay || _realizedByDay;
    const crypto   = deps.cryptoByDay   || _cryptoByDay;
    const cashInfo = deps.cashInfo      || _fetchCashPct;
    const totalPnl = deps.totalPnl      || _fetchTotalPnl;
    const holiday  = deps.isHoliday     || _isHoliday;

    const end = now;
    const start28 = new Date(end.getTime() - 27 * 86400000);
    const sinceKey = start28.toISOString().slice(0, 10);

    const [rows, cryptoRows, cash, total] = await Promise.all([
        realized(userId, sinceKey), crypto(userId, sinceKey), cashInfo(userId), totalPnl(userId).catch(() => null),
    ]);

    const keys28 = tradingDayKeys(start28, end, holiday);
    const keys5  = keys28.slice(-5);
    const monthStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    const keysMtd = keys28.filter(k => k >= monthStart.toISOString().slice(0, 10));

    const summary = {
        userId,
        isPaper: cash?.isPaper ?? null,
        equity: cash?.equity ?? null,
        cashPct: cash?.cashPct ?? null,
        last5: summarizeWindow(rows, keys5),
        last28: summarizeWindow(rows, keys28),
        mtd: summarizeWindow(rows, keysMtd),
        total: total || null,
        targets: cash?.equity > 0 ? {
            annualPct: ANNUAL_TARGET_PCT, stretchPct: ANNUAL_STRETCH_PCT,
            perDay: targetPerDay(cash.equity, ANNUAL_TARGET_PCT),
            stretchPerDay: targetPerDay(cash.equity, ANNUAL_STRETCH_PCT),
        } : null,
    };

    if (cryptoRows.length > 0) {
        const cryptoTotal28 = cryptoRows.reduce((s, r) => s + r.pnl, 0);
        summary.crypto = { total28: cryptoTotal28, avgPerCalendarDay: cryptoTotal28 / 28, trades28: cryptoRows.reduce((s, r) => s + r.trades, 0) };
    }
    return summary;
}

/** "on track" verdict for an actual vs a target over the same window. */
function verdict(actual, target) {
    if (!(target > 0)) return '';
    const pct = Math.round(actual / target * 100);
    return `${pct}% of target ${pct >= 100 ? '✅ on track' : pct >= 50 ? '🟡 behind' : '🔴 well behind'}`;
}

function formatAccountMessage(username, s, { target = DEFAULT_TARGET_USD, stretch = DEFAULT_STRETCH_USD } = {}) {
    const lines = [`📈 *Weekly report — ${username}*${s.isPaper ? ' _(paper)_' : ''}`, ''];
    if (s.targets) {
        const t = s.targets;
        lines.push(`🎯 *Target:* ${t.annualPct}%/yr on $${s.equity.toFixed(0)} = *${money(t.perDay * 5)}/week* (stretch ${t.stretchPct}%: ${money(t.stretchPerDay * 5)}/week)`);
        if (s.total) {
            lines.push(`*Total P&L, last 5 days:* ${money(s.total.last5)} → ${verdict(s.total.last5, t.perDay * 5)}`);
            lines.push(`*Total P&L, last 4 weeks:* ${money(s.total.last28)} vs ${money(t.perDay * 20)} target → ${verdict(s.total.last28, t.perDay * 20)}`);
            lines.push('_Total = closed trades + open positions + core, deposits excluded (Alpaca)._');
        }
        lines.push('');
    }
    lines.push('*Swing trading (closed trades):*');
    lines.push(`*Last 5 trading days:* ${money(s.last5.total)} total → *${money(s.last5.avgPerDay)}/day* (${s.last5.greenDays} green, ${s.last5.redDays} red, ${s.last5.closedTrades} closes)`);
    lines.push(`*Last 4 weeks:* ${money(s.last28.total)} → *${money(s.last28.avgPerDay)}/day* over ${s.last28.days} trading days (${s.last28.greenDays} green / ${s.last28.redDays} red)`);
    lines.push(`*Month to date:* ${money(s.mtd.total)}`);
    if (s.crypto) lines.push(`*Crypto (24/7, 4 weeks):* ${money(s.crypto.total28)} → ${money(s.crypto.avgPerCalendarDay)}/day, ${s.crypto.trades28} closes`);
    if (s.equity != null) lines.push(`*Capital:* $${s.equity.toFixed(0)} equity, ${s.cashPct}% idle cash`);
    lines.push('', '_Swing lines are realized (closed) P&L only; the target lines above use total P&L._');
    return lines.join('\n');
}

function formatCombinedMessage(entries, { target = DEFAULT_TARGET_USD, stretch = DEFAULT_STRETCH_USD } = {}) {
    const live = entries.filter(e => e.summary.isPaper === false);
    const paper = entries.filter(e => e.summary.isPaper !== false);
    const sum = (arr, k) => arr.reduce((t, e) => t + e.summary[k].avgPerDay, 0);
    const liveAvg5 = sum(live, 'last5'), liveAvg28 = sum(live, 'last28');
    const liveEquity = live.reduce((t, e) => t + (e.summary.equity || 0), 0);

    const lines = ['📊 *All accounts — $/day scoreboard*', ''];
    lines.push('*Live accounts (real money):*');
    for (const e of live) {
        lines.push(`  ${e.username}: ${money(e.summary.last5.avgPerDay)}/day (5d) · ${money(e.summary.last28.avgPerDay)}/day (4w) · ${e.summary.cashPct ?? '?'}% cash`);
    }
    lines.push(`  *Combined:* ${money(liveAvg5)}/day (5d) · *${money(liveAvg28)}/day (4w)* on ~$${liveEquity.toFixed(0)}`);
    lines.push('');
    if (target > 0 || stretch > 0) {
        // explicit dollar targets (legacy / tests)
        lines.push(`*Target:* ${money(target)}/day realistic on current capital — currently at ${target > 0 ? Math.round((liveAvg28 / target) * 100) : 0}%`);
        lines.push(`*Your ${money(stretch)}/day goal:* at ${stretch > 0 ? Math.round((liveAvg28 / stretch) * 100) : 0}% — needs ~${(stretch / Math.max(liveEquity, 1) * 100).toFixed(1)}%/day return on this capital`);
    } else {
        lines.push(`*Targets (${ANNUAL_TARGET_PCT}%/yr of each account, total P&L, last 4 weeks):*`);
        for (const e of live) {
            const t = e.summary.targets, tot = e.summary.total;
            if (!t) continue;
            lines.push(`  ${e.username}: ${tot ? money(tot.last28) : 'n/a'} vs ${money(t.perDay * 20)} → ${tot ? verdict(tot.last28, t.perDay * 20) : 'n/a'}`);
        }
    }
    if (paper.length) {
        lines.push('', '*Paper (no real money):*');
        for (const e of paper) {
            const c = e.summary.crypto ? ` · crypto ${money(e.summary.crypto.avgPerCalendarDay)}/day` : '';
            lines.push(`  ${e.username}: stocks ${money(e.summary.last28.avgPerDay)}/day (4w)${c}`);
        }
    }
    return lines.join('\n');
}

/** Builds every active account's summary. */
async function buildAllSummaries({ now = new Date(), deps = {} } = {}) {
    const users = deps.listUsers ? await deps.listUsers() : (await query(
        `SELECT id, username FROM users WHERE username IS NOT NULL ORDER BY username`
    )).rows;
    const entries = [];
    for (const u of users) {
        try {
            const summary = await buildAccountSummary(u.id, { now, deps });
            // Skip accounts with no closed trades (stock or crypto) in the window — the many
            // inactive/test users all resolve to the same shared env paper credentials, so
            // "has equity" says nothing about whether an account actually trades.
            if (summary.last28.closedTrades === 0 && !summary.crypto) continue;
            entries.push({ userId: u.id, username: u.username, summary });
        } catch (err) {
            logger.warn('[DailyPnl] Summary failed for user', { userId: u.id, err: err.message });
        }
    }
    return entries;
}

/**
 * Sends each account its OWN report to its OWN chat only, and one combined scoreboard to
 * admin only. Never cc's one user's numbers to another.
 */
async function sendWeeklyPnlReports({ now = new Date(), deps = {} } = {}) {
    const alertService = deps.alertService || require('./telegramAlertService');
    const entries = await buildAllSummaries({ now, deps });
    let sent = 0;
    for (const e of entries) {
        try {
            const chatId = await alertService.getUserTelegramChatId(e.userId);
            if (chatId) {
                // Core holdings are reported apart from the swing bot's realized P&L above
                // (core never sells, so it never shows up in realized trades).
                let text = formatAccountMessage(e.username, e.summary);
                const core = await (deps.coreSummary || require('./coreHoldingsService').coreSummary)(e.userId).catch(() => null);
                if (core && core.value > 0) {
                    const pct = core.cost > 0 ? (core.unrealizedPl / core.cost * 100).toFixed(1) : '0.0';
                    text += `\n\n🏛️ Core holdings (long-term, separate from swing): $${core.value.toFixed(0)} — unrealized ${core.unrealizedPl >= 0 ? '+' : ''}$${core.unrealizedPl.toFixed(2)} (${pct}%) · ${core.positions.map(p => p.symbol).join(', ')}`;
                }
                await alertService.sendTelegramMessage(chatId, text);
                await require('./reportArchiveService').save({ kind: 'pnl_scoreboard', title: `Weekly $/day scoreboard — ${e.username}`, body: text, userId: e.userId });
                sent++;
            }
        } catch (err) {
            logger.warn('[DailyPnl] Send failed for user', { userId: e.userId, err: err.message });
        }
    }
    if (entries.length > 0) {
        const combined = formatCombinedMessage(entries);
        await require('./reportArchiveService').save({ kind: 'pnl_scoreboard', title: 'Weekly $/day scoreboard — all accounts', body: combined, adminOnly: true });
        await alertService.sendAdminMessage(combined);
    }
    logger.info('[DailyPnl] Weekly $/day reports sent', { accounts: entries.length, userMessages: sent });
    return { accounts: entries.length, userMessages: sent, entries };
}

module.exports = {
    targetPerDay, verdict, ANNUAL_TARGET_PCT, ANNUAL_STRETCH_PCT,
    tradingDayKeys, summarizeWindow, buildAccountSummary, buildAllSummaries,
    formatAccountMessage, formatCombinedMessage, sendWeeklyPnlReports,
    DEFAULT_TARGET_USD, DEFAULT_STRETCH_USD
};
