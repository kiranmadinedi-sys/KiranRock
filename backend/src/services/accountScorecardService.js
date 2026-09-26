/**
 * Account scorecard — added 2026-09-26, from a cross-validated ChatGPT review's
 * suggestion (built the scoped-down version, not its full P0 list — see
 * project_weinstein_history_window_bug_2026_09_25 memory for why): normalize
 * every live account's performance by its own capital and trade count before
 * comparing accounts to each other. Prompted directly by "is kmadined always
 * the one with problems?" — the honest answer, found by hand that day, was no:
 * kmadined's win rate and per-trade return are in line with the other two
 * accounts, it just trades far more (biggest capital), so it surfaces both
 * real bugs and ordinary bad-luck stretches first. This formalizes that
 * one-off query into something re-runnable.
 *
 * Net capital comes from real Alpaca account activities (CSD deposits minus CSW
 * withdrawals), not the app's own "total deposited" bookkeeping — that field is
 * known to miss real transfers made directly at the broker (found 2026-09-23 on
 * Parvataneni: the app only knew about a $1,000 deposit; the account's REAL
 * history was a $2,115 deposit and a later $1,719.78 withdrawal it never
 * recorded). This always asks Alpaca directly instead of trusting that field.
 */
const { query } = require('../config/database');
const axios = require('axios');
const userDb = require('./userDatabaseService');
const { logger } = require('../utils/logger');

async function _getRealCapitalAndEquity(userId) {
    const creds = await userDb.getUserAlpacaCredentials(userId);
    const base = creds.isPaper ? 'https://paper-api.alpaca.markets/v2' : 'https://api.alpaca.markets/v2';
    const headers = { 'APCA-API-KEY-ID': creds.keyId, 'APCA-API-SECRET-KEY': creds.secretKey };

    const acctResp = await axios.get(`${base}/account`, { headers });
    const equity = parseFloat(acctResp.data.equity);

    let all = [], pageToken = null;
    for (let i = 0; i < 20; i++) {
        const params = { direction: 'asc', page_size: 100 };
        if (pageToken) params.page_token = pageToken;
        const resp = await axios.get(`${base}/account/activities`, { headers, params });
        all = all.concat(resp.data);
        if (resp.data.length < 100) break;
        pageToken = resp.data[resp.data.length - 1].id;
    }
    const deposits    = all.filter(a => a.activity_type === 'CSD').reduce((s, a) => s + parseFloat(a.net_amount), 0);
    const withdrawals = all.filter(a => a.activity_type === 'CSW').reduce((s, a) => s + parseFloat(a.net_amount), 0);
    const netCapital = deposits + withdrawals; // withdrawals already negative

    return { netCapital, equity, activities: all };
}

function _pct(n) { return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`; }
function _money(n) { return `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`; }

/**
 * NOT WIRED IN — see getAccountScorecard, which never calls this.
 *
 * Attempted max drawdown in TRADING P&L (raw total_portfolio_value rises with every
 * deposit and falls with every withdrawal, independent of trading performance, so a
 * naive peak-to-trough on it is meaningless — subtracting cumulative net capital
 * contributed as of each snapshot's own timestamp was meant to isolate the real P&L
 * component first). Left disabled rather than shipped, after three separate real
 * data-quality issues turned up while building it, each one exactly the "unknown/bad
 * data silently treated as valid" pattern this whole week's bugs shared:
 *
 *   1. An internally-inconsistent snapshot (cash + holdings != its own total) from
 *      the documented 2026-06-16 over-deployment incident stood in as kmadined's
 *      "peak", producing a nonsense -$4,413 result before being filtered out.
 *   2. A phantom pre-funding snapshot ($1,000 on Parvataneni, 4 days before its real
 *      first deposit) read as pure P&L out of nowhere before being filtered out.
 *   3. Unresolved: a same-day withdrawal's Alpaca *activity* timestamp doesn't
 *      reliably match when the account's real spendable balance actually changed —
 *      found on Parvataneni's 9/17 withdrawal, where a snapshot hours before the
 *      recorded activity time already reflected a large balance drop. Getting this
 *      right needs real brokerage-mechanics investigation, not a quick fix, so this
 *      stays disabled until that's done rather than publish a number with a known,
 *      unresolved failure mode.
 */
async function _maxDrawdownExperimentalDoNotUse(userId, activities) {
    const { rows: rawRows } = await query(
        `SELECT total_portfolio_value, cash_balance, total_holdings_value, captured_at FROM portfolio_snapshots WHERE user_id = $1 ORDER BY captured_at ASC`,
        [userId]
    );
    // Drop internally-inconsistent snapshots (cash + holdings should equal total) before
    // ever computing a peak-to-trough on them. Found while building this: kmadined's
    // apparent "-$4413 drawdown" was really one bad row from the documented 2026-06-16
    // over-deployment incident (cash $80.99 + holdings $5,157.32 = $5,238.31, but that
    // row's own total_portfolio_value said $3,460.48) standing in as ground truth for a
    // peak. Exactly the "unknown/bad data silently treated as valid" pattern this whole
    // week's bugs shared — worth guarding against here too, not just in new code paths.
    const rows = rawRows.filter(r => {
        const total = parseFloat(r.total_portfolio_value);
        const sum = parseFloat(r.cash_balance || 0) + parseFloat(r.total_holdings_value || 0);
        return total > 0 && Math.abs(sum - total) / total <= 0.05;
    });
    if (rows.length < 2) return null; // known gap — e.g. the paper 'user' account has zero snapshots (2026-09-24)

    const flows = activities
        .filter(a => a.activity_type === 'CSD' || a.activity_type === 'CSW')
        .map(a => ({ t: new Date(a.created_at || a.date).getTime(), amount: parseFloat(a.net_amount) }))
        .sort((a, b) => a.t - b.t);
    if (flows.length === 0) return null; // no real capital-flow history to anchor against at all

    // Skip any snapshot dated before the account's first real deposit — found on
    // Parvataneni: a $1,000-value snapshot from 2026-08-20, four days before its real
    // first Alpaca deposit (8/24). With cumCapital still 0 at that point, that $1,000
    // reads as pure "trading P&L" out of nowhere, corrupting the peak. Almost certainly
    // a pre-funding artifact (same family as the documented "brand-new user sees the
    // shared fallback account's balance" bug in portfolioTrackingService.js), not real
    // history for this account.
    const firstFlowTime = flows[0].t;
    const rowsAfterFunding = rows.filter(r => new Date(r.captured_at).getTime() >= firstFlowTime);
    if (rowsAfterFunding.length < 2) return null;

    let flowIdx = 0, cumCapital = 0;
    let peak = -Infinity, maxDd = 0;
    for (const r of rowsAfterFunding) {
        const t = new Date(r.captured_at).getTime();
        while (flowIdx < flows.length && flows[flowIdx].t <= t) { cumCapital += flows[flowIdx].amount; flowIdx++; }
        const tradingPnl = parseFloat(r.total_portfolio_value) - cumCapital;
        if (tradingPnl > peak) peak = tradingPnl;
        const dd = peak - tradingPnl; // dollars, not a %  — a P&L series crosses zero, so a percentage isn't meaningful here
        if (dd > maxDd) maxDd = dd;
    }
    return maxDd; // largest peak-to-trough DECLINE in trading P&L, in dollars
}

async function _tradeStats(userId, sinceDate = null) {
    const params = [userId];
    let dateFilter = '';
    if (sinceDate) {
        params.push(sinceDate);
        dateFilter = `AND trade_date >= $2`;
    }
    const { rows } = await query(`
        SELECT
            COUNT(*) FILTER (WHERE action = 'SELL') AS sells,
            COUNT(*) FILTER (WHERE action = 'SELL' AND pnl > 0) AS wins,
            COUNT(*) FILTER (WHERE action = 'SELL' AND pnl < 0) AS losses,
            COALESCE(SUM(pnl) FILTER (WHERE action = 'SELL'), 0) AS realized_pnl,
            COALESCE(AVG(pnl_percent) FILTER (WHERE action = 'SELL'), 0) AS avg_pnl_pct
        FROM trades
        WHERE user_id = $1 AND status != 'VOIDED' ${dateFilter}
    `, params);
    const r = rows[0];
    const sells = parseInt(r.sells, 10);
    return {
        trades: sells,
        wins: parseInt(r.wins, 10),
        losses: parseInt(r.losses, 10),
        winRate: sells > 0 ? parseInt(r.wins, 10) / sells : null,
        realizedPnl: parseFloat(r.realized_pnl),
        avgPnlPct: parseFloat(r.avg_pnl_pct) / 100,
        expectancyUsd: sells > 0 ? parseFloat(r.realized_pnl) / sells : null,
    };
}

async function _dataQualityRejects(sinceDate) {
    try {
        const { rows } = await query(
            `SELECT reason, COUNT(*) AS n FROM trade_rejection_log WHERE rejection_date >= $1 GROUP BY reason ORDER BY n DESC`,
            [sinceDate]
        );
        return rows.map(r => ({ reason: r.reason, count: parseInt(r.n, 10) }));
    } catch (err) {
        logger.debug('[Scorecard] trade_rejection_log query failed', { error: err.message });
        return [];
    }
}

/**
 * @returns [{ username, netCapital, equity, allTimeReturn, allTimeReturnPct,
 *             allTime: {...}, last30d: {...}, pnlPer1kCapital }]
 */
async function getAccountScorecard() {
    const { rows: users } = await query(
        `SELECT id, username FROM users WHERE username = ANY($1)`,
        [['kmadined', 'Parvataneni', 'anilboddu1']]
    );

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const cards = [];

    for (const u of users) {
        try {
            const [{ netCapital, equity }, allTime, last30d] = await Promise.all([
                _getRealCapitalAndEquity(u.id),
                _tradeStats(u.id),
                _tradeStats(u.id, thirtyDaysAgo),
            ]);
            const allTimeReturn = equity - netCapital;
            cards.push({
                username: u.username,
                netCapital, equity,
                allTimeReturn, allTimeReturnPct: netCapital > 0 ? allTimeReturn / netCapital : null,
                pnlPer1kCapital: netCapital > 0 ? (allTimeReturn / netCapital) * 1000 : null,
                allTime, last30d,
            });
        } catch (err) {
            logger.warn('[Scorecard] Failed to build card for user', { username: u.username, error: err.message });
            cards.push({ username: u.username, error: err.message });
        }
    }

    const dataQualityRejects = await _dataQualityRejects(thirtyDaysAgo);
    return { cards, dataQualityRejects, generatedAt: new Date().toISOString() };
}

function formatScorecard({ cards, dataQualityRejects }) {
    const lines = ['📊 *Account Scorecard* (normalized by capital & trade count)', ''];
    for (const c of cards) {
        if (c.error) { lines.push(`*${c.username}*: failed to build (${c.error})`, ''); continue; }
        lines.push(
            `*${c.username}*`,
            `  Net capital: $${c.netCapital.toFixed(2)} → equity $${c.equity.toFixed(2)} (${_money(c.allTimeReturn)}, ${_pct(c.allTimeReturnPct || 0)})`,
            `  All-time: ${c.allTime.trades} trades, ${c.allTime.winRate != null ? (c.allTime.winRate * 100).toFixed(1) + '%' : 'n/a'} win rate, expectancy ${c.allTime.expectancyUsd != null ? _money(c.allTime.expectancyUsd) : 'n/a'}/trade`,
            `  Last 30d: ${c.last30d.trades} trades, ${c.last30d.winRate != null ? (c.last30d.winRate * 100).toFixed(1) + '%' : 'n/a'} win rate, ${_money(c.last30d.realizedPnl)}`,
            `  Per $1k capital: ${_money(c.pnlPer1kCapital || 0)}`,
            ''
        );
    }
    if (dataQualityRejects.length > 0) {
        lines.push('*Rejections, last 30d (all accounts):*');
        for (const r of dataQualityRejects) lines.push(`  ${r.reason}: ${r.count}`);
    }
    return lines.join('\n');
}

module.exports = { getAccountScorecard, formatScorecard };
