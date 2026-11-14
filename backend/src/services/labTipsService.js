/**
 * Lab tips (2026-11-14) — a short, plain-English note for each day, built only from our own data
 * (no AI call, no cost). Shown on the Lab page "Daily tips" tab. Information, not trade orders:
 * nothing here changes what the bot does.
 *
 * Each tip: { kind, icon, title, text }. Sections are independent; one failing never blocks the rest.
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

let _ready = false;
async function ensureTable() {
    if (_ready) return;
    await query(`CREATE TABLE IF NOT EXISTS lab_tips (
        day DATE PRIMARY KEY, tips JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    _ready = true;
}

const fmtPct = (v, d = 1) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`;

/** Market mood in one sentence, from the same regime read the bot uses. */
function marketTip(r) {
    if (!r || !r.regime) return null;
    const mood = { BULL: 'rising (bullish)', BEAR: 'falling (bearish)', NEUTRAL: 'flat (neutral)', CHOPPY: 'choppy (no clear direction)' }[r.regime] || r.regime;
    const parts = [`The bot reads the market as ${mood}.`];
    const vix = Number(r.vixLevel);
    if (Number.isFinite(vix)) {
        parts.push(vix < 15 ? `The fear index (VIX) is low at ${vix.toFixed(1)}: calm conditions.`
            : vix < 20 ? `The fear index (VIX) is ${vix.toFixed(1)}: normal.`
            : vix < 30 ? `The fear index (VIX) is raised at ${vix.toFixed(1)}: expect bigger daily swings; the bot buys more carefully.`
            : `The fear index (VIX) is high at ${vix.toFixed(1)}: a nervous market; the bot cuts back on new buys.`);
    }
    if (r.qqqAboveMa50 === false) parts.push('Tech (QQQ) is below its 50-day average, so tech stocks are in a weaker patch.');
    const r20 = Number(r.return20d);
    if (Number.isFinite(r20)) parts.push(`The S&P 500 moved ${fmtPct(r20)} over the last 20 trading days.`);
    return { kind: 'market', icon: '🌡️', title: 'Market mood', text: parts.join(' ') };
}

/** The last complete nightly scan (a day with at least 500 analysed stocks). */
async function _lastScanDay() {
    const r = await query(`SELECT analysis_date::text AS d FROM daily_universe_analysis
                           WHERE ai_score IS NOT NULL GROUP BY 1 HAVING count(*) >= 500 ORDER BY 1 DESC LIMIT 1`);
    return r.rows[0]?.d || null;
}

async function topPicksTip(scanDay) {
    if (!scanDay) return null;
    const r = await query(`SELECT symbol, round(ai_score)::int AS s FROM daily_universe_analysis
                           WHERE analysis_date = $1 AND ai_score IS NOT NULL ORDER BY ai_score DESC, symbol LIMIT 5`, [scanDay]);
    const n80 = (await query(`SELECT count(*)::int n FROM daily_universe_analysis WHERE analysis_date = $1 AND ai_score >= 80`, [scanDay])).rows[0].n;
    if (!r.rows.length) return null;
    return {
        kind: 'picks', icon: '⭐', title: 'Highest-scored stocks from the latest scan',
        text: `${scanDay.slice(0, 10)} scan: ${r.rows.map(x => `${x.symbol} (${x.s})`).join(', ')}. ` +
            `${n80} stocks scored 80 or more. These are the bot's candidates, not buy orders; it still checks price, news, risk and free slots before buying.`,
    };
}

/**
 * Does the score still work? Average 5-trading-day return of stocks scored 80+ minus the average
 * of every scored stock the same day, over the last ~60 scan days that have a 5-day outcome.
 */
async function scoreEvidenceTip() {
    const r = await query(`
        WITH d AS (SELECT DISTINCT analysis_date FROM daily_universe_analysis WHERE ai_score IS NOT NULL
                   AND analysis_date < CURRENT_DATE - 8 ORDER BY 1 DESC LIMIT 60),
        p AS (SELECT u.analysis_date AS d, u.symbol, u.ai_score >= 80 AS hi
              FROM daily_universe_analysis u JOIN d USING (analysis_date) WHERE u.ai_score IS NOT NULL),
        f AS (SELECT p.*, (SELECT b.c FROM history_bars b WHERE b.symbol = p.symbol AND b.d <= p.d ORDER BY b.d DESC LIMIT 1) AS c0,
                          (SELECT b.c FROM history_bars b WHERE b.symbol = p.symbol AND b.d > p.d ORDER BY b.d OFFSET 4 LIMIT 1) AS c5
              FROM p),
        -- capped at ±30% like the other studies: a few tiny stocks doubling would otherwise swamp the average
        r AS (SELECT d, hi, LEAST(GREATEST((c5 / c0 - 1) * 100, -30), 30) AS ret FROM f WHERE c0 > 0 AND c5 > 0),
        g AS (SELECT d, avg(ret) FILTER (WHERE hi) AS hi_ret, avg(ret) AS all_ret FROM r GROUP BY d)
        SELECT count(*)::int AS days, avg(hi_ret - all_ret)::float AS edge, (count(*) FILTER (WHERE hi_ret > all_ret))::int AS days_ahead
        FROM g WHERE hi_ret IS NOT NULL`);
    const x = r.rows[0];
    if (!x || !x.days) return null;
    const verdict = x.edge > 0.2 ? 'The score is still pointing the right way.' : x.edge > 0 ? 'The advantage is small right now.' : 'The score is not helping at the moment; worth watching.';
    return {
        kind: 'evidence', icon: '📏', title: 'Is the bot\'s score working?',
        text: `Over the last ${x.days} scan days, stocks scored 80+ did ${Math.abs(x.edge).toFixed(2)}% ${x.edge >= 0 ? 'better' : 'worse'} over the next 5 trading days than the average scanned stock ` +
            `(ahead on ${x.days_ahead} of ${x.days} days). ${verdict}`,
    };
}

const NEG_NEWS = ['analyst_downgrade', 'pt_lower', 'earnings_miss', 'guidance_cut', 'offering', 'dividend_cut', 'fda_rejection', 'trial_negative',
    'exec_departure', 'legal_regulatory', 'bankruptcy_delisting', 'insider_sell', 'analyst_initiate_bearish', 'reverse_split'];
const POS_NEWS = ['analyst_upgrade', 'pt_raise', 'earnings_beat', 'guidance_raise', 'buyback', 'dividend_raise', 'fda_approval', 'trial_positive',
    'contract_win', 'index_addition', 'insider_buy', 'analyst_initiate_bullish', 'acquisition_target'];
const plainType = t => t.replace(/_/g, ' ').replace('pt ', 'price target ');

/** Labelled headlines from the last day on stocks any account holds. */
async function holdingsNewsTip() {
    const r = await query(`
        SELECT e.symbol, e.event_type, count(*)::int n FROM news_events e
        WHERE e.created_at > NOW() - INTERVAL '24 hours' AND e.event_type = ANY($1)
          AND e.symbol IN (SELECT DISTINCT symbol FROM holdings WHERE quantity > 0)
        GROUP BY 1, 2 ORDER BY 1`, [[...NEG_NEWS, ...POS_NEWS]]);
    if (!r.rows.length) return { kind: 'news', icon: '📰', title: 'News on stocks we hold', text: 'No major company news (upgrades, downgrades, earnings, lawsuits…) on our holdings in the last 24 hours.' };
    const bad = r.rows.filter(x => NEG_NEWS.includes(x.event_type)).map(x => `${x.symbol}: ${plainType(x.event_type)}`);
    const good = r.rows.filter(x => POS_NEWS.includes(x.event_type)).map(x => `${x.symbol}: ${plainType(x.event_type)}`);
    return {
        kind: 'news', icon: '📰', title: 'News on stocks we hold',
        text: [bad.length ? `Watch: ${bad.join(', ')}.` : null, good.length ? `Good news: ${good.join(', ')}.` : null,
            'Stop-losses still protect swing positions; this is for awareness.'].filter(Boolean).join(' '),
    };
}

/** Holdings whose re-score has been low two or more checks in a row (the bot may exit). */
async function weakHoldingsTip() {
    const r = await query(`SELECT u.username, h.symbol, round(h.last_rescore_score)::int AS s, h.low_score_streak AS k
                           FROM holdings h JOIN users u ON u.id = h.user_id
                           WHERE h.quantity > 0 AND h.low_score_streak >= 2 ORDER BY h.low_score_streak DESC LIMIT 6`);
    if (!r.rows.length) return null;
    return {
        kind: 'holdings', icon: '⚠️', title: 'Holdings losing their score',
        text: `${r.rows.map(x => `${x.symbol} (${x.username}, score ${x.s}, low ${x.k} checks running)`).join(', ')}. ` +
            'The bot re-checks what it owns; if a score stays low it may sell to free the slot.',
    };
}

/** Options: biggest jumps in expected swing since the previous snapshot, plus SPY's level. */
async function optionsTip() {
    const r = await query(`
        WITH l AS (SELECT max(d) AS d FROM options_iv_history),
        p AS (SELECT max(d) AS d FROM options_iv_history WHERE d < (SELECT d FROM l))
        SELECT a.symbol, a.atm_iv::float AS iv, b.atm_iv::float AS prev
        FROM options_iv_history a LEFT JOIN options_iv_history b ON b.symbol = a.symbol AND b.d = (SELECT d FROM p)
        WHERE a.d = (SELECT d FROM l)`);
    if (!r.rows.length) return null;
    const spy = r.rows.find(x => x.symbol === 'SPY');
    const jumps = r.rows.filter(x => x.prev != null && x.iv - x.prev >= 0.05).sort((a, b) => (b.iv - b.prev) - (a.iv - a.prev)).slice(0, 5);
    const parts = [];
    if (spy) parts.push(`The options market expects the S&P 500 to move about ±${(spy.iv * 100 / Math.sqrt(12)).toFixed(1)}% over the next month (${spy.iv < 0.15 ? 'calm' : spy.iv < 0.22 ? 'normal' : 'nervous'}).`);
    if (jumps.length) parts.push(`Expected swing jumped most for ${jumps.map(x => `${x.symbol} (${(x.prev * 100).toFixed(0)}% → ${(x.iv * 100).toFixed(0)}%)`).join(', ')}; usually news or earnings ahead.`);
    else if (r.rows.some(x => x.prev != null)) parts.push('No big jumps in expected swing since the previous day.');
    return parts.length ? { kind: 'options', icon: '🎯', title: 'Options market', text: parts.join(' ') } : null;
}

const CAUSE_PLAIN = {
    normal_noise: 'an ordinary losing trade, nothing done wrong',
    weak_market: 'the whole market fell',
    chased_extended: 'the stock was bought after it had already run up',
    bad_news_missed: 'company bad news around the time of buying',
    sector_weakness: 'its industry fell while the market held up',
    earnings_or_event: 'earnings or another big event during the hold',
    stop_too_tight: 'the stop was too tight; normal wobble hit it, then the stock recovered',
    weak_setup: 'a weak setup (downtrend or low quality) at entry',
    data_or_execution: 'a bad fill, missing data or a bot error',
    correct_skip: 'the bot was right to skip it',
    cap_or_budget_limit: 'the bot was full (no free slot or cash)',
    filter_too_strict: 'a filter was too strict',
    catalyst_unforeseeable: 'news nobody could have predicted',
};

/** The most common reason behind recent losing trades (daily mistake review). */
async function mistakesTip() {
    const r = await query(`SELECT cause, count(*)::int n FROM trade_lessons
                           WHERE kind = 'loss' AND review_day > CURRENT_DATE - 14 GROUP BY 1 ORDER BY 2 DESC LIMIT 3`);
    if (!r.rows.length) return null;
    const total = r.rows.reduce((s, x) => s + x.n, 0);
    const top = r.rows[0];
    return {
        kind: 'lessons', icon: '🧭', title: 'What our recent losses had in common',
        text: `Last 2 weeks: the most common reason was "${CAUSE_PLAIN[top.cause] || top.cause.replace(/_/g, ' ')}" (${top.n} of ${total} reviewed losses). ` +
            (top.cause === 'normal_noise' || top.cause === 'weak_market'
                ? 'That is the normal cost of trading, not a broken rule.'
                : 'If this keeps repeating, the Lab will test a rule against it.'),
    };
}

/** One honest lesson from the Lab, rotating through tested ideas day by day. */
async function labLessonTip(day) {
    const r = await query(`SELECT name, status, result FROM research_hypotheses WHERE status IN ('pass', 'fail') ORDER BY id`);
    if (!r.rows.length) return null;
    const i = Math.floor(new Date(`${day}T12:00:00Z`).getTime() / 86400000) % r.rows.length;
    const x = r.rows[i], res = x.result || {};
    const tr = res.train?.edgePp, ho = res.holdout?.edgePp;
    const how = x.status === 'pass' ? 'It beat the market in both tests and is in a practice-money trial.'
        : tr != null && tr <= 0 ? `On average it did worse than buying any stock (${fmtPct(tr, 2)} per trade), so we don't use it.`
        : tr != null && ho != null && ho <= 0 ? `It looked good in older years (${fmtPct(tr, 2)}) but failed in recent months (${fmtPct(ho, 2)}), so it was probably luck.`
        : 'Its advantage was too small to rule out luck, so we don\'t use it.';
    return {
        kind: 'lab', icon: '🔬', title: 'Lab lesson of the day',
        text: `"${x.name}"${res.trades ? `, tested on ${Number(res.trades).toLocaleString()} past trades` : ''}. ${how}`,
    };
}

async function buildTips(day, deps = {}) {
    const getRegime = deps.getRegime || (() => require('./marketRegimeService').getMarketRegime());
    const tips = [];
    const run = async (name, fn) => {
        try { const t = await fn(); if (t) tips.push(t); }
        catch (err) { logger.warn('[LabTips] section failed', { section: name, error: err.message }); }
    };
    await run('market', async () => marketTip(await getRegime()));
    const scanDay = await _lastScanDay().catch(() => null);
    await run('picks', () => topPicksTip(scanDay));
    await run('evidence', scoreEvidenceTip);
    await run('news', holdingsNewsTip);
    await run('holdings', weakHoldingsTip);
    await run('options', optionsTip);
    await run('lessons', mistakesTip);
    await run('lab', () => labLessonTip(day));
    return tips;
}

async function runDaily({ now = new Date() } = {}) {
    await ensureTable();
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
    const tips = await buildTips(day);
    await query(`INSERT INTO lab_tips (day, tips) VALUES ($1, $2) ON CONFLICT (day) DO UPDATE SET tips = EXCLUDED.tips, created_at = NOW()`,
        [day, JSON.stringify(tips)]);
    logger.info('[LabTips] Saved', { day, tips: tips.length });
    return { day, tips };
}

module.exports = { runDaily, buildTips, marketTip, ensureTable, CAUSE_PLAIN };
