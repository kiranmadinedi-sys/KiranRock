/**
 * News events (2026-11-07) — sorts the archived headlines (news_archive, ~1M since 2023)
 * into a fixed list of event types, so the research lab can test "what do stocks do after
 * event X?" on 3 years of prices.
 *
 * Two passes:
 *   1. Free keyword rules. Benzinga headlines are formulaic ("Maintains Buy, Raises Price
 *      Target", "Q2 EPS Beats", "Files For Offering"), so rules sort most of them.
 *   2. Gemini for what the rules leave as 'unclassified', in batches, with a hard dollar
 *      cap. It shares credits with the nightly PULSE scoring, so never run it during the
 *      overnight scan.
 *
 * Only headlines tagged with 1-2 symbols are used (wider tags are market round-ups).
 */
const axios = require('axios');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const EVENT_TYPES = [
    'analyst_upgrade', 'analyst_downgrade', 'analyst_initiate_bullish', 'analyst_initiate_bearish', 'pt_raise', 'pt_lower',
    'earnings_beat', 'earnings_miss', 'earnings_mixed', 'guidance_raise', 'guidance_cut',
    'offering', 'reverse_split', 'buyback', 'dividend_raise', 'dividend_cut',
    'acquisition_target', 'acquirer', 'fda_approval', 'fda_rejection', 'trial_positive', 'trial_negative',
    'contract_win', 'partnership', 'product_launch', 'exec_departure', 'exec_hire', 'legal_regulatory',
    'layoffs_restructuring', 'bankruptcy_delisting', 'index_addition', 'insider_buy', 'insider_sell', 'noise',
];

const R = (re, type) => ({ re, type });
// First match wins — order matters (an upgrade that also raises the target is an upgrade).
const RULES = [
    R(/options activity|unusual options|options? (trading|frenzy)|whales|what \d+ analyst|analysts? (have|has) this to say|analyst ratings (have to say|for)|price over earnings|p\/e ratio|short interest|stocks? (moving|to watch)|top (gainers|losers)|mid-day|pre-market|after-hours movers|market update|here'?s how much|if you invested|earnings preview|preview of|gears up for|what to expect|here'?s what you need to know|insights into|a closer look|spotlight on|peering into|deep dive|unpacking|decoding|understanding|why .* (stock|shares) (is|are) (trading|moving|falling|rising|higher|lower|down|up)|(climbs|jumps|slides|falls|rises|soars|tumbles|sinks) ahead of|what'?s going on|to be presented at|to present at|will (report|host|present)|conference call|webcast|fireside chat|cryptocurrency|bitcoin|ethereum|\bxrp\b|dogecoin/i, 'noise'),
    // A headline that both raises and cuts (e.g. EPS up, sales down) is ambiguous — leave it to Gemini.
    R(/(raises|boosts|lifts|increases)\b.*\b(lowers|cuts|reduces)\b|(lowers|cuts|reduces)\b.*\b(raises|boosts|lifts|increases)\b/i, 'unclassified'),
    R(/\bupgrades?\b/i, 'analyst_upgrade'),
    R(/\bdowngrades?\b/i, 'analyst_downgrade'),
    R(/initiates? coverage .*\b(buy|outperform|overweight|strong buy|positive|accumulate)\b/i, 'analyst_initiate_bullish'),
    R(/initiates? coverage .*\b(sell|underperform|underweight|negative|reduce)\b/i, 'analyst_initiate_bearish'),
    R(/initiates? coverage/i, 'noise'),
    R(/(raises|boosts|increases) price target|price target (raised|to \$[\d.]+ from \$[\d.]+)(?=.*raise)/i, 'pt_raise'),
    R(/(lowers|cuts|reduces) price target/i, 'pt_lower'),
    R(/(maintains|reiterates|adjusts) .*price target/i, 'noise'),
    R(/(raises|boosts|lifts|increases) .*(guidance|outlook|forecast)|(fy|full[- ]year|q\d) .*guidance .*(above|raised)/i, 'guidance_raise'),
    R(/(lowers|cuts|reduces|slashes|withdraws) .*(guidance|outlook|forecast)|guidance .*below (estimate|consensus)/i, 'guidance_cut'),
    R(/eps[^,;]*\bbeats?\b[^;]*(sales|revenue)[^,;]*\b(miss|misses)\b|eps[^,;]*\b(miss|misses)\b[^;]*(sales|revenue)[^,;]*\bbeats?\b/i, 'earnings_mixed'),
    R(/eps[^,;]*\bbeats?\b/i, 'earnings_beat'),
    R(/eps[^,;]*\b(miss|misses)\b/i, 'earnings_miss'),
    R(/reverse (stock )?split/i, 'reverse_split'),
    R(/(prices?|pricing|announces?|files?|proposed|launch(es)?)\b[^.]*\b(offering|shelf|private placement|atm program)|\boffering of\b/i, 'offering'),
    R(/reverse (share|stock)? ?split/i, 'reverse_split'),
    R(/(repurchase|buyback)/i, 'buyback'),
    R(/(raises|increases|hikes|boosts) .*dividend|dividend (increase|hike)/i, 'dividend_raise'),
    R(/(cuts|suspends|reduces|eliminates) .*dividend/i, 'dividend_cut'),
    R(/(declares|announces) .*dividend|ex-dividend|dividend (of|payable)/i, 'noise'),
    R(/\bfda (approv|clear|grants? (breakthrough|fast track|priority))|\bfda\b.{0,40}\b(approval|approves|clearance|cleared)\b|approved by (the )?fda/i, 'fda_approval'),
    R(/complete response letter|\bcrl\b|fda[^.]*\b(reject|declin)/i, 'fda_rejection'),
    R(/(added to|join(s|ing)?) (the )?s&p (500|midcap|smallcap)|to replace .* in (the )?s&p/i, 'index_addition'),
    R(/chapter 11|bankruptcy|delist|going concern/i, 'bankruptcy_delisting'),
    R(/class action|securities fraud|investigation (of|on behalf)|shareholder (alert|rights)|law firm|lawsuit (filed|on behalf)|investors? (who|that) (lost|purchased)/i, 'noise'),
    R(/(layoffs?|job cuts|cut(s|ting)? .*jobs|workforce reduction|restructuring)/i, 'layoffs_restructuring'),
    R(/\b(ceo|cfo|chief executive|chief financial)\b[^.]*\b(resign|steps? down|depart|retire|terminated|ousted)/i, 'exec_departure'),
    R(/\b(appoints?|names?|hires?)\b[^.]*\b(ceo|cfo|chief executive|chief financial)/i, 'exec_hire'),
    R(/\b(awarded|wins?|secures?|receives?)\b[^.]*\b(contract|purchase order|order from|orders? (worth|valued|for)|task order)/i, 'contract_win'),
    R(/\b(form 4|insider)\b[^.]*\b(buy|bought|purchase)/i, 'insider_buy'),
    R(/\b(form 4|insider)\b[^.]*\b(sell|sold|sale)/i, 'insider_sell'),
];

/** Rule pass for one headline → event type, or 'unclassified'. */
function classifyRule(headline) {
    const h = String(headline || '');
    for (const { re, type } of RULES) if (re.test(h)) return type;
    return 'unclassified';
}

let _ready = false;
async function ensureTable() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS news_events (
            news_id    BIGINT      NOT NULL,
            symbol     TEXT        NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            event_type TEXT        NOT NULL,
            method     TEXT        NOT NULL,
            PRIMARY KEY (news_id, symbol)
        )`);
    await query(`CREATE INDEX IF NOT EXISTS news_events_type_idx ON news_events (event_type)`);
    _ready = true;
}

/**
 * Rule pass over every headline not yet sorted (idempotent, resumable). Returns counts by type.
 */
async function runRulePass({ since = '2023-01-01', page = 20000 } = {}) {
    await ensureTable();
    const counts = {};
    let lastId = 0;
    for (;;) {
        const r = await query(
            `SELECT a.id, a.created_at, a.headline, a.symbols FROM news_archive a
             WHERE a.id > $1 AND a.created_at >= $2::date AND cardinality(a.symbols) BETWEEN 1 AND 2
               AND NOT EXISTS (SELECT 1 FROM news_events e WHERE e.news_id = a.id)
             ORDER BY a.id LIMIT $3`, [lastId, since, page]);
        if (!r.rows.length) break;
        const values = [], params = [];
        for (const row of r.rows) {
            const type = classifyRule(row.headline);
            counts[type] = (counts[type] || 0) + 1;
            for (const sym of row.symbols) {
                const o = params.length;
                values.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},'rule')`);
                params.push(row.id, sym, row.created_at, type);
            }
        }
        for (let i = 0; i < values.length; i += 4000) {
            const chunk = values.slice(i, i + 4000);
            const first = Number(chunk[0].match(/\$(\d+)/)[1]) - 1;
            await query(
                `INSERT INTO news_events (news_id, symbol, created_at, event_type, method) VALUES ${chunk.join(',').replace(/\$(\d+)/g, (_, n) => `$${Number(n) - first}`)}
                 ON CONFLICT DO NOTHING`, params.slice(first, first + chunk.length * 4));
        }
        lastId = r.rows[r.rows.length - 1].id;
    }
    return counts;
}

// ── Gemini pass ─────────────────────────────────────────────────────────────
const PRICE_IN = Number(process.env.GEMINI_PRICE_IN_PER_M || 0.30);
const PRICE_OUT = Number(process.env.GEMINI_PRICE_OUT_PER_M || 2.50);

function _prompt(items) {
    return `Classify each stock-news headline into exactly one event type for the company named by its ticker.
Types: ${EVENT_TYPES.join(', ')}.
Use "noise" for previews, recaps, opinion, options/technical commentary, routine filings, conference appearances, and anything that is not a new company-specific event.
"acquisition_target" = the ticker is being bought; "acquirer" = the ticker is buying.
Reply with JSON only: [{"i":<number>,"t":"<type>"}] — one object per headline, same numbers.

${items.map((x, i) => `${i}. [${x.symbol}] ${x.headline}`).join('\n')}`;
}

async function _gemini(prompt) {
    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 4000, responseMimeType: 'application/json' } },
        { timeout: 90000 });
    const u = resp.data.usageMetadata || {};
    const cost = (u.promptTokenCount || 0) / 1e6 * PRICE_IN + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) / 1e6 * PRICE_OUT;
    require('./costLedgerService').add('gemini:news', cost);
    const text = resp.data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '[]';
    return { text, cost, usage: u };
}

function parseGeminiReply(text, n) {
    let arr;
    try { arr = JSON.parse(text.replace(/```json|```/g, '').trim()); } catch (_) { return []; }
    if (!Array.isArray(arr)) return [];
    return arr.filter(x => Number.isInteger(x?.i) && x.i >= 0 && x.i < n && EVENT_TYPES.includes(x.t));
}

/**
 * Sort 'unclassified' rows with Gemini until done or the dollar cap is reached.
 * Returns { spentUsd, classified, calls, stoppedBy }.
 */
async function runGeminiPass({ budgetUsd = 25, batch = 100, concurrency = 4, limit = null, onProgress } = {}) {
    await ensureTable();
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
    let spent = 0, classified = 0, calls = 0, failures = 0, lastId = 0, done = false, stoppedBy = 'finished';
    const take = async () => {
        if (done) return null;
        const r = await query(
            `SELECT e.news_id, e.symbol, a.headline FROM news_events e JOIN news_archive a ON a.id = e.news_id
             WHERE e.event_type = 'unclassified' AND e.news_id > $1 ORDER BY e.news_id LIMIT $2`, [lastId, batch]);
        if (!r.rows.length) { done = true; return null; }
        lastId = r.rows[r.rows.length - 1].news_id;
        return r.rows;
    };
    const worker = async () => {
        for (;;) {
            if (spent >= budgetUsd) { stoppedBy = 'budget'; done = true; return; }
            if (limit != null && calls >= limit) { stoppedBy = 'limit'; done = true; return; }
            const items = await take();
            if (!items) return;
            calls++;
            let reply;
            try { reply = await _gemini(_prompt(items)); }
            catch (err) {
                const status = err.response?.status;
                if (status === 402 || status === 401 || status === 403) { stoppedBy = `gemini ${status}`; done = true; return; }
                if (++failures > 20) { stoppedBy = 'too many errors'; done = true; return; }
                await new Promise(r => setTimeout(r, status === 429 ? 30000 : 5000));
                continue; // rows stay 'unclassified' for the next run
            }
            spent += reply.cost;
            const parsed = parseGeminiReply(reply.text, items.length);
            for (const p of parsed) {
                const it = items[p.i];
                await query(`UPDATE news_events SET event_type = $3, method = 'gemini' WHERE news_id = $1 AND symbol = $2 AND event_type = 'unclassified'`,
                    [it.news_id, it.symbol, p.t]);
            }
            classified += parsed.length;
            if (onProgress) onProgress({ spent, classified, calls });
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    logger.info('[NewsEvents] Gemini pass', { spentUsd: +spent.toFixed(2), classified, calls, stoppedBy });
    return { spentUsd: +spent.toFixed(2), classified, calls, stoppedBy };
}

module.exports = { EVENT_TYPES, classifyRule, ensureTable, runRulePass, runGeminiPass, parseGeminiReply, _prompt };
