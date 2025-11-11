const { format, addDays, subDays, startOfWeek, startOfMonth, startOfQuarter, lastDayOfMonth, lastDayOfQuarter } = require('date-fns');
const logger = require('../utils/logger.utils'); // adjust path if needed
const { getCurrentTimezone } = require('../db/tenant.db');

// Default timezone (e.g., 'America/Denver')
const DEFAULT_TZ = process.env.TZ;

function fmt(date) {
    return format(date, 'yyyy-MM-dd');
}

function fmtDate(date) {
    return format(date, 'yyyy-MM-dd HH:mm:ss');
}
/**
 * Get current DateTime object in user's timezone
 * @param {string|null} timezone
 */
function getNowDateTimeInUserTimezone(date = new Date(), timezone = null) {
    const zone = timezone ?? getCurrentTimezone();
    const formatted = formatTimestamp(date, zone);
    return fmtDate(formatted);
}
function getNowDateTimeInUserTimezoneAgo(date = new Date(), { hours = 0, days = 0 } = {}, timezone = null) {
    const zone = timezone ?? getCurrentTimezone();
    const formatted = formatTimestamp(date, zone);
    const dt = new Date(formatted);

    // Subtract days and hours
    const adjusted = new Date(dt.getTime() - (days * 24 * 60 * 60 * 1000) - (hours * 60 * 60 * 1000));
    return fmtDate(adjusted); // returns formatted string "YYYY-MM-DD HH:mm:ss"
}

/**
 * Return JS Date for the current time in user's timezone
 */
function getNowRangeForPeriodInUserTimezone(timezone = null) {
    return getNowDateTimeInUserTimezone(new Date(), timezone);
}

/**
 * Calculate historical week ranges (Sunday–Saturday)
 */
function calculateWeekRanges(numberOfWeeks = 52, skipLatest = true, timezone) {
    const ranges = [];
    const today = getNowDateTimeInUserTimezone(new Date(), timezone);
    const currentSunday = startOfWeek(today, { weekStartsOn: 0 }); // Sunday

    const startWeek = skipLatest ? -2 : 0;

    for (let i = startWeek; i >= startWeek - (numberOfWeeks - 1); i--) {
        const weekStart = addDays(currentSunday, i * 7);
        const weekEnd = addDays(weekStart, 6);

        ranges.push({
            startDate: fmt(weekStart),
            endDate: fmt(weekEnd),
            range: `${fmt(weekStart)} to ${fmt(weekEnd)}`,
            type: 'WEEK'
        });
    }

    return ranges;
}

/**
 * Calculate historical month ranges
 */
function calculateMonthRanges(numberOfMonths = 12, skipCurrent = true, timezone) {
    const ranges = [];
    const today = getNowDateTimeInUserTimezone(new Date(), timezone);
    const startMonthIndex = skipCurrent ? -2 : 0;

    for (let i = startMonthIndex; i >= startMonthIndex - (numberOfMonths - 1); i--) {
        const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
        const monthStart = startOfMonth(d);
        const monthEnd = lastDayOfMonth(d, { weekStartsOn: 0 });

        ranges.push({
            startDate: fmt(monthStart),
            endDate: fmt(monthEnd),
            range: `${fmt(monthStart)} to ${fmt(monthEnd)}`,
            type: 'MONTH'
        });
    }

    return ranges;
}

/**
 * Calculate historical quarter ranges
 */
function calculateQuarterRanges(numberOfQuarters = 4, skipCurrent = true, timezone) {
    const ranges = [];
    const today = getNowDateTimeInUserTimezone(new Date(), timezone);
    const currentQuarter = Math.floor(today.getMonth() / 3); // 0 = Q1

    const startQuarterIndex = skipCurrent ? -2 : 0;

    for (let i = startQuarterIndex; i >= startQuarterIndex - (numberOfQuarters - 1); i--) {
        const qIndex = currentQuarter + i;
        const yearOffset = Math.floor(qIndex / 4);
        const quarter = ((qIndex % 4 + 4) % 4) + 1;
        const year = today.getFullYear() + yearOffset;
        const quarterStartMonth = quarter * 3 - 3;

        const qStart = new Date(year, quarterStartMonth, 1);
        const qEnd = new Date(year, quarterStartMonth + 3, 0); // last day of quarter

        ranges.push({
            startDate: fmt(qStart),
            endDate: fmt(qEnd),
            range: `${fmt(qStart)} to ${fmt(qEnd)}`,
            type: 'QUARTER',
            quarter,
            year
        });
    }

    return ranges;
}

/**
 * Combined full ranges
 */
function calculateFullRanges(timezone) {
    const weeksToPull = parseInt(process.env.WEEKS_TO_PULL || 52);
    const monthsToPull = parseInt(process.env.MONTHS_TO_PULL || 12);
    const quartersToPull = parseInt(process.env.QUARTERS_TO_PULL || 4);

    logger.info({ weeksToPull, monthsToPull, quartersToPull }, 'Initial pull configuration');

    const weekRanges = calculateWeekRanges(weeksToPull, true, timezone);
    const monthRanges = calculateMonthRanges(monthsToPull, true, timezone);
    const quarterRanges = calculateQuarterRanges(quartersToPull, true, timezone);

    return {
        fullWeekRange: weekRanges.length ? `${weekRanges[weekRanges.length - 1].startDate} to ${weekRanges[0].endDate}` : null,
        fullMonthRange: monthRanges.length ? `${monthRanges[monthRanges.length - 1].startDate} to ${monthRanges[0].endDate}` : null,
        fullQuarterRange: quarterRanges.length ? `${quarterRanges[quarterRanges.length - 1].startDate} to ${quarterRanges[0].endDate}` : null,
        weekRanges,
        monthRanges,
        quarterRanges
    };
}

/**
 * Format timestamp using Intl.DateTimeFormat with timezone
 */
function formatTimestamp(timestamp, timeZone = DEFAULT_TZ, options = {}) {
    if (!timestamp) return null;
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    if (Number.isNaN(date.getTime())) return null;

    const fmtOptions = {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        ...options.formatOptions
    };
    const formatted = new Intl.DateTimeFormat('en-US', fmtOptions).format(date);
    return formatted;
}

function getDateRangeForPeriod(period, timezone = null) {
    const zone = timezone ?? getCurrentTimezone();
    const now = getNowDateTimeInUserTimezone(new Date(), zone);
    switch (period) {
        case 'WEEK': {
            const currentWeekStart = startOfWeek(now, { weekStartsOn: 0 });
            const lastWeekEnd = subDays(currentWeekStart, 1);
            const lastWeekStart = subDays(currentWeekStart, 7);
            return { start: fmt(lastWeekStart), end: fmt(lastWeekEnd) };
        }

        case 'MONTH': {
            const firstDayOfCurrentMonth = startOfMonth(now);
            const lastMonthEnd = subDays(firstDayOfCurrentMonth, 1);
            const lastMonthStart = startOfMonth(lastMonthEnd);
            return { start: fmt(lastMonthStart), end: fmt(lastMonthEnd) };
        }

        case 'QUARTER': {
            const currentQuarterStart = startOfQuarter(now);
            const lastQuarterEnd = subDays(currentQuarterStart, 1);
            const lastQuarterStart = startOfQuarter(lastQuarterEnd);
            return { start: fmt(lastQuarterStart), end: fmt(lastQuarterEnd) };
        }

        default:
            return null;
    }
}

module.exports = {
    calculateWeekRanges,
    calculateMonthRanges,
    calculateQuarterRanges,
    calculateFullRanges,
    getNowDateTimeInUserTimezone,
    getNowRangeForPeriodInUserTimezone,
    formatTimestamp,
    getDateRangeForPeriod,
    getNowDateTimeInUserTimezoneAgo
};
