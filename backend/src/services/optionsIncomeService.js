/**
 * Options income — cash-secured puts, PAPER ONLY (built 2026-10-17).
 *
 * Why this strategy: a replay of the last two monthly SPY cycles (Aug→Sep, Sep→Oct, a flat
 * market) showed BUYING options losing 66-100% every time, while SELLING out-of-the-money
 * puts/calls earned a steady ~0.3%/month — but SPY needs ~$72K of collateral per contract.
 * So this tests the income side on affordable quality stocks ($15-100), using Alpaca's free
 * indicative options data (quotes + delta), no paid feed.
 *
 * Rules:
 *   entry  — once a trading day after 11:00 ET: sell 1 put, 25-45 days out, delta −0.15..−0.30,
 *            mid premium ≥ 0.6% of strike, bid/ask spread ≤ 25% of mid; underlying from the
 *            latest scan (score ≥ 70, above its 200-day average, no earnings before expiry,
 *            not Gemini Strong Bearish, not a fund); one position per underlying.
 *   limits — ≤ 5 open, ≤ $10K collateral each, ≤ OPTIONS_INCOME_MAX_COLLATERAL ($30K) total.
 *   exit   — buy back at 50% of the premium (take the profit), or with ≤ 7 days left, or if the
 *            put costs ≥ 3× what we sold it for (stop). Day limit orders; reconciled each tick.
 *
 * HARD GUARD: refuses any account whose Alpaca credentials are not paper. Enabled per
 * account via OPTIONS_INCOME_USER_IDS. Results go to options_income_trades and the
 * Saturday report; anything for real money would go through an approval request.
 */
const axios = require('axios');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const CFG = {
    minDte: 25, maxDte: 45,
    minDelta: -0.30, maxDelta: -0.15,
    minPremiumPct: 0.6,          // mid premium as % of strike
    maxSpreadPct: 25,            // (ask − bid) as % of mid
    minPrice: 15, maxPrice: 100,
    maxPositions: 5,
    maxCollateralEach: 10000,
    takeProfitFrac: 0.5,         // buy back when the put costs ≤ 50% of the premium received
    stopMultiple: 3,             // buy back when the put costs ≥ 3× the premium received
    closeDte: 7,
};
const maxCollateralTotal = () => parseFloat(process.env.OPTIONS_INCOME_MAX_COLLATERAL || '30000');
const userIds = () => (process.env.OPTIONS_INCOME_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

let _ready = false;
async function ensureTable() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS options_income_trades (
            id              SERIAL      PRIMARY KEY,
            user_id         TEXT        NOT NULL,
            contract        TEXT        NOT NULL,
            underlying      TEXT        NOT NULL,
            strike          NUMERIC     NOT NULL,
            expiry          DATE        NOT NULL,
            qty             INT         NOT NULL DEFAULT 1,
            status          TEXT        NOT NULL DEFAULT 'pending_open'
                            CHECK (status IN ('pending_open', 'open', 'pending_close', 'closed', 'not_filled', 'expired', 'assigned')),
            open_order_id   TEXT,
            entry_premium   NUMERIC,
            entry_delta     NUMERIC,
            collateral      NUMERIC,
            opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            close_order_id  TEXT,
            close_premium   NUMERIC,
            close_reason    TEXT,
            closed_at       TIMESTAMPTZ,
            pnl             NUMERIC
        )`);
    await query(`ALTER TABLE options_income_trades ADD COLUMN IF NOT EXISTS next_earnings DATE`);
    _ready = true;
}

async function _client(userId) {
    const c = await require('./userDatabaseService').getUserAlpacaCredentials(userId);
    if (c.isPaper === false) throw new Error('options income is PAPER ONLY — refusing a live account');
    return {
        trade: 'https://paper-api.alpaca.markets',
        headers: { 'APCA-API-KEY-ID': c.keyId, 'APCA-API-SECRET-KEY': c.secretKey },
    };
}

const DATA = 'https://data.alpaca.markets';
const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);
const roundTick = p => (p >= 3 ? Math.round(p * 20) / 20 : Math.round(p * 100) / 100);
const etToday = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** Pick the best put to sell on one underlying, or null. Pure apart from the snapshot fetch. */
async function pickPut(client, underlying, price, now = new Date()) {
    const today = etToday(now);
    const from = new Date(now.getTime() + CFG.minDte * 86400000).toISOString().slice(0, 10);
    const to = new Date(now.getTime() + CFG.maxDte * 86400000).toISOString().slice(0, 10);
    const r = await axios.get(`${DATA}/v1beta1/options/snapshots/${underlying}`, {
        headers: client.headers, timeout: 15000,
        params: { feed: 'indicative', type: 'put', expiration_date_gte: from, expiration_date_lte: to,
                  strike_price_gte: (price * 0.80).toFixed(2), strike_price_lte: (price * 0.98).toFixed(2), limit: 200 },
    });
    return choosePut(r.data?.snapshots || {}, today);
}

/** Selection rules over a snapshots map — exported for tests. */
function choosePut(snapshots, today) {
    const parse = sym => {
        const m = sym.match(/^([A-Z.]+)(\d{2})(\d{2})(\d{2})P(\d{8})$/);
        return m ? { expiry: `20${m[2]}-${m[3]}-${m[4]}`, strike: parseInt(m[5], 10) / 1000 } : null;
    };
    const cands = [];
    for (const [sym, s] of Object.entries(snapshots)) {
        const p = parse(sym); if (!p) continue;
        const bid = s.latestQuote?.bp, ask = s.latestQuote?.ap, delta = s.greeks?.delta;
        if (!(bid > 0 && ask > 0) || delta == null) continue;
        const mid = (bid + ask) / 2;
        const dte = dayDiff(p.expiry, today);
        if (dte < CFG.minDte || dte > CFG.maxDte) continue;
        if (delta < CFG.minDelta || delta > CFG.maxDelta) continue;
        if ((ask - bid) / mid * 100 > CFG.maxSpreadPct) continue;
        const premiumPct = mid / p.strike * 100;
        if (premiumPct < CFG.minPremiumPct) continue;
        if (p.strike * 100 > CFG.maxCollateralEach) continue;
        cands.push({ contract: sym, ...p, bid, ask, mid, delta, dte, premiumPct, monthlyPct: premiumPct * 30 / dte });
    }
    // best premium per month of collateral
    cands.sort((a, b) => b.monthlyPct - a.monthlyPct);
    return cands[0] || null;
}

/**
 * Next earnings date for one symbol from Finnhub (2026-10-21: the scan's daysToEarnings is null for
 * every symbol, so SHAK sold a put straight across its Nov 5 report). Per-symbol on purpose — the
 * range calendar silently truncates at 1500 rows in earnings season. Cached per symbol per day.
 * Returns undefined when the lookup fails — callers must then skip (fail closed); null = none in window.
 */
const _earnCache = new Map();
async function nextEarnings(symbol, now = new Date()) {
    const day = now.toISOString().slice(0, 10);
    const hit = _earnCache.get(symbol);
    if (hit && hit.day === day) return hit.date;
    try {
        const to = new Date(now.getTime() + (CFG.maxDte + 5) * 86400000).toISOString().slice(0, 10);
        const resp = await axios.get('https://finnhub.io/api/v1/calendar/earnings', {
            params: { from: day, to, symbol, token: process.env.FINNHUB_KEY }, timeout: 15000 });
        const rows = resp.data?.earningsCalendar;
        if (!Array.isArray(rows)) throw new Error('bad earnings response');
        const date = rows.map(e => e.date).filter(Boolean).sort()[0] || null;
        _earnCache.set(symbol, { day, date });
        return date;
    } catch (err) {
        logger.warn('[OptionsIncome] Earnings lookup failed — skipping', { symbol, error: err.message });
        return undefined;
    }
}

/** Quality underlyings from the latest complete scan. */
async function candidateUnderlyings() {
    const LATEST_DATE_SQL = require('./precomputedUniverseService').buildLatestTradingScanDateSql();
    const r = await query(`
        SELECT symbol, ai_score::float AS score, (metadata->>'price')::float AS price,
               (metadata->>'aboveMa200')::boolean AS above200, (metadata->>'daysToEarnings')::int AS dte_earn,
               COALESCE(sector, 'Unknown') AS sector,
               (SELECT substring(l from '^Gemini: ([+-]?[0-9]+)')::int FROM jsonb_array_elements_text(metadata->'scoringLog') l WHERE l LIKE 'Gemini:%' LIMIT 1) AS gem
        FROM daily_universe_analysis
        WHERE analysis_date = ${LATEST_DATE_SQL} AND passed_prescreen AND ai_score >= 70
        ORDER BY ai_score DESC, md5(symbol)`);
    return r.rows.filter(x => x.price >= CFG.minPrice && x.price <= CFG.maxPrice && x.above200 === true
        && x.sector !== 'Unknown' && !(x.gem != null && x.gem <= -3)
        && (x.dte_earn == null || x.dte_earn > CFG.maxDte));
}

async function _openRows(userId) {
    const r = await query(`SELECT * FROM options_income_trades WHERE user_id = $1 AND status IN ('pending_open', 'open', 'pending_close')`, [String(userId)]);
    return r.rows;
}

/** Once a trading day: open new short puts up to the limits. */
async function runEntries(userId, now = new Date()) {
    await ensureTable();
    const client = await _client(userId);
    const open = await _openRows(userId);
    let slots = CFG.maxPositions - open.length;
    let collateral = open.reduce((s, x) => s + Number(x.collateral || 0), 0);
    if (slots <= 0) return { opened: [], reason: 'max positions' };
    const held = new Set(open.map(x => x.underlying));
    const opened = [];
    for (const u of await candidateUnderlyings()) {
        if (slots <= 0) break;
        if (held.has(u.symbol)) continue;
        let pick;
        try { pick = await pickPut(client, u.symbol, u.price, now); } catch (err) { continue; }
        if (!pick) continue;
        const nextEarn = await nextEarnings(u.symbol, now);
        if (nextEarn === undefined) continue;
        if (nextEarn && nextEarn <= pick.expiry) {
            logger.info('[OptionsIncome] Skipped — earnings before expiry', { symbol: u.symbol, earnings: nextEarn, expiry: pick.expiry });
            continue;
        }
        const need = pick.strike * 100;
        if (collateral + need > maxCollateralTotal()) continue;
        const limit = roundTick(pick.mid);
        try {
            const o = (await axios.post(`${client.trade}/v2/orders`, {
                symbol: pick.contract, qty: '1', side: 'sell', type: 'limit', limit_price: String(limit),
                time_in_force: 'day', position_intent: 'sell_to_open',
            }, { headers: client.headers, timeout: 15000 })).data;
            await query(`INSERT INTO options_income_trades (user_id, contract, underlying, strike, expiry, open_order_id, entry_premium, entry_delta, collateral, next_earnings)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [String(userId), pick.contract, u.symbol, pick.strike, pick.expiry, o.id, limit, pick.delta, need, nextEarn]);
            logger.info('[OptionsIncome] Sell-to-open placed', { userId, contract: pick.contract, limit, delta: pick.delta, dte: pick.dte, premiumPct: pick.premiumPct.toFixed(2) });
            opened.push({ contract: pick.contract, limit, collateral: need });
            held.add(u.symbol); slots--; collateral += need;
        } catch (err) {
            logger.warn('[OptionsIncome] Order rejected', { userId, contract: pick.contract, error: err.response?.data?.message || err.message });
        }
    }
    return { opened };
}

/** Every tick in market hours: reconcile fills, take profits, stop losses, close near expiry. */
async function runManagement(userId, now = new Date()) {
    await ensureTable();
    const client = await _client(userId);
    const rows = await _openRows(userId);
    const today = etToday(now);
    const actions = [];
    for (const t of rows) {
        // reconcile the pending order first
        const oid = t.status === 'pending_close' ? t.close_order_id : t.status === 'pending_open' ? t.open_order_id : null;
        if (oid) {
            const o = (await axios.get(`${client.trade}/v2/orders/${oid}`, { headers: client.headers, timeout: 15000 }).catch(() => ({ data: null }))).data;
            if (!o) continue;
            const filled = o.status === 'filled', dead = ['canceled', 'expired', 'rejected'].includes(o.status);
            if (t.status === 'pending_open' && filled) {
                await query(`UPDATE options_income_trades SET status = 'open', entry_premium = $2 WHERE id = $1`, [t.id, Number(o.filled_avg_price)]);
                t.status = 'open'; t.entry_premium = Number(o.filled_avg_price);
            } else if (t.status === 'pending_open' && dead) {
                await query(`UPDATE options_income_trades SET status = 'not_filled', closed_at = NOW() WHERE id = $1`, [t.id]);
                continue;
            } else if (t.status === 'pending_close' && filled) {
                const close = Number(o.filled_avg_price);
                await query(`UPDATE options_income_trades SET status = 'closed', close_premium = $2, closed_at = NOW(), pnl = ($3 - $2) * 100 * qty WHERE id = $1`,
                    [t.id, close, Number(t.entry_premium)]);
                actions.push({ contract: t.contract, closed: close });
                continue;
            } else if (t.status === 'pending_close' && dead) {
                await query(`UPDATE options_income_trades SET status = 'open', close_order_id = NULL WHERE id = $1`, [t.id]);
                t.status = 'open';
            } else continue;
        }
        if (t.status !== 'open') continue;
        const dte = dayDiff(String(t.expiry).slice(0, 10), today);
        // expired / assigned: the contract is gone from positions
        if (dte < 0) {
            const pos = await axios.get(`${client.trade}/v2/positions/${t.contract}`, { headers: client.headers }).catch(() => null);
            if (!pos) {
                const assigned = await axios.get(`${client.trade}/v2/positions/${t.underlying}`, { headers: client.headers }).catch(() => null);
                await query(`UPDATE options_income_trades SET status = $2, closed_at = NOW(), close_premium = 0, pnl = $3 * 100 * qty, close_reason = $4 WHERE id = $1`,
                    [t.id, assigned ? 'assigned' : 'expired', Number(t.entry_premium), assigned ? 'assigned (shares delivered)' : 'expired worthless']);
            }
            continue;
        }
        const s = (await axios.get(`${DATA}/v1beta1/options/snapshots`, {
            headers: client.headers, params: { symbols: t.contract, feed: 'indicative' }, timeout: 15000,
        }).catch(() => ({ data: {} }))).data?.snapshots?.[t.contract];
        const ask = s?.latestQuote?.ap;
        if (!(ask > 0)) continue;
        const entry = Number(t.entry_premium);
        const reason = ask <= entry * CFG.takeProfitFrac ? 'take profit (50%)'
            : ask >= entry * CFG.stopMultiple ? 'stop (3× premium)'
            : dte <= CFG.closeDte ? `close near expiry (${dte}d)` : null;
        if (!reason) continue;
        try {
            const o = (await axios.post(`${client.trade}/v2/orders`, {
                symbol: t.contract, qty: String(t.qty), side: 'buy', type: 'limit', limit_price: String(roundTick(ask)),
                time_in_force: 'day', position_intent: 'buy_to_close',
            }, { headers: client.headers, timeout: 15000 })).data;
            await query(`UPDATE options_income_trades SET status = 'pending_close', close_order_id = $2, close_reason = $3 WHERE id = $1`, [t.id, o.id, reason]);
            logger.info('[OptionsIncome] Buy-to-close placed', { userId, contract: t.contract, ask, entry, reason });
            actions.push({ contract: t.contract, reason });
        } catch (err) {
            logger.warn('[OptionsIncome] Close rejected', { userId, contract: t.contract, error: err.response?.data?.message || err.message });
        }
    }
    return actions;
}

/** Scheduler tick (every 5 min): management in market hours; entries once a day after 11:00 ET. */
const _enteredOn = new Set();
async function runTick(now = new Date()) {
    const ids = userIds();
    if (!ids.length) return;
    const { isMarketOpen } = require('../utils/marketCalendar');
    if (!isMarketOpen(now)) return;
    const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
    const etMin = parseInt(et.find(p => p.type === 'hour').value, 10) * 60 + parseInt(et.find(p => p.type === 'minute').value, 10);
    for (const id of ids) {
        try {
            await runManagement(id, now);
            const key = `${id}:${etToday(now)}`;
            if (etMin >= 11 * 60 && etMin < 15 * 60 + 30 && !_enteredOn.has(key)) {
                _enteredOn.add(key);
                const r = await runEntries(id, now);
                if (r.opened?.length) logger.info('[OptionsIncome] Entries', { userId: id, opened: r.opened });
            }
        } catch (err) {
            logger.warn('[OptionsIncome] Tick failed (non-blocking)', { userId: id, error: err.message });
        }
    }
}

/** For the Saturday report. */
async function summary() {
    await ensureTable();
    const r = await query(`
        SELECT COUNT(*) FILTER (WHERE status IN ('open', 'pending_close'))::int AS open,
               COALESCE(SUM(collateral) FILTER (WHERE status IN ('open', 'pending_close')), 0)::float AS collateral,
               COUNT(*) FILTER (WHERE status IN ('closed', 'expired', 'assigned'))::int AS done,
               COUNT(*) FILTER (WHERE status IN ('closed', 'expired', 'assigned') AND pnl > 0)::int AS wins,
               COALESCE(SUM(pnl) FILTER (WHERE status IN ('closed', 'expired', 'assigned')), 0)::float AS pnl,
               COUNT(*) FILTER (WHERE status = 'assigned')::int AS assigned
        FROM options_income_trades`);
    return r.rows[0];
}

module.exports = { CFG, choosePut, nextEarnings, candidateUnderlyings, runEntries, runManagement, runTick, summary, ensureTable };
