/**
 * Utility functions for calculating historical date ranges
 * (Week, Month, Quarter) — all timezone-aware and ISO date formatted.
 */

const { subDays } = require('date-fns');
const { DateTime } = require('luxon');
const logger = require('../utils/logger.utils'); // adjust path if needed

// Default timezone (e.g., 'America/Denver')
const DEFAULT_TZ = process.env.TZ || 'America/Denver';

/**
 * Format a Luxon DateTime or JS Date to 'YYYY-MM-DD'
 */
function fmt(date) {
    if (!date) return null;
    if (DateTime.isDateTime(date)) {
        return date.toISODate();
    }
    return DateTime.fromJSDate(date).toISODate();
}

/**
 * Get current DateTime object in user's timezone
 * @param {string|null} timezone
 */
function getNowDateTimeInUserTimezone(timezone) {
    const tz = timezone ?? DEFAULT_TZ;
    return DateTime.now().setZone(tz);
}

/**
 * Return JS Date for the current time in user's timezone
 * (optional, rarely needed)
 */
function getNowRangeForPeriodInUserTimezone(timezone) {
    return getNowDateTimeInUserTimezone(timezone).toJSDate();
}

/**
 * Calculate historical week ranges (Sunday–Saturday)
 */
function calculateWeekRanges(numberOfWeeks = 52, skipLatest = true, timezone) {
    const ranges = [];
    const today = getNowDateTimeInUserTimezone(timezone);
    const currentSunday = today.startOf('week'); // Sunday

    const startWeek = skipLatest ? -2 : 0;

    for (let i = startWeek; i >= startWeek - (numberOfWeeks - 1); i--) {
        const weekStart = currentSunday.plus({ weeks: i });
        const weekEnd = weekStart.plus({ days: 6 });

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
    const today = getNowDateTimeInUserTimezone(timezone);
    const startMonthIndex = skipCurrent ? -2 : 0;

    for (let i = startMonthIndex; i >= startMonthIndex - (numberOfMonths - 1); i--) {
        const monthStart = today.plus({ months: i }).startOf('month');
        const monthEnd = monthStart.endOf('month');

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
    const today = getNowDateTimeInUserTimezone(timezone);
    const startQuarterIndex = skipCurrent ? -2 : 0;

    for (let i = startQuarterIndex; i >= startQuarterIndex - (numberOfQuarters - 1); i--) {
        const qStart = today.plus({ months: i * 3 }).startOf('quarter');
        const qEnd = qStart.endOf('quarter');

        ranges.push({
            startDate: fmt(qStart),
            endDate: fmt(qEnd),
            range: `${fmt(qStart)} to ${fmt(qEnd)}`,
            type: 'QUARTER',
            quarter: qStart.quarter,
            year: qStart.year
        });
    }

    return ranges;
}

/**
 * Calculate combined full ranges for week, month, quarter
 */
function calculateFullRanges(timezone) {
    const weeksToPull = parseInt(process.env.WEEKS_TO_PULL || 52);
    const monthsToPull = parseInt(process.env.MONTHS_TO_PULL || 12);
    const quartersToPull = parseInt(process.env.QUARTERS_TO_PULL || 4);

    logger.info({ weeksToPull, monthsToPull, quartersToPull }, 'Initial pull configuration');

    const weekRanges = calculateWeekRanges(weeksToPull, true, timezone);
    const monthRanges = calculateMonthRanges(monthsToPull, true, timezone);
    const quarterRanges = calculateQuarterRanges(quartersToPull, true, timezone);

    const fullWeekRange = weekRanges.length
        ? `${weekRanges[weekRanges.length - 1].startDate} to ${weekRanges[0].endDate}`
        : null;

    const fullMonthRange = monthRanges.length
        ? `${monthRanges[monthRanges.length - 1].startDate} to ${monthRanges[0].endDate}`
        : null;

    const fullQuarterRange = quarterRanges.length
        ? `${quarterRanges[quarterRanges.length - 1].startDate} to ${quarterRanges[0].endDate}`
        : null;

    return {
        fullWeekRange,
        fullMonthRange,
        fullQuarterRange,
        weekRanges,
        monthRanges,
        quarterRanges
    };
}

/**
 * Return start/end for the latest completed WEEK, MONTH, or QUARTER
 */
function getDateRangeForPeriod(period, timezone) {
    const now = getNowDateTimeInUserTimezone(timezone);
    switch (period) {
        case 'WEEK': {
            // Last completed week Sunday-Saturday
            const lastSaturday = now.startOf('week').minus({ days: 1 }); // last Saturday
            const lastSunday = lastSaturday.minus({ days: 6 });          // previous Sunday
            return { start: fmt(lastSunday), end: fmt(lastSaturday) };
        }

        case 'MONTH': {
            // Last completed month
            const firstDayOfCurrentMonth = now.startOf('month');
            const lastMonthEnd = firstDayOfCurrentMonth.minus({ days: 1 });
            const lastMonthStart = lastMonthEnd.startOf('month');
            return { start: fmt(lastMonthStart), end: fmt(lastMonthEnd) };
        }

        case 'QUARTER': {
            // Last completed quarter
            const currentQuarterStart = now.startOf('quarter');
            const lastQuarterEnd = currentQuarterStart.minus({ days: 1 });
            const lastQuarterStart = lastQuarterEnd.startOf('quarter');
            return { start: fmt(lastQuarterStart), end: fmt(lastQuarterEnd) };
        }

        default:
            return null;
    }
}


/**
 * Format a Date or Luxon DateTime to YYYY-MM-DD
 */
function formatDate(date) {
    return fmt(date);
}

module.exports = {
    calculateWeekRanges,
    calculateMonthRanges,
    calculateQuarterRanges,
    calculateFullRanges,
    getDateRangeForPeriod,
    getNowDateTimeInUserTimezone,
    getNowRangeForPeriodInUserTimezone,
    formatDate
};
