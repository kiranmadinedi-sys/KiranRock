/**
 * Bear side — PAPER ONLY test (built 2026-11-20, the user asked for it after two −2%/−3% days:
 * "we can't predict always in one direction", so the bot should be able to make money, or at least
 * lose less, when the market falls).
 *
 * Three legs, all switched on only while the bot's own market regime is BEAR (or PANIC):
 *   1. hedge  — buy inverse index ETFs (SH = −1× S&P 500, PSQ = −1× Nasdaq-100). Plain buys: the most
 *               that can be lost is what was paid. BEAR_HEDGE_PCT (10%) of the account, half each.
 *   2. short  — sell short weak liquid stocks: below the 50- and 200-day averages, 3-month return ≥10 points
 *               worse than SPY, ≥$50M/day traded, easy to borrow, no earnings inside the hold, RSI(14) ≥ 30
 *               (not already extremely oversold), no +8% day in the last 20 sessions (squeeze history),
 *               not already −15% in 5 days, at most 2 per sector. Each BEAR_SHORT_EACH_PCT (2%), at most 5.
 *               Every short gets a GTC buy-stop 8% above entry the moment it fills (if the stop cannot be
 *               placed the short is covered at once — fail closed). The stop only ever moves down. Covered on
 *               −15% (take profit), 21 days, or if it stops being easy to borrow (checked daily). Never added to.
 *   3. spread — bear put spreads on SPY and QQQ: buy the at-the-money put, sell one 5% lower (4/3/2.5% if
 *               the wider one risks too much), 30-50 days out, debit ≤ 45% of the width, both legs bid/ask
 *               ≤ 15% of mid, natural debit ≤ 15% over mid, one multi-leg LIMIT order. Partial fills are kept
 *               as the real position (never re-ordered). Take profit at half the max gain, stop at half the
 *               debit, close with ≤ 7 days left; closes the short leg first with single-leg limit orders.
 *               (The options-income replay found BUYING options lost 66-100% in flat months — this tests
 *               the debit side only when the regime says the market is already falling.)
 *
 * Regime: BEAR → manage, and enter only once BEAR has lasted 18h and SPY isn't bouncing (+3% in 5 days or
 * back above its 20-day average). PANIC → manage + keep stops, no new entries; it counts as bear, so it never
 * starts the exit timer. NEUTRAL/CHOPPY → close after BEAR_EXIT_AFTER_HOURS (24h) with no bear reading.
 * BULL → close at once. After the book closes, the next BEAR must be confirmed again. Entries 10:30-15:30
 * ET, once a day per leg.
 *
 * Risk (max loss, not capital): hedge/short = distance to the stop, spread = the debit. Any one position
 * ≤ BEAR_MAX_TRADE_RISK_PCT (1%) of equity; everything open ≤ BEAR_MAX_RISK_PCT (5%). The weekly report also
 * shows capital deployed and a +5% overnight-gap stress loss (a gap jumps the stops).
 * Alerts (Telegram, once a day each): a short without a stop, a stop that can't be replaced, a borrow change,
 * a broker-vs-record mismatch, a spread close stuck for a day. Mismatches are never auto-fixed.
 *
 * Funding (the 2026-11-16 rule — sold puts must be covered by real cash): the hedge and spreads only use
 * free cash = cash − open put collateral − proceeds of open shorts − 5% of equity, unless
 * BEAR_ALLOW_MARGIN=true. Shorts need margin, not cash (their proceeds are never counted as free cash).
 * Gross cap: |market value| of hedges + |market value| of shorts + spread debits ≤ BEAR_GROSS_CAP_PCT (25%)
 * of equity — a capital limit, separate from the max-loss limits above.
 *
 * Isolation: hedge ETFs and shorted symbols are registered as the 'bear' sleeve in core_holdings, so the
 * swing bot never buys (a swing buy would silently cover a short), stops or sells them. Shorts and
 * spreads are tracked only in bear_positions (not holdings/trades); the reconciler already ignores short
 * and option positions, and reconcileFillHistory skips the order ids listed here.
 * Every day in BEAR the top-20 short candidates are logged with their price (bear_short_candidates), so
 * shorting is graded on all of them, not only the few traded.
 *
 * Second review pass (2026-11-21): stale/fallback regime readings are "unknown" (hold, no entries, no timers);
 * BULL_STRONG/BULL_MILD close the book (the regime service never says plain 'BULL' — that rule had never fired);
 * any fresh non-bear reading restarts the BEAR confirmation, which must also span two trading sessions. Shorts:
 * dividends due inside the hold are looked up (Alpaca corporate actions) and counted in max loss — special or
 * > 1%-of-price dividends are skipped, and an open short is covered before one goes ex; no entry into a stock up
 * 4%+ today or under a short-sale restriction; borrow re-checked hourly; squeeze warnings (6% in 15 min, 4×
 * volume, gap-up, possible halt) alert but never widen the stop. Exits: an unfilled hedge sell stays
 * pending_close until the broker confirms it; spread closes re-order only what the broker still holds; a
 * liquidation not done in 30 min alerts, and when done it is confirmed flat at the broker. Report: +10/20/30%
 * single-short gap stress, dividend liability, results by regime (BEAR moderate/high VIX, PANIC, recovery),
 * and an RSI-band shadow test of the rejected candidates.
 *
 * HARD GUARD: refuses any account whose Alpaca credentials are not paper. Enabled per account via
 * BEAR_SIDE_USER_IDS. Anything for real money would go through an approval request.
 */
const axios = require('axios');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const num = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) ? v : d; };
const CFG = {
    hedgeEtfs: [{ symbol: 'SH', weight: 0.5 }, { symbol: 'PSQ', weight: 0.5 }],
    hedgeStopPct: 6,             // sell a hedge ETF that has lost 6% (the market bounced)
    shortMax: 5,
    shortStopPct: 8,             // buy-stop this far above entry, trails down with the price
    shortTargetPct: 15,          // cover after a 15% fall
    shortMaxDays: 21,            // calendar days
    shortMinPrice: 20,
    shortUniverse: 300,          // most-traded non-fund stocks
    shortMax5dDropPct: 15,       // skip a stock already down >15% in 5 days (snap-back risk)
    spreadUnderlyings: ['SPY', 'QQQ'],
    spreadMinDte: 30, spreadMaxDte: 50,
    spreadWidthPct: 5,
    spreadMaxDebitFrac: 0.45,
    spreadTakeProfitFrac: 0.5,   // of the max gain (width − debit)
    spreadStopFrac: 0.5,         // spread value ≤ half the debit
    spreadCloseDte: 7,
    spreadPendingMaxMin: 60,     // cancel an unfilled entry after an hour
    cashBufferPct: 5,
    candidatesLogged: 20,
    // 2026-11-20 safety pass (review feedback, checked against data):
    maxShortsPerSector: 2,       // 7 of the first top-10 candidates were Technology
    shortMinRsi: 30,             // don't short a stock that is already extremely oversold
    shortMaxDayGainPct: 8,       // skip anything with a +8% day in the last 20 sessions (squeeze history)
    shortMinDollarVol: 50e6,     // average daily dollar volume
    shortMinRelWeakPct: 10,      // 3-month return at least 10 points worse than SPY's
    spreadWidthsPct: [5, 4, 3, 2.5], // narrower spreads when the wider one risks too much
    spreadMaxLegSpreadPct: 15,   // each leg: (ask − bid) / mid
    spreadMaxSlipFrac: 0.15,     // natural debit at most 15% over the mid debit
    bearConfirmHours: 18,        // BEAR must have lasted this long before new entries
    recoveryBounce5dPct: 3,      // SPY +3% in 5 days, or back above its 20-day average = recovering: no new entries
    stressGapPct: 5,             // report-only stress test: overnight market gap up of 5%
    shortStressBeta: 1.5,
    // 2026-11-21 second review pass (checked against code + Alpaca data):
    stressSingleGapsPct: [10, 20, 30], // report-only: one short (and all shorts) gapping up this much overnight
    staleRegimeMin: 30,          // a regime reading older than this (data-failure fallback) = unknown: no entries, no timers
    divMaxPctOfPrice: 1,         // skip a short whose dividend due inside the hold is > 1% of the price, or any special dividend
    entryMaxDayUpPct: 4,         // don't short a stock already up 4%+ today (squeezing / gapping up)
    ssrDropPct: 10,              // short-sale restriction (Rule 201): −10% from the prior close → skip today and the next day
    squeezeRisePct: 6,           // open short up 6%+ off its 15-minute low → alert (stop is never widened)
    squeezeWindowMin: 15,
    squeezeVolMult: 4,           // 15-minute volume ≥ 4× a normal 15 minutes while rising → alert
    gapUpAlertPct: 5,            // open short opened 5%+ above yesterday's close → alert
    haltNoQuoteMin: 10,          // no quote/trade for 10 min in market hours → possibly halted → alert
    borrowCheckMin: 60,          // re-check borrow status hourly (Alpaca has no recall / buy-in notice API)
    closeStuckMin: 30,           // liquidation still not done after 30 min → alert
};
const hedgePct = () => num('BEAR_HEDGE_PCT', 10);
const shortEachPct = () => num('BEAR_SHORT_EACH_PCT', 2);
const spreadPct = () => num('BEAR_SPREAD_PCT', 2);
const grossCapPct = () => num('BEAR_GROSS_CAP_PCT', 25);
const exitAfterHours = () => num('BEAR_EXIT_AFTER_HOURS', 24);
const allowMargin = () => String(process.env.BEAR_ALLOW_MARGIN || '').toLowerCase() === 'true';
// Risk = the most each position can lose: hedge/short = distance to its stop, spread = the whole debit.
const maxRiskPct = () => num('BEAR_MAX_RISK_PCT', 5);           // all bear positions together
const maxTradeRiskPct = () => num('BEAR_MAX_TRADE_RISK_PCT', 1); // any one position
// Gap stress (separate from stop-based risk): every short gapping +30% through its stop, plus a +5% market gap
// on hedges and spreads. A new position must keep this under BEAR_MAX_GAP_RISK_PCT of equity.
const maxGapRiskPct = () => num('BEAR_MAX_GAP_RISK_PCT', 6);
const userIds = () => (process.env.BEAR_SIDE_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const BEAR_REGIMES = new Set(['BEAR', 'PANIC']);
const DATA = 'https://data.alpaca.markets';
const TRADE = 'https://paper-api.alpaca.markets';
const etToday = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);
const r2 = v => Math.round(v * 100) / 100;
const optTick = p => (p >= 3 ? Math.round(p * 20) / 20 : Math.round(p * 100) / 100);
const sleep = ms => new Promise(res => setTimeout(res, ms));
const OPEN_STATUSES = ['pending_open', 'open', 'pending_close'];

let _ready = false;
async function ensureTables() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS bear_positions (
            id              SERIAL      PRIMARY KEY,
            user_id         TEXT        NOT NULL,
            leg             TEXT        NOT NULL CHECK (leg IN ('hedge', 'short', 'spread')),
            symbol          TEXT        NOT NULL,          -- ETF / stock / spread underlying
            long_contract   TEXT,
            short_contract  TEXT,
            width           NUMERIC,
            qty             NUMERIC     NOT NULL,
            status          TEXT        NOT NULL DEFAULT 'pending_open'
                            CHECK (status IN ('pending_open', 'open', 'pending_close', 'closed', 'not_filled')),
            entry_price     NUMERIC,                       -- share price, or net debit per spread
            entry_order_id  TEXT,
            stop_price      NUMERIC,
            stop_order_id   TEXT,
            exit_order_id   TEXT,
            exit_price      NUMERIC,
            exit_reason     TEXT,
            pnl             NUMERIC,
            regime          TEXT,
            meta            JSONB       NOT NULL DEFAULT '{}',
            opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            closed_at       TIMESTAMPTZ
        )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_bear_positions_user_status ON bear_positions (user_id, status)`);
    await query(`
        CREATE TABLE IF NOT EXISTS bear_short_candidates (
            d           DATE    NOT NULL,
            symbol      TEXT    NOT NULL,
            rank        INT     NOT NULL,
            price       NUMERIC NOT NULL,
            ret63       NUMERIC,
            ret5        NUMERIC,
            regime      TEXT,
            traded      BOOLEAN NOT NULL DEFAULT false,
            PRIMARY KEY (d, symbol)
        )`);
    await query(`
        CREATE TABLE IF NOT EXISTS bear_state (
            user_id       TEXT PRIMARY KEY,
            last_bear_at  TIMESTAMPTZ,
            last_regime   TEXT,
            checked_at    TIMESTAMPTZ
        )`);
    await query(`ALTER TABLE bear_positions ADD COLUMN IF NOT EXISTS risk_usd NUMERIC, ADD COLUMN IF NOT EXISTS sector TEXT`);
    await query(`ALTER TABLE bear_state ADD COLUMN IF NOT EXISTS bear_since TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS recovering BOOLEAN,
                 ADD COLUMN IF NOT EXISTS liquidating_since TIMESTAMPTZ,
                 ADD COLUMN IF NOT EXISTS halted_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS halt_reason TEXT`);
    await query(`
        CREATE TABLE IF NOT EXISTS bear_resume_log (
            id          SERIAL      PRIMARY KEY,
            user_id     TEXT        NOT NULL,
            at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            by_whom     TEXT        NOT NULL,
            granted     BOOLEAN     NOT NULL,
            halt_reason TEXT,
            halted_at   TIMESTAMPTZ,
            problems    JSONB       NOT NULL DEFAULT '[]'
        )`);
    await query(`ALTER TABLE bear_short_candidates ADD COLUMN IF NOT EXISTS rsi NUMERIC, ADD COLUMN IF NOT EXISTS passed BOOLEAN NOT NULL DEFAULT true,
                 ADD COLUMN IF NOT EXISTS reject_reason TEXT`);
    _ready = true;
}

async function _client(userId) {
    const c = await require('./userDatabaseService').getUserAlpacaCredentials(userId);
    if (c.isPaper !== true) throw new Error('bear side is PAPER ONLY — refusing a non-paper account');
    return { headers: { 'APCA-API-KEY-ID': c.keyId, 'APCA-API-SECRET-KEY': c.secretKey } };
}
const _get = (client, path, params) => axios.get(`${TRADE}${path}`, { headers: client.headers, params, timeout: 15000 }).then(r => r.data);
const _post = (client, path, body) => axios.post(`${TRADE}${path}`, body, { headers: client.headers, timeout: 15000 }).then(r => r.data);
const _errMsg = err => err.response?.data?.message || err.message;

async function _waitFill(client, orderId, ms = 20000) {
    const until = Date.now() + ms;
    let o = null;
    while (Date.now() < until) {
        o = await _get(client, `/v2/orders/${orderId}`).catch(() => o);
        if (o && ['filled', 'canceled', 'expired', 'rejected'].includes(o.status)) return o;
        await sleep(1000);
    }
    return o;
}

async function _stockPrices(client, symbols) {
    const out = {};
    for (let i = 0; i < symbols.length; i += 100) {
        const r = await axios.get(`${DATA}/v2/stocks/trades/latest`, {
            headers: client.headers, params: { symbols: symbols.slice(i, i + 100).join(','), feed: 'iex' }, timeout: 15000 });
        for (const [sym, tr] of Object.entries(r.data?.trades || {})) if (tr?.p > 0) out[sym] = tr.p;
    }
    return out;
}

async function _optionQuotes(client, contracts) {
    const r = await axios.get(`${DATA}/v1beta1/options/snapshots`, {
        headers: client.headers, params: { symbols: contracts.join(','), feed: 'indicative' }, timeout: 15000 });
    const out = {};
    for (const c of contracts) {
        const q = r.data?.snapshots?.[c]?.latestQuote;
        if (q?.bp > 0 && q?.ap > 0) out[c] = { bid: q.bp, ask: q.ap, mid: (q.bp + q.ap) / 2 };
    }
    return out;
}

// ─── Regime gate (pure parts unit-tested) ────────────────────────────────────

/**
 * Pure: should the bear book be held, entered, or closed?
 *   BEAR    → manage; new entries only once BEAR has lasted bearConfirmHours and the market isn't bouncing
 *   PANIC   → manage + keep stops, no new entries; counts as bear (never starts the exit timer)
 *   NEUTRAL / CHOPPY → hold until exitHours without any BEAR/PANIC reading, then close
 *   BULL    → close at once
 */
function regimeDecision({ regimeType, lastBearAt, bearSince = null, recovering = false, now = new Date(),
                          exitHours = exitAfterHours(), confirmHours = CFG.bearConfirmHours, stale = false }) {
    // a stale / fallback reading says nothing new: keep what is open (stops stay on), enter nothing
    if (stale) return { bearNow: false, hold: true, enter: false, stale: true, why: 'regime reading stale (data fallback): hold, no entries' };
    const bearNow = BEAR_REGIMES.has(regimeType);
    if (bearNow) {
        const bearHours = bearSince ? (now.getTime() - new Date(bearSince).getTime()) / 3600000 : 0;
        // the streak must span two trading sessions as well as confirmHours (weekend hours alone don't confirm)
        const priorSession = bearSince ? etToday(new Date(bearSince)) < etToday(now) : false;
        const enter = regimeType === 'BEAR' && bearHours >= confirmHours && priorSession && !recovering;
        const why = regimeType !== 'BEAR' ? 'PANIC: no new entries'
            : bearHours < confirmHours ? `BEAR only ${bearHours.toFixed(1)}h old (needs ${confirmHours}h)`
            : !priorSession ? 'BEAR first seen this session (needs a second session)'
            : recovering ? 'market bouncing: no new entries' : null;
        return { bearNow, hold: true, enter, why };
    }
    // the regime service reports BULL_STRONG / BULL_MILD (never plain 'BULL')
    if (/^BULL/.test(String(regimeType))) return { bearNow, hold: false, enter: false, why: `${regimeType}: close` };
    const since = lastBearAt ? (now.getTime() - new Date(lastBearAt).getTime()) / 3600000 : Infinity;
    return { bearNow, hold: since < exitHours, enter: false, hoursSinceBear: since, why: `not bear for ${Number.isFinite(since) ? since.toFixed(1) + 'h' : 'ever'}` };
}

/** Pure: is the market bouncing? closes = SPY daily closes, oldest first. */
function recoverySignal(closes, { bounce5dPct = CFG.recoveryBounce5dPct } = {}) {
    if (!Array.isArray(closes) || closes.length < 21) return { recovering: false };
    const c = closes[closes.length - 1];
    const ret5 = (c / closes[closes.length - 6] - 1) * 100;
    const sma20 = closes.slice(-20).reduce((s, v) => s + v, 0) / 20;
    return { recovering: ret5 >= bounce5dPct || c > sma20, ret5: r2(ret5), aboveSma20: c > sma20, sma20: r2(sma20) };
}

async function _spyCloses(client) {
    // daily bars for history + today's last trade, so the bounce check sees the current session
    const r = await query(`SELECT close::float AS c FROM daily_bars WHERE symbol = 'SPY' ORDER BY timestamp DESC LIMIT 30`);
    const closes = r.rows.map(x => x.c).reverse();
    const live = (await _stockPrices(client, ['SPY']).catch(() => ({}))).SPY;
    if (live > 0 && closes.length) closes.push(live);
    return closes;
}

async function _regimeState(userId, now, client) {
    const regime = await require('./marketRegimeService').getMarketRegime();
    const regimeType = regime?.regimeType || regime?.regime || 'NEUTRAL';
    const uid = String(userId);
    const stale = regimeStale(regime, now);
    if (stale) {
        // don't let a fallback reading start, extend or end the bear streak
        await query(`INSERT INTO bear_state (user_id, checked_at) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET checked_at = $2`, [uid, now]);
        const st0 = (await query(`SELECT last_bear_at FROM bear_state WHERE user_id = $1`, [uid])).rows[0];
        if (st0?.last_bear_at && now - new Date(st0.last_bear_at) > 3600000) {
            await _alert(userId, 'regime-stale', `Market-regime reading is stale (${regime?.timestamp || 'no data'}). Bear side is holding, with no new entries, until it is fresh.`, now);
        }
        return { regimeType, recovery: { recovering: false }, vix: regime?.vixLevel ?? null, ...regimeDecision({ regimeType, stale: true }) };
    }
    const rec = client ? recoverySignal(await _spyCloses(client).catch(() => [])) : { recovering: false };
    if (BEAR_REGIMES.has(regimeType)) {
        await query(`INSERT INTO bear_state (user_id, last_bear_at, bear_since, last_regime, checked_at, recovering) VALUES ($1, $2, $2, $3, $2, $4)
                     ON CONFLICT (user_id) DO UPDATE SET last_bear_at = $2, bear_since = COALESCE(bear_state.bear_since, $2),
                     last_regime = $3, checked_at = $2, recovering = $4`, [uid, now, regimeType, rec.recovering]);
    } else {
        // a fresh non-bear reading breaks the streak: the next BEAR is confirmed from scratch
        // (holding open positions still runs off last_bear_at + the exit timer)
        await query(`INSERT INTO bear_state (user_id, last_regime, checked_at, recovering) VALUES ($1, $2, $3, $4)
                     ON CONFLICT (user_id) DO UPDATE SET last_regime = $2, checked_at = $3, recovering = $4, bear_since = NULL`, [uid, regimeType, now, rec.recovering]);
    }
    const st = (await query(`SELECT last_bear_at, bear_since FROM bear_state WHERE user_id = $1`, [uid])).rows[0];
    const d = regimeDecision({ regimeType, lastBearAt: st?.last_bear_at, bearSince: st?.bear_since, recovering: rec.recovering, now });
    return { regimeType, recovery: rec, vix: regime?.vixLevel ?? null, ...d };
}

/** Pure: is a regime reading too old to act on? (The regime service falls back to a ≤6h-old copy, or to NEUTRAL with no data.) */
function regimeStale(regime, now = new Date(), maxMin = CFG.staleRegimeMin) {
    if (!regime || regime.spyPrice == null || !regime.timestamp) return true;
    return (now.getTime() - new Date(regime.timestamp).getTime()) / 60000 > maxMin;
}

// ─── Risk (pure, unit-tested) ────────────────────────────────────────────────

/** The most one position can lose: hedge/short = distance to its stop; spread = the debit paid. */
function positionRisk({ leg, qty, price, debit, dividendUsd = 0 }) {
    if (leg === 'spread') return r2((debit || 0) * 100 * (qty || 0));
    const stopPct = leg === 'short' ? CFG.shortStopPct : CFG.hedgeStopPct;
    // a short owes any dividend that goes ex while it is open — part of what it can lose
    return r2((qty || 0) * (price || 0) * stopPct / 100 + (leg === 'short' ? dividendUsd : 0));
}

/**
 * Pure: dividends a short would owe if held from today for holdDays. divs = Alpaca cash_dividends rows
 * (ex_date, rate, special) for the past ~13 months and any announced ones. Announced ex-dates inside the
 * hold count in full; if none is announced, a regular payer's next ex-date is projected from its usual
 * interval (estimated). ok=false for any special dividend in the hold, or > maxPct of the price.
 */
function dividendExposure(divs, { today, holdDays = CFG.shortMaxDays, price, maxPct = CFG.divMaxPctOfPrice } = {}) {
    const rows = (divs || []).filter(d => d?.ex_date && d.rate > 0).sort((a, b) => a.ex_date.localeCompare(b.ex_date));
    const inHold = d => { const n = dayDiff(d, today); return n >= 0 && n <= holdDays; };
    const announced = rows.filter(d => inHold(d.ex_date));
    let perShare = announced.reduce((s, d) => s + Number(d.rate), 0), estimated = false, exDate = announced[0]?.ex_date || null;
    const special = announced.some(d => d.special);
    if (!announced.length) {
        const regular = rows.filter(d => !d.special && d.ex_date < today);
        if (regular.length >= 2) {
            const gaps = regular.slice(1).map((d, i) => dayDiff(d.ex_date, regular[i].ex_date)).sort((a, b) => a - b);
            const gap = gaps[Math.floor(gaps.length / 2)];
            const last = regular[regular.length - 1];
            const next = new Date(new Date(last.ex_date).getTime() + gap * 86400000).toISOString().slice(0, 10);
            // projected inside the hold (allow a week of drift in either direction)
            const n = dayDiff(next, today);
            if (gap >= 20 && n >= -7 && n <= holdDays + 7) { perShare = Number(last.rate); estimated = true; exDate = next; }
        }
    }
    const pct = price > 0 ? perShare / price * 100 : 0;
    const ok = !special && pct <= maxPct;
    return { ok, perShare: r2(perShare * 1e4) / 1e4, pctOfPrice: r2(pct), exDate, estimated, special,
             why: special ? 'special dividend inside the hold' : !ok ? `dividend ${r2(pct)}% of price inside the hold` : null };
}

async function _dividends(client, symbol, today) {
    const start = new Date(new Date(today).getTime() - 400 * 86400000).toISOString().slice(0, 10);
    const end = new Date(new Date(today).getTime() + (CFG.shortMaxDays + 10) * 86400000).toISOString().slice(0, 10);
    const r = await axios.get(`${DATA}/v1/corporate-actions`, { headers: client.headers, timeout: 15000,
        params: { symbols: symbol, types: 'cash_dividend', start, end, limit: 1000 } });
    return r.data?.corporate_actions?.cash_dividends || [];
}

/** Room left for new risk: total budget minus open risk, and the per-position cap. */
function riskRoom({ equity, openRisk = 0, totalPct = maxRiskPct(), tradePct = maxTradeRiskPct() }) {
    if (!(equity > 0)) return { total: 0, perTrade: 0 };
    const total = Math.max(0, equity * totalPct / 100 - openRisk);
    return { total, perTrade: Math.min(total, equity * tradePct / 100) };
}

/** Pure: Wilder RSI(14) of closes (oldest first), or null. */
function rsi14(closes) {
    if (!Array.isArray(closes) || closes.length < 15) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= 14; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gain += d; else loss -= d; }
    gain /= 14; loss /= 14;
    for (let i = 15; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        gain = (gain * 13 + Math.max(0, d)) / 14; loss = (loss * 13 + Math.max(0, -d)) / 14;
    }
    return loss === 0 ? 100 : r2(100 - 100 / (1 + gain / loss));
}

/** Pure: short-specific checks on recent closes — not extremely oversold, no recent squeeze-type up day. */
function shortQuality(closes, { minRsi = CFG.shortMinRsi, maxDayGainPct = CFG.shortMaxDayGainPct } = {}) {
    const rsi = rsi14(closes);
    if (rsi == null) return { ok: false, reason: 'not enough history' };
    const recent = closes.slice(-21);
    let maxUp = 0;
    for (let i = 1; i < recent.length; i++) maxUp = Math.max(maxUp, (recent[i] / recent[i - 1] - 1) * 100);
    if (rsi < minRsi) return { ok: false, reason: `RSI ${rsi} — already extremely oversold`, rsi };
    if (maxUp >= maxDayGainPct) return { ok: false, reason: `+${maxUp.toFixed(1)}% day in the last 20 sessions (squeeze risk)`, rsi, maxUp };
    return { ok: true, rsi, maxUp: r2(maxUp) };
}

/** Pure: report-only stress test — what the open bear book loses if the market gaps up gapPct overnight. */
function stressLoss(open, { gapPct = CFG.stressGapPct, beta = CFG.shortStressBeta } = {}) {
    let loss = 0;
    for (const p of open) {
        if (p.leg === 'hedge') loss += Math.abs(p.value || 0) * gapPct / 100;
        else if (p.leg === 'short') loss += Math.abs(p.value || 0) * gapPct * beta / 100; // a gap jumps the stop
        else if (p.leg === 'spread') loss += Math.min(p.debitUsd || 0, (p.debitUsd || 0) * 0.5 * gapPct / 5); // ~half the debit on a 5% gap, never more than the debit
    }
    return r2(loss);
}

/**
 * Pure: report-only single-stock gap stress — a short gapping up X% opens above its stop, so the loss is the
 * whole gap. Shows the largest short alone and every short at once, for each X in gaps.
 */
function shortGapStress(open, { gaps = CFG.stressSingleGapsPct } = {}) {
    const vals = open.filter(p => p.leg === 'short').map(p => Math.abs(p.value || 0));
    const largest = vals.length ? Math.max(...vals) : 0, all = vals.reduce((s, v) => s + v, 0);
    return gaps.map(g => ({ gapPct: g, largestShortUsd: r2(largest * g / 100), allShortsUsd: r2(all * g / 100) }));
}

/**
 * Pure: entry-day tape checks for a new short from an Alpaca snapshot. prevPrevClose = the close before
 * prevDailyBar (for yesterday's short-sale-restriction check). ok=false with the reason if it should be skipped.
 */
function entryTape(snap, prevPrevClose, { maxUpPct = CFG.entryMaxDayUpPct, ssrPct = CFG.ssrDropPct } = {}) {
    const prev = snap?.prevDailyBar?.c, px = snap?.latestTrade?.p || snap?.dailyBar?.c;
    if (!(prev > 0) || !(px > 0)) return { ok: false, reason: 'no snapshot' };
    const dayPct = (px / prev - 1) * 100;
    if (dayPct >= maxUpPct) return { ok: false, reason: `up ${r2(dayPct)}% today (squeeze / gap-up)`, dayPct: r2(dayPct) };
    const low = Math.min(snap?.dailyBar?.l || px, px);
    if ((low / prev - 1) * 100 <= -ssrPct) return { ok: false, reason: 'short-sale restriction likely today (−10% from prior close)', dayPct: r2(dayPct) };
    if (prevPrevClose > 0 && snap?.prevDailyBar?.l > 0 && (snap.prevDailyBar.l / prevPrevClose - 1) * 100 <= -ssrPct) {
        return { ok: false, reason: 'short-sale restriction carried over from yesterday', dayPct: r2(dayPct) };
    }
    return { ok: true, dayPct: r2(dayPct) };
}

/**
 * Pure: squeeze warning signs for an open short. bars = recent 1-minute bars (oldest first, {t,h,l,c,v});
 * snap = Alpaca snapshot. Returns a list of flags (empty = nothing unusual). Alert-only: the stop is never widened.
 */
function squeezeFlags({ bars = [], snap = null, nowMs = Date.now(), windowMin = CFG.squeezeWindowMin, risePct = CFG.squeezeRisePct,
                        volMult = CFG.squeezeVolMult, gapPct = CFG.gapUpAlertPct, haltMin = CFG.haltNoQuoteMin } = {}) {
    const flags = [];
    const recent = bars.filter(b => nowMs - new Date(b.t).getTime() <= windowMin * 60000);
    const last = recent[recent.length - 1]?.c ?? snap?.latestTrade?.p;
    if (recent.length) {
        const low = Math.min(...recent.map(b => b.l));
        const rise = (last / low - 1) * 100;
        if (rise >= risePct) flags.push(`up ${r2(rise)}% in ${windowMin} min`);
        const prevVol = snap?.prevDailyBar?.v;
        const vol = recent.reduce((s, b) => s + (b.v || 0), 0);
        if (prevVol > 0 && vol >= prevVol / (390 / windowMin) * volMult && last > recent[0].o) flags.push(`volume ${r2(vol / (prevVol / (390 / windowMin)))}× normal while rising`);
    }
    const prevC = snap?.prevDailyBar?.c, open = snap?.dailyBar?.o;
    const todayBar = snap?.dailyBar?.t && etToday(new Date(snap.dailyBar.t)) === etToday(new Date(nowMs));
    if (todayBar && prevC > 0 && open > 0 && (open / prevC - 1) * 100 >= gapPct) flags.push(`gapped up ${r2((open / prevC - 1) * 100)}% at the open`);
    const lastSeen = Math.max(new Date(snap?.latestTrade?.t || 0).getTime(), new Date(snap?.latestQuote?.t || 0).getTime());
    if (snap && lastSeen > 0 && (nowMs - lastSeen) / 60000 >= haltMin) flags.push(`no trade or quote for ${Math.round((nowMs - lastSeen) / 60000)} min (possible halt)`);
    return flags;
}

// ─── Money available ─────────────────────────────────────────────────────────

/** Pure: free cash for the hedge/spreads, and room under the gross cap. */
function fundingRoom({ cash, equity, putCollateral = 0, shortProceeds = 0, bearGross = 0, margin = false,
                       bufferPct = CFG.cashBufferPct, capPct = grossCapPct() }) {
    if (!(equity > 0)) return { freeCash: 0, capRoom: 0, spendable: 0 };
    const freeCash = Math.max(0, (cash || 0) - putCollateral - shortProceeds - equity * bufferPct / 100);
    const capRoom = Math.max(0, equity * capPct / 100 - bearGross);
    return { freeCash, capRoom, spendable: margin ? capRoom : Math.min(freeCash, capRoom) };
}

async function _funding(client, userId, rows) {
    const acct = await _get(client, '/v2/account');
    const positions = await _get(client, '/v2/positions');
    const equity = parseFloat(acct.equity), cash = parseFloat(acct.cash);
    const shortProceeds = positions.filter(p => (p.asset_class || 'us_equity') === 'us_equity' && parseFloat(p.qty) < 0)
        .reduce((s, p) => s + Math.abs(parseFloat(p.market_value) || 0), 0);
    let putCollateral = 0;
    try {
        putCollateral = parseFloat((await query(`SELECT COALESCE(SUM(collateral), 0) AS c FROM options_income_trades
                                                 WHERE user_id = $1 AND status IN ('pending_open', 'open', 'pending_close')`, [String(userId)])).rows[0].c) || 0;
    } catch (_) { /* table missing = no puts */ }
    const bySym = Object.fromEntries(positions.map(p => [p.symbol, p]));
    const bearGross = rows.filter(r => OPEN_STATUSES.includes(r.status)).reduce((s, r) => {
        if (r.leg === 'spread') return s + Number(r.entry_price || r.meta?.limit || 0) * 100 * Number(r.qty);
        return s + Math.abs(parseFloat(bySym[r.symbol]?.market_value) || Number(r.entry_price || 0) * Number(r.qty));
    }, 0);
    const openRisk = rows.filter(r => OPEN_STATUSES.includes(r.status)).reduce((s, r) => s + (Number(r.risk_usd) || positionRisk({
        leg: r.leg, qty: Number(r.qty), price: Number(r.entry_price), debit: Number(r.entry_price || r.meta?.limit) })), 0);
    const rr = riskRoom({ equity, openRisk });
    const open = rows.filter(r => OPEN_STATUSES.includes(r.status));
    const mv = r => Math.abs(parseFloat(bySym[r.symbol]?.market_value) || Number(r.entry_price || r.meta?.decisionPx || 0) * Number(r.qty));
    const shortsValue = open.filter(r => r.leg === 'short').reduce((s, r) => s + mv(r), 0);
    const hedgeValue = open.filter(r => r.leg === 'hedge').reduce((s, r) => s + mv(r), 0);
    const spreadDebit = open.filter(r => r.leg === 'spread').reduce((s, r) => s + Number(r.entry_price || r.meta?.limit || 0) * 100 * Number(r.qty), 0);
    return { equity, cash, positions, bySym, shortsValue, hedgeValue, spreadDebit, ...fundingRoom({ cash, equity, putCollateral, shortProceeds, bearGross, margin: allowMargin() }),
             putCollateral, shortProceeds, bearGross, openRisk, riskTotal: rr.total };
}

/** Money a cash-using leg (hedge, spread) may still spend this tick. */
const _spendable = f => (allowMargin() ? f.capRoom : Math.min(f.freeCash, f.capRoom));
/** Max loss a new position may carry: the per-position cap, within what is left of the total budget. */
const _tradeRisk = f => Math.max(0, Math.min(f.riskTotal, f.equity * maxTradeRiskPct() / 100));
/** Book what a leg just used: cash legs use free cash and gross room; shorts only gross room. Risk always. */
function _book(f, usd, { usesCash, risk = 0 }) {
    f.capRoom = Math.max(0, f.capRoom - usd);
    if (usesCash) f.freeCash = Math.max(0, f.freeCash - usd);
    f.riskTotal = Math.max(0, f.riskTotal - risk);
}

async function _rows(userId) {
    return (await query(`SELECT * FROM bear_positions WHERE user_id = $1 AND status = ANY($2)`, [String(userId), OPEN_STATUSES])).rows;
}

async function _syncSleeve(userId) {
    const syms = (await query(`SELECT DISTINCT symbol FROM bear_positions WHERE user_id = $1 AND leg IN ('hedge', 'short') AND status = ANY($2)`,
        [String(userId), OPEN_STATUSES])).rows.map(r => r.symbol);
    await require('./coreHoldingsService').setBearSymbols(userId, syms);
}

// ─── Leg 1: inverse ETF hedge ────────────────────────────────────────────────

async function _enterHedge(client, userId, f, rows, regimeType) {
    const broker = require('./brokerService');
    const out = [];
    const prices = await _stockPrices(client, CFG.hedgeEtfs.map(e => e.symbol));
    for (const etf of CFG.hedgeEtfs) {
        if (rows.some(r => r.leg === 'hedge' && r.symbol === etf.symbol)) continue;
        const px = prices[etf.symbol];
        if (!(px > 0)) continue;
        const want = Math.min(f.equity * hedgePct() / 100 * etf.weight, _spendable(f), _tradeRisk(f) / (CFG.hedgeStopPct / 100));
        const qty = Math.floor(want / (px * 1.01));
        if (_tradeRisk(f) <= 0) { out.push({ leg: 'hedge', symbol: etf.symbol, skipped: 'bear risk budget used up' }); continue; }
        if (qty < 1) { out.push({ leg: 'hedge', symbol: etf.symbol, skipped: _spendable(f) < px ? 'no free cash (sold puts reserve it; BEAR_ALLOW_MARGIN=true to use margin)' : 'too small' }); continue; }
        if (!_gapFits(f, { hedgeValue: qty * px })) { out.push({ leg: 'hedge', symbol: etf.symbol, skipped: `gap-stress limit (${maxGapRiskPct()}% of equity)` }); continue; }
        // protect before ordering so the swing bot never touches it, even for one cycle
        await require('./coreHoldingsService').setBearSymbols(userId, [...new Set([...rows.filter(r => r.leg !== 'spread').map(r => r.symbol), etf.symbol])]);
        try {
            const res = await broker.buyMarket(userId, etf.symbol, qty, {
                executedBy: 'BEAR_HEDGE', reason: `Bear-side hedge (paper, regime ${regimeType})`, safetyOptions: { enforceNotionalLimit: false },
            });
            const filled = Number(res.filledQty) || 0;
            const fillPx = Number(res.filledAvgPrice) || px;
            const risk = positionRisk({ leg: 'hedge', qty: filled, price: fillPx });
            await query(`INSERT INTO bear_positions (user_id, leg, symbol, qty, status, entry_price, entry_order_id, regime, closed_at, risk_usd, meta)
                         VALUES ($1, 'hedge', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [String(userId), etf.symbol, filled || qty, filled > 0 ? 'open' : 'not_filled', fillPx, res.orderId || null, regimeType, filled > 0 ? null : new Date(),
                 risk, JSON.stringify({ decisionPx: px, slippagePct: r2((fillPx / px - 1) * 100), vixAtEntry: f.vix ?? null })]);
            _book(f, filled * fillPx, { usesCash: true, risk });
            out.push({ leg: 'hedge', symbol: etf.symbol, qty: filled, price: res.filledAvgPrice });
        } catch (err) {
            out.push({ leg: 'hedge', symbol: etf.symbol, error: err.message });
        }
    }
    await _syncSleeve(userId);
    return out;
}

/** A hedge ETF the broker no longer holds (its protective stop filled): close the row at the recorded sell. */
async function _hedgeGone(userId, r, px) {
    const sell = (await query(`SELECT price::float AS p FROM trades WHERE user_id = $1 AND UPPER(symbol) = $2 AND action = 'SELL' AND trade_date >= $3
                               ORDER BY trade_date DESC LIMIT 1`, [String(userId), r.symbol, r.opened_at]).catch(() => ({ rows: [] }))).rows[0]?.p;
    const exit = sell || px || Number(r.entry_price);
    await query(`UPDATE bear_positions SET status = 'closed', closed_at = NOW(), exit_price = $2, exit_reason = $3,
                 pnl = ($2::numeric - entry_price) * qty WHERE id = $1`, [r.id, exit, sell ? 'stop filled at broker' : 'gone at broker (exit price estimated)']);
    return { symbol: r.symbol, leg: 'hedge', reason: 'gone at broker', exit };
}

async function _closeHedge(userId, r, reason, px, liveQty) {
    const broker = require('./brokerService');
    if (!(liveQty > 0)) return _hedgeGone(userId, r, px);
    const res = await broker.sellMarket(userId, r.symbol, liveQty, { executedBy: 'BEAR_HEDGE', reason: `Bear-side hedge exit: ${reason}` });
    const filled = Number(res.filledQty) || 0;
    if (filled < liveQty) {
        // not (fully) filled yet — sellMarket returns early on a resting/partial order. Keep it open as
        // pending_close and confirm against the broker next tick; never mark closed on an unfilled sell.
        await query(`UPDATE bear_positions SET status = 'pending_close', exit_order_id = $2, exit_reason = $3,
                     meta = meta || jsonb_build_object('closeStartedAt', COALESCE(meta->>'closeStartedAt', NOW()::text)) WHERE id = $1`,
            [r.id, res.orderId || null, reason]);
        logger.warn('[BearSide] Hedge sell not fully filled — will confirm next tick', { userId, symbol: r.symbol, want: liveQty, filled, status: res.status });
        return { symbol: r.symbol, leg: 'hedge', pendingClose: true, filled };
    }
    const exit = Number(res.filledAvgPrice) || px;
    await query(`UPDATE bear_positions SET status = 'closed', closed_at = NOW(), exit_price = $2, exit_reason = $3, exit_order_id = $4,
                 pnl = ($2::numeric - entry_price) * qty WHERE id = $1`, [r.id, exit, reason, res.orderId || null]);
    return { symbol: r.symbol, reason, exit };
}

/** A hedge whose exit sell was not fully filled: closed once the broker no longer holds it; re-sells if the order died. */
async function _manageHedgeClosing(client, userId, r, px, liveQty, now) {
    const o = r.exit_order_id ? await _get(client, `/v2/orders/${r.exit_order_id}`).catch(() => undefined) : null;
    if (o === undefined) return null; // couldn't read the order — never re-sell blind
    if (!(liveQty > 0)) {
        const exit = parseFloat(o?.filled_avg_price) || px || Number(r.entry_price);
        await query(`UPDATE bear_positions SET status = 'closed', closed_at = NOW(), exit_price = $2, pnl = ($2::numeric - entry_price) * qty WHERE id = $1`, [r.id, exit]);
        return { symbol: r.symbol, leg: 'hedge', reason: r.exit_reason, exit };
    }
    if (!o || ['canceled', 'expired', 'rejected', 'filled'].includes(o.status)) {
        // the order is finished but shares remain (partial fill / rejection): sell what is still held
        return _closeHedge(userId, r, r.exit_reason || 'retry exit', px, liveQty);
    }
    return null; // still working
}

// ─── Leg 2: short selling ────────────────────────────────────────────────────

/**
 * Pure: rank short candidates from per-symbol stats. Liquid (top-N dollar volume), $20+, below both the
 * 50- and 200-day averages, not already down >15% in 5 days; weakest 3-month return first.
 */
function rankShortCandidates(stats, { exclude = new Set(), universe = CFG.shortUniverse, minPrice = CFG.shortMinPrice,
                                       max5dDrop = CFG.shortMax5dDropPct, minDollarVol = CFG.shortMinDollarVol,
                                       spyRet63 = null, minRelWeakPct = CFG.shortMinRelWeakPct } = {}) {
    return stats
        .filter(x => x.c0 >= minPrice && x.dv >= minDollarVol && x.sma50 > 0 && x.sma200 > 0 && x.c63 > 0 && x.c5 > 0)
        .sort((a, b) => b.dv - a.dv).slice(0, universe)
        .map(x => ({ symbol: x.symbol, price: x.c0, ret63: x.c0 / x.c63 - 1, ret5: x.c0 / x.c5 - 1, below50: x.c0 < x.sma50, below200: x.c0 < x.sma200, dv: x.dv }))
        .filter(x => x.below50 && x.below200 && x.ret5 * 100 > -max5dDrop && !exclude.has(x.symbol)
            // weaker than the market, not just falling with it
            && (spyRet63 == null || (x.ret63 - spyRet63) * 100 <= -minRelWeakPct))
        .sort((a, b) => a.ret63 - b.ret63);
}

async function _recentCloses(symbols) {
    if (!symbols.length) return {};
    const r = await query(`
        SELECT symbol, array_agg(c ORDER BY ts) AS closes FROM (
            SELECT symbol, close::float AS c, timestamp AS ts, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY timestamp DESC) AS rn
            FROM daily_bars WHERE symbol = ANY($1) AND timestamp >= NOW() - INTERVAL '90 days') x
        WHERE rn <= 60 GROUP BY symbol`, [symbols]);
    return Object.fromEntries(r.rows.map(x => [x.symbol, x.closes]));
}

async function _spyRet63() {
    const r = await query(`SELECT close::float AS c FROM daily_bars WHERE symbol = 'SPY' ORDER BY timestamp DESC LIMIT 64`);
    return r.rows.length === 64 ? r.rows[0].c / r.rows[63].c - 1 : null;
}

async function _shortStats() {
    const r = await query(`
        WITH b AS (
            SELECT symbol, close::float AS c, volume::float AS v,
                   ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY timestamp DESC) AS rn
            FROM daily_bars WHERE timestamp >= NOW() - INTERVAL '320 days'
        )
        SELECT symbol,
               MAX(c) FILTER (WHERE rn = 1)  AS c0,
               MAX(c) FILTER (WHERE rn = 6)  AS c5,
               MAX(c) FILTER (WHERE rn = 64) AS c63,
               AVG(c) FILTER (WHERE rn <= 50)  AS sma50,
               CASE WHEN COUNT(*) FILTER (WHERE rn <= 200) = 200 THEN AVG(c) FILTER (WHERE rn <= 200) END AS sma200,
               AVG(c * v) FILTER (WHERE rn <= 60) AS dv
        FROM b
        WHERE NOT EXISTS (SELECT 1 FROM fund_symbols f WHERE f.symbol = b.symbol)
        GROUP BY symbol`);
    return r.rows;
}

async function _logCandidates(cands, regimeType, today) {
    const top = cands.slice(0, CFG.candidatesLogged);
    for (let i = 0; i < top.length; i++) {
        const c = top[i];
        await query(`INSERT INTO bear_short_candidates (d, symbol, rank, price, ret63, ret5, regime, rsi, passed) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
                     ON CONFLICT (d, symbol) DO NOTHING`, [today, c.symbol, i + 1, c.price, c.ret63, c.ret5, regimeType, c.rsi ?? null]);
    }
}

/** Shadow only: candidates the short-quality filter rejected (RSI < 30, recent +8% day), for grading the cut-off. */
async function _logRejected(rejected, regimeType, today) {
    for (let i = 0; i < rejected.length; i++) {
        const c = rejected[i];
        await query(`INSERT INTO bear_short_candidates (d, symbol, rank, price, ret63, ret5, regime, rsi, passed, reject_reason)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,$9) ON CONFLICT (d, symbol) DO NOTHING`,
            [today, c.symbol, i + 1, c.price, c.ret63, c.ret5, regimeType, c.rsi ?? null, String(c.reject || '').slice(0, 200)]);
    }
}

/** Pure: the RSI band the review proposed (for the shadow comparison only — trading still uses RSI ≥ 30). */
function rsiBand(rsi) {
    if (rsi == null) return 'unknown';
    return rsi < 25 ? '<25' : rsi < 30 ? '25-30' : rsi < 40 ? '30-40' : rsi < 50 ? '40-50' : '50+';
}

async function _enterShorts(client, userId, f, rows, regimeType, today, now) {
    const out = [];
    await require('./satelliteService').refreshFundList(); // fund list (shared with the satellite) so ETFs never get shorted
    const open = rows.filter(r => r.leg === 'short');
    let slots = CFG.shortMax - open.length;
    const held = new Set(f.positions.map(p => String(p.symbol).toUpperCase()));
    const protectedSyms = await require('./coreHoldingsService').getCoreSymbols(userId);
    const swingRows = (await query(`SELECT UPPER(symbol) AS s FROM holdings WHERE user_id = $1 AND quantity > 0`, [String(userId)])).rows.map(r => r.s);
    const exclude = new Set([...held, ...protectedSyms, ...swingRows]);
    const ranked = rankShortCandidates(await _shortStats(), { exclude, spyRet63: await _spyRet63() });
    // short-specific checks on the strongest-looking 40: not extremely oversold, no recent squeeze-type day
    const closes = await _recentCloses(ranked.slice(0, 40).map(c => c.symbol));
    const { resolveSector } = require('./sectorMetadataService');
    const cands = [], rejected = [];
    for (const c of ranked.slice(0, 40)) {
        const q = shortQuality(closes[c.symbol] || []);
        if (!q.ok) { rejected.push({ ...c, rsi: q.rsi ?? rsi14(closes[c.symbol] || []), reject: q.reason }); continue; }
        cands.push({ ...c, rsi: q.rsi, sector: resolveSector(c.symbol) || null });
    }
    await _logCandidates(cands, regimeType, today);
    // shadow only: the rejected ones too, with their RSI band, so the RSI 30 cut-off can be graded (never traded)
    await _logRejected(rejected, regimeType, today).catch(err => logger.warn('[BearSide] Rejected-candidate log failed', { error: err.message }));
    if (slots <= 0) return out;
    const nextEarnings = require('./optionsIncomeService').nextEarnings;
    const sectorCount = {};
    for (const r of open) sectorCount[r.sector || 'Unknown'] = (sectorCount[r.sector || 'Unknown'] || 0) + 1;
    for (const c of cands.slice(0, 25)) {
        if (slots <= 0) break;
        if ((sectorCount[c.sector || 'Unknown'] || 0) >= CFG.maxShortsPerSector) continue; // only filled shorts count
        const notional = Math.min(f.equity * shortEachPct() / 100, _tradeRisk(f) / (CFG.shortStopPct / 100));
        if (_tradeRisk(f) <= 0) { out.push({ leg: 'short', skipped: 'bear risk budget used up' }); break; }
        if (notional > f.capRoom) { out.push({ leg: 'short', skipped: 'gross cap reached' }); break; }
        try {
            const asset = await _get(client, `/v2/assets/${c.symbol}`);
            if (!asset.tradable || !asset.shortable || !asset.easy_to_borrow) continue;
            const earn = await nextEarnings(c.symbol, now);
            if (earn === undefined) continue; // lookup failed — fail closed
            if (earn && dayDiff(earn, today) <= CFG.shortMaxDays) continue;
            // today's tape: not squeezing / gapping up, no short-sale restriction (today or carried from yesterday)
            const snap = (await axios.get(`${DATA}/v2/stocks/snapshots`, { headers: client.headers, timeout: 15000, params: { symbols: c.symbol, feed: 'iex' } })).data?.[c.symbol];
            const cl = closes[c.symbol] || [];
            const prevDate = snap?.prevDailyBar?.t ? etToday(new Date(snap.prevDailyBar.t)) : null;
            const ppc = prevDate ? (await query(`SELECT close::float AS c FROM daily_bars WHERE symbol = $1 AND (timestamp AT TIME ZONE 'UTC')::date < $2
                                                 ORDER BY timestamp DESC LIMIT 1`, [c.symbol, prevDate])).rows[0]?.c : cl[cl.length - 2];
            const tape = entryTape(snap, ppc);
            if (!tape.ok) { out.push({ leg: 'short', symbol: c.symbol, skipped: tape.reason }); continue; }
            const px = snap?.latestTrade?.p || (await _stockPrices(client, [c.symbol]))[c.symbol] || c.price;
            // dividends owed while short: worked out before opening; fail closed if the lookup fails
            const div = dividendExposure(await _dividends(client, c.symbol, today), { today, price: px });
            if (!div.ok) { out.push({ leg: 'short', symbol: c.symbol, skipped: div.why }); continue; }
            let qty = Math.floor(notional / px);
            // the expected dividend counts toward the position's max loss
            while (qty >= 1 && positionRisk({ leg: 'short', qty, price: px, dividendUsd: qty * div.perShare }) > _tradeRisk(f)) qty--;
            if (qty < 1) continue;
            if (!_gapFits(f, { shortsValue: qty * px })) { out.push({ leg: 'short', symbol: c.symbol, skipped: `gap-stress limit (${maxGapRiskPct()}% of equity)` }); break; }
            const res = await _openShort(client, userId, c.symbol, qty, regimeType, rows,
                { sector: c.sector, decisionPx: px, dividend: div, rsi: c.rsi, vix: f.vix ?? null });
            if (res) {
                out.push(res);
                if (res.qty > 0 || res.pending) {
                    // a pending order is booked at its intended size so a slow fill can't open a sixth short
                    const q = res.qty > 0 ? res.qty : qty, p = res.price || px;
                    slots--; _book(f, q * p, { usesCash: false, risk: positionRisk({ leg: 'short', qty: q, price: p, dividendUsd: q * div.perShare }) });
                    sectorCount[c.sector || 'Unknown'] = (sectorCount[c.sector || 'Unknown'] || 0) + 1;
                    await query(`UPDATE bear_short_candidates SET traded = true WHERE d = $1 AND symbol = $2`, [today, c.symbol]);
                }
            }
        } catch (err) {
            out.push({ leg: 'short', symbol: c.symbol, error: _errMsg(err) });
        }
    }
    return out;
}

async function _openShort(client, userId, symbol, qty, regimeType, rows, { sector = null, decisionPx = null, dividend = null, rsi = null, vix = null } = {}) {
    // protect first: a swing buy of this symbol would quietly cover the short
    await require('./coreHoldingsService').setBearSymbols(userId, [...new Set([...rows.filter(r => r.leg !== 'spread').map(r => r.symbol), symbol])]);
    const o = await _post(client, '/v2/orders', { symbol, qty: String(qty), side: 'sell', type: 'market', time_in_force: 'day' });
    const divPs = dividend?.perShare || 0;
    const ins = await query(`INSERT INTO bear_positions (user_id, leg, symbol, qty, status, entry_order_id, regime, sector, risk_usd, meta)
                             VALUES ($1, 'short', $2, $3, 'pending_open', $4, $5, $6, $7, $8) RETURNING id`,
        [String(userId), symbol, qty, o.id, regimeType, sector, positionRisk({ leg: 'short', qty, price: decisionPx, dividendUsd: qty * divPs }),
         JSON.stringify({ decisionPx, rsi, vixAtEntry: vix,
                          dividend: dividend ? { perShare: divPs, exDate: dividend.exDate, estimated: dividend.estimated, liabilityUsd: r2(qty * divPs) } : null })]);
    const id = ins.rows[0].id;
    const filled = await _waitFill(client, o.id);
    if (!filled || filled.status !== 'filled') {
        logger.info('[BearSide] Short order not filled yet — will reconcile next tick', { userId, symbol, status: filled?.status });
        return { leg: 'short', symbol, qty: 0, pending: true };
    }
    return _afterShortFill(client, userId, { id, symbol }, filled);
}

/** A short just filled: place its protective buy-stop, or cover immediately if that fails. */
async function _afterShortFill(client, userId, r, filled) {
    const qty = parseFloat(filled.filled_qty), entry = parseFloat(filled.filled_avg_price);
    const stop = r2(entry * (1 + CFG.shortStopPct / 100));
    // slippage for a short: selling below the price we decided on is the cost
    await query(`UPDATE bear_positions SET status = 'open', qty = $2, entry_price = $3,
                 risk_usd = $4::numeric + $2::numeric * COALESCE((meta->'dividend'->>'perShare')::numeric, 0),
                 meta = meta || jsonb_build_object('slippagePct', CASE WHEN (meta->>'decisionPx')::numeric > 0 THEN round((1 - $3::numeric / (meta->>'decisionPx')::numeric) * 100, 3) END)
                 WHERE id = $1`, [r.id, qty, entry, positionRisk({ leg: 'short', qty, price: entry })]);
    try {
        const s = await _post(client, '/v2/orders', { symbol: r.symbol, qty: String(qty), side: 'buy', type: 'stop', stop_price: String(stop), time_in_force: 'gtc' });
        await query(`UPDATE bear_positions SET stop_price = $2, stop_order_id = $3 WHERE id = $1`, [r.id, stop, s.id]);
        logger.info('[BearSide] Short opened with buy-stop', { userId, symbol: r.symbol, qty, entry, stop });
        return { leg: 'short', symbol: r.symbol, qty, price: entry, stop };
    } catch (err) {
        logger.error('[BearSide] Could not place buy-stop on new short — covering now (fail closed)', { userId, symbol: r.symbol, error: _errMsg(err) });
        await _alert(userId, `stopfail:${r.id}`, `${r.symbol} short filled but its buy-stop was rejected (${_errMsg(err)}) — covering it now.`);
        await _coverShort(client, userId, { ...r, qty, entry_price: entry, stop_order_id: null }, 'no stop could be placed');
        return { leg: 'short', symbol: r.symbol, qty: 0, error: 'stop failed — covered' };
    }
}

async function _coverShort(client, userId, r, reason) {
    if (r.stop_order_id) {
        await axios.delete(`${TRADE}/v2/orders/${r.stop_order_id}`, { headers: client.headers, timeout: 15000 }).catch(() => {});
        await sleep(1500);
        const so = await _get(client, `/v2/orders/${r.stop_order_id}`).catch(() => null);
        if (so?.status === 'filled') return _markShortClosed(r, parseFloat(so.filled_avg_price), 'stop', so.id);
    }
    const pos = await _get(client, `/v2/positions/${r.symbol}`).catch(err => (err.response?.status === 404 ? null : undefined));
    if (pos === undefined) return null; // couldn't read — retry next tick
    const liveQty = pos ? parseFloat(pos.qty) : 0;
    if (!(liveQty < 0)) return _markShortClosed(r, Number(pos?.current_price) || Number(r.entry_price), 'gone at broker', null);
    const o = await _post(client, '/v2/orders', { symbol: r.symbol, qty: String(Math.abs(liveQty)), side: 'buy', type: 'market', time_in_force: 'day' });
    await query(`UPDATE bear_positions SET status = 'pending_close', exit_order_id = $2, exit_reason = $3,
                 meta = meta || jsonb_build_object('closeStartedAt', COALESCE(meta->>'closeStartedAt', NOW()::text)) WHERE id = $1`, [r.id, o.id, reason]);
    const filled = await _waitFill(client, o.id);
    if (filled?.status === 'filled') return _markShortClosed(r, parseFloat(filled.filled_avg_price), reason, o.id);
    return { symbol: r.symbol, pendingCover: true };
}

async function _markShortClosed(r, exit, reason, orderId) {
    await query(`UPDATE bear_positions SET status = 'closed', closed_at = NOW(), exit_price = $2, exit_reason = $3,
                 exit_order_id = COALESCE($4, exit_order_id), pnl = (entry_price - $2::numeric) * qty WHERE id = $1`, [r.id, exit, reason, orderId]);
    logger.info('[BearSide] Short closed', { symbol: r.symbol, entry: Number(r.entry_price), exit, reason });
    return { symbol: r.symbol, exit, reason };
}

/** Pure: exit reason for an open short, or null. Also the trailed stop, if it should move down. */
function shortPlan({ entry, price, stop, openedAt, now = new Date(), hold = true }) {
    const days = (now.getTime() - new Date(openedAt).getTime()) / 86400000;
    const reason = !hold ? 'regime no longer bear'
        : price <= entry * (1 - CFG.shortTargetPct / 100) ? `take profit (−${CFG.shortTargetPct}%)`
        : days >= CFG.shortMaxDays ? `time exit (${CFG.shortMaxDays} days)` : null;
    const trailed = r2(price * (1 + CFG.shortStopPct / 100));
    return { reason, newStop: stop && trailed < stop * 0.99 ? trailed : null };
}

async function _manageShort(client, userId, r, price, hold, now, posQty = null) {
    if (r.status === 'pending_open') {
        const o = await _get(client, `/v2/orders/${r.entry_order_id}`).catch(() => null);
        if (o?.status === 'filled') return _afterShortFill(client, userId, r, o);
        // cancelled after a PARTIAL fill: those shares are a real short — record them and put the stop on
        if (o && ['canceled', 'expired'].includes(o.status) && parseFloat(o.filled_qty) > 0) return _afterShortFill(client, userId, r, o);
        if (o && ['canceled', 'expired', 'rejected'].includes(o.status)) {
            await query(`UPDATE bear_positions SET status = 'not_filled', closed_at = NOW() WHERE id = $1`, [r.id]);
        }
        return null;
    }
    if (r.status === 'pending_close') {
        const o = await _get(client, `/v2/orders/${r.exit_order_id}`).catch(() => null);
        if (o?.status === 'filled') return _markShortClosed(r, parseFloat(o.filled_avg_price), r.exit_reason, o.id);
        if (o && ['canceled', 'expired', 'rejected'].includes(o.status)) return _coverShort(client, userId, { ...r, stop_order_id: null }, r.exit_reason || 'retry cover');
        return null;
    }
    // stop filled at the broker?
    if (r.stop_order_id) {
        const so = await _get(client, `/v2/orders/${r.stop_order_id}`).catch(() => null);
        if (so?.status === 'filled') return _markShortClosed(r, parseFloat(so.filled_avg_price), 'stop', so.id);
        if (so && ['canceled', 'expired', 'rejected'].includes(so.status)) {
            // stop vanished (e.g. cancelled by something else) — put it back, or cover
            try {
                const s = await _post(client, '/v2/orders', { symbol: r.symbol, qty: String(r.qty), side: 'buy', type: 'stop', stop_price: String(r.stop_price), time_in_force: 'gtc' });
                await query(`UPDATE bear_positions SET stop_order_id = $2 WHERE id = $1`, [r.id, s.id]);
                logger.warn('[BearSide] Short buy-stop was gone — replaced', { userId, symbol: r.symbol, was: so.status });
            } catch (err) {
                await _halt(userId, `${r.symbol} short lost its buy-stop and it could not be replaced — covering now`, now);
                return _coverShort(client, userId, { ...r, stop_order_id: null }, 'stop gone and could not be replaced');
            }
        }
    } else {
        await _halt(userId, `${r.symbol} short has NO buy-stop on record`, now);
    }
    if (!(await _borrowStillOk(client, r, now))) {
        await _alert(userId, `borrow:${r.id}`, `${r.symbol} is no longer easy to borrow (recall / fee risk) — covering.`, now);
        return _coverShort(client, userId, r, 'no longer easy to borrow');
    }
    const dv = await _dividendStillOk(client, r, now);
    if (!dv.ok) {
        await _alert(userId, `div:${r.id}`, `${r.symbol} short: ${dv.why} — covering before the ex-date.`, now);
        return _coverShort(client, userId, r, `dividend: ${dv.why}`);
    }
    const mm = posQty ? brokerMismatch(r, posQty) : null;
    if (mm) await _halt(userId, `Position mismatch — ${mm} (unexplained quantity change: possible buy-in / recall / manual trade). Not auto-fixed`, now);
    if (!(price > 0)) return null;
    const plan = shortPlan({ entry: Number(r.entry_price), price, stop: Number(r.stop_price), openedAt: r.opened_at, now, hold });
    if (plan.reason) return _coverShort(client, userId, r, plan.reason);
    if (plan.newStop && r.stop_order_id) {
        try {
            const s = (await axios.patch(`${TRADE}/v2/orders/${r.stop_order_id}`, { stop_price: String(plan.newStop) }, { headers: client.headers, timeout: 15000 })).data;
            await query(`UPDATE bear_positions SET stop_price = $2, stop_order_id = $3 WHERE id = $1`, [r.id, plan.newStop, s.id]);
            logger.info('[BearSide] Short stop trailed down', { symbol: r.symbol, from: Number(r.stop_price), to: plan.newStop });
        } catch (err) {
            logger.warn('[BearSide] Could not trail short stop', { symbol: r.symbol, error: _errMsg(err) });
        }
    }
    return null;
}

// ─── Alerts + broker-vs-record checks ───────────────────────────────────────

const _alerted = new Set();
/** Telegram alert to the paper account's owner, at most once per key per day. Never throws. */
async function _alert(userId, key, text, now = new Date()) {
    const k = `${userId}:${key}:${etToday(now)}`;
    if (_alerted.has(k)) return;
    _alerted.add(k);
    logger.warn('[BearSide] ALERT', { userId, key, text });
    try { await require('./telegramAlertService').sendMessage(userId, `🐻 *Bear side (paper)*\n${text}`); } catch (_) { /* logged above */ }
}

/** Pure: does the broker hold what our record says? posQty = { symbol: signed qty } (shorts and short legs negative). */
function brokerMismatch(r, posQty) {
    if (r.leg === 'short') {
        const q = posQty[r.symbol] || 0;
        return q === -Number(r.qty) ? null : `${r.symbol}: record short ${Number(r.qty)}, broker ${q}`;
    }
    if (r.leg === 'spread') {
        const L = posQty[r.long_contract] || 0, S = posQty[r.short_contract] || 0, n = Number(r.qty);
        return L === n && S === -n ? null : `${r.symbol} spread: record +${n}/−${n}, broker long ${L} / short ${S}`;
    }
    return null;
}

const _borrowChecked = new Map();
/**
 * Hourly per short: still shortable and easy to borrow? Alpaca has no recall / forced buy-in notice in its
 * API; a buy-in shows up as the position changing, which brokerMismatch alerts on every tick.
 */
async function _borrowStillOk(client, r, now) {
    const last = _borrowChecked.get(r.id);
    if (last && now.getTime() - last < CFG.borrowCheckMin * 60000) return true;
    const a = await _get(client, `/v2/assets/${r.symbol}`).catch(() => null);
    if (!a) return true; // unreadable: try again next tick
    _borrowChecked.set(r.id, now.getTime());
    return a.shortable && a.easy_to_borrow;
}

const _divChecked = new Set();
/** Daily per short: a special or large dividend announced since entry, going ex within 2 days → cover before it. */
async function _dividendStillOk(client, r, now) {
    const today = etToday(now), k = `${r.id}:${today}`;
    if (_divChecked.has(k)) return { ok: true };
    let divs;
    try { divs = await _dividends(client, r.symbol, today); } catch (_) { return { ok: true }; } // retry next tick
    _divChecked.add(k);
    const soon = divs.filter(d => d.ex_date && dayDiff(d.ex_date, today) >= 0 && dayDiff(d.ex_date, today) <= 2);
    const px = Number(r.entry_price) || 0;
    const bad = soon.find(d => d.special || (px > 0 && d.rate / px * 100 > CFG.divMaxPctOfPrice));
    return bad ? { ok: false, why: `${bad.special ? 'special ' : ''}dividend $${bad.rate} goes ex ${bad.ex_date}` } : { ok: true };
}

/** Squeeze alerts for open shorts, one batched data call each per tick. Alert + record only; never widens a stop. */
async function _squeezeWatch(client, userId, shorts, now) {
    if (!shorts.length) return;
    const syms = [...new Set(shorts.map(r => r.symbol))];
    const start = new Date(now.getTime() - (CFG.squeezeWindowMin + 5) * 60000).toISOString();
    const [bars, snaps] = await Promise.all([
        axios.get(`${DATA}/v2/stocks/bars`, { headers: client.headers, timeout: 15000, params: { symbols: syms.join(','), timeframe: '1Min', start, feed: 'iex', limit: 10000 } })
            .then(r => r.data?.bars || {}),
        axios.get(`${DATA}/v2/stocks/snapshots`, { headers: client.headers, timeout: 15000, params: { symbols: syms.join(','), feed: 'iex' } }).then(r => r.data || {}),
    ]);
    for (const r of shorts) {
        const flags = squeezeFlags({ bars: bars[r.symbol] || [], snap: snaps[r.symbol], nowMs: now.getTime() });
        if (!flags.length) continue;
        await query(`UPDATE bear_positions SET meta = jsonb_set(meta, '{squeezeFlags}', COALESCE(meta->'squeezeFlags', '[]'::jsonb) || $2::jsonb) WHERE id = $1`,
            [r.id, JSON.stringify([{ at: now.toISOString(), flags }])]).catch(() => {});
        await _alert(userId, `squeeze:${r.id}:${flags[0].split(' ')[0]}`,
            `${r.symbol} short — squeeze warning: ${flags.join('; ')}. Buy-stop stays at $${Number(r.stop_price)} (not widened). Review now.`, now);
    }
}

// ─── Leg 3: bear put spreads ─────────────────────────────────────────────────

const parseOcc = sym => {
    const m = String(sym).match(/^([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
    return m ? { underlying: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5], strike: parseInt(m[6], 10) / 1000 } : null;
};

/**
 * Pure: pick a bear put spread from a puts snapshot map, or null (with the reason in `why`).
 * Both legs must have a tight two-sided quote; the natural debit may be at most spreadMaxSlipFrac over the
 * mid; one spread must not risk more than maxDebitUsd — narrower widths are tried before giving up.
 */
function chooseSpread(snapshots, price, today, { minDte = CFG.spreadMinDte, maxDte = CFG.spreadMaxDte,
                                                  widthsPct = CFG.spreadWidthsPct, maxDebitFrac = CFG.spreadMaxDebitFrac,
                                                  maxLegSpreadPct = CFG.spreadMaxLegSpreadPct, maxSlipFrac = CFG.spreadMaxSlipFrac,
                                                  maxDebitUsd = Infinity } = {}) {
    const byExp = {};
    for (const [sym, s] of Object.entries(snapshots || {})) {
        const p = parseOcc(sym);
        const bid = s?.latestQuote?.bp, ask = s?.latestQuote?.ap;
        if (!p || p.type !== 'P' || !(bid > 0 && ask > 0)) continue;
        const mid = (bid + ask) / 2;
        if ((ask - bid) / mid * 100 > maxLegSpreadPct) continue; // thin leg: unreliable fills
        const dte = dayDiff(p.expiry, today);
        if (dte < minDte || dte > maxDte) continue;
        (byExp[p.expiry] = byExp[p.expiry] || []).push({ contract: sym, strike: p.strike, bid, ask, mid, dte });
    }
    const exps = Object.keys(byExp).sort((a, b) => Math.abs(byExp[a][0].dte - 40) - Math.abs(byExp[b][0].dte - 40));
    let why = exps.length ? 'no spread met the rules' : 'no liquid puts 30-50 days out';
    for (const exp of exps) {
        const legs = byExp[exp];
        const atm = legs.filter(l => l.strike <= price * 1.005).sort((a, b) => b.strike - a.strike)[0];
        if (!atm) continue;
        for (const widthPct of widthsPct) {
            const target = atm.strike - price * widthPct / 100;
            const low = legs.filter(l => l.strike < atm.strike).sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))[0];
            if (!low) continue;
            const width = atm.strike - low.strike;
            const debit = atm.mid - low.mid;
            const natural = atm.ask - low.bid;
            if (!(debit > 0) || width < price * widthPct / 100 * 0.6 || Math.abs(width - price * widthPct / 100) > price * widthPct / 100 * 0.4) continue;
            if (debit > width * maxDebitFrac) { why = `debit > ${maxDebitFrac * 100}% of width`; continue; }
            if (natural > debit * (1 + maxSlipFrac)) { why = `bid/ask too wide (natural ${r2(natural)} vs mid ${r2(debit)})`; continue; }
            const limit = optTick(Math.min(natural, debit + (natural - debit) * 0.25));
            if (limit * 100 > maxDebitUsd) { why = `one spread risks $${Math.round(limit * 100)} > $${Math.round(maxDebitUsd)} limit`; continue; }
            return { expiry: exp, dte: atm.dte, long: atm, short: low, width, widthPct, debit, natural, limit };
        }
    }
    return { none: true, why };
}

async function _enterSpreads(client, userId, f, rows, regimeType, today) {
    const out = [];
    const prices = await _stockPrices(client, CFG.spreadUnderlyings);
    for (const und of CFG.spreadUnderlyings) {
        if (rows.some(r => r.leg === 'spread' && r.symbol === und)) continue;
        const px = prices[und];
        if (!(px > 0)) continue;
        const from = new Date(Date.now() + CFG.spreadMinDte * 86400000).toISOString().slice(0, 10);
        const to = new Date(Date.now() + CFG.spreadMaxDte * 86400000).toISOString().slice(0, 10);
        let snaps;
        try {
            snaps = (await axios.get(`${DATA}/v1beta1/options/snapshots/${und}`, {
                headers: client.headers, timeout: 15000,
                params: { feed: 'indicative', type: 'put', expiration_date_gte: from, expiration_date_lte: to,
                          strike_price_gte: (px * 0.88).toFixed(2), strike_price_lte: (px * 1.01).toFixed(2), limit: 500 },
            })).data?.snapshots;
        } catch (err) { out.push({ leg: 'spread', symbol: und, error: _errMsg(err) }); continue; }
        const maxDebitUsd = Math.min(_tradeRisk(f), f.equity * spreadPct() / 100);
        const pick = chooseSpread(snaps, px, today, { maxDebitUsd });
        if (pick.none) { out.push({ leg: 'spread', symbol: und, skipped: pick.why }); continue; }
        const cost = pick.limit * 100;
        const room = _spendable(f);
        const qty = Math.floor(Math.min(maxDebitUsd, room) / cost);
        if (qty < 1) { out.push({ leg: 'spread', symbol: und, skipped: room < cost ?'no free cash (BEAR_ALLOW_MARGIN=true to use margin)' : 'one spread costs more than the per-spread limit', cost }); continue; }
        if (!_gapFits(f, { spreadDebit: cost * qty })) { out.push({ leg: 'spread', symbol: und, skipped: `gap-stress limit (${maxGapRiskPct()}% of equity)` }); continue; }
        try {
            const o = await _post(client, '/v2/orders', {
                order_class: 'mleg', qty: String(qty), type: 'limit', limit_price: String(pick.limit), time_in_force: 'day',
                legs: [
                    { symbol: pick.long.contract, ratio_qty: '1', side: 'buy', position_intent: 'buy_to_open' },
                    { symbol: pick.short.contract, ratio_qty: '1', side: 'sell', position_intent: 'sell_to_open' },
                ],
            });
            await query(`INSERT INTO bear_positions (user_id, leg, symbol, long_contract, short_contract, width, qty, status, entry_order_id, regime, meta, risk_usd)
                         VALUES ($1, 'spread', $2, $3, $4, $5, $6, 'pending_open', $7, $8, $9, $10)`,
                [String(userId), und, pick.long.contract, pick.short.contract, pick.width, qty, o.id, regimeType,
                 JSON.stringify({ limit: pick.limit, debitMid: r2(pick.debit), natural: r2(pick.natural), dte: pick.dte, widthPct: pick.widthPct, underlyingPx: px, vixAtEntry: f.vix ?? null }),
                 positionRisk({ leg: 'spread', qty, debit: pick.limit })]);
            _book(f, cost * qty, { usesCash: true, risk: cost * qty });
            logger.info('[BearSide] Bear put spread order placed', { userId, und, long: pick.long.contract, short: pick.short.contract, qty, limit: pick.limit, width: pick.width });
            out.push({ leg: 'spread', symbol: und, long: pick.long.contract, short: pick.short.contract, qty, limit: pick.limit });
        } catch (err) {
            out.push({ leg: 'spread', symbol: und, error: _errMsg(err) });
        }
    }
    return out;
}

/** Pure: exit reason for an open spread, or null. value = what the spread is worth now (mid). */
function spreadPlan({ debit, width, value, dte, hold = true }) {
    if (!hold) return 'regime no longer bear';
    if (value >= debit + (width - debit) * CFG.spreadTakeProfitFrac) return `take profit (${CFG.spreadTakeProfitFrac * 100}% of max gain)`;
    if (value <= debit * CFG.spreadStopFrac) return `stop (value ≤ ${CFG.spreadStopFrac * 100}% of debit)`;
    if (dte <= CFG.spreadCloseDte) return `close near expiry (${dte}d)`;
    return null;
}

/**
 * Closing a spread: two single-leg orders, short leg first (buy_to_close) so the account is never left
 * holding an uncovered short put; then sell_to_close the long. Marketable limits (ask / bid).
 * Alpaca's docs don't define the price sign of a credit mleg order, so no mleg close.
 */
/**
 * Status of a working close order: 'filled' (sets the fill), 'working', or 'dead' (cancelled/expired,
 * or stale > 10 min and now cancelled so the next tick re-places it at a fresh quote).
 */
async function _closeOrderState(client, orderId) {
    const o = await _get(client, `/v2/orders/${orderId}`).catch(() => null);
    if (!o) return { state: 'working' };
    if (o.status === 'filled') return { state: 'filled', fill: parseFloat(o.filled_avg_price) };
    if (['canceled', 'expired', 'rejected'].includes(o.status)) return { state: 'dead' };
    if (Date.now() - new Date(o.created_at).getTime() > 10 * 60000) {
        await axios.delete(`${TRADE}/v2/orders/${orderId}`, { headers: client.headers, timeout: 15000 }).catch(() => {});
    }
    return { state: 'working' };
}

async function _closeSpreadStep(client, userId, r, reason) {
    const meta = r.meta || {};
    if (!meta.closeStartedAt) meta.closeStartedAt = new Date().toISOString();
    const q = await _optionQuotes(client, [r.long_contract, r.short_contract]).catch(() => ({}));
    if (meta.shortCloseFill == null) {
        if (meta.shortCloseOrder) {
            const s = await _closeOrderState(client, meta.shortCloseOrder);
            if (s.state === 'filled') meta.shortCloseFill = s.fill;
            else if (s.state === 'working') return null;
            else meta.shortCloseOrder = null;
        }
        if (meta.shortCloseFill == null) {
            // a short leg that is no longer held (expired worthless) needs no close
            const pos = await _get(client, `/v2/positions/${r.short_contract}`).catch(err => (err.response?.status === 404 ? null : undefined));
            if (pos === undefined) return null; // unreadable — never order blind
            if (pos === null || !(parseFloat(pos.qty) < 0)) meta.shortCloseFill = meta.shortCloseFill ?? 0;
            else {
                const ask = q[r.short_contract]?.ask;
                if (!(ask > 0)) return null;
                // what is still short at the broker (a re-placed close after a partial fill must not over-buy)
                const o = await _post(client, '/v2/orders', { symbol: r.short_contract, qty: String(Math.abs(parseFloat(pos.qty))), side: 'buy', type: 'limit',
                    limit_price: String(optTick(ask)), time_in_force: 'day', position_intent: 'buy_to_close' });
                meta.shortCloseOrder = o.id;
                const f = await _waitFill(client, o.id, 15000);
                if (f?.status === 'filled') meta.shortCloseFill = parseFloat(f.filled_avg_price);
            }
        }
        await query(`UPDATE bear_positions SET status = 'pending_close', exit_reason = COALESCE(exit_reason, $2), meta = $3 WHERE id = $1`, [r.id, reason, JSON.stringify(meta)]);
        if (meta.shortCloseFill == null) return null;
    }
    if (meta.longCloseOrder && meta.longCloseFill == null) {
        const s = await _closeOrderState(client, meta.longCloseOrder);
        if (s.state === 'filled') meta.longCloseFill = s.fill;
        else if (s.state === 'working') return null;
        else meta.longCloseOrder = null;
    }
    if (meta.longCloseFill == null) {
        const pos = await _get(client, `/v2/positions/${r.long_contract}`).catch(err => (err.response?.status === 404 ? null : undefined));
        if (pos === undefined) { await query(`UPDATE bear_positions SET meta = $2 WHERE id = $1`, [r.id, JSON.stringify(meta)]); return null; }
        if (pos === null || !(parseFloat(pos.qty) > 0)) meta.longCloseFill = 0;
        else {
            const bid = q[r.long_contract]?.bid;
            if (!(bid > 0)) { await query(`UPDATE bear_positions SET meta = $2 WHERE id = $1`, [r.id, JSON.stringify(meta)]); return null; }
            const o = await _post(client, '/v2/orders', { symbol: r.long_contract, qty: String(parseFloat(pos.qty)), side: 'sell', type: 'limit',
                limit_price: String(optTick(bid)), time_in_force: 'day', position_intent: 'sell_to_close' });
            meta.longCloseOrder = o.id;
            const f = await _waitFill(client, o.id, 15000);
            if (f?.status === 'filled') meta.longCloseFill = parseFloat(f.filled_avg_price);
        }
    }
    await query(`UPDATE bear_positions SET meta = $2 WHERE id = $1`, [r.id, JSON.stringify(meta)]);
    if (meta.longCloseFill == null) return null;
    const exit = r2(meta.longCloseFill - meta.shortCloseFill);
    await query(`UPDATE bear_positions SET status = 'closed', closed_at = NOW(), exit_price = $2, pnl = ($2::numeric - entry_price) * 100 * qty WHERE id = $1`, [r.id, exit]);
    logger.info('[BearSide] Bear put spread closed', { userId, und: r.symbol, debit: Number(r.entry_price), exit, reason: r.exit_reason || reason });
    return { symbol: r.symbol, leg: 'spread', exit, reason: r.exit_reason || reason };
}

async function _manageSpread(client, userId, r, hold, now, posQty = null) {
    if (r.status === 'pending_open') {
        const o = await _get(client, `/v2/orders/${r.entry_order_id}`).catch(() => null);
        if (!o) return null;
        const filledQty = parseFloat(o.filled_qty) || 0;
        const dead = ['canceled', 'expired', 'rejected'].includes(o.status);
        // filled, or cancelled after a PARTIAL fill: what filled is a real position — never re-order it
        if (o.status === 'filled' || (dead && filledQty > 0)) {
            let debit = parseFloat(o.filled_avg_price);
            if (!(debit > 0) && Array.isArray(o.legs)) {
                const leg = c => parseFloat(o.legs.find(l => l.symbol === c)?.filled_avg_price) || 0;
                debit = leg(r.long_contract) - leg(r.short_contract);
            }
            debit = r2(debit || Number(r.meta?.limit));
            const mid = Number(r.meta?.debitMid) || null;
            const meta = { ...(r.meta || {}), filledDebit: debit, slippagePct: mid ? r2((debit / mid - 1) * 100) : null, partial: o.status !== 'filled' };
            await query(`UPDATE bear_positions SET status = 'open', qty = $2, entry_price = $3, risk_usd = $4, meta = $5 WHERE id = $1`,
                [r.id, filledQty, debit, positionRisk({ leg: 'spread', qty: filledQty, debit }), JSON.stringify(meta)]);
            logger.info('[BearSide] Bear put spread filled', { userId, und: r.symbol, qty: filledQty, debit, mid, partial: meta.partial });
            return null;
        }
        if (dead) {
            await query(`UPDATE bear_positions SET status = 'not_filled', closed_at = NOW() WHERE id = $1`, [r.id]);
        } else if ((now.getTime() - new Date(r.opened_at).getTime()) / 60000 > CFG.spreadPendingMaxMin) {
            await axios.delete(`${TRADE}/v2/orders/${r.entry_order_id}`, { headers: client.headers, timeout: 15000 }).catch(() => {});
        }
        return null;
    }
    if (r.status === 'pending_close') {
        const since = r.meta?.closeStartedAt ? new Date(r.meta.closeStartedAt) : null;
        if (since && now.getTime() - since.getTime() > 24 * 3600000) {
            await _alert(userId, `closestuck:${r.id}`, `${r.symbol} bear put spread has been trying to close for over a day (${r.exit_reason}). Still counted as open risk; check the account.`, now);
        }
        return _closeSpreadStep(client, userId, r, r.exit_reason || 'close');
    }
    const mm = posQty ? brokerMismatch(r, posQty) : null;
    if (mm) await _halt(userId, `Position mismatch — ${mm} (unexplained quantity change: possible buy-in / recall / manual trade). Not auto-fixed`, now);
    const q = await _optionQuotes(client, [r.long_contract, r.short_contract]).catch(() => ({}));
    const L = q[r.long_contract], S = q[r.short_contract];
    if (!L || !S) return null;
    const value = L.mid - S.mid;
    const dte = dayDiff(parseOcc(r.long_contract).expiry, etToday(now));
    const meta = r.meta || {};
    if (meta.minValue == null || value < meta.minValue) { meta.minValue = r2(value); }
    if (meta.maxValue == null || value > meta.maxValue) { meta.maxValue = r2(value); }
    await query(`UPDATE bear_positions SET meta = $2 WHERE id = $1`, [r.id, JSON.stringify(meta)]).catch(() => {});
    const reason = spreadPlan({ debit: Number(r.entry_price), width: Number(r.width), value, dte, hold });
    if (!reason) return null;
    logger.info('[BearSide] Closing bear put spread', { und: r.symbol, reason, value: r2(value), debit: Number(r.entry_price), dte });
    return _closeSpreadStep(client, userId, { ...r, meta }, reason);
}

/**
 * Pure: which closed bear positions does the broker still hold? closed = rows closed during the liquidation;
 * posQty = { symbol: signed qty }. Returns readable leftovers (empty = confirmed flat).
 */
function liquidationLeftovers(closed, posQty) {
    const left = [];
    for (const r of closed) {
        if (r.leg === 'short' && (posQty[r.symbol] || 0) < 0) left.push(`${r.symbol} still short ${posQty[r.symbol]}`);
        if (r.leg === 'hedge' && (posQty[r.symbol] || 0) > 0) left.push(`${r.symbol} still held ${posQty[r.symbol]}`);
        if (r.leg === 'spread') {
            for (const c of [r.long_contract, r.short_contract]) if (c && posQty[c]) left.push(`${c} still ${posQty[c]}`);
        }
    }
    return [...new Set(left)];
}

/** When the book is told to close (BULL / exit timer): alert if it isn't flat within 30 min, then confirm against the broker. */
async function _verifyLiquidation(client, userId, st, stillOpen, now) {
    const uid = String(userId);
    const s = (await query(`SELECT liquidating_since FROM bear_state WHERE user_id = $1`, [uid])).rows[0];
    if (st.hold) {
        if (s?.liquidating_since) await query(`UPDATE bear_state SET liquidating_since = NULL WHERE user_id = $1`, [uid]);
        return;
    }
    const since = s?.liquidating_since ? new Date(s.liquidating_since) : null;
    if (stillOpen.length) {
        if (!since) { await query(`UPDATE bear_state SET liquidating_since = $2 WHERE user_id = $1`, [uid, now]); return; }
        if (now - since > CFG.closeStuckMin * 60000) {
            await _alert(userId, 'liquidation-slow', `Bear book closing (${st.why}) but ${stillOpen.length} position(s) not closed after ${CFG.closeStuckMin} min: `
                + stillOpen.map(r => `${r.symbol} ${r.leg} [${r.status}]`).join(', '), now);
        }
        return;
    }
    if (!since) return; // nothing was open when the close started
    const closed = (await query(`SELECT leg, symbol, long_contract, short_contract FROM bear_positions WHERE user_id = $1 AND status = 'closed' AND closed_at >= $2 - INTERVAL '10 minutes'`,
        [uid, since])).rows;
    const posQty = await _get(client, '/v2/positions').then(ps => Object.fromEntries(ps.map(p => [p.symbol, parseFloat(p.qty)]))).catch(() => null);
    if (!posQty) return; // try again next tick
    const left = liquidationLeftovers(closed, posQty);
    if (left.length) {
        await _alert(userId, 'liquidation-leftover', `Bear book marked closed but the broker still holds: ${left.join('; ')}. Not auto-fixed; check the account.`, now);
        return;
    }
    await query(`UPDATE bear_state SET liquidating_since = NULL WHERE user_id = $1`, [uid]);
    await _alert(userId, 'liquidation-done', `Bear book fully closed (${st.why}) — ${closed.length} position(s), confirmed flat at the broker.`, now);
}

// ─── Kill switch ─────────────────────────────────────────────────────────────
/**
 * Latching halt of NEW entries when something can't be trusted: a broker-vs-record mismatch, an unknown
 * short at the broker, a short without a working stop, or recorded risk over the cap. While halted the bot
 * keeps managing what is open (stops, exits, closes) — it never liquidates because of the halt itself.
 * Resumes only on an explicit review: resumeBear(userId) (POST /api/paper-tests/bear/resume).
 * Stale data and an unreachable broker block entries for that tick only (they clear on their own).
 */
async function _halt(userId, reason, now = new Date()) {
    const r = await query(`UPDATE bear_state SET halted_at = $2, halt_reason = $3 WHERE user_id = $1 AND halted_at IS NULL RETURNING user_id`,
        [String(userId), now, String(reason).slice(0, 500)]);
    logger.error('[BearSide] KILL SWITCH — new entries halted', { userId, reason });
    if (r.rows.length) {
        await _alert(userId, `halt:${reason}`, `🚨 *CRITICAL — bear entries HALTED*\n${reason}\nOpen positions are still managed (stops/exits). Nothing was auto-fixed. New entries stay off until reviewed and resumed.`, now);
    } else {
        await _alert(userId, `halt-extra:${reason}`, `🚨 *CRITICAL (already halted)*\n${reason}`, now);
    }
}

async function _haltState(userId) {
    return (await query(`SELECT halted_at, halt_reason FROM bear_state WHERE user_id = $1`, [String(userId)])).rows[0] || {};
}

/**
 * Pure: may the bear engine resume? Every open record must match the broker, no unexplained short, every open
 * short has a live buy-stop, and stop-based + gap-stress risk are inside their caps. Returns the problems.
 */
function resumeProblems({ rows, positions, stopStatus = {}, equity, openRisk, gapStress }) {
    const problems = [];
    const posQty = Object.fromEntries(positions.map(p => [p.symbol, parseFloat(p.qty)]));
    for (const r of rows.filter(x => x.status === 'open')) {
        const mm = brokerMismatch(r, posQty);
        if (mm) problems.push(`mismatch: ${mm}`);
        if (r.leg === 'short' && !['new', 'accepted', 'held', 'pending_new', 'replaced'].includes(stopStatus[r.id])) {
            problems.push(`${r.symbol} short has no live buy-stop (${stopStatus[r.id] || 'none'})`);
        }
    }
    const unk = unknownShorts(positions, rows);
    if (unk.length) problems.push(`unknown short(s) at the broker: ${unk.join(', ')}`);
    if (!(equity > 0)) problems.push('account equity unreadable');
    else {
        if (openRisk > equity * maxRiskPct() / 100 * 1.02) problems.push(`stop-based risk $${Math.round(openRisk)} over the ${maxRiskPct()}% cap`);
        if (gapStress > equity * maxGapRiskPct() / 100) problems.push(`gap stress $${Math.round(gapStress)} over the ${maxGapRiskPct()}% cap`);
    }
    return problems;
}

/**
 * Explicit resume after review. Re-reconciles against the broker first and REFUSES while any problem
 * remains; every attempt (granted or refused) is recorded in bear_resume_log with who and when.
 */
async function resumeBear(userId, by = 'user') {
    await ensureTables();
    const uid = String(userId);
    const st = await _haltState(uid);
    if (!st.halted_at) return { resumed: false, wasHalted: false, problems: [] };
    let problems;
    try {
        const client = await _client(uid);
        const rows = await _rows(uid);
        const positions = await _get(client, '/v2/positions');
        const stopStatus = {};
        for (const r of rows.filter(x => x.leg === 'short' && x.status === 'open')) {
            stopStatus[r.id] = r.stop_order_id ? (await _get(client, `/v2/orders/${r.stop_order_id}`).catch(() => null))?.status || 'unreadable' : 'none';
        }
        const f = await _funding(client, uid, rows);
        problems = resumeProblems({ rows, positions, stopStatus, equity: f.equity, openRisk: f.openRisk,
            gapStress: gapStressUsd({ shortsValue: f.shortsValue, hedgeValue: f.hedgeValue, spreadDebit: f.spreadDebit }) });
    } catch (err) {
        problems = [`could not reconcile with the broker: ${_errMsg(err)}`];
    }
    const ok = problems.length === 0;
    await query(`INSERT INTO bear_resume_log (user_id, by_whom, granted, halt_reason, halted_at, problems) VALUES ($1, $2, $3, $4, $5, $6)`,
        [uid, String(by).slice(0, 200), ok, st.halt_reason, st.halted_at, JSON.stringify(problems)]);
    if (ok) await query(`UPDATE bear_state SET halted_at = NULL, halt_reason = NULL WHERE user_id = $1`, [uid]);
    logger.warn(`[BearSide] Resume ${ok ? 'GRANTED' : 'REFUSED'}`, { userId: uid, by, problems });
    return { resumed: ok, wasHalted: true, problems };
}

/** Pure: shorts in the broker account that no bear record explains (open or pending). */
function unknownShorts(positions, rows) {
    const known = new Set(rows.filter(r => r.leg === 'short').map(r => r.symbol));
    return positions.filter(p => (p.asset_class || 'us_equity') === 'us_equity' && parseFloat(p.qty) < 0 && !known.has(p.symbol))
        .map(p => `${p.symbol} ${parseFloat(p.qty)}`);
}

/** Pure: gap-stress loss — shorts gapping shortGapPct through their stops + a marketGapPct gap on hedges and spreads. */
function gapStressUsd({ shortsValue = 0, hedgeValue = 0, spreadDebit = 0, shortGapPct = 30, marketGapPct = CFG.stressGapPct }) {
    return r2(shortsValue * shortGapPct / 100 + hedgeValue * marketGapPct / 100 + Math.min(spreadDebit, spreadDebit * 0.5 * marketGapPct / 5));
}

/** Gap-stress room check for a new position; books it when it fits. */
function _gapFits(f, add) {
    const after = gapStressUsd({ shortsValue: f.shortsValue + (add.shortsValue || 0), hedgeValue: f.hedgeValue + (add.hedgeValue || 0),
                                 spreadDebit: f.spreadDebit + (add.spreadDebit || 0) });
    if (after > f.equity * maxGapRiskPct() / 100) return false;
    f.shortsValue += add.shortsValue || 0; f.hedgeValue += add.hedgeValue || 0; f.spreadDebit += add.spreadDebit || 0;
    return true;
}

// ─── Tick ────────────────────────────────────────────────────────────────────

/** One account: manage everything open; enter once a day per leg while BEAR. */
async function runForUser(userId, now = new Date(), { allowEntries = true } = {}) {
    await ensureTables();
    const client = await _client(userId);
    const today = etToday(now);
    const st = await _regimeState(userId, now, client);
    let rows = await _rows(userId);
    const actions = [];
    const tickStart = new Date();

    // manage
    const stockSyms = [...new Set(rows.filter(r => r.leg !== 'spread').map(r => r.symbol))];
    const prices = stockSyms.length ? await _stockPrices(client, stockSyms).catch(() => ({})) : {};
    // one positions read per tick; null = unreadable → hedges are left alone this tick (never "gone")
    // broker positions are the final authority: read every tick, even with nothing open (finds unknown shorts)
    const brokerPositions = await _get(client, '/v2/positions').catch(() => null);
    const posQty = brokerPositions ? Object.fromEntries(brokerPositions.map(p => [p.symbol, parseFloat(p.qty)])) : null;
    if (brokerPositions) {
        const unk = unknownShorts(brokerPositions, rows);
        if (unk.length) await _halt(userId, `Short position(s) at the broker with no bear record: ${unk.join(', ')}`, now);
    }
    for (const r of rows) {
        try {
            let res = null;
            if (r.leg === 'hedge' && r.status === 'open' && posQty) {
                const px = prices[r.symbol];
                const liveQty = posQty[r.symbol] || 0;
                const reason = !st.hold ? 'regime no longer bear'
                    : px > 0 && px <= Number(r.entry_price) * (1 - CFG.hedgeStopPct / 100) ? `stop (−${CFG.hedgeStopPct}%)` : null;
                if (!(liveQty > 0)) res = await _hedgeGone(userId, r, px);
                else if (reason) res = await _closeHedge(userId, r, reason, px, liveQty);
            } else if (r.leg === 'hedge' && r.status === 'pending_close' && posQty) {
                res = await _manageHedgeClosing(client, userId, r, prices[r.symbol], posQty[r.symbol] || 0, now);
            } else if (r.leg === 'short') {
                res = await _manageShort(client, userId, r, prices[r.symbol], st.hold, now, posQty);
            } else if (r.leg === 'spread') {
                res = await _manageSpread(client, userId, r, st.hold, now, posQty);
            }
            if (res) actions.push(res);
        } catch (err) {
            logger.warn('[BearSide] Managing position failed — others continue', { userId, id: r.id, leg: r.leg, symbol: r.symbol, error: _errMsg(err) });
        }
    }
    await _syncSleeve(userId).catch(err => logger.warn('[BearSide] Sleeve sync failed', { userId, error: err.message }));
    // regime context at exit, for the per-regime report (BEAR / PANIC / recovery)
    await query(`UPDATE bear_positions SET meta = meta || jsonb_build_object('exitRegime', $2::text, 'exitVix', $3::numeric)
                 WHERE user_id = $1 AND status = 'closed' AND closed_at >= $4 AND NOT (meta ? 'exitRegime')`,
        [String(userId), st.stale ? 'UNKNOWN' : st.regimeType, st.vix, tickStart]).catch(() => {});
    const stillOpen = await _rows(userId);
    await _squeezeWatch(client, userId, stillOpen.filter(r => r.leg === 'short' && r.status === 'open'), now)
        .catch(err => logger.warn('[BearSide] Squeeze watch failed (non-blocking)', { userId, error: _errMsg(err) }));
    await _verifyLiquidation(client, userId, st, stillOpen, now)
        .catch(err => logger.warn('[BearSide] Liquidation check failed (non-blocking)', { userId, error: _errMsg(err) }));
    for (const r of stillOpen.filter(x => x.status === 'pending_close' && x.meta?.closeStartedAt)) {
        if (now.getTime() - new Date(r.meta.closeStartedAt).getTime() > CFG.closeStuckMin * 60000) {
            await _alert(userId, `closestuck:${r.id}`, `${r.symbol} ${r.leg} exit (${r.exit_reason || 'close'}) not confirmed after ${CFG.closeStuckMin} min — still counted as open risk; check the account.`, now);
        }
    }

    // enter
    const halt = await _haltState(userId);
    if (allowEntries && st.enter && halt.halted_at) logger.warn('[BearSide] Entries skipped — kill switch on', { userId, since: halt.halted_at, reason: halt.halt_reason });
    if (allowEntries && st.enter && !posQty) logger.warn('[BearSide] Entries skipped — broker positions unreadable this tick', { userId });
    if (allowEntries && st.enter && !halt.halted_at && posQty) {
        rows = await _rows(userId);
        const f = await _funding(client, userId, rows);
        f.vix = st.vix;
        // recorded risk over the cap means the books can't be trusted: halt, don't add
        if (f.openRisk > f.equity * maxRiskPct() / 100 * 1.02) {
            await _halt(userId, `Recorded bear risk ${Math.round(f.openRisk)} is over the ${maxRiskPct()}% cap (${Math.round(f.equity * maxRiskPct() / 100)})`, now);
            return { regime: st.regimeType, hold: st.hold, enter: false, actions };
        }
        const tryLeg = async (leg, fn) => {
            const key = `${userId}:${leg}:${today}`;
            if (_enteredOn.has(key)) return;
            _enteredOn.add(key);
            try {
                const res = await fn();
                if (res.length) { actions.push(...res); logger.info(`[BearSide] ${leg} entries`, { userId, regime: st.regimeType, results: res, freeCash: Math.round(f.freeCash), capRoom: Math.round(f.capRoom) }); }
            } catch (err) { logger.warn(`[BearSide] ${leg} entries failed`, { userId, error: _errMsg(err) }); }
        };
        await tryLeg('hedge', () => _enterHedge(client, userId, f, rows, st.regimeType));
        await tryLeg('short', () => _enterShorts(client, userId, f, rows, st.regimeType, today, now));
        await tryLeg('spread', () => _enterSpreads(client, userId, f, rows, st.regimeType, today));
    }
    return { regime: st.regimeType, hold: st.hold, enter: st.enter, actions };
}

/** Scheduler tick (every 5 min, market hours). Entries 10:30-15:30 ET. */
const _enteredOn = new Set();
async function runTick(now = new Date()) {
    const ids = userIds();
    if (!ids.length) return;
    const { isMarketOpen } = require('../utils/marketCalendar');
    if (!isMarketOpen(now)) return;
    const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
    const etMin = parseInt(et.find(p => p.type === 'hour').value, 10) * 60 + parseInt(et.find(p => p.type === 'minute').value, 10);
    const allowEntries = etMin >= 10 * 60 + 30 && etMin < 15 * 60 + 30;
    for (const id of ids) {
        try {
            const r = await runForUser(id, now, { allowEntries });
            if (r.actions.length) logger.info('[BearSide] Tick', { userId: id, regime: r.regime, actions: r.actions });
        } catch (err) {
            logger.warn('[BearSide] Tick failed (non-blocking)', { userId: id, error: err.message });
        }
    }
}

/** Order ids of shorts (entry, stop, cover) — reconcileFillHistory skips these; they are not in `trades`. */
async function managedOrderIds(userId) {
    try {
        const r = await query(`SELECT entry_order_id, stop_order_id, exit_order_id FROM bear_positions
                               WHERE user_id = $1 AND leg = 'short' AND opened_at > NOW() - INTERVAL '60 days'`, [String(userId)]);
        return new Set(r.rows.flatMap(x => [x.entry_order_id, x.stop_order_id, x.exit_order_id]).filter(Boolean));
    } catch (_) {
        return new Set(); // table not created yet
    }
}

/**
 * Results for the paper-tests page / Saturday report: per leg P&L, open positions, and the shadow test —
 * every logged short candidate's 5- and 10-trading-day return (a short gains when it is negative) vs SPY.
 */
/**
 * Pure: per-leg results from closed positions (oldest first). Return on risk = P&L / max loss taken;
 * the T-bill line is what the same capital would have earned in cash over the same days — a bear leg that
 * can't beat it isn't adding value. Commissions are $0 on Alpaca; short borrow fees are not in the API
 * (only easy-to-borrow names are shorted, and a short is covered if that changes).
 */
function legMetrics(rows, { riskFreePct = num('RISK_FREE_PCT', 4) } = {}) {
    const out = {};
    for (const leg of ['hedge', 'short', 'spread']) {
        const all = rows.filter(r => r.leg === leg);
        const closed = all.filter(r => r.status === 'closed' && r.pnl != null);
        const pnls = closed.map(r => Number(r.pnl));
        const wins = pnls.filter(p => p > 0), losses = pnls.filter(p => p <= 0);
        const grossWin = wins.reduce((s, p) => s + p, 0), grossLoss = -losses.reduce((s, p) => s + p, 0);
        const risk = closed.reduce((s, r) => s + (Number(r.risk_usd) || 0), 0);
        let cum = 0, peak = 0, maxDd = 0, peakAt = null, underwaterDays = 0;
        closed.forEach((r, i) => {
            cum += pnls[i];
            const at = new Date(r.closed_at || r.opened_at);
            if (cum >= peak) { peak = cum; peakAt = at; }
            else if (peakAt) underwaterDays = Math.max(underwaterDays, (at - peakAt) / 86400000);
            maxDd = Math.max(maxDd, peak - cum);
        });
        // a short stopped out above its stop = an overnight / fast gap through the stop
        const gapLoss = closed.filter(r => leg === 'short' && r.exit_reason === 'stop' && Number(r.stop_price) > 0 && Number(r.exit_price) > Number(r.stop_price))
            .reduce((s, r) => s + (Number(r.exit_price) - Number(r.stop_price)) * Number(r.qty), 0);
        const capital = r => leg === 'spread' ? Number(r.entry_price) * 100 * Number(r.qty) : Number(r.entry_price) * Number(r.qty);
        const tbill = closed.reduce((s, r) => s + capital(r) * Math.max(1, (new Date(r.closed_at) - new Date(r.opened_at)) / 86400000) / 365 * riskFreePct / 100, 0);
        const slips = all.map(r => Number(r.meta?.slippagePct)).filter(Number.isFinite);
        out[leg] = {
            open: all.filter(r => OPEN_STATUSES.includes(r.status)).length, closed: closed.length, wins: wins.length,
            pnl: r2(cum), avgWin: wins.length ? r2(grossWin / wins.length) : null, avgLoss: losses.length ? r2(-grossLoss / losses.length) : null,
            profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : (grossWin > 0 ? Infinity : null),
            expectancy: closed.length ? r2(cum / closed.length) : null,
            returnOnRiskPct: risk > 0 ? r2(cum / risk * 100) : null,
            maxDrawdown: r2(maxDd), tbillSameCapital: r2(tbill), vsTbill: r2(cum - tbill),
            avgSlippagePct: slips.length ? r2(slips.reduce((s, v) => s + v, 0) / slips.length) : null,
            winRatePct: closed.length ? r2(wins.length / closed.length * 100) : null,
            longestUnderwaterDays: r2(underwaterDays), gapLossUsd: r2(gapLoss),
        };
    }
    return out;
}

/** Pure: market context a closed position lived through — VIX at entry and the regime when it closed. */
function regimeBucket(r, { highVix = 25 } = {}) {
    const ex = r.meta?.exitRegime;
    if (ex === 'PANIC') return 'PANIC';
    if (ex && ex !== 'BEAR' && ex !== 'UNKNOWN') return 'recovery (closed as BEAR ended)';
    const v = Number(r.meta?.vixAtEntry);
    if (!Number.isFinite(v) || r.meta?.vixAtEntry == null) return 'BEAR, VIX unknown';
    return v >= highVix ? 'BEAR, high volatility (VIX ≥ 25)' : 'BEAR, moderate volatility (VIX < 25)';
}

/** Pure: all-legs results split by market context, so a strategy that only works in one kind of bear shows up. */
function regimeBreakdown(rows) {
    const groups = {};
    for (const r of rows.filter(x => x.status === 'closed' && x.pnl != null)) (groups[regimeBucket(r)] = groups[regimeBucket(r)] || []).push(r);
    return Object.entries(groups).map(([bucket, rs]) => {
        const p = rs.map(r => Number(r.pnl)), w = p.filter(v => v > 0);
        const gl = -p.filter(v => v <= 0).reduce((s, v) => s + v, 0), gw = w.reduce((s, v) => s + v, 0);
        return { bucket, trades: rs.length, winRatePct: r2(w.length / rs.length * 100), pnl: r2(p.reduce((s, v) => s + v, 0)),
                 profitFactor: gl > 0 ? r2(gw / gl) : (gw > 0 ? Infinity : null), expectancy: r2(p.reduce((s, v) => s + v, 0) / rs.length),
                 byLeg: Object.fromEntries(['hedge', 'short', 'spread'].map(l => [l, r2(rs.filter(r => r.leg === l).reduce((s, r) => s + Number(r.pnl), 0))])) };
    });
}

async function summary() {
    await ensureTables();
    const allRows = (await query(`SELECT leg, status, pnl::float, risk_usd::float, entry_price::float, qty::float, opened_at, closed_at, meta,
                                         exit_reason, stop_price::float, exit_price::float
                                  FROM bear_positions WHERE status <> 'not_filled' ORDER BY COALESCE(closed_at, opened_at)`)).rows;
    const metrics = legMetrics(allRows);
    const byRegime = regimeBreakdown(allRows);
    const legs = Object.entries(metrics).filter(([, m]) => m.open || m.closed).map(([leg, m]) => ({ leg, ...m }));
    const open = (await query(`SELECT user_id, leg, symbol, long_contract, short_contract, qty::float, entry_price::float, stop_price::float, risk_usd::float,
                                      sector, status, opened_at, regime, meta
                               FROM bear_positions WHERE status IN ('open', 'pending_open', 'pending_close') ORDER BY opened_at`)).rows;
    // risk view of what is open now: capital deployed vs max loss vs a +5% overnight gap
    const deployed = open.reduce((s, p) => s + (p.leg === 'spread' ? (p.entry_price || 0) * 100 * p.qty : (p.entry_price || 0) * p.qty), 0);
    const maxLoss = open.reduce((s, p) => s + (p.risk_usd || 0), 0);
    const openVals = open.map(p => ({ leg: p.leg, value: (p.entry_price || 0) * p.qty, debitUsd: (p.entry_price || 0) * 100 * p.qty }));
    const stress = stressLoss(openVals);
    const gapStress = shortGapStress(openVals);
    const shadowSql = where => `
        WITH c AS (SELECT d, symbol, price::float AS p, rsi::float AS rsi, passed FROM bear_short_candidates WHERE ${where}),`;
    const FWD = `
        fwd AS (
            SELECT c.d, c.symbol, c.p,
                   (SELECT close::float FROM daily_bars b WHERE b.symbol = c.symbol AND (b.timestamp AT TIME ZONE 'UTC')::date > c.d
                    ORDER BY b.timestamp OFFSET 4 LIMIT 1) AS c5,
                   (SELECT close::float FROM daily_bars b WHERE b.symbol = c.symbol AND (b.timestamp AT TIME ZONE 'UTC')::date > c.d
                    ORDER BY b.timestamp OFFSET 9 LIMIT 1) AS c10,
                   (SELECT close::float FROM daily_bars b WHERE b.symbol = 'SPY' AND (b.timestamp AT TIME ZONE 'UTC')::date <= c.d
                    ORDER BY b.timestamp DESC LIMIT 1) AS s0,
                   (SELECT close::float FROM daily_bars b WHERE b.symbol = 'SPY' AND (b.timestamp AT TIME ZONE 'UTC')::date > c.d
                    ORDER BY b.timestamp OFFSET 4 LIMIT 1) AS s5
            FROM c)
`;
    const shadow = (await query(shadowSql('passed') + FWD + `
        SELECT COUNT(*)::int AS logged, COUNT(DISTINCT d)::int AS days,
               COUNT(c5)::int AS n5, (AVG(c5 / p - 1) * 100)::float AS avg_ret5,
               (AVG(CASE WHEN c5 < p THEN 1.0 ELSE 0 END) FILTER (WHERE c5 IS NOT NULL) * 100)::float AS pct_fell5,
               COUNT(c10)::int AS n10, (AVG(c10 / p - 1) * 100)::float AS avg_ret10,
               (AVG(s5 / s0 - 1) FILTER (WHERE c5 IS NOT NULL) * 100)::float AS spy_ret5
        FROM fwd`)).rows[0];
    // shadow test of the RSI cut-off: forward returns by RSI band, passed and rejected candidates alike
    // (only RSI ≥ 30 is ever traded; the bands are the review's proposed classification)
    const byRsi = (await query(shadowSql('true') + FWD.replace('SELECT c.d, c.symbol, c.p,', 'SELECT c.d, c.symbol, c.p, c.rsi, c.passed,') + `
        SELECT CASE WHEN rsi IS NULL THEN 'unknown' WHEN rsi < 25 THEN '<25' WHEN rsi < 30 THEN '25-30' WHEN rsi < 40 THEN '30-40'
                    WHEN rsi < 50 THEN '40-50' ELSE '50+' END AS band,
               COUNT(*)::int AS logged, COUNT(c5)::int AS n5, (AVG(c5 / p - 1) * 100)::float AS avg_ret5,
               (AVG(CASE WHEN c5 < p THEN 1.0 ELSE 0 END) FILTER (WHERE c5 IS NOT NULL) * 100)::float AS pct_fell5,
               COUNT(c10)::int AS n10, (AVG(c10 / p - 1) * 100)::float AS avg_ret10,
               (AVG(s5 / s0 - 1) FILTER (WHERE c5 IS NOT NULL) * 100)::float AS spy_ret5
        FROM fwd GROUP BY 1 ORDER BY 1`)).rows;
    const state = (await query(`SELECT user_id, last_bear_at, bear_since, last_regime, recovering, checked_at, liquidating_since, halted_at, halt_reason FROM bear_state`)).rows;
    // actual unrealized P&L as the broker reports it, for the bear book's symbols/contracts only
    let unrealizedUsd = null;
    try {
        for (const uid of [...new Set(open.map(p => p.user_id))]) {
            const ps = await _get(await _client(uid), '/v2/positions');
            const mine = new Set(open.filter(p => p.user_id === uid).flatMap(p => [p.leg === 'spread' ? null : p.symbol, p.long_contract, p.short_contract]).filter(Boolean));
            unrealizedUsd = (unrealizedUsd || 0) + ps.filter(p => mine.has(p.symbol)).reduce((s, p) => s + (parseFloat(p.unrealized_pl) || 0), 0);
        }
    } catch (_) { unrealizedUsd = null; } // report without it
    const maxDefinedLossUsd = r2(openVals.filter(p => p.leg === 'spread').reduce((s, p) => s + p.debitUsd, 0));
    return { legs, open, shadow, shadowByRsi: byRsi, byRegime, state,
             riskLabels: { maxLossUsd: 'stop-based: loss if every stop fills at its price (+ dividends owed)',
                           gapStressUsd: 'defined scenario, NOT worst case: shorts +30% through stops, hedges/spreads a +5% market gap — shorts can gap further',
                           maxDefinedLossUsd: 'spreads: the full debit (the most they can lose)', unrealizedUsd: 'broker-reported unrealized P&L now' },
             risk: { deployedUsd: r2(deployed), maxLossUsd: r2(maxLoss), stressGapUsd: stress, stressGapPct: CFG.stressGapPct, shortGapStress: gapStress,
                     dividendLiabilityUsd: r2(open.reduce((s, p) => s + (Number(p.meta?.dividend?.liabilityUsd) || 0), 0)),
                     maxDefinedLossUsd, unrealizedUsd: unrealizedUsd == null ? null : r2(unrealizedUsd),
                     gapStressUsd: gapStressUsd({ shortsValue: openVals.filter(p => p.leg === 'short').reduce((s, p) => s + p.value, 0),
                                                  hedgeValue: openVals.filter(p => p.leg === 'hedge').reduce((s, p) => s + p.value, 0),
                                                  spreadDebit: openVals.filter(p => p.leg === 'spread').reduce((s, p) => s + p.debitUsd, 0) }) },
             config: { hedgePct: hedgePct(), shortEachPct: shortEachPct(), shortMax: CFG.shortMax, spreadPct: spreadPct(),
             grossCapPct: grossCapPct(), maxRiskPct: maxRiskPct(), maxTradeRiskPct: maxTradeRiskPct(), maxShortsPerSector: CFG.maxShortsPerSector,
             exitAfterHours: exitAfterHours(), allowMargin: allowMargin(), maxGapRiskPct: maxGapRiskPct() } };
}

module.exports = {
    CFG, regimeDecision, recoverySignal, fundingRoom, positionRisk, riskRoom, rsi14, shortQuality, stressLoss,
    brokerMismatch, legMetrics, rankShortCandidates, shortPlan, chooseSpread, spreadPlan, parseOcc,
    regimeStale, dividendExposure, shortGapStress, entryTape, squeezeFlags, liquidationLeftovers, rsiBand, regimeBucket, regimeBreakdown,
    unknownShorts, gapStressUsd, resumeBear, resumeProblems,
    runForUser, runTick, managedOrderIds, summary, ensureTables,
    _internal: { closeHedge: (...a) => _closeHedge(...a), closeSpreadStep: (...a) => _closeSpreadStep(...a), gapFits: (...a) => _gapFits(...a),
                 manageShort: (...a) => _manageShort(...a) },
};
