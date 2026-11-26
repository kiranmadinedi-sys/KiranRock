/**
 * App vs SPY with the same deposits (2026-11-26).
 *
 * Question it answers: "if every dollar I deposited had gone into SPY on the day it arrived,
 * would I have more or less than the account holds now?" Deposits are not profit, and a plain
 * "equity − deposits" hides that money deposited just before a market drop starts out losing
 * no matter what the app does.
 *
 * Source of truth: Alpaca account activities (CSD deposits, CSW withdrawals, JNLC journals)
 * and the account's current equity. SPY uses split/dividend-ADJUSTED daily closes (Polygon,
 * Alpaca bars as backup), so dividends are included on the SPY side too.
 * A flow is bought/sold at the close of its date (next trading day's close on weekends).
 *
 * Live accounts only (real money). Never throws: a failed account is reported as unavailable.
 */
const axios = require('axios');
const { logger } = require('../utils/logger');

const FLOW_TYPES = 'CSD,CSW,JNLC';

async function _client(userId) {
    const creds = await require('./userDatabaseService').getUserAlpacaCredentials(userId);
    if (!creds.keyId || !creds.secretKey) throw new Error('no Alpaca keys');
    const Alpaca = require('@alpacahq/alpaca-trade-api');
    return { client: new Alpaca({ keyId: creds.keyId, secretKey: creds.secretKey, paper: creds.isPaper }), isPaper: creds.isPaper };
}

/** All cash moves for the account, oldest first: [{ date: 'YYYY-MM-DD', amount }]. */
async function _flows(client) {
    const out = [];
    let pageToken;
    for (let i = 0; i < 50; i++) {
        const page = await client.getAccountActivities({ activityTypes: FLOW_TYPES, pageSize: 100, pageToken, direction: 'asc' });
        if (!Array.isArray(page) || page.length === 0) break;
        for (const a of page) {
            const date = String(a.date || a.transaction_time || '').slice(0, 10);
            const amount = Number(a.net_amount);
            if (date && Number.isFinite(amount) && amount !== 0) out.push({ date, amount });
        }
        if (page.length < 100) break;
        pageToken = page[page.length - 1].id;
    }
    return out;
}

/** Adjusted SPY daily closes from `from` to today: [{ d, c }] ascending. */
async function _spyCloses(from) {
    const to = new Date().toISOString().slice(0, 10);
    const key = process.env.POLYGON_API_KEY;
    if (key) {
        try {
            const r = await axios.get(`https://api.polygon.io/v2/aggs/ticker/SPY/range/1/day/${from}/${to}`,
                { params: { adjusted: true, sort: 'asc', limit: 5000, apiKey: key }, timeout: 10000 });
            const bars = (r.data?.results || []).map(b => ({ d: new Date(b.t).toISOString().slice(0, 10), c: b.c }));
            if (bars.length) return bars;
        } catch (err) {
            logger.warn('[DepositBenchmark] Polygon SPY bars failed — trying Alpaca', { error: err.message });
        }
    }
    const Alpaca = require('@alpacahq/alpaca-trade-api');
    const c = new Alpaca({ keyId: process.env.ALPACA_KEY_ID, secretKey: process.env.ALPACA_SECRET_KEY, paper: true });
    const bars = [];
    for await (const b of c.getBarsV2('SPY', { start: from, end: to, timeframe: '1Day', feed: 'iex', adjustment: 'all' })) {
        bars.push({ d: String(b.Timestamp || b.t).slice(0, 10), c: b.ClosePrice ?? b.c });
    }
    return bars;
}

/**
 * Pure math. flows: [{date, amount}] (+deposit / −withdrawal); closes: [{d, c}] ascending.
 * Returns what the same flows would be worth in SPY at the last close.
 */
function simulate(flows, closes, equity) {
    if (!flows.length || !closes.length) return null;
    const last = closes[closes.length - 1];
    let shares = 0;
    for (const f of flows) {
        const bar = closes.find(b => b.d >= f.date) || last;
        shares += f.amount / bar.c;
    }
    const netDeposits = flows.reduce((s, f) => s + f.amount, 0);
    const spyValue = shares * last.c;
    const appPnl = equity - netDeposits;
    const spyPnl = spyValue - netDeposits;
    return {
        firstDeposit: flows[0].date,
        flowsCount: flows.length,
        netDeposits: +netDeposits.toFixed(2),
        equity: +equity.toFixed(2),
        appPnl: +appPnl.toFixed(2),
        spyValue: +spyValue.toFixed(2),
        spyPnl: +spyPnl.toFixed(2),
        appVsSpy: +(appPnl - spyPnl).toFixed(2),
        spyAsOf: last.d,
    };
}

/** One account. deps: { client(userId) → {client,isPaper}, spyCloses(from) }. */
async function forAccount(userId, deps = {}) {
    const { client, isPaper } = await (deps.client || _client)(userId);
    if (isPaper) return { skipped: 'paper' };
    const [acct, flows] = await Promise.all([client.getAccount(), _flows(client)]);
    if (!flows.length) return { skipped: 'no deposits' };
    const closes = await (deps.spyCloses || _spyCloses)(flows[0].date);
    return simulate(flows, closes, Number(acct.equity));
}

/** accounts: [{ userId, username }] (live only). Never throws. */
async function forAccounts(accounts, deps = {}) {
    const out = [];
    for (const a of accounts) {
        if (!a.userId) continue;
        try {
            const r = await forAccount(a.userId, deps);
            if (r && !r.skipped) out.push({ username: a.username, ...r });
        } catch (err) {
            logger.warn('[DepositBenchmark] Account failed', { username: a.username, error: err.message });
            out.push({ username: a.username, error: err.message });
        }
    }
    return out;
}

const usd = v => `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const signed = v => `${v < 0 ? '−' : '+'}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** HTML lines for the Telegram / /reports message. */
function formatLines(rows) {
    if (!rows || !rows.length) return [];
    const L = ['<b>App vs simply buying SPY</b> (every deposit put into SPY on the day it arrived)'];
    for (const r of rows) {
        if (r.error) { L.push(`  ${r.username}: unavailable (${r.error})`); continue; }
        const verdict = r.appVsSpy >= 0 ? `✅ app ahead by ${usd(r.appVsSpy)}` : `❌ app behind by ${usd(-r.appVsSpy)}`;
        L.push(`  ${r.username}: deposited ${usd(r.netDeposits)} since ${r.firstDeposit} → now ${usd(r.equity)} (${signed(r.appPnl)}) · SPY would be ${usd(r.spyValue)} (${signed(r.spyPnl)}) · ${verdict}`);
    }
    return L;
}

module.exports = { simulate, forAccount, forAccounts, formatLines };
