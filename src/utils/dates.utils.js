const { format, subDays, lastDayOfMonth, startOfMonth } = require('date-fns');

// Denver timezone (Mountain Time)
const DENVER_TZ = 'America/Denver';

function fmt(date) {
    return format(date, 'yyyy-MM-dd');
}

/**
 * Get current date/time in Denver timezone using native JavaScript Intl API
 * Denver uses Mountain Time (MT): UTC-7 (MST) or UTC-6 (MDT during daylight saving)
 */
function getNowInDenver(timezone = DENVER_TZ) {
    // Use Intl API to get date components in Denver timezone
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    
    const parts = formatter.formatToParts(now);
    const getValue = (type) => parts.find(p => p.type === type)?.value;
    
    // Create a new Date object with Denver timezone values
    return new Date(
        parseInt(getValue('year')),
        parseInt(getValue('month')) - 1,
        parseInt(getValue('day')),
        parseInt(getValue('hour')),
        parseInt(getValue('minute')),
        parseInt(getValue('second'))
    );
}

function getDateRangeForPeriod(period, timezone = DENVER_TZ, useDenverTz = true) {
    const now = useDenverTz ? getNowInDenver(timezone) : new Date();
    switch (period) {
        case 'WEEK': {
            // last completed Sunday-Saturday
            const todayDow = now.getDay();
            const daysSinceSaturday = (todayDow + 1) % 7; // 0 if Sunday -> 1, Saturday -> 0
            const end = subDays(now, daysSinceSaturday || 7);
            const start = subDays(end, 6);
            return { start: fmt(start), end: fmt(end) };
        }
        case 'MONTH': {
            const lastMonthLastDay = lastDayOfMonth(subDays(startOfMonth(now), 1));
            const lastMonthFirstDay = startOfMonth(lastMonthLastDay);
            return { start: fmt(lastMonthFirstDay), end: fmt(lastMonthLastDay) };
        }
        case 'QUARTER': {
            const month = now.getMonth() + 1;
            let q = Math.ceil(month / 3) - 1; if (q < 1) q = 4;
            let year = now.getFullYear();
            if (Math.ceil(month / 3) === 1) year -= 1;
            const firstMonth = (q - 1) * 3 + 1; // 1,4,7,10
            const lastMonth = q * 3; // 3,6,9,12
            const first = new Date(year, firstMonth - 1, 1);
            const last = lastDayOfMonth(new Date(year, lastMonth - 1, 1));
            return { start: fmt(first), end: fmt(last) };
        }
        default:
            return null;
    }
}

module.exports = { 
    getDateRangeForPeriod,
    getNowInDenver,
    DENVER_TZ
};


