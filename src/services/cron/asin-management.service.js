/**
 * ASIN Management Service
 * Handles all ASIN-related operations
 */

const logger = require('../../utils/logger.utils');
const { Op } = require('sequelize');
const DateTime = require('luxon');
const model = require('../../models/sqp.cron.model');

class AsinManagementService {
    /**
     * Get eligible ASINs for processing
     * @param {Object} params - Query parameters
     * @returns {Promise<Array>} List of eligible ASINs
     */
    async getEligibleAsins({ sellerId, isInitialPull = false, limit = null }) {
        try {

            const { asins, reportTypes } = await model.getActiveASINsBySeller(sellerId, isInitialPull);
            if (!asins.length) {
                logger.warn({ sellerId }, 'No eligible ASINs for seller (pending or ${env.MAX_DAYS_AGO}+ day old completed)');
                return { asins: [], reportTypes: [] };
            }
            logger.info({
                sellerId,
                isInitialPull,
                count: asins.length
            }, 'Retrieved eligible ASINs');

            return {
                asins: asins.map(a => a.ASIN),
                reportTypes: reportTypes
            };
            
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
            const { asins, reportTypes } = await this.getEligibleAsins({ 
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

