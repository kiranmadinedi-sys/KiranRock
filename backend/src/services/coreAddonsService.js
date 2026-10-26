/**
 * Core add-ons (2026-10-26, user-approved list):
 *   1. Cash sweep (PAPER ONLY until proven): idle cash above the reserve + a buffer goes into SGOV;
 *      when swing trading pulls cash below the reserve, swept SGOV is sold back. Only the swept
 *      shares are ever sold — the core SGOV target is untouched. Sweep sells are tagged
 *      "CORE_SWEEP" in trade notes so the "paper core was never sold" approval check ignores them.
 *   2. Calm drawdown alerts: core value/cost falls 10/15/20% from its own peak → one Telegram
 *      message per level with historical context, so a dip isn't sold in panic. Information only.
 *   3. Income & tax view: dividends received on core symbols (Alpaca DIV activities) and the date
 *      each holding's first lot turns one year old (US long-term holding period — not tax advice).
 *   4. Add-to-core from the watchlist: paper applies immediately; a live account gets an approval
 *      request (user rule: real-money changes only via approval).
 */
const axios = require('axios');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const SWEEP_SYMBOL = 'SGOV';
const SWEEP_IN_BUFFER_PCT = 5;     // keep reserve + 5% of equity in cash before sweeping more in
const SWEEP_OUT_TRIGGER_PCT = 2;   // sell swept SGOV when cash falls 2% of equity below the reserve
const SWEEP_MIN_USD = 100;
const SWEEP_OUT_THROTTLE_MS = 15 * 60 * 1000;
const DD_LEVELS = [20, 15, 10];
const DD_RESET_PCT = 5;

let _ready = false;
async function ensureColumns() {
    if (_ready) return;
    await require('./coreHoldingsService').ensureTable();
    await query(`ALTER TABLE core_settings
        ADD COLUMN IF NOT EXISTS sweep_enabled BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS sweep_qty NUMERIC NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS dd_peak_index NUMERIC,
        ADD COLUMN IF NOT EXISTS dd_alert_level INT NOT NULL DEFAULT 0`);
    _ready = true;
}

async function getAddonSettings(userId) {
    await ensureColumns();
    const r = await query(`SELECT sweep_enabled AS "sweepEnabled", sweep_qty::float AS "sweepQty", dd_peak_index::float AS "ddPeakIndex", dd_alert_level AS "ddAlertLevel"
                           FROM core_settings WHERE user_id = $1`, [String(userId)]);
    return r.rows[0] || { sweepEnabled: false, sweepQty: 0, ddPeakIndex: null, ddAlertLevel: 0 };
}

async function _isPaper(userId) {
    const cr = await require('./userDatabaseService').getUserAlpacaCredentials(userId);
    return cr.isPaper !== false;
}

async function setSweepEnabled(userId, enabled) {
    await ensureColumns();
    if (enabled && !(await _isPaper(userId))) {
        const e = new Error('Cash sweep is paper-only until it has a clean paper record.'); e.status = 400; throw e;
    }
    await query(`INSERT INTO core_settings (user_id, sweep_enabled) VALUES ($1, $2)
                 ON CONFLICT (user_id) DO UPDATE SET sweep_enabled = EXCLUDED.sweep_enabled`, [String(userId), !!enabled]);
    return getAddonSettings(userId);
}

/** Pure: how much to sweep in (+USD) or out (−USD), or 0. */
function sweepDecision({ equity, cash, reservePct, sweptValue }) {
    const reserve = equity * reservePct / 100;
    const inLine = reserve + equity * SWEEP_IN_BUFFER_PCT / 100;
    const outLine = reserve - equity * SWEEP_OUT_TRIGGER_PCT / 100;
    if (cash < outLine && sweptValue > 0) return -Math.min(sweptValue, reserve - cash);
    if (cash > inLine && cash - inLine >= SWEEP_MIN_USD) return cash - inLine;
    return 0;
}

const _lastOut = new Map();
const _sweptInOn = new Set();
/** Every scheduler tick in market hours: sweep out whenever needed (throttled), sweep in once a day. */
async function runSweepTick(userId, now = new Date()) {
    const s = await getAddonSettings(userId);
    if (!s.sweepEnabled) return null;
    if (!(await _isPaper(userId))) return null; // guard even if the flag was set by hand
    const broker = require('./brokerService');
    const core = require('./coreHoldingsService');
    const acct = await broker.getAccountInfo(userId);
    const { cashReservePct } = await core.getSettings(userId);
    const quote = await require('./dataProvider').getQuote(SWEEP_SYMBOL);
    const price = quote?.price;
    if (!(price > 0)) return null;
    const delta = sweepDecision({ equity: acct.portfolioValue, cash: Math.max(0, acct.cashBalance ?? 0), reservePct: cashReservePct, sweptValue: s.sweepQty * price });
    const day = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (delta < 0) {
        if (Date.now() - (_lastOut.get(userId) || 0) < SWEEP_OUT_THROTTLE_MS) return null;
        _lastOut.set(userId, Date.now());
        const qty = Math.min(s.sweepQty, Math.ceil((-delta / price) * 10000) / 10000);
        const res = await broker.sellMarket(userId, SWEEP_SYMBOL, qty, {
            reason: 'CORE_SWEEP: cash back for swing trading', idempotencyKey: `sweep-out:${userId}:${Date.now()}`,
        });
        const filled = res?.filledQty || 0;
        if (filled > 0) await query(`UPDATE core_settings SET sweep_qty = GREATEST(0, sweep_qty - $2) WHERE user_id = $1`, [String(userId), filled]);
        logger.info('[CoreSweep] Swept out', { userId, qty, filled });
        return { action: 'out', qty, filled };
    }
    if (delta > 0 && !_sweptInOn.has(`${userId}:${day}`)) {
        _sweptInOn.add(`${userId}:${day}`);
        const qty = Math.floor((delta / (price * 1.005)) * 10000) / 10000;
        if (qty <= 0) return null;
        const res = await broker.buyMarket(userId, SWEEP_SYMBOL, qty, {
            executedBy: 'CORE', reason: 'CORE_SWEEP: idle cash into T-bills', safetyOptions: { enforceNotionalLimit: false },
        });
        const filled = res?.filledQty || 0;
        if (filled > 0) await query(`UPDATE core_settings SET sweep_qty = sweep_qty + $2 WHERE user_id = $1`, [String(userId), filled]);
        logger.info('[CoreSweep] Swept in', { userId, qty, filled });
        return { action: 'in', qty, filled };
    }
    return null;
}

/** Pure: new peak, drawdown %, and the level to alert at (or null). */
function drawdownDecision({ index, peak, alertedLevel }) {
    const newPeak = peak == null ? index : Math.max(peak, index);
    const ddPct = (1 - index / newPeak) * 100;
    if (ddPct < DD_RESET_PCT) return { newPeak, ddPct, alert: null, level: 0 };
    const level = DD_LEVELS.find(l => ddPct >= l) || 0;
    return { newPeak, ddPct, alert: level > alertedLevel ? level : null, level: Math.max(level, alertedLevel) };
}

const DD_CONTEXT = {
    10: 'Pullbacks of 10% happen most years — the S&P 500 has had one in roughly every other year since 1950 and recovered from almost all of them.',
    15: 'In 2022 the S&P 500 fell 19% and the Nasdaq 23%; both were back at new highs by 2024. Selling in a drop locks the loss in.',
    20: 'A 20%+ drop is a bear market. These have historically recovered within about 1–3 years. Core is designed to be held through them.',
};

/** Once a day: track core's value/cost peak and send one calm alert per new drawdown level. */
async function runDrawdownCheck(userId) {
    const core = require('./coreHoldingsService');
    const sum = await core.coreSummary(userId);
    if (!sum || !(sum.cost > 0)) return null;
    const s = await getAddonSettings(userId);
    const d = drawdownDecision({ index: sum.value / sum.cost, peak: s.ddPeakIndex, alertedLevel: s.ddAlertLevel });
    await query(`UPDATE core_settings SET dd_peak_index = $2, dd_alert_level = $3 WHERE user_id = $1`, [String(userId), d.newPeak, d.level]);
    if (d.alert) {
        const msg = `🏛️ *Core holdings are ${d.ddPct.toFixed(0)}% below their peak*\n\n${DD_CONTEXT[d.alert]}\n\nNothing is sold automatically. Core value: $${sum.value.toFixed(0)}.`;
        await require('./telegramAlertService').sendMessage(userId, msg).catch(() => {});
        await require('./reportArchiveService').save({ kind: 'core_watchlist', title: `Core drawdown alert — ${d.alert}%`, body: msg, userId });
        logger.info('[CoreDrawdown] Alert sent', { userId, level: d.alert, ddPct: d.ddPct.toFixed(1) });
    }
    return d;
}

const _divCache = new Map();
/** Dividends on core symbols since core started, and each holding's first-lot long-term date. */
async function incomeAndTax(userId, symbols) {
    const out = { dividends: { total: 0, bySymbol: {} }, longTerm: {} };
    if (!symbols.length) return out;
    const start = (await query(`SELECT MIN(created_at)::date::text AS d FROM core_holdings WHERE user_id = $1 AND sleeve = 'core'`, [String(userId)])).rows[0]?.d;
    for (const s of symbols) {
        const r = await query(
            `SELECT MIN(trade_date)::date::text AS d FROM trades WHERE user_id = $1 AND symbol = $2 AND action = 'BUY' AND trade_date >= $3::date`,
            [String(userId), s, start || '2026-01-01']);
        const first = r.rows[0]?.d;
        if (first) {
            const lt = new Date(`${first}T12:00:00Z`); lt.setUTCFullYear(lt.getUTCFullYear() + 1); lt.setUTCDate(lt.getUTCDate() + 1);
            out.longTerm[s] = { firstBuy: first, longTermFrom: lt.toISOString().slice(0, 10) };
        }
    }
    const hit = _divCache.get(userId);
    if (hit && Date.now() - hit.at < 60 * 60 * 1000) { out.dividends = hit.data; return out; }
    try {
        const cr = await require('./userDatabaseService').getUserAlpacaCredentials(userId);
        const base = cr.isPaper === false ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
        const acts = (await axios.get(`${base}/v2/account/activities/DIV`, {
            params: { after: start || '2026-01-01', page_size: 100 }, timeout: 15000,
            headers: { 'APCA-API-KEY-ID': cr.keyId, 'APCA-API-SECRET-KEY': cr.secretKey },
        })).data || [];
        const set = new Set(symbols);
        for (const a of acts) {
            if (!set.has(a.symbol)) continue;
            const amt = parseFloat(a.net_amount || 0);
            out.dividends.total += amt;
            out.dividends.bySymbol[a.symbol] = (out.dividends.bySymbol[a.symbol] || 0) + amt;
        }
        _divCache.set(userId, { at: Date.now(), data: out.dividends });
    } catch (err) {
        out.dividends.error = 'dividends unavailable right now';
        logger.debug('[CoreIncome] Dividend lookup failed', { userId, error: err.message });
    }
    return out;
}

/**
 * Add a watchlist symbol to core at targetPct. Paper: applied now. Live: approval request.
 */
async function addToCore(userId, symbol, targetPct) {
    const core = require('./coreHoldingsService');
    const sym = String(symbol || '').trim().toUpperCase();
    const pct = Number(targetPct);
    if (!(pct >= 1 && pct <= 20)) { const e = new Error('Target must be 1-20% for a single added name.'); e.status = 400; throw e; }
    const rows = await core.getCoreRows(userId);
    if (rows.some(r => r.symbol === sym)) { const e = new Error(`${sym} is already in core.`); e.status = 400; throw e; }
    const holdings = [...rows.map(r => ({ symbol: r.symbol, targetPct: r.targetPct })), { symbol: sym, targetPct: pct }];
    if (await _isPaper(userId)) {
        const res = await core.saveConfig(userId, { holdings });
        return { applied: true, message: `${sym} added to core at ${pct}% (paper).`, holdings: res.holdings };
    }
    const { created } = await require('./approvalService').createRequest({
        userId, kind: 'core_add', key: `${sym}:${pct}`,
        title: `Add ${sym} to Core Holdings at ${pct}%`,
        message: `You asked to add ${sym} to core at ${pct}% of the account from the watchlist. Core buys it after 10:00 AM ET on trading days (fractional shares allowed), holds it long-term and never sells automatically.`,
        payload: { symbol: sym, targetPct: pct },
    });
    return { applied: false, message: created ? 'Approval request sent — approve it in the popup or on Telegram.' : 'An approval request for this is already pending.' };
}

module.exports = {
    SWEEP_SYMBOL, ensureColumns, getAddonSettings, setSweepEnabled, sweepDecision, runSweepTick,
    drawdownDecision, runDrawdownCheck, incomeAndTax, addToCore,
};
