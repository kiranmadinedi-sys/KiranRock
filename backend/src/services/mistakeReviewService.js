/**
 * Daily mistake review (2026-11-07) — after each close the app looks at what went wrong:
 *  - every losing swing trade closed in the last few days, and
 *  - every stock the bot rejected that then ran ≥ +8% in 5 days (shadow_trades).
 * Gemini labels each with ONE cause from a fixed list plus a one-line lesson, using the
 * facts we hand it (entry setup, market move during the hold, news events around it).
 *
 * Report + memory only: lessons go into trade_lessons, repeated causes are fed to the
 * Saturday research agent (researchAgentService._week), which turns them into ideas the lab
 * tests. Nothing here changes trading — fixes still go lab → paper → approval.
 */
const axios = require('axios');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');
const ledger = require('./costLedgerService');

const LOSS_CAUSES = [
    'chased_extended',      // bought after a big run, near the top
    'bad_news_missed',      // negative company news before or right after entry
    'weak_market',          // the whole market fell during the hold
    'sector_weakness',      // the sector fell while the market held up
    'earnings_or_event',    // earnings/guidance/FDA etc. during the hold
    'stop_too_tight',       // stopped out on normal noise, then recovered
    'weak_setup',           // entry setup was poor (downtrend, no momentum, low quality)
    'normal_noise',         // nothing wrong — an ordinary losing trade
    'data_or_execution',    // bad fill, slippage, missing data, bot error
];
const MISS_CAUSES = [
    'filter_too_strict',    // a rule blocked a good setup (volume gate, setup block, ...)
    'cap_or_budget_limit',  // portfolio/sector caps or candidate budget, not the stock
    'catalyst_unforeseeable', // the move came from news nobody could know at rejection
    'correct_skip',         // the rejection was reasonable; the move was luck
];
const MISS_MIN_RETURN_PCT = 8;
const MAX_ITEMS = 25;
const MODEL = () => process.env.GEMINI_REVIEW_MODEL || 'gemini-3.5-flash-lite';

let _ready = false;
async function ensureTable() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS trade_lessons (
            id          BIGSERIAL PRIMARY KEY,
            review_day  DATE NOT NULL,
            kind        TEXT NOT NULL,          -- 'loss' | 'missed'
            ref_id      BIGINT NOT NULL,        -- trades.id or shadow_trades.id
            user_id     UUID,
            symbol      TEXT NOT NULL,
            pnl_pct     REAL,
            cause       TEXT NOT NULL,
            lesson      TEXT,
            facts       JSONB,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (kind, ref_id)
        )`);
    _ready = true;
}

/** Losing swing trades closed in the last 10 days that haven't been reviewed. */
async function _losses() {
    return (await query(`
        SELECT s.id, s.user_id, s.symbol, s.price::float AS exit_price, s.pnl_percent::float AS pnl_pct,
               s.hold_hours::float AS hold_h, s.ai_score::float AS score, s.sector, s.entry_regime,
               s.slippage_pct::float AS slippage_pct, s.mfe_pct::float AS mfe_pct, s.mae_pct::float AS mae_pct,
               s.notes AS exit_notes, s.trade_date AS exit_at,
               b.price::float AS entry_price, b.trade_date AS entry_at, b.notes AS entry_notes
        FROM trades s
        LEFT JOIN LATERAL (
            SELECT price, trade_date, notes FROM trades b
            WHERE b.user_id = s.user_id AND b.symbol = s.symbol AND b.action = 'BUY' AND b.trade_date <= s.trade_date
            ORDER BY b.trade_date DESC LIMIT 1) b ON TRUE
        WHERE s.action = 'SELL' AND s.pnl < 0 AND s.status IS DISTINCT FROM 'VOIDED'
          AND s.trade_date >= NOW() - INTERVAL '10 days'
          AND COALESCE(s.notes, '') NOT ILIKE '%satellite%' AND COALESCE(s.notes, '') NOT ILIKE '%core holding%'
          AND NOT EXISTS (SELECT 1 FROM trade_lessons l WHERE l.kind = 'loss' AND l.ref_id = s.id)
        ORDER BY s.pnl_percent ASC LIMIT $1`, [MAX_ITEMS])).rows;
}

/** Rejected stocks that ran ≥ +8% over the next 5 days (one row per symbol + day). */
async function _misses(limit) {
    if (limit <= 0) return [];
    return (await query(`
        SELECT * FROM (
            SELECT DISTINCT ON (symbol, rejection_date::date) id, symbol, rejection_date, rejection_reason, rejection_detail,
                   ai_score::float AS score, sector, regime, entry_price_ref::float AS entry_price, return_5d_pct::float AS ret5
            FROM shadow_trades
            WHERE return_5d_pct >= $1 AND rejection_date >= NOW() - INTERVAL '30 days'
              AND NOT EXISTS (SELECT 1 FROM trade_lessons l WHERE l.kind = 'missed' AND l.ref_id = shadow_trades.id)
            ORDER BY symbol, rejection_date::date, return_5d_pct DESC) x
        ORDER BY ret5 DESC LIMIT $2`, [MISS_MIN_RETURN_PCT, limit])).rows;
}

/** Price setup on a day + SPY move over a window, from history_bars. */
async function _context(symbol, fromDate, toDate) {
    const r = await query(`
        WITH b AS (SELECT d, c, MAX(c) OVER w20 AS hi20, AVG(c) OVER w50 AS sma50,
                          LAG(c, 5) OVER o AS c5, LAG(c, 20) OVER o AS c20
                   FROM history_bars WHERE symbol = $1 AND d BETWEEN $2::date - 90 AND $2::date
                   WINDOW o AS (ORDER BY d), w20 AS (ORDER BY d ROWS 19 PRECEDING), w50 AS (ORDER BY d ROWS 49 PRECEDING))
        SELECT (c / NULLIF(c5, 0) - 1) * 100 AS ret5, (c / NULLIF(c20, 0) - 1) * 100 AS ret20,
               (c / NULLIF(hi20, 0) - 1) * 100 AS from_hi20, (c / NULLIF(sma50, 0) - 1) * 100 AS vs_sma50
        FROM b WHERE d < $2::date ORDER BY d DESC LIMIT 1`, [symbol, fromDate]);
    const spy = await query(`
        SELECT (MAX(c) FILTER (WHERE d = (SELECT MAX(d) FROM history_bars WHERE symbol = 'SPY' AND d <= $2::date))
              / NULLIF(MAX(c) FILTER (WHERE d = (SELECT MAX(d) FROM history_bars WHERE symbol = 'SPY' AND d < $1::date)), 0) - 1) * 100 AS spy
        FROM history_bars WHERE symbol = 'SPY' AND d BETWEEN $1::date - 10 AND $2::date`, [fromDate, toDate]);
    const news = await query(`
        SELECT to_char(e.created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS day, e.event_type, LEFT(a.headline, 140) AS headline
        FROM news_events e JOIN news_archive a ON a.id = e.news_id
        WHERE e.symbol = $1 AND e.event_type NOT IN ('noise', 'unclassified')
          AND e.created_at BETWEEN $2::date - 3 AND $3::date + 1 ORDER BY e.created_at LIMIT 8`, [symbol, fromDate, toDate]).catch(() => ({ rows: [] }));
    const round = v => (v == null ? null : +Number(v).toFixed(1));
    const s = r.rows[0] || {};
    return {
        beforeEntry: { ret5Pct: round(s.ret5), ret20Pct: round(s.ret20), fromHigh20Pct: round(s.from_hi20), vsSma50Pct: round(s.vs_sma50) },
        spyDuringPct: round(spy.rows[0]?.spy),
        news: news.rows,
    };
}

const _d = v => (v ? new Date(v).toISOString().slice(0, 10) : null);

async function _facts(losses, misses) {
    const items = [];
    for (const t of losses) {
        const ctx = await _context(t.symbol, _d(t.entry_at) || _d(t.exit_at), _d(t.exit_at));
        items.push({
            key: `loss:${t.id}`, kind: 'loss', ref: t, facts: {
                symbol: t.symbol, pnlPct: +t.pnl_pct.toFixed(2), holdHours: t.hold_h == null ? null : Math.round(t.hold_h),
                score: t.score, sector: t.sector, regimeAtEntry: t.entry_regime, slippagePct: t.slippage_pct,
                bestDuringPct: t.mfe_pct, worstDuringPct: t.mae_pct,
                entry: { date: _d(t.entry_at), price: t.entry_price, note: (t.entry_notes || '').slice(0, 160) },
                exit: { date: _d(t.exit_at), price: t.exit_price, note: (t.exit_notes || '').slice(0, 160) },
                ...ctx,
            },
        });
    }
    for (const m of misses) {
        const day = _d(m.rejection_date);
        const end = _d(new Date(new Date(m.rejection_date).getTime() + 8 * 86400000));
        const ctx = await _context(m.symbol, day, end);
        items.push({
            key: `missed:${m.id}`, kind: 'missed', ref: m, facts: {
                symbol: m.symbol, ret5DaysAfterPct: +m.ret5.toFixed(2), score: m.score, sector: m.sector, regime: m.regime,
                rejectedOn: day, rejectedBecause: m.rejection_reason, rejectionDetail: String(m.rejection_detail || '').slice(0, 160),
                ...ctx,
            },
        });
    }
    return items;
}

function buildPrompt(items) {
    return `You review a US swing-trading bot's mistakes. For each case pick exactly ONE cause from the allowed list and write a one-sentence lesson the bot could act on. Judge only from the facts given; if nothing clearly went wrong, say so (normal_noise / correct_skip) — do not invent problems.

Losing trades ("loss") causes: ${LOSS_CAUSES.join(', ')}
Rejected stocks that then rose ≥${MISS_MIN_RETURN_PCT}% ("missed") causes: ${MISS_CAUSES.join(', ')}

Field notes: beforeEntry = stock move up to the entry/rejection day (ret5Pct, ret20Pct, fromHigh20Pct = distance below the 20-day high, vsSma50Pct). spyDuringPct = S&P 500 move over the hold. news = sorted headline events around the trade. bestDuringPct/worstDuringPct = best/worst move while held.

Cases:
${items.map(i => JSON.stringify({ key: i.key, kind: i.kind, ...i.facts })).join('\n')}

Reply with JSON only: [{"key": "...", "cause": "...", "lesson": "..."}]`;
}

/** Validate the model's labels; unknown causes fall back to the neutral cause. */
function parseLabels(text, items) {
    let arr;
    try { arr = JSON.parse(String(text).replace(/```json|```/g, '').trim()); } catch (_) { return []; }
    if (!Array.isArray(arr)) return [];
    const byKey = new Map(items.map(i => [i.key, i]));
    const out = [];
    for (const x of arr) {
        const item = x && byKey.get(x.key);
        if (!item) continue;
        byKey.delete(x.key);
        const allowed = item.kind === 'loss' ? LOSS_CAUSES : MISS_CAUSES;
        const cause = allowed.includes(x.cause) ? x.cause : (item.kind === 'loss' ? 'normal_noise' : 'correct_skip');
        out.push({ item, cause, lesson: String(x.lesson || '').slice(0, 300) });
    }
    return out;
}

async function _ask(prompt) {
    const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 8000, responseMimeType: 'application/json' } },
        { timeout: 120000 });
    const cost = ledger.geminiCost(resp.data.usageMetadata);
    ledger.add('gemini:mistake_review', cost);
    return { text: resp.data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '[]', cost };
}

/** Cause counts + recent lessons — what the Saturday research agent reads. */
async function recentPatterns({ days = 30 } = {}) {
    await ensureTable();
    const counts = (await query(`
        SELECT kind, cause, COUNT(*)::int AS n, ROUND(AVG(pnl_pct)::numeric, 2)::float AS avg_pct
        FROM trade_lessons WHERE review_day >= CURRENT_DATE - $1::int GROUP BY 1, 2 ORDER BY 3 DESC`, [days])).rows;
    const lessons = (await query(`
        SELECT kind, symbol, cause, lesson FROM trade_lessons
        WHERE review_day >= CURRENT_DATE - $1::int AND cause NOT IN ('normal_noise', 'correct_skip')
        ORDER BY created_at DESC LIMIT 15`, [days])).rows;
    return { counts, lessons };
}

function formatMessage(saved, cost, patterns) {
    const L = [`🔍 <b>Daily mistake review</b> — ${saved.length} case(s), $${cost.toFixed(3)}`];
    for (const s of saved) {
        const f = s.item.facts;
        const pct = s.item.kind === 'loss' ? `${f.pnlPct}%` : `skipped, then +${f.ret5DaysAfterPct}%`;
        L.push(`• ${f.symbol} (${pct}) — <b>${s.cause}</b>: ${s.lesson.replace(/[<>&]/g, '')}`);
    }
    const repeats = patterns.counts.filter(c => c.n >= 3 && !['normal_noise', 'correct_skip'].includes(c.cause));
    if (repeats.length) L.push('', `<b>Repeating (30 days):</b> ${repeats.map(c => `${c.cause} ×${c.n}`).join(', ')} → goes to Saturday's research agent`);
    return L.join('\n');
}

/** Weekdays after the close. Returns { saved, cost } or null. Never throws. */
async function runDaily({ now = new Date() } = {}) {
    try {
        if (!process.env.GEMINI_API_KEY) return null;
        await ensureTable();
        const losses = await _losses();
        const misses = await _misses(MAX_ITEMS - losses.length);
        if (!losses.length && !misses.length) { logger.info('[MistakeReview] Nothing to review'); return { saved: [], cost: 0 }; }
        const items = await _facts(losses, misses);
        const { text, cost } = await _ask(buildPrompt(items));
        const labels = parseLabels(text, items);
        const day = ledger._etDay(now);
        for (const l of labels) {
            const r = l.item.ref;
            await query(
                `INSERT INTO trade_lessons (review_day, kind, ref_id, user_id, symbol, pnl_pct, cause, lesson, facts)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (kind, ref_id) DO NOTHING`,
                [day, l.item.kind, r.id, r.user_id || null, r.symbol, l.item.kind === 'loss' ? r.pnl_pct : r.ret5, l.cause, l.lesson, JSON.stringify(l.item.facts)]);
        }
        const patterns = await recentPatterns();
        if (labels.length) {
            const msg = formatMessage(labels, cost, patterns);
            await require('./telegramAlertService').sendAdminMessage(msg, 'HTML').catch(() => {});
            await require('./reportArchiveService').save({ kind: 'mistake_review', title: `Mistake review — ${day}`, body: msg, format: 'html', adminOnly: true }).catch(() => {});
        }
        logger.info('[MistakeReview] Done', { losses: losses.length, misses: misses.length, labelled: labels.length, cost: +cost.toFixed(4) });
        return { saved: labels, cost };
    } catch (err) {
        logger.warn('[MistakeReview] Daily run failed', { error: err.response?.status || err.message });
        return null;
    }
}

module.exports = { runDaily, recentPatterns, buildPrompt, parseLabels, formatMessage, ensureTable, LOSS_CAUSES, MISS_CAUSES };
