/**
 * ORACLE shadow (2026-11-07) — Gemini answers the exact same candidate check the local
 * model answers in live cycles, and both are logged side by side. LOG ONLY: trading keeps
 * using the local verdict; nothing waits for Gemini.
 *
 * Why: live cycles run ORACLE on the small local model (qwen 7B) for speed, it holds a lot
 * of the PC's 31 GB while loaded, and queue waits make it skip candidates. If Gemini proves
 * at least as good on real outcomes (report() joins 5-day returns from history_bars), the
 * switch goes through an approval like any live change.
 *
 * Env: ORACLE_SHADOW_GEMINI=false turns it off; ORACLE_SHADOW_MAX_PER_DAY caps spend
 * (default 600 ≈ under $1/day on Flash-Lite); GEMINI_ORACLE_MODEL picks the model.
 */
const axios = require('axios');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const MAX_PER_DAY = () => parseInt(process.env.ORACLE_SHADOW_MAX_PER_DAY || '600', 10);
const enabled = () => (process.env.ORACLE_SHADOW_GEMINI || 'true').toLowerCase() !== 'false' && !!process.env.GEMINI_API_KEY;
const MODEL = () => process.env.GEMINI_ORACLE_MODEL || 'gemini-3.5-flash-lite';
const PRICE_IN = Number(process.env.GEMINI_PRICE_IN_PER_M || 0.30);
const PRICE_OUT = Number(process.env.GEMINI_PRICE_OUT_PER_M || 2.50);

let _ready = false;
async function ensureTable() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS oracle_shadow (
            id             BIGSERIAL   PRIMARY KEY,
            at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            symbol         TEXT        NOT NULL,
            price          REAL,
            local_model    TEXT,
            local_verdict  TEXT,
            local_score    REAL,
            local_conf     TEXT,
            local_ms       INT,
            gemini_model   TEXT,
            gemini_verdict TEXT,
            gemini_score   REAL,
            gemini_conf    TEXT,
            gemini_ms      INT,
            gemini_cost    REAL,
            gemini_error   TEXT
        )`);
    await query(`CREATE INDEX IF NOT EXISTS oracle_shadow_at_idx ON oracle_shadow (at)`);
    _ready = true;
}

const _day = { date: null, n: 0 };
function _takeSlot(now = new Date()) {
    const d = now.toISOString().slice(0, 10);
    if (_day.date !== d) { _day.date = d; _day.n = 0; }
    if (_day.n >= MAX_PER_DAY()) return false;
    _day.n++;
    return true;
}

/** Same field rules as the local verdict parser. */
function parseVerdict(raw) {
    const cleaned = String(raw || '').replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    const p = JSON.parse(m ? m[0] : cleaned);
    return {
        verdict: ['TRADE', 'WATCHLIST', 'SKIP'].includes(p.verdict) ? p.verdict : 'WATCHLIST',
        score: Math.max(0, Math.min(100, Number(p.score) || 50)),
        confidence: ['HIGH', 'MEDIUM', 'LOW'].includes(p.confidence) ? p.confidence : 'MEDIUM',
    };
}

async function _askGemini(system, prompt) {
    const t0 = Date.now();
    const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 1500, responseMimeType: 'application/json' },
        },
        { timeout: 60000 });
    const u = resp.data.usageMetadata || {};
    const text = resp.data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    require('./costLedgerService').add('gemini:oracle_shadow', require('./costLedgerService').geminiCost(u, { inPerM: PRICE_IN, outPerM: PRICE_OUT }));
    return {
        ...parseVerdict(text), ms: Date.now() - t0,
        cost: (u.promptTokenCount || 0) / 1e6 * PRICE_IN + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) / 1e6 * PRICE_OUT,
    };
}

/**
 * Fire-and-forget from the live ORACLE path: ask Gemini the same question and log both.
 * local = the local verdict (null when it failed or timed out). Never throws.
 */
function record({ symbol, price, system, prompt, localModel, local, localMs }) {
    if (!enabled() || !_takeSlot()) return;
    (async () => {
        let g = null, error = null;
        try { g = await _askGemini(system, prompt); }
        catch (err) { error = String(err.response?.status || err.message).slice(0, 120); }
        await ensureTable();
        await query(
            `INSERT INTO oracle_shadow (symbol, price, local_model, local_verdict, local_score, local_conf, local_ms,
                                        gemini_model, gemini_verdict, gemini_score, gemini_conf, gemini_ms, gemini_cost, gemini_error)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [symbol, price ?? null, localModel, local?.verdict ?? null, local?.score ?? null, local?.confidence ?? null, localMs ?? null,
             MODEL(), g?.verdict ?? null, g?.score ?? null, g?.confidence ?? null, g?.ms ?? null, g?.cost ?? null, error]);
    })().catch(err => logger.debug('[OracleShadow] record failed', { symbol, error: err.message }));
}

/**
 * Comparison so far: coverage, agreement, and each model's verdicts vs the next 5 trading
 * days (buy the next open after the check, close 5 days later, from history_bars).
 */
async function report({ sinceDays = 30 } = {}) {
    await ensureTable();
    const r = await query(`
        WITH s AS (SELECT DISTINCT ON (symbol, (at AT TIME ZONE 'America/New_York')::date) *,
                          (at AT TIME ZONE 'America/New_York')::date AS d
                   FROM oracle_shadow WHERE at >= NOW() - ($1::int * INTERVAL '1 day') ORDER BY symbol, (at AT TIME ZONE 'America/New_York')::date, at),
             b AS (SELECT symbol, d, o, c, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY d) rn FROM history_bars WHERE symbol IN (SELECT symbol FROM s)),
             e AS (SELECT s.id, MIN(b.rn) rn FROM s JOIN b ON b.symbol = s.symbol AND b.d > s.d GROUP BY s.id)
        SELECT s.local_verdict, s.gemini_verdict, s.gemini_cost, s.local_ms, s.gemini_ms,
               (x5.c / NULLIF(x1.o, 0) - 1) * 100 AS r5
        FROM s LEFT JOIN e ON e.id = s.id
               LEFT JOIN b x1 ON x1.symbol = s.symbol AND x1.rn = e.rn
               LEFT JOIN b x5 ON x5.symbol = s.symbol AND x5.rn = e.rn + 4`, [sinceDays]);
    const rows = r.rows;
    const avg = a => (a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) : null);
    const byVerdict = key => Object.fromEntries(['TRADE', 'WATCHLIST', 'SKIP'].map(v => {
        const rs = rows.filter(x => x[key] === v && x.r5 != null).map(x => Math.max(-40, Math.min(40, +x.r5)));
        return [v, { n: rows.filter(x => x[key] === v).length, withReturns: rs.length, avg5dPct: avg(rs) }];
    }));
    const both = rows.filter(x => x.local_verdict && x.gemini_verdict);
    return {
        checks: rows.length,
        localAnswered: rows.filter(x => x.local_verdict).length,
        geminiAnswered: rows.filter(x => x.gemini_verdict).length,
        agreementPct: both.length ? +(both.filter(x => x.local_verdict === x.gemini_verdict).length / both.length * 100).toFixed(1) : null,
        local: byVerdict('local_verdict'), gemini: byVerdict('gemini_verdict'),
        geminiCostUsd: +rows.reduce((s, x) => s + (+x.gemini_cost || 0), 0).toFixed(2),
        medianMs: {
            local: (a => a.length ? a.sort((x, y) => x - y)[a.length >> 1] : null)(rows.map(x => x.local_ms).filter(Boolean)),
            gemini: (a => a.length ? a.sort((x, y) => x - y)[a.length >> 1] : null)(rows.map(x => x.gemini_ms).filter(Boolean)),
        },
    };
}

module.exports = { record, report, parseVerdict, ensureTable, _takeSlot, _day };
