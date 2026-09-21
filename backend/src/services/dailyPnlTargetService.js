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

// What the platform can realistically aim for on the current live capital, combined across
// live accounts (a good swing system earns ~0.1-0.3%/day; ~$8.85k -> ~$9-27/day), and the
// owner's stated stretch goal, shown alongside so the gap stays visible.
const DEFAULT_TARGET_USD  = parseFloat(process.env.DAILY_PNL_TARGET_USD  || '15');
const DEFAULT_STRETCH_USD = parseFloat(process.env.DAILY_PNL_STRETCH_USD || '100');

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

/** Build the numbers for one account. Injectable deps keep this testable. */
async function buildAccountSummary(userId, { now = new Date(), deps = {} } = {}) {
    const realized = deps.realizedByDay || _realizedByDay;
    const crypto   = deps.cryptoByDay   || _cryptoByDay;
    const cashInfo = deps.cashInfo      || _fetchCashPct;
    const holiday  = deps.isHoliday     || _isHoliday;

    const end = now;
    const start28 = new Date(end.getTime() - 27 * 86400000);
    const sinceKey = start28.toISOString().slice(0, 10);

    const [rows, cryptoRows, cash] = await Promise.all([realized(userId, sinceKey), crypto(userId, sinceKey), cashInfo(userId)]);

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
        mtd: summarizeWindow(rows, keysMtd)
    };

    if (cryptoRows.length > 0) {
        const cryptoTotal28 = cryptoRows.reduce((s, r) => s + r.pnl, 0);
        summary.crypto = { total28: cryptoTotal28, avgPerCalendarDay: cryptoTotal28 / 28, trades28: cryptoRows.reduce((s, r) => s + r.trades, 0) };
    }
    return summary;
}

function formatAccountMessage(username, s, { target = DEFAULT_TARGET_USD, stretch = DEFAULT_STRETCH_USD } = {}) {
    const lines = [`📈 *Weekly $/day report — ${username}*${s.isPaper ? ' _(paper)_' : ''}`, ''];
    lines.push(`*Last 5 trading days:* ${money(s.last5.total)} total → *${money(s.last5.avgPerDay)}/day* (${s.last5.greenDays} green, ${s.last5.redDays} red, ${s.last5.closedTrades} closes)`);
    lines.push(`*Last 4 weeks:* ${money(s.last28.total)} → *${money(s.last28.avgPerDay)}/day* over ${s.last28.days} trading days (${s.last28.greenDays} green / ${s.last28.redDays} red)`);
    lines.push(`*Month to date:* ${money(s.mtd.total)}`);
    if (s.crypto) lines.push(`*Crypto (24/7, 4 weeks):* ${money(s.crypto.total28)} → ${money(s.crypto.avgPerCalendarDay)}/day, ${s.crypto.trades28} closes`);
    if (s.equity != null) lines.push(`*Capital:* $${s.equity.toFixed(0)} equity, ${s.cashPct}% idle cash`);
    lines.push('', '_Realized (closed) P&L only — deposits and unrealized swings are excluded._');
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
    lines.push(`*Target:* ${money(target)}/day realistic on current capital — currently at ${target > 0 ? Math.round((liveAvg28 / target) * 100) : 0}%`);
    lines.push(`*Your ${money(stretch)}/day goal:* at ${stretch > 0 ? Math.round((liveAvg28 / stretch) * 100) : 0}% — needs ~${(stretch / Math.max(liveEquity, 1) * 100).toFixed(1)}%/day return on this capital`);
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
                await alertService.sendTelegramMessage(chatId, formatAccountMessage(e.username, e.summary));
                sent++;
            }
        } catch (err) {
            logger.warn('[DailyPnl] Send failed for user', { userId: e.userId, err: err.message });
        }
    }
    if (entries.length > 0) await alertService.sendAdminMessage(formatCombinedMessage(entries));
    logger.info('[DailyPnl] Weekly $/day reports sent', { accounts: entries.length, userMessages: sent });
    return { accounts: entries.length, userMessages: sent, entries };
}

module.exports = {
    tradingDayKeys, summarizeWindow, buildAccountSummary, buildAllSummaries,
    formatAccountMessage, formatCombinedMessage, sendWeeklyPnlReports,
    DEFAULT_TARGET_USD, DEFAULT_STRETCH_USD
};
