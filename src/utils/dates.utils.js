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
            // Custom quarter mapping (example: Q1 = Mar–May, Q2 = Jun–Aug, Q3 = Sep–Nov, Q4 = Dec–Feb)
            const quarters = [
                { startMonth: 2, endMonth: 4 },  // Mar–May
                { startMonth: 5, endMonth: 7 },  // Jun–Aug
                { startMonth: 8, endMonth: 10 }, // Sep–Nov
                { startMonth: 11, endMonth: 1 }  // Dec–Feb
            ];
            
            let year = now.getFullYear();
            let month = now.getMonth(); // 0–11
            
            // Find which quarter today belongs to
            let qIndex = quarters.findIndex(q =>
                (q.startMonth <= q.endMonth && month >= q.startMonth && month <= q.endMonth) ||
                (q.startMonth > q.endMonth && (month >= q.startMonth || month <= q.endMonth))
            );
            
            // Go to last quarter
            qIndex = (qIndex - 1 + 4) % 4;
            let q = quarters[qIndex];
            
            let first = new Date(year, q.startMonth, 1);
            let last = lastDayOfMonth(new Date(year, q.endMonth, 1));
            
            // Special case: if quarter spans year boundary (Dec–Feb)
            if (q.startMonth > q.endMonth && month < q.startMonth) {
                first.setFullYear(year - 1);
            }
            return { start: fmt(first), end: fmt(last) };
        }
        default:
            return null;
    }
}

module.exports = { getDateRangeForPeriod };


