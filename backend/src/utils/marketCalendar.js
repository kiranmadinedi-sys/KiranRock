/**
 * Market Calendar — single source of truth for "is NYSE open right now"
 * ========================================================================
 * Found 2026-09-06 (the evening before Labor Day 2026-09-07): isMarketOpen()
 * was independently reimplemented in FIVE separate files (enhancedAITradingBot.js,
 * intradayScheduler.js, newsRescanService.js, optionsBotScheduler.js,
 * systemHealthMonitorService.js), every single one checking only weekday +
 * time-of-day — NONE of them consulted NYSE_HOLIDAYS, which already lived in
 * enhancedAITradingBot.js and already correctly listed 2026-09-07. Every one of
 * those five schedulers would have believed the market was open on a holiday it
 * already had the data to know was closed.
 *
 * Every consumer should import isMarketOpen from here rather than reimplementing
 * it — that's the whole point of this file existing.
 */

const { logger } = require('./logger');

// Days when NYSE is fully closed. First trading day AFTER a holiday has lower
// liquidity, wider spreads, and gap-fill volatility.
// Update each January. Source: https://www.nyse.com/markets/hours-calendars
const NYSE_HOLIDAYS = new Set([
    // 2025
    '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18',
    '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01',
    '2025-11-27', '2025-12-25',
    // 2026
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
    '2026-05-25', '2026-06-19',
    '2026-07-03', '2026-07-04', // July 4 falls on Sat → NYSE observes on Fri July 3
    '2026-09-07', '2026-11-26', '2026-12-25',
]);

// Early-close days: NYSE closes at 1:00 PM ET (found 2026-11-22: before this, every weekday
// was treated as open until 4:00 PM, so on 11-27 the bots would have kept trading for three
// hours after the real close — orders queued to Monday's open, EOD jobs on a closed market,
// Blitz flattening at 3:50 PM after the close). Update each January with the holiday list.
const NYSE_EARLY_CLOSES = new Set([
    '2025-07-03', '2025-11-28', '2025-12-24',
    '2026-11-27', '2026-12-24',
]);
const REGULAR_CLOSE_MIN = 16 * 60;
const EARLY_CLOSE_MIN = 13 * 60;

function _etDateKey(date) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date); // YYYY-MM-DD
}

/** True if `date` (default now) is a listed 1:00 PM early-close day, ET calendar day. */
function isEarlyClose(date = new Date()) {
    return NYSE_EARLY_CLOSES.has(_etDateKey(date));
}

/** Today's close in minutes after ET midnight: 780 (1:00 PM) on early-close days, else 960. */
function marketCloseMinutesET(date = new Date()) {
    return isEarlyClose(date) ? EARLY_CLOSE_MIN : REGULAR_CLOSE_MIN;
}

/** Returns true if `date` (default now) falls on a listed NYSE holiday, ET calendar day. */
function isTradingHoliday(date = new Date()) {
    const etDateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date); // YYYY-MM-DD
    return NYSE_HOLIDAYS.has(etDateKey);
}

/**
 * Is NYSE open right now? Weekday + 9:30 AM-4:00 PM ET (1:00 PM on early-close days) + not a listed holiday.
 * Uses Intl.DateTimeFormat so DST (EDT=UTC-4, EST=UTC-5) is handled automatically.
 */
function isMarketOpen(date = new Date()) {
    const etDayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
    const dayStr = etDayFormatter.format(date);
    if (dayStr === 'Sat' || dayStr === 'Sun') return false;

    if (isTradingHoliday(date)) return false;

    const etTimeFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false
    });
    const parts    = etTimeFormatter.formatToParts(date);
    const etHour   = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const etMinute = parseInt(parts.find(p => p.type === 'minute').value, 10);
    const etMin    = etHour * 60 + etMinute;

    return etMin >= 9 * 60 + 30 && etMin < marketCloseMinutesET(date);
}

/**
 * The NYSE trading day before `dateStr` (YYYY-MM-DD), skipping weekends and listed
 * holidays. Pure date-string arithmetic (noon UTC) so no timezone can shift the day.
 */
function previousTradingDay(dateStr) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    do {
        d.setUTCDate(d.getUTCDate() - 1);
    } while (d.getUTCDay() === 0 || d.getUTCDay() === 6 || NYSE_HOLIDAYS.has(d.toISOString().slice(0, 10)));
    return d.toISOString().slice(0, 10);
}

if (isTradingHoliday()) {
    logger.info('[MarketCalendar] Today is a listed NYSE holiday — isMarketOpen() will return false all day');
}

module.exports = {
    isMarketOpen, isTradingHoliday, isEarlyClose, marketCloseMinutesET, previousTradingDay,
    NYSE_HOLIDAYS, NYSE_EARLY_CLOSES,
};
