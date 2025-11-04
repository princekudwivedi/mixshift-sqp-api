const { format, subDays, lastDayOfMonth, startOfMonth } = require('date-fns');
const { DateTime } = require('luxon');

// Denver timezone (Mountain Time)
const DENVER_TZ = process.env.TZ;

function fmt(date) {
    return format(date, 'yyyy-MM-dd');
}

function getNowDateTimeInUserTimezone(timezone = DENVER_TZ){
    const now = new Date();
    //const now = DateTime.now().setZone(timezone).toJSDate();
    return now;
}
/**
 * Get current date/time in Denver timezone using native JavaScript Intl API
 * Denver uses Mountain Time (MT): UTC-7 (MST) or UTC-6 (MDT during daylight saving)
 */
function getNowRangeForPeriodInUserTimezone(timezone = DENVER_TZ) {
    const now = getNowDateTimeInUserTimezone(timezone);
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

function getDateRangeForPeriod(period, timezone = DENVER_TZ) {
    const now = getNowRangeForPeriodInUserTimezone(timezone);
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
            // if it's the 1st of the month → return the month before last (because last month not yet available)
            const day = now.getDate();
            let target = startOfMonth(now);
            if (day <= 1) {
                // too early → go back 2 months
                target = subDays(target, 1); // go to last month
                target = subDays(startOfMonth(target), 1); // go to month before last
            } else {
                // safe to use last month
                target = subDays(target, 1); // last day of last month
            }
            const lastMonthLastDay = lastDayOfMonth(target);
            const lastMonthFirstDay = startOfMonth(lastMonthLastDay);
            return { start: fmt(lastMonthFirstDay), end: fmt(lastMonthLastDay) };
        }
        case 'QUARTER': {
            const month = now.getMonth() + 1;
            const day = now.getDate();

            // Determine last completed quarter
            let q = Math.ceil(month / 3) - 1;
            if (q < 1) q = 4;
            let year = now.getFullYear();
            if (Math.ceil(month / 3) === 1) year -= 1;

            // If it's the 1st of a new quarter → still fetch the previous quarter (not yet available)
            if (day <= 1 && (month === 1 || month === 4 || month === 7 || month === 10)) {
                q -= 1;
                if (q < 1) {
                    q = 4;
                    year -= 1;
                }
            }

            const firstMonth = (q - 1) * 3 + 1;
            const lastMonth = q * 3;
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
    getNowDateTimeInUserTimezone,
    getNowRangeForPeriodInUserTimezone
};


