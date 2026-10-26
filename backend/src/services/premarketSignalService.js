/**
 * Pre-market overnight signal (2026-10-26) — real market data, read at 9:05 AM ET on trading days:
 *   - US futures proxy: SPY/QQQ/IWM pre-market vs last close
 *   - Asia (closed by then): EWJ Japan, EWY Korea, FXI China, EWT Taiwan — pre-market vs last close
 *   - Europe (mid-session): VGK
 *   - Scheduled event days (FOMC decisions, the 2026 midterm election)
 * It becomes a risk level on the same scale as the macro briefing and feeds the SAME soft
 * position-size dampener (macroRiskService.getRiskSizeMultiplier takes the stricter of the two).
 * Never blocks a trade, fails open (no row / no data → no adjustment).
 */
const axios = require('axios');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const PAPER_DATA_USER = '83f08677-e55a-48d1-bd31-f5b56fa79c23'; // market data only — any valid Alpaca key works
const GROUPS = {
    us: ['SPY', 'QQQ', 'IWM'],
    asia: ['EWJ', 'EWY', 'FXI', 'EWT'],
    europe: ['VGK'],
};
const NAMES = { SPY: 'S&P 500', QQQ: 'Nasdaq 100', IWM: 'Russell 2000', EWJ: 'Japan', EWY: 'Korea', FXI: 'China', EWT: 'Taiwan', VGK: 'Europe' };

// Decision days only (the second day of each 2026 FOMC meeting) + the midterm election and the day after.
const EVENT_DAYS = {
    '2026-01-28': 'FOMC rate decision', '2026-03-18': 'FOMC rate decision', '2026-04-29': 'FOMC rate decision',
    '2026-06-17': 'FOMC rate decision', '2026-07-29': 'FOMC rate decision', '2026-09-16': 'FOMC rate decision',
    '2026-10-28': 'FOMC rate decision', '2026-12-09': 'FOMC rate decision',
    '2026-11-03': 'US midterm election', '2026-11-04': 'Day after US midterm election',
};

const LEVEL_RANK = ['Calm', 'Elevated', 'High', 'Extreme', 'Panic'];
const worse = (a, b) => (LEVEL_RANK.indexOf(a) >= LEVEL_RANK.indexOf(b) ? a : b);
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const todayET = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** Pure: % change per symbol from an Alpaca snapshots payload, pre-market vs last regular close. */
function changesFromSnapshots(snaps, today) {
    const out = {};
    for (const [sym, s] of Object.entries(snaps || {})) {
        const lastT = s?.latestTrade?.t, last = s?.latestTrade?.p;
        if (!last || !lastT || todayET(new Date(lastT)) !== today) continue; // no trade today yet
        const dailyDay = s?.dailyBar?.t ? todayET(new Date(s.dailyBar.t)) : null;
        const ref = dailyDay === today ? s?.prevDailyBar?.c : s?.dailyBar?.c;
        if (ref > 0) out[sym] = (last / ref - 1) * 100;
    }
    return out;
}

/** Pure: risk level + reasons from group averages and today's event. */
function classify({ us, asia, europe }, event) {
    let level = 'Calm';
    const reasons = [];
    if (us != null && us <= -2.0) { level = 'High'; reasons.push(`US pre-market ${us.toFixed(2)}%`); }
    else if (us != null && us <= -1.0) { level = 'Elevated'; reasons.push(`US pre-market ${us.toFixed(2)}%`); }
    const abroad = avg([asia, europe].filter(v => v != null));
    if (abroad != null && abroad <= -1.5 && (us == null || us <= -0.5)) {
        level = worse(level, 'Elevated'); reasons.push(`Asia/Europe ${abroad.toFixed(2)}%`);
    }
    if (event) { level = worse(level, 'Elevated'); reasons.push(event); }
    return { level, reasons };
}

let _ready = false;
async function ensureTable() {
    if (_ready) return;
    await query(`CREATE TABLE IF NOT EXISTS premarket_signals (
        signal_date DATE PRIMARY KEY, risk_level TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    _ready = true;
}

async function _snapshots(today) {
    const cr = await require('./userDatabaseService').getUserAlpacaCredentials(PAPER_DATA_USER);
    const symbols = Object.values(GROUPS).flat().join(',');
    const get = feed => axios.get('https://data.alpaca.markets/v2/stocks/snapshots', {
        params: { symbols, feed }, timeout: 15000,
        headers: { 'APCA-API-KEY-ID': cr.keyId, 'APCA-API-SECRET-KEY': cr.secretKey },
    }).then(r => r.data);
    // IEX alone had no pre-market trades in EWJ/EWY/FXI/EWT/VGK on 2026-10-26, leaving Asia/Europe
    // blank. Fall back per symbol to the free 15-minute-delayed full-market feed.
    const iex = await get('iex');
    const delayed = await get('delayed_sip').catch(() => ({}));
    const hasToday = s => s?.latestTrade?.t && todayET(new Date(s.latestTrade.t)) === today;
    const out = { ...iex };
    for (const sym of Object.keys(delayed)) if (!hasToday(out[sym]) && hasToday(delayed[sym])) out[sym] = delayed[sym];
    return out;
}

function formatBrief(today, ch, groups, event, { level, reasons }) {
    const pct = v => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
    const line = syms => syms.map(s => `${NAMES[s]} ${pct(ch[s] ?? null)}`).join(' · ');
    return [
        `🌏 *Pre-market overnight check* — ${today}`,
        `US futures (pre-market ETFs): ${line(GROUPS.us)}`,
        `Asia (closed): ${line(GROUPS.asia)}`,
        `Europe (open): ${line(GROUPS.europe)}`,
        event ? `📅 Today: ${event}` : '📅 No major scheduled event today',
        '',
        `*Risk: ${level}*${reasons.length ? ` — ${reasons.join('; ')}` : ''}`,
        level === 'Calm' ? 'Position sizes: normal.' : 'New position sizes trimmed today (soft — never blocks a trade).',
    ].join('\n');
}

/** 9:05 AM ET job. Stores today's level, archives + sends the brief. Never throws. */
async function runPremarketCheck(now = new Date()) {
    try {
        const today = todayET(now);
        const cal = require('../utils/marketCalendar');
        const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
        if (dow === 0 || dow === 6 || cal.isTradingHoliday(now)) return { skipped: 'not a trading day' };
        await ensureTable();
        const ch = changesFromSnapshots(await _snapshots(today), today);
        const groups = Object.fromEntries(Object.entries(GROUPS).map(([g, syms]) => [g, avg(syms.map(s => ch[s]).filter(v => v != null))]));
        const event = EVENT_DAYS[today] || null;
        const verdict = classify(groups, event);
        await query(`INSERT INTO premarket_signals (signal_date, risk_level, payload) VALUES ($1, $2, $3)
                     ON CONFLICT (signal_date) DO UPDATE SET risk_level = EXCLUDED.risk_level, payload = EXCLUDED.payload, created_at = NOW()`,
            [today, verdict.level, JSON.stringify({ changes: ch, groups, event, reasons: verdict.reasons })]);
        const text = formatBrief(today, ch, groups, event, verdict);
        await require('./reportArchiveService').save({ kind: 'premarket_brief', title: `Pre-market check — ${verdict.level}`, body: text });
        await require('./telegramAlertService').sendAdminMessage(text).catch(() => {});
        logger.info('[Premarket] Overnight check', { today, level: verdict.level, groups });
        return { today, ...verdict, groups };
    } catch (err) {
        logger.warn('[Premarket] Overnight check failed (no sizing adjustment today)', { error: err.message });
        return { error: err.message };
    }
}

/** Today's level, or null. Never throws. */
async function getTodayLevel(now = new Date()) {
    try {
        const r = await query(`SELECT risk_level FROM premarket_signals WHERE signal_date = $1`, [todayET(now)]);
        return r.rows[0]?.risk_level || null;
    } catch { return null; }
}

module.exports = { GROUPS, EVENT_DAYS, changesFromSnapshots, classify, runPremarketCheck, getTodayLevel, formatBrief };
