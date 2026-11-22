/**
 * Broker scoreboard (2026-11-22) — P&L per strategy computed ONLY from the broker's own
 * records (Alpaca fills, fees, dividends, open positions), never from the bot's tables.
 *
 * Why: twice the bot's own records disagreed with the broker — swing P&L (11-16) and crypto
 * (11-22: the bot said +$3, the broker −$392). Decisions need numbers that can't drift.
 *
 * READ ONLY: no orders, no settings. Weekly (Saturday 14:00 ET) to the admin + /reports.
 *
 * How fills are assigned to a strategy (first match wins):
 *   1. bear    — the order id or option contract belongs to bear_positions
 *   2. crypto  — a coin pair (BTC/USD …)
 *   3. options — any option contract, or a stock in the 'options' sleeve (assigned wheel shares)
 *   4. core / satellite — the stock is in that core_holdings sleeve
 *   5. swing   — everything else
 * Limitation: a stock held by core AND traded by swing counts as core.
 *
 * Realized P&L uses average cost per strategy+symbol, replayed from the account's first fill.
 * Paper records no expiry activity, so an option past its expiry that is no longer held is
 * closed at $0 on its expiry date.
 */
const axios = require('axios');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const OCC = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
const CRYPTO_BASES = new Set(['BTC', 'ETH', 'SOL', 'LTC', 'BCH', 'LINK', 'UNI', 'AAVE', 'DOT', 'AVAX', 'DOGE', 'SHIB', 'XRP', 'MKR', 'CRV', 'USDT', 'USDC']);
const STRATEGIES = ['swing', 'core', 'satellite', 'options', 'bear', 'crypto'];
const DAY = 86400000;

const isCrypto = s => s.includes('/') || (/USD[TC]?$/.test(s) && CRYPTO_BASES.has(s.replace(/USD[TC]?$/, '')));
const occExpiry = s => { const m = OCC.exec(s); return m ? `20${m[2]}-${m[3]}-${m[4]}` : null; };
const norm = s => String(s || '').replace('/', '');

/** Pick the strategy for one fill or position. ctx = { bearOrders:Set, bearSymbols:Set, sleeves:Map(symbol→sleeve) } */
function classify({ symbol, orderId }, ctx) {
    const s = norm(symbol);
    if ((orderId && ctx.bearOrders.has(orderId)) || ctx.bearSymbols.has(s)) return 'bear';
    if (isCrypto(s)) return 'crypto';
    if (OCC.test(s)) return 'options';
    const sleeve = ctx.sleeves.get(s);
    if (sleeve === 'options') return 'options';
    if (sleeve === 'core' || sleeve === 'satellite') return sleeve;
    return 'swing';
}

/**
 * Replay fills (sorted oldest first) with average cost; returns realized events and what is
 * still open. fills: [{ time, symbol, side, qty, price, strategy }]
 */
function replay(fills, { today, heldSymbols = new Set() } = {}) {
    const book = new Map(); // strategy|symbol → { qty, avg, strategy, symbol }
    const events = [];      // { time, strategy, symbol, pnl }
    let unknownBasis = 0;
    for (const f of fills) {
        const sym = norm(f.symbol);
        const mult = OCC.test(sym) ? 100 : 1;
        const key = `${f.strategy}|${sym}`;
        const p = book.get(key) || { qty: 0, avg: 0, strategy: f.strategy, symbol: sym };
        let t = (f.side === 'buy' ? 1 : -1) * Math.abs(f.qty);
        const px = f.price;
        if (p.qty === 0 || Math.sign(p.qty) === Math.sign(t)) {
            // A plain sale (not a short sale) with nothing bought here — e.g. a renamed ticker (BK → BNY).
            if (p.qty === 0 && t < 0 && !OCC.test(sym) && f.rawSide === 'sell') unknownBasis++;
            p.avg = (Math.abs(p.qty) * p.avg + Math.abs(t) * px) / (Math.abs(p.qty) + Math.abs(t));
            p.qty += t;
        } else {
            const close = Math.min(Math.abs(t), Math.abs(p.qty));
            events.push({ time: f.time, strategy: f.strategy, symbol: sym, pnl: close * (px - p.avg) * Math.sign(p.qty) * mult });
            p.qty += Math.sign(t) * close;
            t -= Math.sign(t) * close;
            if (Math.abs(p.qty) < 1e-9) { p.qty = 0; p.avg = 0; }
            if (Math.abs(t) > 1e-9) { p.qty = t; p.avg = px; }
        }
        book.set(key, p);
    }
    // Options that expired while still on the book and are no longer held → closed at $0.
    for (const p of book.values()) {
        const exp = occExpiry(p.symbol);
        if (exp && p.qty !== 0 && exp < today && !heldSymbols.has(p.symbol)) {
            events.push({ time: `${exp}T21:00:00Z`, strategy: p.strategy, symbol: p.symbol, pnl: (0 - p.avg) * p.qty * 100, expired: true });
            p.qty = 0;
        }
    }
    return { events, open: [...book.values()].filter(p => Math.abs(p.qty) > 1e-9), unknownBasis };
}

function sumBy(rows, since, field = 'pnl') {
    const out = Object.fromEntries(STRATEGIES.map(s => [s, 0]));
    for (const r of rows) if (!since || r.time >= since) out[r.strategy] = (out[r.strategy] || 0) + r[field];
    return out;
}

async function _client(userId) {
    const c = await require('./userDatabaseService').getUserAlpacaCredentials(userId);
    const base = c.isPaper ? 'https://paper-api.alpaca.markets/v2' : 'https://api.alpaca.markets/v2';
    return { base, isPaper: c.isPaper === true, headers: { 'APCA-API-KEY-ID': c.keyId, 'APCA-API-SECRET-KEY': c.secretKey } };
}

async function _activities(cl) {
    const all = [];
    let token;
    for (let i = 0; i < 400; i++) {
        const r = (await axios.get(`${cl.base}/account/activities`, { headers: cl.headers, timeout: 20000,
            params: { after: '2026-01-01T00:00:00Z', direction: 'asc', page_size: 100, page_token: token } })).data;
        if (!r.length) break;
        all.push(...r);
        token = r[r.length - 1].id;
        if (r.length < 100) break;
    }
    return all;
}

async function _context(userId) {
    const bear = await query(`SELECT symbol, long_contract, short_contract, entry_order_id, stop_order_id, exit_order_id, meta
                              FROM bear_positions WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] }));
    const bearOrders = new Set(), bearSymbols = new Set();
    for (const r of bear.rows) {
        [r.entry_order_id, r.stop_order_id, r.exit_order_id].filter(Boolean).forEach(id => bearOrders.add(id));
        Object.values(r.meta || {}).filter(v => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v)).forEach(id => bearOrders.add(id));
        [r.long_contract, r.short_contract].filter(Boolean).forEach(s => bearSymbols.add(norm(s)));
    }
    const sl = await query(`SELECT symbol, sleeve FROM core_holdings WHERE user_id = $1 AND sleeve IN ('core','satellite','options')`, [userId]).catch(() => ({ rows: [] }));
    const sleeves = new Map(sl.rows.map(r => [norm(r.symbol).toUpperCase(), r.sleeve]));
    return { bearOrders, bearSymbols, sleeves };
}

/** One account's scoreboard. Read-only. */
async function buildAccount(userId, { now = new Date(), deps = {} } = {}) {
    const cl = deps.client || await _client(userId);
    const acts = deps.activities || await _activities(cl);
    const positions = deps.positions || (await axios.get(`${cl.base}/positions`, { headers: cl.headers, timeout: 15000 })).data;
    const account = deps.account || (await axios.get(`${cl.base}/account`, { headers: cl.headers, timeout: 15000 })).data;
    const ctx = deps.ctx || await _context(userId);
    const today = new Date(now.getTime() - 5 * 3600e3).toISOString().slice(0, 10);

    const fills = acts.filter(a => a.activity_type === 'FILL')
        .map(a => ({ time: a.transaction_time, symbol: a.symbol, side: a.side === 'buy' ? 'buy' : 'sell', rawSide: a.side, qty: +a.qty, price: +a.price,
            strategy: classify({ symbol: a.symbol, orderId: a.order_id }, ctx) }))
        .sort((a, b) => (a.time < b.time ? -1 : 1));
    const held = new Set(positions.map(p => norm(p.symbol)));
    const { events, unknownBasis } = replay(fills, { today, heldSymbols: held });

    const dated = a => a.transaction_time || `${a.date}T21:00:00Z`;
    const income = acts.filter(a => a.activity_type === 'DIV')
        .map(a => ({ time: dated(a), strategy: classify({ symbol: a.symbol }, ctx), pnl: +a.net_amount }));
    // Crypto fees come two ways: USD taken from sale proceeds (no symbol), and coin taken from
    // each purchase (symbol, negative qty × price). The coin never reaches the position, so
    // without this line it would sit on the book forever and the loss would never show.
    const cryptoFees = acts.filter(a => a.activity_type === 'CFEE')
        .map(a => ({ time: dated(a), strategy: 'crypto', pnl: a.symbol ? (+a.qty || 0) * (+a.price || 0) : +a.net_amount }));
    const regFees = acts.filter(a => a.activity_type === 'FEE').map(a => ({ time: dated(a), pnl: +a.net_amount }));
    const flows = acts.filter(a => ['CSD', 'CSW', 'JNLC', 'JNLS'].includes(a.activity_type)).reduce((s, a) => s + +a.net_amount, 0);
    const interest = acts.filter(a => a.activity_type === 'INT').reduce((s, a) => s + +a.net_amount, 0);

    const unreal = Object.fromEntries(STRATEGIES.map(s => [s, 0]));
    for (const p of positions) unreal[classify({ symbol: p.symbol }, ctx)] += +p.unrealized_pl;

    const since7 = new Date(now.getTime() - 7 * DAY).toISOString();
    const since30 = new Date(now.getTime() - 30 * DAY).toISOString();
    const all = [...events, ...income, ...cryptoFees];
    const windows = { d7: sumBy(all, since7), d30: sumBy(all, since30), all: sumBy(all, null) };
    const fees = { d7: regFees.filter(r => r.time >= since7).reduce((s, r) => s + r.pnl, 0),
        d30: regFees.filter(r => r.time >= since30).reduce((s, r) => s + r.pnl, 0), all: regFees.reduce((s, r) => s + r.pnl, 0) };

    // Honesty check: everything we can explain vs what the equity really did.
    const explained = Object.values(windows.all).reduce((s, v) => s + v, 0) + fees.all + interest + Object.values(unreal).reduce((s, v) => s + v, 0);
    let startEquity = null;
    if (cl.isPaper) {
        const h = deps.history || (await axios.get(`${cl.base}/account/portfolio/history`, { headers: cl.headers, timeout: 20000,
            params: { period: 'all', timeframe: '1D' } }).catch(() => ({ data: null }))).data;
        startEquity = h?.base_value ?? (h?.equity || []).find(v => v > 0) ?? null;
    }
    const realChange = cl.isPaper ? (startEquity != null ? +account.equity - startEquity : null) : +account.equity - flows;
    return {
        userId, isPaper: cl.isPaper, equity: +account.equity, windows, unrealized: unreal, fees, interest,
        check: { explained, realChange, gap: realChange == null ? null : realChange - explained },
        counts: { fills: fills.length, unknownBasis, expiredOptions: events.filter(e => e.expired).length },
    };
}

const usd = n => (n == null ? '   n/a' : `${n < 0 ? '−' : '+'}$${Math.abs(n).toFixed(0)}`);
const NAMES = { swing: 'Swing', core: 'Core', satellite: 'Satellite', options: 'Options', bear: 'Bear side', crypto: 'Crypto' };

function format(name, a, spy) {
    const pad = (s, n) => String(s).padStart(n);
    const lines = [`${'Strategy'.padEnd(10)}${pad('7 days', 8)}${pad('30 days', 9)}${pad('All', 8)}${pad('Open', 8)}`];
    for (const s of STRATEGIES) {
        const vals = [a.windows.d7[s], a.windows.d30[s], a.windows.all[s], a.unrealized[s]];
        if (vals.every(v => Math.abs(v) < 0.5)) continue;
        lines.push(`${NAMES[s].padEnd(10)}${pad(usd(vals[0]), 8)}${pad(usd(vals[1]), 9)}${pad(usd(vals[2]), 8)}${pad(usd(vals[3]), 8)}`);
    }
    lines.push(`${'Reg. fees'.padEnd(10)}${pad(usd(a.fees.d7), 8)}${pad(usd(a.fees.d30), 9)}${pad(usd(a.fees.all), 8)}`);
    const tot = w => Object.values(a.windows[w]).reduce((x, y) => x + y, 0) + a.fees[w];
    lines.push(`${'TOTAL'.padEnd(10)}${pad(usd(tot('d7')), 8)}${pad(usd(tot('d30')), 9)}${pad(usd(tot('all')), 8)}${pad(usd(Object.values(a.unrealized).reduce((x, y) => x + y, 0)), 8)}`);
    const gap = a.check.gap == null ? 'equity start unknown' : `${usd(a.check.gap)} not explained by the table`;
    return `<b>${name}</b> (${a.isPaper ? 'paper' : 'LIVE'}) · equity $${a.equity.toFixed(0)}\n<pre>${lines.join('\n')}</pre>\n` +
        `Realized = closed trades + dividends + crypto fees. Open = today's unrealized.\n` +
        `Check vs broker equity: ${gap}${a.counts.unknownBasis ? ` · ${a.counts.unknownBasis} sales had no recorded buy` : ''}` +
        `${a.counts.expiredOptions ? ` · ${a.counts.expiredOptions} options expired` : ''}` +
        (spy ? `\nSPY: 7 days ${spy.d7 >= 0 ? '+' : ''}${spy.d7.toFixed(1)}%, 30 days ${spy.d30 >= 0 ? '+' : ''}${spy.d30.toFixed(1)}%` : '');
}

async function _spy(cl) {
    try {
        const bars = (await axios.get('https://data.alpaca.markets/v2/stocks/SPY/bars', { headers: cl.headers, timeout: 15000,
            params: { timeframe: '1Day', start: new Date(Date.now() - 50 * DAY).toISOString().slice(0, 10), feed: 'iex', limit: 100 } })).data.bars || [];
        const last = bars[bars.length - 1].c;
        const at = days => { const t = new Date(Date.now() - days * DAY).toISOString(); return [...bars].reverse().find(b => b.t <= t)?.c; };
        return { d7: (last / at(7) - 1) * 100, d30: (last / at(30) - 1) * 100 };
    } catch (_) { return null; }
}

function _userIds() {
    const env = (process.env.BROKER_SCOREBOARD_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    return env.length ? env : ['83f08677-e55a-48d1-bd31-f5b56fa79c23', 'ca632c53-8798-46f4-be94-29be0fede7f2'];
}

async function runWeekly({ now = new Date(), send = true } = {}) {
    const parts = [];
    let spy = null;
    for (const userId of _userIds()) {
        try {
            const cl = await _client(userId);
            if (!spy) spy = await _spy(cl);
            const a = await buildAccount(userId, { now, deps: { client: cl } });
            const u = await query('SELECT username FROM users WHERE id = $1', [userId]).catch(() => ({ rows: [] }));
            parts.push(format(u.rows[0]?.username || userId.slice(0, 8), a, spy));
        } catch (err) {
            logger.warn('[BrokerScoreboard] Account failed', { userId, error: err.message });
            parts.push(`<b>${userId.slice(0, 8)}</b>: could not read the broker (${err.message})`);
        }
    }
    const text = `📒 <b>Broker scoreboard</b> — from the broker's fills only, ${now.toISOString().slice(0, 10)}\n\n${parts.join('\n\n')}`;
    if (send) {
        await require('./telegramAlertService').sendAdminMessage(text, 'HTML').catch(() => {});
        await require('./reportArchiveService').save({ kind: 'broker_scoreboard', title: `Broker scoreboard — ${now.toISOString().slice(0, 10)}`, body: text, format: 'html', adminOnly: true }).catch(() => {});
    }
    logger.info('[BrokerScoreboard] Built', { accounts: parts.length });
    return text;
}

module.exports = { classify, replay, buildAccount, format, runWeekly, isCrypto, occExpiry };
