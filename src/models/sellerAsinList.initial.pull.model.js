/**
 * Seller ASIN List - Initial Pull Status Management
 * Updates overall initial pull status for tracking historical data pull progress
 */

const { getModel: getSellerAsinList } = require('./sequelize/sellerAsinList.model');
const logger = require('../utils/logger.utils');
const { Op, literal } = require('sequelize');
const { updateSellerAsinLatestRanges } = require('../services/sqp.json.processing.service');

/**
 * Status values:
 * 0 = Pending (not started)
 * 1 = In Progress
 * 2 = Completed (all types: Week, Month, Quarter)
 * 3 = Failed
 */

/**
 * Update overall initial pull status
 * @param {string} amazonSellerID - Amazon Seller ID
 * @param {Array<string>} asinList - List of ASINs (optional, updates all if not provided)
 * @param {number} status - Status value (0=pending, 1=in_progress, 2=completed, 3=failed)
 * @param {Date} startTime - Start time (optional)
 * @param {Date} endTime - End time (optional)
 */
async function updateInitialPullStatus(cronDetailID, SellerID, amazonSellerID, asinList, status, startTime = null, endTime = null) {
    try {
        const SellerAsinList = getSellerAsinList();
        
        // Build update data
        const updateData = {
            InitialPullStatus: status,
            dtUpdatedOn: new Date()
        };
        
        if (startTime) {
            updateData.InitialPullStartTime = startTime;
        }
        
        if (endTime) {
            updateData.InitialPullEndTime = endTime;
        }        
        
        // Build where clause
        const where = { AmazonSellerID: amazonSellerID };
        if (asinList && asinList.length > 0) {
            where.ASIN = asinList;
            logger.info({
                cronDetailID,
                SellerID,
                amazonSellerID,
                asinList,
                status,
                startTime,
                endTime
            }, 'Updating initial pull status for ASINs in seller_ASIN_list');
            if(cronDetailID != ''){
                const { getModel: getSqpWeekly } = require('../models/sequelize/sqpWeekly.model');
                const { getModel: getSqpMonthly } = require('../models/sequelize/sqpMonthly.model');
                const { getModel: getSqpQuarterly } = require('../models/sequelize/sqpQuarterly.model');
                for (const asin of asinList) {
                    for (const reportType of ['WEEK', 'MONTH', 'QUARTER']) {
                        let SqpModel = null;
                        SqpModel = reportType === 'WEEK' ? getSqpWeekly()
                            : reportType === 'MONTH' ? getSqpMonthly()
                            : reportType === 'QUARTER' ? getSqpQuarterly()
                            : null;

                        if (!SqpModel) {
                            logger.error({
                                asin,
                                reportType,
                                amazonSellerID,
                                SellerID
                            }, 'Invalid SQP model for report type');
                            continue;
                        }
                        try {
                            const dateRanges = await SqpModel.findOne({
                                where: { ASIN: asin, SellerID: SellerID, AmazonSellerID: amazonSellerID },
                                attributes: [
                                    [literal('MAX(StartDate)'), 'minStartDate'],
                                    [literal('MAX(EndDate)'), 'maxEndDate']
                                ],
                                raw: true
                            });
    
                            let minRange = null;
                            let maxRange = null;
                            let isDataAvailable = 2;
    
                            if (dateRanges?.minStartDate && dateRanges?.maxEndDate) {
                                minRange = dateRanges.minStartDate;
                                maxRange = dateRanges.maxEndDate;
                                
                                // Get current date range for this report type
                                const datesUtils = require('../utils/dates.utils');
                                const currentRange = datesUtils.getDateRangeForPeriod(reportType);
                                
                                // Check if data is for current period
                                const isCurrentPeriod = 
                                    minRange === currentRange.start && 
                                    maxRange === currentRange.end;
                                
                                isDataAvailable = isCurrentPeriod ? 1 : 2;
                            }
    
                            logger.info({
                                asin,
                                reportType,
                                minRange,
                                maxRange,
                                isDataAvailable
                            }, 'Processing ASIN for report type');
    
                            await updateSellerAsinLatestRanges({
                                cronJobID: cronDetailID,
                                amazonSellerID: amazonSellerID,
                                reportType,
                                minRange: minRange || '',
                                maxRange: maxRange || '',
                                jsonAsins: [asin],
                                IsDataAvailable: isDataAvailable
                            });
                        } catch (asinError) {
                            console.error(`❌ Error processing ASIN ${asin}:`, asinError.message);
                        }
                    }
                }
            }
        }
        if(SellerID){
            where.SellerID = SellerID;
        }
        const [affectedRows] = await SellerAsinList.update(updateData, { where });
        
        logger.info({
            amazonSellerID,
            SellerID,
            status,
            affectedRows,
            asinCount: asinList?.length || 'all'
        }, 'Updated initial pull status for ASINs');
        
        return affectedRows;
    } catch (error) {
        logger.error({
            error: error.message,
            amazonSellerID,
            status
        }, 'Error updating initial pull status');
        throw error;
    }
}

/**
 * Mark initial pull as started (status = 1)
 */
async function markInitialPullStarted(amazonSellerID, asinList, SellerID, cronDetailID) {
    return updateInitialPullStatus(
        '',
        SellerID,
        amazonSellerID,
        asinList,
        1, // In Progress
        new Date(), // Start time
        null
    );
}

/**
 * Mark initial pull as completed (status = 2)
 */
async function markInitialPullCompleted(amazonSellerID, asinList, SellerID, cronDetailID) {
    return updateInitialPullStatus(
        cronDetailID,
        SellerID,
        amazonSellerID,
        asinList,
        2, // Completed
        null,
        new Date() // End time
    );
}

/**
 * Mark initial pull as failed (status = 3)
 */
async function markInitialPullFailed(amazonSellerID, asinList, SellerID, cronDetailID) {
    return updateInitialPullStatus(
        cronDetailID,
        SellerID,
        amazonSellerID,
        asinList,
        3, // Failed
        null,
        new Date() // End time
    );
}

module.exports = {
    updateInitialPullStatus,
    markInitialPullStarted,
    markInitialPullCompleted,
    markInitialPullFailed
};
