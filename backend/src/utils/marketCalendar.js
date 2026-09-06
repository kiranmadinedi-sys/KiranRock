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

/** Returns true if `date` (default now) falls on a listed NYSE holiday, ET calendar day. */
function isTradingHoliday(date = new Date()) {
    const etDateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date); // YYYY-MM-DD
    return NYSE_HOLIDAYS.has(etDateKey);
}

/**
 * Is NYSE open right now? Weekday + 9:30 AM-4:00 PM ET + not a listed holiday.
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
    const etTime   = etHour + etMinute / 60;

    return etTime >= 9.5 && etTime < 16;
}

if (isTradingHoliday()) {
    logger.info('[MarketCalendar] Today is a listed NYSE holiday — isMarketOpen() will return false all day');
}

module.exports = { isMarketOpen, isTradingHoliday, NYSE_HOLIDAYS };
