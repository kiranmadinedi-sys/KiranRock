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
 * 2026-10-26 additions: max 2 open puts per sector; the underlying is protected from the swing bot
 * while a put is open (and after assignment); assignment P&L is premium minus the strike-vs-market
 * loss on the delivered shares (was: always booked as a full-premium win); unfilled entries step
 * down from mid toward the bid (3 steps, never under the minimum premium); results are compared with
 * what the same collateral would earn in T-bills (RISK_FREE_PCT, default 4%/yr).
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
    maxPerSector: 2,
    repriceAfterMin: 45,         // minutes an unfilled entry waits before stepping its price down
    repriceSteps: 3,             // mid → mid − 1/3, 2/3, 3/3 of (mid − bid), floored at the min premium
};
const riskFreePct = () => parseFloat(process.env.RISK_FREE_PCT || '4');
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
    await query(`ALTER TABLE options_income_trades
        ADD COLUMN IF NOT EXISTS sector TEXT,
        ADD COLUMN IF NOT EXISTS reprice_count INT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_reprice_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS assigned_price NUMERIC`);
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
// A DATE column comes back from pg as a local-midnight Date object; String(date).slice(0, 10) gave
// "Fri Nov 20", parsed as Nov 20 2001 — so every open put looked expired and was never managed
// (no stop, take-profit or 7-day close from the first entry on 10-20 until the fix on 10-30).
const ymd = v => v instanceof Date
    ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
    : String(v).slice(0, 10);

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
    const sectorCount = {};
    for (const x of open) if (x.sector) sectorCount[x.sector] = (sectorCount[x.sector] || 0) + 1;
    // Stocks the account already owns (swing or core) — a put on them would double the exposure and
    // tangle a swing stop with assigned shares.
    const owned = new Set((await query(`SELECT UPPER(symbol) AS s FROM holdings WHERE user_id = $1 AND quantity > 0`, [String(userId)])).rows.map(r => r.s));
    const coreSyms = await require('./coreHoldingsService').getCoreSymbols(userId).catch(() => null);
    if (!coreSyms) return { opened: [], reason: 'could not read protected symbols' };
    const opened = [];
    for (const u of await candidateUnderlyings()) {
        if (slots <= 0) break;
        if (held.has(u.symbol) || owned.has(u.symbol) || coreSyms.has(u.symbol)) continue;
        if ((sectorCount[u.sector] || 0) >= CFG.maxPerSector) continue;
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
            await query(`INSERT INTO options_income_trades (user_id, contract, underlying, strike, expiry, open_order_id, entry_premium, entry_delta, collateral, next_earnings, sector)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                [String(userId), pick.contract, u.symbol, pick.strike, pick.expiry, o.id, limit, pick.delta, need, nextEarn, u.sector]);
            await require('./coreHoldingsService').setOptionsProtected(userId, u.symbol, true);
            sectorCount[u.sector] = (sectorCount[u.sector] || 0) + 1;
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
        // One put failing (bad data, DB error) must not stop the others being managed (2026-10-30).
        try {
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
                    await _releaseIfDone(userId, t.underlying);
                    continue;
                } else if (t.status === 'pending_open') {
                    await _maybeReprice(client, userId, t, o, now);
                    continue;
                } else if (t.status === 'pending_close' && filled) {
                    const close = Number(o.filled_avg_price);
                    await query(`UPDATE options_income_trades SET status = 'closed', close_premium = $2::numeric, closed_at = NOW(), pnl = ($3::numeric - $2::numeric) * 100 * qty WHERE id = $1`,
                        [t.id, close, Number(t.entry_premium)]);
                    actions.push({ contract: t.contract, closed: close });
                    await _releaseIfDone(userId, t.underlying);
                    continue;
                } else if (t.status === 'pending_close' && dead) {
                    await query(`UPDATE options_income_trades SET status = 'open', close_order_id = NULL WHERE id = $1`, [t.id]);
                    t.status = 'open';
                } else continue;
            }
            if (t.status !== 'open') continue;
            const dte = dayDiff(ymd(t.expiry), today);
            // expired / assigned: the contract is gone from positions
            if (dte < 0) {
                const pos = await axios.get(`${client.trade}/v2/positions/${t.contract}`, { headers: client.headers }).catch(() => null);
                if (!pos) {
                    const assigned = (await axios.get(`${client.trade}/v2/positions/${t.underlying}`, { headers: client.headers }).catch(() => null))?.data;
                    if (assigned) {
                        // Shares were bought at the strike; mark them at today's price (2026-10-26 — was
                        // booked as a full-premium win however far the stock had fallen).
                        const px = Number(assigned.current_price) || Number(t.strike);
                        const pnl = assignmentPnl({ premium: Number(t.entry_premium), strike: Number(t.strike), price: px, qty: Number(t.qty) });
                        await query(`UPDATE options_income_trades SET status = 'assigned', closed_at = NOW(), close_premium = 0, assigned_price = $2, pnl = $3,
                                     close_reason = $4 WHERE id = $1`,
                            [t.id, px, pnl, `assigned — 100 shares at $${Number(t.strike).toFixed(2)}, worth $${px.toFixed(2)} (held, protected from the swing bot)`]);
                        await require('./coreHoldingsService').setOptionsProtected(userId, t.underlying, true, 'assigned from short put');
                    } else {
                        await query(`UPDATE options_income_trades SET status = 'expired', closed_at = NOW(), close_premium = 0, pnl = $2::numeric * 100 * qty,
                                     close_reason = 'expired worthless' WHERE id = $1`, [t.id, Number(t.entry_premium)]);
                        await _releaseIfDone(userId, t.underlying);
                    }
                } else {
                    // Past expiry but the broker still holds it: never silent again (this is how the
                    // 10-30 date bug hid every open put from management for 10 days).
                    logger.warn('[OptionsIncome] Put past expiry still held at broker — not managed', { userId, contract: t.contract, expiry: ymd(t.expiry), dte });
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
        } catch (err) {
            logger.warn('[OptionsIncome] Managing put failed — others continue', { userId, contract: t.contract, error: err.message });
        }
    }
    return actions;
}

/** Pure: P&L of an assigned put marked at today's price: premium kept minus (strike − price) on the shares. */
function assignmentPnl({ premium, strike, price, qty = 1 }) {
    return Math.round((premium - Math.max(0, strike - price)) * 100 * qty * 100) / 100;
}

/** Pure: next limit for an unfilled sell-to-open, or null to leave it. */
function stepDownLimit({ mid, bid, step, steps, floor, current }) {
    if (!(mid > 0 && bid > 0) || step > steps) return null;
    const next = roundTick(Math.max(floor, mid - (mid - bid) * step / steps));
    return next < current ? next : null;
}

async function _maybeReprice(client, userId, t, order, now) {
    if (Number(t.reprice_count) >= CFG.repriceSteps) return;
    const since = new Date(t.last_reprice_at || t.opened_at).getTime();
    if (now.getTime() - since < CFG.repriceAfterMin * 60000) return;
    const s = (await axios.get(`${DATA}/v1beta1/options/snapshots`, {
        headers: client.headers, params: { symbols: t.contract, feed: 'indicative' }, timeout: 15000,
    }).catch(() => ({ data: {} }))).data?.snapshots?.[t.contract];
    const bid = s?.latestQuote?.bp, ask = s?.latestQuote?.ap;
    const floor = roundTick(Number(t.strike) * CFG.minPremiumPct / 100);
    const next = stepDownLimit({ mid: (bid + ask) / 2, bid, step: Number(t.reprice_count) + 1, steps: CFG.repriceSteps,
                                 floor, current: Number(order.limit_price || t.entry_premium) });
    await query(`UPDATE options_income_trades SET reprice_count = reprice_count + 1, last_reprice_at = NOW() WHERE id = $1`, [t.id]);
    if (next == null) return;
    try {
        const o = (await axios.patch(`${client.trade}/v2/orders/${t.open_order_id}`, { limit_price: String(next) },
            { headers: client.headers, timeout: 15000 })).data;
        await query(`UPDATE options_income_trades SET open_order_id = $2, entry_premium = $3 WHERE id = $1`, [t.id, o.id, next]);
        logger.info('[OptionsIncome] Entry repriced', { userId, contract: t.contract, from: order.limit_price, to: next, step: Number(t.reprice_count) + 1 });
    } catch (err) {
        logger.warn('[OptionsIncome] Reprice failed', { userId, contract: t.contract, error: err.response?.data?.message || err.message });
    }
}

/** Drop the swing-bot protection once no open/pending put remains on that underlying (never after assignment). */
async function _releaseIfDone(userId, underlying) {
    const r = await query(`SELECT 1 FROM options_income_trades WHERE user_id = $1 AND underlying = $2
                           AND status IN ('pending_open', 'open', 'pending_close', 'assigned') LIMIT 1`, [String(userId), underlying]);
    if (!r.rows.length) await require('./coreHoldingsService').setOptionsProtected(userId, underlying, false).catch(() => {});
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
               COUNT(*) FILTER (WHERE status = 'assigned')::int AS assigned,
               COALESCE(SUM(collateral * GREATEST(1, EXTRACT(EPOCH FROM (COALESCE(closed_at, NOW()) - opened_at)) / 86400) / 365.0 * $1 / 100)
                        FILTER (WHERE status IN ('open', 'pending_close', 'closed', 'expired', 'assigned')), 0)::float AS tbill_benchmark
        FROM options_income_trades`, [riskFreePct()]);
    return { ...r.rows[0], riskFreePct: riskFreePct() };
}

/**
 * Exit plan + risk flags for one open put (2026-10-27): the prices and dates the management loop
 * acts on, plus what assignment would cost. Note the stop is checked in market hours only — an
 * earnings gap can fill well past it.
 */
function exitPlan(t, { mark = null, stockPrice = null } = {}) {
    const entry = Number(t.premium ?? t.entry_premium), strike = Number(t.strike);
    const exp = new Date(`${ymd(t.expiry)}T00:00:00Z`);
    const closeBy = new Date(exp.getTime() - CFG.closeDte * 86400000).toISOString().slice(0, 10);
    const earnings = t.next_earnings ? String(t.next_earnings).slice(0, 10) : null;
    const plan = {
        takeProfitAt: Math.round(entry * CFG.takeProfitFrac * 100) / 100,
        stopAt: Math.round(entry * CFG.stopMultiple * 100) / 100,
        closeBy, earnings,
        earningsBeforeClose: !!earnings && earnings <= closeBy,
        assignmentCost: strike * 100 * (t.qty || 1),
        mark, stockPrice,
        cushionPct: stockPrice ? Math.round((stockPrice / strike - 1) * 10000) / 100 : null,
    };
    plan.flags = [
        ...(stockPrice != null && stockPrice < strike ? ['below strike'] : []),
        ...(plan.earningsBeforeClose ? ['earnings before close'] : []),
        ...(mark != null && mark >= entry * (CFG.stopMultiple - 1) ? ['near stop'] : []),
    ];
    return plan;
}

module.exports = { CFG, ymd, exitPlan, choosePut, assignmentPnl, stepDownLimit, nextEarnings, candidateUnderlyings, runEntries, runManagement, runTick, summary, ensureTable };
