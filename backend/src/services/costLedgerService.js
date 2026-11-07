/**
 * Cost ledger (2026-11-07) — what the app spends to run, so it can answer for itself:
 * "this week we spent $X on services and the live accounts made $Y".
 *
 * Two kinds of cost:
 *  - metered (pay per use, e.g. Gemini): each call site reports its own cost via add();
 *    rows are summed per day + service in api_costs.
 *  - subscriptions (fixed monthly plans): service_subscriptions, one row per service with
 *    the monthly price. Unknown prices stay NULL and the report says so instead of guessing.
 *
 * add() is fire-and-forget and never throws — cost tracking must never break a caller.
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

// Services the app uses (keys in .env). monthly_usd NULL = price not known yet.
const KNOWN_SERVICES = [
    ['Alpaca', 'broker + market data'],
    ['Polygon', 'market data'],
    ['Finnhub', 'fundamentals, earnings, insider filings'],
    ['Gemini', 'metered — tracked per call, not a subscription'],
    ['Twilio', 'WhatsApp/SMS alerts'],
    ['NewsAPI', 'news'],
    ['Alpha Vantage', 'market data'],
    ['X (Twitter) API', 'social sentiment'],
    ['Claude subscription', 'Claude Code + daily macro briefing routine'],
    ['Cloudflare', 'tunnel for the website'],
];

let _ready = false;
async function ensureTables() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS api_costs (
            day     DATE    NOT NULL,
            service TEXT    NOT NULL,
            calls   INT     NOT NULL DEFAULT 0,
            usd     NUMERIC NOT NULL DEFAULT 0,
            PRIMARY KEY (day, service)
        )`);
    await query(`
        CREATE TABLE IF NOT EXISTS service_subscriptions (
            service     TEXT PRIMARY KEY,
            monthly_usd NUMERIC,
            notes       TEXT,
            active      BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    for (const [service, notes] of KNOWN_SERVICES) {
        await query(`INSERT INTO service_subscriptions (service, notes) VALUES ($1, $2) ON CONFLICT (service) DO NOTHING`, [service, notes]);
    }
    _ready = true;
}

const _etDay = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** Record metered spend. service e.g. 'gemini:pulse'. Never throws, never awaited by callers. */
function add(service, usd, calls = 1) {
    if (!(usd >= 0)) return;
    (async () => {
        await ensureTables();
        await query(
            `INSERT INTO api_costs (day, service, calls, usd) VALUES ($1, $2, $3, $4)
             ON CONFLICT (day, service) DO UPDATE SET calls = api_costs.calls + EXCLUDED.calls, usd = api_costs.usd + EXCLUDED.usd`,
            [_etDay(), service, calls, usd]);
    })().catch(err => logger.debug('[CostLedger] add failed', { service, error: err.message }));
}

/** Gemini cost from a response's usageMetadata (thinking tokens bill as output). */
function geminiCost(usage, { inPerM = Number(process.env.GEMINI_PRICE_IN_PER_M || 0.30), outPerM = Number(process.env.GEMINI_PRICE_OUT_PER_M || 2.50) } = {}) {
    const u = usage || {};
    return (u.promptTokenCount || 0) / 1e6 * inPerM + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) / 1e6 * outPerM;
}

/** Spend between two ET dates (inclusive): metered by service + subscriptions pro-rated by days. */
async function spend(fromDay, toDay) {
    await ensureTables();
    const metered = (await query(
        `SELECT service, SUM(calls)::int AS calls, SUM(usd)::float AS usd FROM api_costs
         WHERE day BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 3 DESC`, [fromDay, toDay])).rows;
    const subs = (await query(`SELECT service, monthly_usd::float AS monthly_usd, notes FROM service_subscriptions WHERE active ORDER BY service`)).rows;
    const days = Math.round((new Date(toDay) - new Date(fromDay)) / 86400000) + 1;
    const share = days / (365 / 12);
    const known = subs.filter(s => s.monthly_usd != null);
    const meteredUsd = metered.reduce((s, x) => s + x.usd, 0);
    const subsUsd = known.reduce((s, x) => s + x.monthly_usd * share, 0);
    return {
        fromDay, toDay, days, metered, meteredUsd,
        subscriptions: known.map(s => ({ ...s, periodUsd: s.monthly_usd * share })),
        subscriptionsUsd: subsUsd,
        unknownPrices: subs.filter(s => s.monthly_usd == null && !/metered/.test(s.notes || '')).map(s => s.service),
        totalUsd: meteredUsd + subsUsd,
    };
}

module.exports = { add, geminiCost, spend, ensureTables, KNOWN_SERVICES, _etDay };
