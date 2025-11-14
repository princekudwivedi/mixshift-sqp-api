const { format, addDays, subDays, startOfWeek, startOfMonth, startOfQuarter, lastDayOfMonth, lastDayOfQuarter } = require('date-fns');
const { getCurrentTimezone } = require('../db/tenant.db');
const { Op, literal } = require('sequelize');

// Default timezone (e.g., 'America/Denver')
const DEFAULT_TZ = process.env.TZ;

function fmt(date) {
    return format(date, 'yyyy-MM-dd');
}

function fmtDate(date) {
    return format(date, 'yyyy-MM-dd HH:mm:ss');
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function evaluateReportDelay(reportType, now) {
    
	if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
		return { delay: false };
	}
	const dayOfWeek = now.getDay(); // 0 (Sunday) - 6 (Saturday)
	const dayOfMonth = now.getDate(); // 1 - 31
	const month = now.getMonth() + 1; // 1 (Jan) - 12 (Dec)
    const weeklyDelay = Number(process.env.WEEKLY_REPORT_DELAY || 2);
    const monthlyDelay = Number(process.env.MONTHLY_REPORT_DELAY || 3);
    const quarterlyDelay = Number(process.env.QUARTERLY_REPORT_DELAY || 20);
    const todatDate = fmt(now);
	switch (reportType) {
		case 'WEEK': {
			if (dayOfWeek < weeklyDelay) {
				return {
					delay: true,
					reason: `Weekly reports unlock on ${DAY_NAMES[weeklyDelay]}; today is ${DAY_NAMES[dayOfWeek]} and Date: ${todatDate}`
				};
			}
			return { delay: false };
		}
		case 'MONTH': {
			if (dayOfMonth < monthlyDelay) {
				return {
					delay: true,
					reason: `Monthly reports unlock on day ${monthlyDelay}; current day ${dayOfMonth} and date is ${todatDate}`
				};
			}
			return { delay: false };
		}
		case 'QUARTER': {
            const isQuarterStartMonth = [1,4,7,10].includes(month);
			if (isQuarterStartMonth && dayOfMonth < quarterlyDelay) {            
				return {
					delay: true,
					reason: `Quarterly reports unlock on day ${quarterlyDelay} of the first month in the quarter; current day ${dayOfMonth} and date is ${todatDate}`
				};
			}
			return { delay: false };
		}
		default:
			return { delay: false };
	}
}

function resolveTimezone(preferred) {
    if (preferred && preferred.trim().length > 0 && preferred !== 'UTC') {
        return preferred;
    }
    if (DEFAULT_TZ && DEFAULT_TZ.trim().length > 0 && DEFAULT_TZ !== 'UTC') {
        return DEFAULT_TZ;
    }
    try {
        const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (resolved && resolved !== 'UTC') {
            return resolved;
        }
    } catch (err) {
        // ignore
    }
    if (preferred && preferred.trim().length > 0) {
        return preferred;
    }
    if (DEFAULT_TZ && DEFAULT_TZ.trim().length > 0) {
        return DEFAULT_TZ;
    }
    try {
        const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (resolved) {
            return resolved;
        }
    } catch (err) {
        // ignore
    }
    return 'UTC';
}

function parseOffset(timeZoneName) {
    const match = timeZoneName.match(/GMT([+-]?)(\d{1,2})(?::(\d{2}))?/i);
    if (!match) {
        return { minutes: 0, string: '+00:00' };
    }
    const sign = match[1] === '-' ? -1 : 1;
    const hours = parseInt(match[2] || '0', 10);
    const minutes = parseInt(match[3] || '0', 10);
    const totalMinutes = sign * (hours * 60 + minutes);
    const normalized = `${sign === -1 ? '-' : '+'}${String(Math.abs(hours)).padStart(2, '0')}:${String(Math.abs(minutes)).padStart(2, '0')}`;
    return { minutes: totalMinutes, string: normalized };
}

function getTimeZoneParts(date, timeZone) {
    const targetZone = resolveTimezone(timeZone);
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: targetZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZoneName: 'short'
    });

    const parts = formatter.formatToParts(date);
    const map = {};
    parts.forEach(({ type, value }) => {
        map[type] = value;
    });

    const datePart = `${map.year}-${map.month}-${map.day}`;
    const timePart = `${map.hour}:${map.minute}:${map.second}`;
    const { string: offsetString } = parseOffset(map.timeZoneName || 'GMT');
    const iso = `${datePart}T${timePart}${offsetString === '+00:00' ? 'Z' : offsetString}`;

    return {
        datePart,
        timePart,
        formatted: `${datePart} ${timePart}`,
        offsetString,
        date: new Date(iso)
    };
}

function formatTimestamp(timestamp, timeZone = DEFAULT_TZ, options = {}) {
    if (!timestamp) return null;
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    if (Number.isNaN(date.getTime())) return null;

    const useRaw = timestamp instanceof Date && !timeZone;
    const parts = useRaw
        ? { datePart: format(date, 'yyyy-MM-dd'), timePart: format(date, 'HH:mm:ss'), formatted: format(date, 'yyyy-MM-dd HH:mm:ss'), offsetString: '+00:00' }
        : getTimeZoneParts(date, timeZone);

    if (options.onlyDate) {
        return parts.datePart;
    }

    if (options.includeOffset) {
        return `${parts.formatted} ${parts.offsetString}`;
    }

    return parts.formatted;
}

function getNowDateTimeInUserTimezone(date = new Date(), timezone = null) {
    const zone = resolveTimezone(timezone ?? getCurrentTimezone());
    const formatted = formatTimestamp(date, zone);
    return { db: literal(`'${formatted}'`), log: formatted };
}

function getNowDateTimeInUserTimezoneDate(date = new Date(), timezone = null) {
    const zone = resolveTimezone(timezone ?? getCurrentTimezone());
    return getTimeZoneParts(date, zone).date;
}

function getNowDateTimeInUserTimezoneAgo(date = new Date(), { hours = 0, days = 0, minutes = 0 } = {}, timezone = null) {
    const zone = resolveTimezone(timezone ?? getCurrentTimezone());
    const baseDate = getTimeZoneParts(date, zone).date;
    const adjusted = new Date(baseDate.getTime() - ((days * 24 * 60 + hours * 60 + minutes) * 60000));
    return formatTimestamp(adjusted, zone);
}

function getNowDateTimeInUserTimezoneAgoDate(date = new Date(), { hours = 0, days = 0, minutes = 0 } = {}, timezone = null) {
    const zone = resolveTimezone(timezone ?? getCurrentTimezone());
    const baseDate = getTimeZoneParts(date, zone).date;
    return new Date(baseDate.getTime() - ((days * 24 * 60 + hours * 60 + minutes) * 60000));
}

/**
 * Return JS Date for the current time in user's timezone
 */
function getNowRangeForPeriodInUserTimezone(timezone = null) {
    return getNowDateTimeInUserTimezoneDate(new Date(), timezone);
}

/**
 * Calculate historical week ranges (Sunday–Saturday)
 */
function calculateWeekRanges(numberOfWeeks = 52, skipLatest = true, timezone) {
    const ranges = [];
    const today = getNowDateTimeInUserTimezoneDate(new Date(), timezone);
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
    const today = getNowDateTimeInUserTimezoneDate(new Date(), timezone);
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
    const today = getNowDateTimeInUserTimezoneDate(new Date(), timezone);
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

function getDateRangeForPeriod(period, timezone = null) {
    const zone = resolveTimezone(timezone ?? getCurrentTimezone());
    const now = getNowDateTimeInUserTimezoneDate(new Date(), zone);
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
    getNowDateTimeInUserTimezoneDate,
    getNowRangeForPeriodInUserTimezone,
    formatTimestamp,
    getDateRangeForPeriod,
    getNowDateTimeInUserTimezoneAgo,
    getNowDateTimeInUserTimezoneAgoDate,
    resolveTimezone,
    evaluateReportDelay
};
