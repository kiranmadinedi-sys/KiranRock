const fs = require('fs');
const path = require('path');

const REPORT_TIMEZONE = 'America/New_York';
const REPORT_TRACKING_FILE = path.join(__dirname, '../../config/lastReportSent.json');

const SCHEDULES = [
    { id: 'daily-prewarm-early', label: 'Daily prewarm (early)', days: [1, 2, 3, 4, 5], hour: 4, minute: 15 },
    { id: 'daily-prewarm-refresh', label: 'Daily prewarm (refresh)', days: [1, 2, 3, 4, 5], hour: 6, minute: 30 },
    { id: 'daily-predictions', label: 'Daily predictions report', days: [1, 2, 3, 4, 5], hour: 7, minute: 0 },
    { id: 'daily-performance', label: 'AI bot daily summary', days: [1, 2, 3, 4, 5], hour: 16, minute: 15 },
    { id: 'weekend-prep', label: 'Weekend prep report', days: [6], hour: 8, minute: 0 },
    { id: 'weekly-buy-list', label: 'Weekly buy list', days: [0], hour: 8, minute: 0 },
    { id: 'weekly-recap', label: 'Weekly performance recap', days: [0], hour: 9, minute: 0 }
];

function getZonedParts(date, timeZone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    const parts = formatter.formatToParts(date);
    const values = {};

    for (const part of parts) {
        values[part.type] = part.value;
    }

    const weekdayMap = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6
    };

    return {
        weekday: weekdayMap[values.weekday],
        year: Number.parseInt(values.year, 10),
        month: Number.parseInt(values.month, 10),
        day: Number.parseInt(values.day, 10),
        hour: Number.parseInt(values.hour, 10),
        minute: Number.parseInt(values.minute, 10),
        second: Number.parseInt(values.second, 10)
    };
}

function formatInTimeZone(date, timeZone) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short'
    }).format(date);
}

function findNextOccurrence(schedule, fromDate = new Date()) {
    const start = new Date(fromDate.getTime());
    start.setSeconds(0, 0);

    for (let offsetMinutes = 1; offsetMinutes <= 8 * 24 * 60; offsetMinutes++) {
        const candidate = new Date(start.getTime() + offsetMinutes * 60 * 1000);
        const zoned = getZonedParts(candidate, REPORT_TIMEZONE);

        if (
            schedule.days.includes(zoned.weekday) &&
            zoned.hour === schedule.hour &&
            zoned.minute === schedule.minute
        ) {
            return candidate;
        }
    }

    return null;
}

function readLastReportTimes() {
    try {
        if (!fs.existsSync(REPORT_TRACKING_FILE)) {
            return {};
        }

        return JSON.parse(fs.readFileSync(REPORT_TRACKING_FILE, 'utf8'));
    } catch (error) {
        return {
            error: error.message
        };
    }
}

function getLatestTrackedSend(tracking) {
    const entries = Object.entries(tracking)
        .map(([name, value]) => ({
            name,
            iso: value,
            timestamp: Date.parse(value)
        }))
        .filter((entry) => Number.isFinite(entry.timestamp))
        .sort((left, right) => right.timestamp - left.timestamp);

    return entries[0] || null;
}

function getReportSchedulerStatus(now = new Date()) {
    const tracking = readLastReportTimes();
    const trackingError = tracking.error || null;
    const latestTrackedSend = trackingError ? null : getLatestTrackedSend(tracking);

    return {
        timezone: REPORT_TIMEZONE,
        trackingFile: REPORT_TRACKING_FILE,
        trackingAvailable: trackingError === null,
        trackingError,
        lastTrackedReport: latestTrackedSend
            ? {
                name: latestTrackedSend.name,
                sentAt: latestTrackedSend.iso,
                sentAtLocal: formatInTimeZone(new Date(latestTrackedSend.timestamp), REPORT_TIMEZONE)
            }
            : null,
        nextRuns: SCHEDULES.map((schedule) => {
            const nextRun = findNextOccurrence(schedule, now);

            return {
                id: schedule.id,
                label: schedule.label,
                nextRun: nextRun ? nextRun.toISOString() : null,
                nextRunLocal: nextRun ? formatInTimeZone(nextRun, REPORT_TIMEZONE) : null
            };
        })
    };
}

module.exports = {
    getReportSchedulerStatus
};