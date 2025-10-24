/**
 * SQP Data Utilities
 * Helper functions for SQP data operations
 */

const { literal } = require('sequelize');
const logger = require('./logger.utils');

/**
 * Get Sequelize model for report type
 * @param {string} reportType - WEEK, MONTH, or QUARTER
 * @returns {Object} Sequelize model instance
 */
function getModelForReportType(reportType) {
    const { getModel: getSqpWeekly } = require('../models/sequelize/sqpWeekly.model');
    const { getModel: getSqpMonthly } = require('../models/sequelize/sqpMonthly.model');
    const { getModel: getSqpQuarterly } = require('../models/sequelize/sqpQuarterly.model');

    switch (reportType) {
        case 'WEEK':
            return getSqpWeekly();
        case 'MONTH':
            return getSqpMonthly();
        case 'QUARTER':
            return getSqpQuarterly();
        default:
            throw new Error(`Invalid report type: ${reportType}`);
    }
}

/**
 * Get latest date range and check if it's current
 * @param {string} reportType - WEEK, MONTH, or QUARTER
 * @param {string} asin - ASIN
 * @param {number} sellerId - Seller ID
 * @param {string} amazonSellerID - Amazon Seller ID
 * @param {boolean} hasData - Whether data exists (default: true)
 * @returns {Promise<{minRange: string|null, maxRange: string|null, isDataAvailable: number}>}
 */
async function getLatestDataRangeAndAvailability(reportType, asin, sellerId, amazonSellerID, hasData = true) {
    try {
        // Get model for report type
        const SqpModel = getModelForReportType(reportType);
        
        // Fetch latest date range from database
        const dateRanges = await SqpModel.findOne({
            where: { 
                ASIN: asin, 
                SellerID: sellerId, 
                AmazonSellerID: amazonSellerID 
            },
            attributes: [
                [literal('MAX(StartDate)'), 'minStartDate'],
                [literal('MAX(EndDate)'), 'maxEndDate']
            ],
            raw: true
        });
        
        let minRange = null;
        let maxRange = null;
        let isDataAvailable = 2; // default: no data or not current
        
        if (hasData && dateRanges?.minStartDate && dateRanges?.maxEndDate) {
            minRange = dateRanges.minStartDate;
            maxRange = dateRanges.maxEndDate;
            
            // Get current date range for this report type
            const datesUtils = require('./dates.utils');
            const currentRange = datesUtils.getDateRangeForPeriod(reportType);
            
            // Check if data is for current period
            const isCurrentPeriod = 
                minRange === currentRange.start && 
                maxRange === currentRange.end;
            
            isDataAvailable = isCurrentPeriod ? 1 : 2;
        }
        
        return {
            minRange,
            maxRange,
            isDataAvailable
        };
        
    } catch (error) {
        logger.error({ 
            error: error.message, 
            reportType, 
            asin, 
            sellerId 
        }, 'Error getting latest data range');
        
        return {
            minRange: null,
            maxRange: null,
            isDataAvailable: 2
        };
    }
}

module.exports = {
    getModelForReportType,
    getLatestDataRangeAndAvailability
};

