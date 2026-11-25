/**
 * Universe build: Polygon first, Yahoo as backup — design: docs/UNIVERSE_BUILD_POLYGON_PREFILTER.md
 *
 * UNIVERSE_PREFILTER = off | shadow | on   (default shadow)
 *   off    — nothing here runs; both builds behave exactly as before.
 *   shadow — decisions are computed and compared, but every symbol still goes to Yahoo
 *            and the build output is unchanged. Results go to universe_prefilter_shadow.
 *   on     — HERMES skips the Yahoo call for clearly illiquid bulk (tier 6) names, and the
 *            Blitz pre-market build reuses the last completed HERMES build instead of Yahoo.
 *            Owner approval required before setting this.
 *
 * Every entry point fails OPEN: any error / missing data → "prefilter off" → today's full
 * Yahoo path. Nothing in this module may shrink a universe on its own failure.
 */
const { logger } = require('../utils/logger');
const marketCalendar = require('../utils/marketCalendar');

const WINDOW_DAYS         = 20;    // trading days of whole-market volume to average
const MIN_GOOD_DAYS       = 15;    // health gate: days present with full coverage
const MIN_TICKERS_PER_DAY = 8000;  // a "good" day has at least this many tickers
const MIN_SYMBOL_DAYS     = 10;    // a symbol needs this many days to be judged at all
const HERMES_MAX_AGE_DAYS = 4;     // Blitz reuses a completed weekday build at most this old
const RETAIN_CALENDAR_DAYS = 50;   // ~30+ trading days kept in market_daily_volume

function mode() {
    const m = String(process.env.UNIVERSE_PREFILTER || 'shadow').toLowerCase();
    return ['off', 'shadow', 'on'].includes(m) ? m : 'shadow';
}
function minVolume() {
    return parseInt(process.env.HERMES_PREFILTER_MIN_VOLUME || '150000', 10);
}
function _db(deps) { return deps.query || require('../config/database').query; }

// ── Whole-market daily volume (written by the 6:30 PM ET EOD job) ─────────────

let _schemaReady = false;
async function ensureSchema(deps = {}) {
    if (_schemaReady) return;
    const query = _db(deps);
    await query(`CREATE TABLE IF NOT EXISTS market_daily_volume (
        symbol     VARCHAR(12) NOT NULL,
        trade_date DATE        NOT NULL,
        close      NUMERIC,
        volume     BIGINT,
        PRIMARY KEY (symbol, trade_date))`);
    await query(`CREATE INDEX IF NOT EXISTS idx_market_daily_volume_date ON market_daily_volume (trade_date)`);
    await query(`CREATE TABLE IF NOT EXISTS universe_prefilter_shadow (
        id         SERIAL PRIMARY KEY,
        run_date   DATE NOT NULL,
        kind       VARCHAR(20) NOT NULL,
        summary    JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW())`);
    _schemaReady = true;
}

/** Store every ticker of one Polygon grouped-daily response. Returns rows written. */
async function storeMarketDailyVolume(tradeDate, bars, deps = {}) {
    if (!Array.isArray(bars) || bars.length === 0) return 0;
    const query = _db(deps);
    await ensureSchema(deps);
    const rows = bars.filter(b => b && b.symbol && Number.isFinite(Number(b.volume)));
    const CHUNK = 5000;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const c = rows.slice(i, i + CHUNK);
        await query(
            `INSERT INTO market_daily_volume (symbol, trade_date, close, volume)
             SELECT s, $1::date, c, v FROM UNNEST($2::text[], $3::numeric[], $4::bigint[]) AS t(s, c, v)
             ON CONFLICT (symbol, trade_date) DO UPDATE SET close = EXCLUDED.close, volume = EXCLUDED.volume`,
            [tradeDate, c.map(b => String(b.symbol).slice(0, 12)), c.map(b => Number(b.close) || null), c.map(b => Math.round(Number(b.volume)))]
        );
    }
    await query(`DELETE FROM market_daily_volume WHERE trade_date < $1::date - ${RETAIN_CALENDAR_DAYS}`, [tradeDate]);
    return rows.length;
}

/** The last WINDOW_DAYS completed trading days, newest first. Today counts only if its EOD rows exist. */
function windowDays(todayET, todayStored) {
    const days = [];
    let d = todayStored ? todayET : marketCalendar.previousTradingDay(todayET);
    while (days.length < WINDOW_DAYS) {
        days.push(d);
        d = marketCalendar.previousTradingDay(d);
    }
    return days;
}

/**
 * Load the 20-day average volume per symbol and decide whether the prefilter may be used.
 * Returns { mode, active, reason, avgVol: Map(symbol → {avg, days}), goodDays }.
 * `active` = the data passed the health gate. In shadow mode decisions are still only logged.
 */
async function prepareHermesPrefilter(todayET, deps = {}) {
    const m = mode();
    const off = (reason) => ({ mode: m, active: false, reason, avgVol: new Map(), goodDays: 0 });
    if (m === 'off') return off('UNIVERSE_PREFILTER=off');
    try {
        const query = _db(deps);
        await ensureSchema(deps);
        const todayCnt = await query(`SELECT COUNT(*)::int AS n FROM market_daily_volume WHERE trade_date = $1::date`, [todayET]);
        const days = windowDays(todayET, (todayCnt.rows[0]?.n || 0) >= MIN_TICKERS_PER_DAY);
        const cov = await query(
            `SELECT trade_date::text AS d, COUNT(*)::int AS n FROM market_daily_volume
             WHERE trade_date = ANY($1::date[]) GROUP BY 1`, [days]);
        const good = cov.rows.filter(r => r.n >= MIN_TICKERS_PER_DAY).map(r => r.d);
        if (good.length < MIN_GOOD_DAYS) {
            return off(`only ${good.length} of ${WINDOW_DAYS} days have whole-market volume (need ${MIN_GOOD_DAYS})`);
        }
        const res = await query(
            `SELECT symbol, AVG(volume)::float AS avg, COUNT(*)::int AS days FROM market_daily_volume
             WHERE trade_date = ANY($1::date[]) GROUP BY symbol`, [good]);
        const avgVol = new Map(res.rows.map(r => [r.symbol, { avg: r.avg, days: r.days }]));
        return { mode: m, active: true, reason: null, avgVol, goodDays: good.length };
    } catch (err) {
        logger.warn('[UniversePrefilter] Load failed — prefilter off, full Yahoo build', { error: err.message });
        return off(`load failed: ${err.message}`);
    }
}

/**
 * Would HERMES skip the Yahoo call for this symbol? Only bulk tier 6, never velocity,
 * only when Polygon's average AND our own daily_bars average are both clearly low.
 */
function shouldSkip({ tier, isVelocity, poly, realAvg, hermesFloor, cut = minVolume() }) {
    if (tier !== 6 || isVelocity) return false;
    if (!poly || poly.days < MIN_SYMBOL_DAYS) return false;     // unknown to Polygon → Yahoo
    if (!(poly.avg < cut)) return false;
    if ((realAvg || 0) >= hermesFloor) return false;             // our own bars say liquid → Yahoo
    return true;
}

// ── Blitz: reuse the last completed HERMES build ──────────────────────────────

const REJECT_REASONS = new Set(['volume', 'cap', 'both', 'volume_prefilter']);

/** Latest completed weekday HERMES build ≤ today within HERMES_MAX_AGE_DAYS → Map(symbol → row). */
async function loadHermesCache(todayET, deps = {}) {
    const query = _db(deps);
    const b = await query(
        `SELECT universe_date::text AS d FROM hermes_build_status
         WHERE universe_date <= $1::date AND universe_date >= $1::date - ${HERMES_MAX_AGE_DAYS}
           AND EXTRACT(DOW FROM universe_date) NOT IN (0, 6)
         ORDER BY universe_date DESC LIMIT 5`, [todayET]);
    // Holiday builds (e.g. Thanksgiving) can be weekend-size — never reuse one.
    const date = b.rows.map(r => r.d)
        .find(d => !marketCalendar.isTradingHoliday(new Date(`${d}T17:00:00Z`)));
    if (!date) return { date: null, map: new Map() };
    const r = await query(
        `SELECT symbol, passed, fail_reason, market_cap, avg_volume, price, rs_score,
                week52_high, week52_low, sma50, sma200, sector, industry
         FROM hermes_symbol_log WHERE universe_date = $1::date`, [date]);
    return { date, map: new Map(r.rows.map(x => [x.symbol, x])) };
}

/** 'hit' (use stored fields) | 'reject' (no Yahoo call) | 'miss' (go to Yahoo). */
function classifyCached(row) {
    if (!row) return 'miss';
    if (row.passed && !row.fail_reason) {
        // Pre-migration rows lack the stored fields → Yahoo.
        return (row.rs_score != null && Number(row.market_cap) > 0) ? 'hit' : 'miss';
    }
    if (!row.passed && REJECT_REASONS.has(row.fail_reason)) return 'reject';
    return 'miss';
}

const _num = v => (v == null ? null : Number(v));

/** Build a Blitz stock object from a cached HERMES row. Volume is 0 on purpose: never IEX volume. */
function stockFromCache(symbol, row, livePrice) {
    return {
        symbol,
        marketCap:          _num(row.market_cap),
        marketCapFormatted: String(row.market_cap),
        price:              livePrice != null ? livePrice : _num(row.price),
        volume:             0,
        avgVolume:          _num(row.avg_volume) || 0,
        week52High:         _num(row.week52_high),
        week52Low:          _num(row.week52_low),
        sma50:              _num(row.sma50),
        sma200:             _num(row.sma200),
        sector:             row.sector || 'Unknown',
        industry:           row.industry || 'Unknown',
        rsScore:            _num(row.rs_score) ?? 0.5,
        isVelocity:         false,
        isETF:              false,
        isSpeculative:      false,
        daysToEarnings:     null,
        tier:               2,
        fromHermesCache:    true,
    };
}

// ── Comparison helpers + shadow persistence ───────────────────────────────────

function jaccard(a, b) {
    const A = new Set(a), B = new Set(b);
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    const uni = A.size + B.size - inter;
    return uni === 0 ? 1 : inter / uni;
}
function topOverlap(a, b, n = 100) {
    const A = new Set(a.slice(0, n));
    const B = b.slice(0, n);
    if (B.length === 0) return A.size === 0 ? 1 : 0;
    return B.filter(x => A.has(x)).length / Math.max(A.size, B.length);
}

async function recordShadow(runDate, kind, summary, deps = {}) {
    try {
        await ensureSchema(deps);
        await _db(deps)(`INSERT INTO universe_prefilter_shadow (run_date, kind, summary) VALUES ($1, $2, $3)`,
            [runDate, kind, JSON.stringify(summary)]);
    } catch (err) {
        logger.warn('[UniversePrefilter] Could not store shadow result', { error: err.message });
    }
}

module.exports = {
    mode, minVolume,
    ensureSchema, storeMarketDailyVolume, windowDays, prepareHermesPrefilter, shouldSkip,
    loadHermesCache, classifyCached, stockFromCache,
    jaccard, topOverlap, recordShadow,
    WINDOW_DAYS, MIN_GOOD_DAYS, MIN_TICKERS_PER_DAY, MIN_SYMBOL_DAYS,
};
