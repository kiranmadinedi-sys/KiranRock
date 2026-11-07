/**
 * Research agent (2026-11-07) — every Saturday, Gemini reads the week (our trades, the
 * market, news events) plus the research lab's full memory (every idea tested so far and
 * why it passed or failed), then writes a few NEW ideas in the lab's spec format.
 *
 * It only proposes. The lab (researchLabService, Saturday 13:00 ET) tests the ideas
 * against its fixed pass rule, and the results become next week's memory. The agent can't
 * grade its own ideas, change trading, or bypass paper → approval.
 *
 * It "learns" by remembering: each week's prompt includes every past result, so it stops
 * repeating failures and builds on what came close. No model is retrained.
 */
const axios = require('axios');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');
const lab = require('./researchLabService');
const { EVENT_TYPES } = require('./newsEventService');

const MAX_IDEAS = 6; // a few per week — every extra test raises the odds of a lucky pass
const MODEL = () => process.env.GEMINI_AGENT_MODEL || 'gemini-3.5-flash';

async function _memory() {
    await lab.ensureTable();
    const r = await query(`SELECT name, family, idea, spec, status, result FROM research_hypotheses ORDER BY id`);
    return r.rows.map(h => {
        const res = h.result || {};
        return {
            name: h.name, family: h.family, idea: h.idea, spec: h.spec, status: h.status,
            ...(h.status === 'queued' ? {} : {
                trainEdgePp: res.train?.edgePp, trainT: res.train?.t, holdoutEdgePp: res.holdout?.edgePp, holdoutT: res.holdout?.t,
                trades: res.trades, years: res.years, why: res.why,
            }),
        };
    });
}

async function _week(now) {
    const since = new Date(now.getTime() - 7 * 86400000).toISOString();
    const trades = (await query(
        `SELECT symbol, sector, ai_score::float AS score, pnl_percent::float AS pnl_pct, hold_hours::float AS hold_h, entry_regime
         FROM trades WHERE action = 'SELL' AND pnl IS NOT NULL AND trade_date >= $1 ORDER BY trade_date`, [since])).rows;
    const idx = (await query(
        `SELECT symbol, (array_agg(c ORDER BY d DESC))[1] / NULLIF((array_agg(c ORDER BY d DESC))[6], 0) - 1 AS r5
         FROM history_bars WHERE symbol IN ('SPY', 'QQQ', 'IWM') AND d >= CURRENT_DATE - 14 GROUP BY symbol`)).rows;
    const events = (await query(
        `SELECT event_type, COUNT(*)::int AS n FROM news_events
         WHERE created_at >= $1 AND event_type NOT IN ('noise', 'unclassified') GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, [since]).catch(() => ({ rows: [] }))).rows;
    return {
        closedTrades: trades.map(t => ({ ...t, pnl_pct: t.pnl_pct == null ? null : +t.pnl_pct.toFixed(2), hold_h: t.hold_h == null ? null : Math.round(t.hold_h) })),
        index5dPct: Object.fromEntries(idx.map(x => [x.symbol, x.r5 == null ? null : +(x.r5 * 100).toFixed(2)])),
        newsEventsThisWeek: events,
    };
}

function buildPrompt(memory, week) {
    return `You are the research agent for a US stock swing-trading system. Propose up to ${MAX_IDEAS} NEW trading ideas that a fixed test bench will check on 3 years of daily prices (2023 →, ~4,700 liquid US stocks).

HOW THE BENCH TESTS AN IDEA (you cannot change this):
- Signal on a day's close when every condition holds (and the news event, if given, came out before the next open). Buy the next open, sell at the close "hold" trading days later, optional stop "stopPct".
- Edge = the idea's average return minus the average of ALL eligible stocks bought the same day with the same hold.
- PASS needs: train (before ${lab.HOLDOUT_START}) edge ≥ +${lab.PASS.trainEdge}pp with t ≥ ${lab.PASS.trainT}; holdout (from ${lab.HOLDOUT_START}) edge ≥ +${lab.PASS.holdEdge}pp with t ≥ ${lab.PASS.holdT}; ≥ ${lab.PASS.positiveYearsShare * 100}% of years positive.

SPEC FORMAT (JSON): {"when": [[feature, op, value], ...], "hold": 1-60, "stopPct": number|null, "event": optional event type}
- features: ${JSON.stringify(lab.FEATURES)}
- ops: ">", ">=", "<", "<=", "between" (value [lo, hi])
- event types (from sorted news headlines, 2023 →): ${EVENT_TYPES.filter(e => e !== 'noise').join(', ')}
- "when" may be empty only if "event" is given.

RESEARCH MEMORY — every idea tested so far (do NOT repeat or trivially re-tune these; learn from why they failed and from anything that came close):
${JSON.stringify(memory)}

THIS WEEK:
${JSON.stringify(week)}

RULES:
- Each idea needs a clear economic reason (why would this make money, who is on the other side?). Write it in "idea" in one sentence.
- Prefer ideas that are different from everything in memory. Small parameter tweaks of failed ideas waste the test budget.
- Plenty of trades: avoid conditions so narrow they fire on fewer than ~100 days.
- name: short snake_case, unique, ending in the hold (e.g. "_5d").

Reply with JSON only: [{"name": "...", "family": "momentum|mean_reversion|trend|event|market|other", "idea": "...", "spec": {...}}]`;
}

/** Parse + validate the model's ideas against the spec rules and the memory. */
function acceptIdeas(text, memory) {
    let arr;
    try { arr = JSON.parse(String(text).replace(/```json|```/g, '').trim()); } catch (_) { return { accepted: [], rejected: [{ why: 'reply was not JSON' }] }; }
    if (!Array.isArray(arr)) return { accepted: [], rejected: [{ why: 'reply was not a list' }] };
    const names = new Set(memory.map(m => m.name));
    const specs = new Set(memory.map(m => JSON.stringify(lab.validateSpec(m.spec))));
    const accepted = [], rejected = [];
    for (const x of arr.slice(0, MAX_IDEAS)) {
        try {
            if (!x || typeof x.name !== 'string' || !/^[a-z0-9_]{3,60}$/.test(x.name)) throw new Error('bad name');
            if (names.has(x.name)) throw new Error('name already tested');
            const clean = lab.validateSpec(x.spec);
            const key = JSON.stringify(clean);
            if (specs.has(key)) throw new Error('same spec already tested');
            names.add(x.name); specs.add(key);
            accepted.push({ name: x.name, family: String(x.family || 'other').slice(0, 30), idea: String(x.idea || '').slice(0, 400), spec: clean });
        } catch (err) {
            rejected.push({ name: x?.name, why: err.message });
        }
    }
    return { accepted, rejected };
}

async function _ask(prompt) {
    const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 16000, responseMimeType: 'application/json' } },
        { timeout: 180000 });
    const text = resp.data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '[]';
    return { text, usage: resp.data.usageMetadata || {} };
}

/**
 * Saturday: write new ideas into the lab queue (the 13:00 lab run tests them).
 * Returns { added, rejected, usage } or null. Never throws.
 */
async function runWeekly({ now = new Date() } = {}) {
    try {
        if (!process.env.GEMINI_API_KEY) return null;
        const memory = await _memory();
        const week = await _week(now);
        const { text, usage } = await _ask(buildPrompt(memory, week));
        const { accepted, rejected } = acceptIdeas(text, memory);
        for (const idea of accepted) await lab.addHypothesis({ ...idea, source: 'agent' });
        logger.info('[ResearchAgent] Proposed ideas', { added: accepted.map(a => a.name), rejected, usage });
        return { added: accepted, rejected, usage };
    } catch (err) {
        logger.warn('[ResearchAgent] Weekly run failed', { error: err.response?.status || err.message });
        return null;
    }
}

module.exports = { runWeekly, buildPrompt, acceptIdeas, MAX_IDEAS };
