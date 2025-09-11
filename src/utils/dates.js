const { format, subDays, lastDayOfMonth, startOfMonth } = require('date-fns');

function fmt(date) {
    return format(date, 'yyyy-MM-dd');
}

function getDateRangeForPeriod(period, tzIgnored = true) {
    const now = new Date();
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

module.exports = { getDateRangeForPeriod };


