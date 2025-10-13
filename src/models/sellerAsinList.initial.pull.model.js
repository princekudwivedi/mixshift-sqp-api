/**
 * Seller ASIN List - Initial Pull Status Management
 * Updates overall initial pull status for tracking historical data pull progress
 */

const { getModel: getSellerAsinList } = require('./sequelize/sellerAsinList.model');
const logger = require('../utils/logger.utils');

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
async function updateInitialPullStatus(amazonSellerID, asinList, status, startTime = null, endTime = null) {
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
        }
        
        const [affectedRows] = await SellerAsinList.update(updateData, { where });
        
        logger.info({
            amazonSellerID,
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
async function markInitialPullStarted(amazonSellerID, asinList) {
    return updateInitialPullStatus(
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
async function markInitialPullCompleted(amazonSellerID, asinList) {
    return updateInitialPullStatus(
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
async function markInitialPullFailed(amazonSellerID, asinList) {
    return updateInitialPullStatus(
        amazonSellerID,
        asinList,
        3, // Failed
        null,
        new Date() // End time
    );
}

/**
 * Get initial pull status for ASINs
 * @param {string} amazonSellerID - Amazon Seller ID
 * @returns {Promise<Array>} ASINs with their status
 */
async function getInitialPullStatus(amazonSellerID) {
    try {
        const SellerAsinList = getSellerAsinList();
        
        const results = await SellerAsinList.findAll({
            where: { AmazonSellerID: amazonSellerID },
            attributes: [
                'ASIN',
                'ItemName',
                'InitialPullStatus',
                'InitialPullStartTime',
                'InitialPullEndTime'
            ],
            raw: true
        });
        
        return results;
    } catch (error) {
        logger.error({
            error: error.message,
            amazonSellerID
        }, 'Error getting initial pull status');
        throw error;
    }
}

/**
 * Get initial pull status summary for a seller
 * @param {string} amazonSellerID - Amazon Seller ID
 * @returns {Promise<Object>} Summary with counts
 */
async function getInitialPullSummary(amazonSellerID) {
    try {
        const SellerAsinList = getSellerAsinList();
        
        const results = await SellerAsinList.findAll({
            where: { AmazonSellerID: amazonSellerID, IsActive: 1 },
            attributes: ['InitialPullStatus'],
            raw: true
        });
        
        const summary = {
            total: results.length,
            pending: 0,
            inProgress: 0,
            completed: 0,
            failed: 0
        };
        
        results.forEach(row => {
            const status = row.InitialPullStatus;
            if (status === 0 || status === null) summary.pending++;
            else if (status === 1) summary.inProgress++;
            else if (status === 2) summary.completed++;
            else if (status === 3) summary.failed++;
        });
        
        return summary;
    } catch (error) {
        logger.error({
            error: error.message,
            amazonSellerID
        }, 'Error getting initial pull summary');
        throw error;
    }
}

module.exports = {
    updateInitialPullStatus,
    markInitialPullStarted,
    markInitialPullCompleted,
    markInitialPullFailed,
    getInitialPullStatus,
    getInitialPullSummary
};
