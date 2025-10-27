/**
 * ASIN Management Service
 * Handles all ASIN-related operations
 */

const logger = require('../../utils/logger.utils');
const { Op } = require('sequelize');

class AsinManagementService {
    /**
     * Get eligible ASINs for processing
     * @param {Object} params - Query parameters
     * @returns {Promise<Array>} List of eligible ASINs
     */
    async getEligibleAsins({ sellerId, isInitialPull = false, limit = null }) {
        try {
            const { getModel: getSellerAsinList } = require('../../models/sequelize/sellerAsinList.model');
            const SellerAsinList = getSellerAsinList();
            
            const where = { SellerID: sellerId };
            
            if (isInitialPull) {
                // For initial pull: Status = 0 (pending) OR Status = 3 (failed) and not pulled in last 3 days
                const threeDaysAgo = new Date();
                threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
                
                where[Op.or] = [
                    { InitialPullStatus: 0 },
                    {
                        [Op.and]: [
                            { InitialPullStatus: 3 },
                            {
                                [Op.or]: [
                                    { initialPullEndTime: null },
                                    { initialPullEndTime: { [Op.lte]: threeDaysAgo } }
                                ]
                            }
                        ]
                    }
                ];
            } else {
                // For main cron: Status = 1 (completed) OR Status = 3 (failed) and not pulled in last 3 days
                const threeDaysAgo = new Date();
                threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
                
                where[Op.or] = [
                    { Status: 1 },
                    {
                        [Op.and]: [
                            { Status: 3 },
                            {
                                [Op.or]: [
                                    { LastPullDate: null },
                                    { LastPullDate: { [Op.lte]: threeDaysAgo } }
                                ]
                            }
                        ]
                    }
                ];
            }
            
            const options = {
                where,
                attributes: ['ASIN', 'SellerID', 'Status', 'InitialPullStatus'],
                order: [['dtCreatedOn', 'ASC']]
            };
            
            if (limit) {
                options.limit = limit;
            }
            
            const asins = await SellerAsinList.findAll(options);
            
            logger.info({
                sellerId,
                isInitialPull,
                count: asins.length
            }, 'Retrieved eligible ASINs');
            
            return asins.map(a => a.ASIN);
            
        } catch (error) {
            logger.error({
                error: error.message,
                sellerId,
                isInitialPull
            }, 'Error getting eligible ASINs');
            throw error;
        }
    }

    /**
     * Check if seller has any eligible ASINs
     * @param {number} sellerId - Seller ID (null for all sellers)
     * @param {boolean} isInitialPull - Whether this is for initial pull
     * @returns {Promise<boolean>} True if eligible ASINs exist
     */
    async hasEligibleAsins(sellerId, isInitialPull = false) {
        try {
            const asins = await this.getEligibleAsins({ 
                sellerId, 
                isInitialPull, 
                limit: 1 
            });
            
            return asins.length > 0;
            
        } catch (error) {
            logger.error({
                error: error.message,
                sellerId
            }, 'Error checking eligible ASINs');
            return false;
        }
    }

    /**
     * Split ASINs into chunks for API requests
     * Amazon allows max 20 ASINs and 200 characters per request
     * @param {Array} asinList - List of ASINs
     * @returns {Array<Array>} Chunked ASIN lists
     */
    splitAsinsIntoChunks(asinList) {
        const chunks = [];
        let currentChunk = [];
        let currentLength = 0;
        
        const maxAsins = 20;
        const maxLength = 200;
        
        for (const asin of asinList) {
            const asinLength = asin.length + 1; // +1 for space
            
            // Check if adding this ASIN would exceed limits
            if (currentChunk.length >= maxAsins || currentLength + asinLength > maxLength) {
                if (currentChunk.length > 0) {
                    chunks.push([...currentChunk]);
                }
                currentChunk = [asin];
                currentLength = asin.length;
            } else {
                currentChunk.push(asin);
                currentLength += asinLength;
            }
        }
        
        // Add remaining chunk
        if (currentChunk.length > 0) {
            chunks.push(currentChunk);
        }
        
        logger.debug({
            totalAsins: asinList.length,
            chunks: chunks.length
        }, 'Split ASINs into chunks');
        
        return chunks;
    }

    /**
     * Mark ASINs as pending
     * @param {Array} asinList - List of ASINs
     * @param {number} sellerId - Seller ID
     * @param {boolean} isInitialPull - Whether this is for initial pull
     * @returns {Promise<number>} Number of ASINs updated
     */
    async markAsinsAsPending(asinList, sellerId, isInitialPull = false) {
        try {
            const { getModel: getSellerAsinList } = require('../../models/sequelize/sellerAsinList.model');
            const SellerAsinList = getSellerAsinList();
            
            const updateData = isInitialPull
                ? { InitialPullStatus: 0, initialPullStartTime: new Date() }
                : { Status: 0, LastPullDate: new Date() };
            
            const [updateCount] = await SellerAsinList.update(updateData, {
                where: {
                    ASIN: { [Op.in]: asinList },
                    SellerID: sellerId
                }
            });
            
            logger.info({
                sellerId,
                count: updateCount,
                isInitialPull
            }, 'Marked ASINs as pending');
            
            return updateCount;
            
        } catch (error) {
            logger.error({
                error: error.message,
                sellerId
            }, 'Error marking ASINs as pending');
            throw error;
        }
    }

    /**
     * Mark ASINs as completed
     * @param {Array} asinList - List of ASINs
     * @param {number} sellerId - Seller ID
     * @param {boolean} isInitialPull - Whether this is for initial pull
     * @returns {Promise<number>} Number of ASINs updated
     */
    async markAsinsAsCompleted(asinList, sellerId, isInitialPull = false) {
        try {
            const { getModel: getSellerAsinList } = require('../../models/sequelize/sellerAsinList.model');
            const SellerAsinList = getSellerAsinList();
            
            const updateData = isInitialPull
                ? { InitialPullStatus: 1, initialPullEndTime: new Date() }
                : { Status: 1, LastPullDate: new Date() };
            
            const [updateCount] = await SellerAsinList.update(updateData, {
                where: {
                    ASIN: { [Op.in]: asinList },
                    SellerID: sellerId
                }
            });
            
            logger.info({
                sellerId,
                count: updateCount,
                isInitialPull
            }, 'Marked ASINs as completed');
            
            return updateCount;
            
        } catch (error) {
            logger.error({
                error: error.message,
                sellerId
            }, 'Error marking ASINs as completed');
            throw error;
        }
    }

    /**
     * Mark ASINs as failed
     * @param {Array} asinList - List of ASINs
     * @param {number} sellerId - Seller ID
     * @param {boolean} isInitialPull - Whether this is for initial pull
     * @returns {Promise<number>} Number of ASINs updated
     */
    async markAsinsAsFailed(asinList, sellerId, isInitialPull = false) {
        try {
            const { getModel: getSellerAsinList } = require('../../models/sequelize/sellerAsinList.model');
            const SellerAsinList = getSellerAsinList();
            
            const updateData = isInitialPull
                ? { InitialPullStatus: 3, initialPullEndTime: new Date() }
                : { Status: 3, LastPullDate: new Date() };
            
            const [updateCount] = await SellerAsinList.update(updateData, {
                where: {
                    ASIN: { [Op.in]: asinList },
                    SellerID: sellerId
                }
            });
            
            logger.info({
                sellerId,
                count: updateCount,
                isInitialPull
            }, 'Marked ASINs as failed');
            
            return updateCount;
            
        } catch (error) {
            logger.error({
                error: error.message,
                sellerId
            }, 'Error marking ASINs as failed');
            throw error;
        }
    }

    /**
     * Filter ASINs to prevent duplicates
     * @param {Array} newAsins - New ASINs to add
     * @param {number} sellerId - Seller ID
     * @returns {Promise<Array>} Filtered ASINs (only new ones)
     */
    async filterDuplicateAsins(newAsins, sellerId) {
        try {
            const { getModel: getSellerAsinList } = require('../../models/sequelize/sellerAsinList.model');
            const SellerAsinList = getSellerAsinList();
            
            // Get existing ASINs
            const existing = await SellerAsinList.findAll({
                where: {
                    ASIN: { [Op.in]: newAsins },
                    SellerID: sellerId
                },
                attributes: ['ASIN']
            });
            
            const existingSet = new Set(existing.map(a => a.ASIN));
            const filtered = newAsins.filter(asin => !existingSet.has(asin));
            
            logger.info({
                sellerId,
                totalNew: newAsins.length,
                duplicates: existingSet.size,
                filtered: filtered.length
            }, 'Filtered duplicate ASINs');
            
            return filtered;
            
        } catch (error) {
            logger.error({
                error: error.message,
                sellerId
            }, 'Error filtering duplicate ASINs');
            throw error;
        }
    }

    /**
     * Bulk insert ASINs
     * @param {Array} asinList - List of ASINs
     * @param {number} sellerId - Seller ID
     * @param {string} amazonSellerID - Amazon Seller ID
     * @returns {Promise<number>} Number of ASINs inserted
     */
    async bulkInsertAsins(asinList, sellerId, amazonSellerID) {
        try {
            // Filter duplicates first
            const filtered = await this.filterDuplicateAsins(asinList, sellerId);
            
            if (filtered.length === 0) {
                logger.info({ sellerId }, 'No new ASINs to insert');
                return 0;
            }
            
            const { getModel: getSellerAsinList } = require('../../models/sequelize/sellerAsinList.model');
            const SellerAsinList = getSellerAsinList();
            
            const records = filtered.map(asin => ({
                ASIN: asin,
                SellerID: sellerId,
                AmazonSellerID: amazonSellerID,
                Status: 0,
                InitialPullStatus: 0,
                dtCreatedOn: new Date(),
                dtUpdatedOn: new Date()
            }));
            
            await SellerAsinList.bulkCreate(records, {
                ignoreDuplicates: true
            });
            
            logger.info({
                sellerId,
                inserted: filtered.length
            }, 'Bulk inserted ASINs');
            
            return filtered.length;
            
        } catch (error) {
            logger.error({
                error: error.message,
                sellerId
            }, 'Error bulk inserting ASINs');
            throw error;
        }
    }
}

// Export singleton instance
module.exports = new AsinManagementService();

