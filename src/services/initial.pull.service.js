/**
 * Initial Pull Service
 * Handles historical ASIN data pulling for weeks, months, and quarters
 * 
 * Requirements:
 * - Pull 7 weeks historical (skip most recent)
 * - Pull 36 months historical (skip current month)
 * - Pull 8 quarters historical (skip current quarter)
 */

const logger = require('../utils/logger.utils');
const config = require('../config/env.config');

class InitialPullService {
    /**
     * Calculate historical week ranges (Sunday to Saturday)
     * 
     * SKIP LOGIC:
     * 1. Current incomplete week (e.g., Oct 5-11, 2025)
     * 2. Previous complete week (e.g., Sep 27-Oct 4, 2025) - Latest week
     * 
     * PULL: 52 weeks starting from 2 weeks ago
     * 
     * @param {number} numberOfWeeks - Number of weeks to pull (default 52)
     * @param {boolean} skipLatest - Skip current + previous week (default true)
     * @returns {Array} Array of week range objects
     */
    calculateWeekRanges(numberOfWeeks = 52, skipLatest = true) {
        const ranges = [];
        const today = new Date();
        
        // Use UTC to avoid timezone issues - get current date in UTC
        const currentSunday = new Date(Date.UTC(
            today.getFullYear(), 
            today.getMonth(), 
            today.getDate()
        ));
        
        // Get day of week in UTC (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
        const dayOfWeek = currentSunday.getUTCDay();
        
        // Set to Sunday of current week in UTC
        currentSunday.setUTCDate(currentSunday.getUTCDate() - dayOfWeek);
        
        // Skip 2 weeks: current incomplete + previous complete
        const startWeek = skipLatest ? -2 : 0;
        
        for (let i = startWeek; i >= startWeek - (numberOfWeeks - 1); i--) {
            const weekStart = new Date(currentSunday);
            weekStart.setUTCDate(currentSunday.getUTCDate() + (i * 7)); // Sunday
            
            const weekEnd = new Date(weekStart);
            weekEnd.setUTCDate(weekStart.getUTCDate() + 6); // Saturday
            
            ranges.push({
                startDate: weekStart.toISOString().split('T')[0],
                endDate: weekEnd.toISOString().split('T')[0],
                range: `${weekStart.toISOString().split('T')[0]} to ${weekEnd.toISOString().split('T')[0]}`,
                type: 'WEEK'
            });
        }
        
        return ranges;
    }

    /**
     * Calculate historical month ranges
     * 
     * SKIP LOGIC:
     * 1. Current incomplete month (e.g., October 2025)
     * 2. Previous complete month (e.g., September 2025) - Latest month
     * 
     * 
     * @param {number} numberOfMonths - Number of months to pull (default 12)
     * @param {boolean} skipCurrent - Skip current + previous month (default true)
     * @returns {Array} Array of month range objects
     */
    calculateMonthRanges(numberOfMonths = 12, skipCurrent = true) {
        const ranges = [];
        const today = new Date();
        
        // Skip 2 months: current incomplete + previous complete
        const startMonth = skipCurrent ? -2 : 0;
        
        for (let i = startMonth; i >= startMonth - (numberOfMonths - 1); i--) {
            const monthStart = new Date(today.getFullYear(), today.getMonth() + i, 1);
            const monthEnd = new Date(today.getFullYear(), today.getMonth() + i + 1, 0); // Last day of month
            
            ranges.push({
                startDate: monthStart.toISOString().split('T')[0],
                endDate: monthEnd.toISOString().split('T')[0],
                range: `${monthStart.toISOString().split('T')[0]} to ${monthEnd.toISOString().split('T')[0]}`,
                type: 'MONTH'
            });
        }
        
        return ranges;
    }

    /**
     * Calculate historical quarter ranges
     * 
     * SKIP LOGIC:
     * 1. Current incomplete quarter (e.g., Q4 2025: Oct-Dec)
     * 2. Previous complete quarter (e.g., Q3 2025: Jul-Sep) - Latest quarter
     * 
     * PULL: 4 quarters starting from 2 quarters ago
     * 
     * @param {number} numberOfQuarters - Number of quarters to pull (default 7)
     * @param {boolean} skipCurrent - Skip current + previous quarter (default true)
     * @returns {Array} Array of quarter range objects
     */
    calculateQuarterRanges(numberOfQuarters = 4, skipCurrent = true) {
        const ranges = [];
        const today = new Date();
        
        // Get current quarter (0-3)
        const currentQuarter = Math.floor(today.getMonth() / 3);
        const currentYear = today.getFullYear();
        
        // Skip 2 quarters: current incomplete + previous complete
        const startQuarter = skipCurrent ? -2 : 0;
        
        for (let i = startQuarter; i >= startQuarter - (numberOfQuarters - 1); i--) {
            // Calculate which quarter and year
            let quarter = currentQuarter + i;
            let year = currentYear;
            
            while (quarter < 0) {
                quarter += 4;
                year -= 1;
            }
            
            // Quarter start months: 0 (Jan), 3 (Apr), 6 (Jul), 9 (Oct)
            const quarterStartMonth = quarter * 3;
            const quarterStart = new Date(year, quarterStartMonth, 1);
            const quarterEnd = new Date(year, quarterStartMonth + 3, 0); // Last day of 3rd month
            
            ranges.push({
                startDate: quarterStart.toISOString().split('T')[0],
                endDate: quarterEnd.toISOString().split('T')[0],
                range: `${quarterStart.toISOString().split('T')[0]} to ${quarterEnd.toISOString().split('T')[0]}`,
                type: 'QUARTER',
                quarter: quarter + 1,
                year
            });
        }
        
        return ranges;
    }

    /**
     * Calculate full range string for all periods
     * @returns {Object} Full ranges for week, month, quarter
     */
    calculateFullRanges() {
        // Configurable via environment variables
        const weeksToPull = config.WEEKS_TO_PULL;
        const monthsToPull = config.MONTHS_TO_PULL;
        const quartersToPull = config.QUARTERS_TO_PULL;
        
        logger.info({ weeksToPull, monthsToPull, quartersToPull }, 'Initial pull configuration');
        
        const weekRanges = this.calculateWeekRanges(weeksToPull, true);
        const monthRanges = this.calculateMonthRanges(monthsToPull, true);
        const quarterRanges = this.calculateQuarterRanges(quartersToPull, true);
        
        const fullWeekRange = weekRanges.length > 0 
            ? `${weekRanges[weekRanges.length - 1].startDate} to ${weekRanges[0].endDate}`
            : null;
            
        const fullMonthRange = monthRanges.length > 0
            ? `${monthRanges[monthRanges.length - 1].startDate} to ${monthRanges[0].endDate}`
            : null;
            
        const fullQuarterRange = quarterRanges.length > 0
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
     * Get summary of historical ranges
     * @returns {Object} Summary with counts and date ranges
     */
    getHistoricalSummary() {
        const ranges = this.calculateFullRanges();
        
        return {
            weeks: {
                count: ranges.weekRanges.length,
                fullRange: ranges.fullWeekRange,
                skipLatest: true,
                ranges: ranges.weekRanges
            },
            months: {
                count: ranges.monthRanges.length,
                fullRange: ranges.fullMonthRange,
                skipCurrent: true,
                ranges: ranges.monthRanges
            },
            quarters: {
                count: ranges.quarterRanges.length,
                fullRange: ranges.fullQuarterRange,
                skipCurrent: true,
                ranges: ranges.quarterRanges
            },
            totalRanges: ranges.weekRanges.length + ranges.monthRanges.length + ranges.quarterRanges.length
        };
    }

    /**
     * Format date for Amazon SP-API (YYYY-MM-DD)
     * @param {Date} date - Date object
     * @returns {string} Formatted date string
     */
    formatDate(date) {
        return date.toISOString().split('T')[0];
    }

    /**
     * Get date range for specific index and type
     * @param {string} type - 'WEEK', 'MONTH', or 'QUARTER'
     * @param {number} index - Index in the array (0 = most recent)
     * @returns {Object} Date range object
     */
    getDateRangeByIndex(type, index) {
        let ranges;
        
        switch(type) {
            case 'WEEK':
                ranges = this.calculateWeekRanges(7, true);
                break;
            case 'MONTH':
                ranges = this.calculateMonthRanges(36, true);
                break;
            case 'QUARTER':
                ranges = this.calculateQuarterRanges(8, true);
                break;
            default:
                throw new Error(`Invalid type: ${type}. Must be WEEK, MONTH, or QUARTER`);
        }
        
        if (index < 0 || index >= ranges.length) {
            throw new Error(`Invalid index: ${index}. Must be between 0 and ${ranges.length - 1}`);
        }
        
        return ranges[index];
    }
}

module.exports = new InitialPullService();

