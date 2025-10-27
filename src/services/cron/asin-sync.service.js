/**
 * ASIN Sync Service
 * Business logic for ASIN synchronization
 */

const { initDatabaseContext, loadDatabase } = require('../../db/tenant.db');
const sellerModel = require('../../models/sequelize/seller.model');
const asinManagementService = require('./asin-management.service');
const logger = require('../../utils/logger.utils');

class AsinSyncService {
    /**
     * Sync seller ASINs from mws_items to seller_ASIN_list
     * @param {number} userId - User ID
     * @param {string} amazonSellerID - Amazon Seller ID
     * @returns {Promise<Object>} Sync result
     */
    async syncSellerAsins(userId, amazonSellerID) {
        return initDatabaseContext(async () => {
            try {
                await loadDatabase(userId);

                // Get seller details
                const seller = await sellerModel.getProfileDetailsByAmazonSellerID(amazonSellerID);
                if (!seller) {
                    throw new Error(`Seller not found: ${amazonSellerID}`);
                }

                // Get ASINs from mws_items
                const { getModel: getMwsItems } = require('../../models/sequelize/mwsItems.model');
                const MwsItems = getMwsItems();

                const items = await MwsItems.findAll({
                    where: { SellerID: seller.idSellerAccount },
                    attributes: ['ASIN'],
                    group: ['ASIN']
                });

                const newAsins = items.map(item => item.ASIN);

                if (newAsins.length === 0) {
                    logger.info({ 
                        sellerId: seller.idSellerAccount 
                    }, 'No ASINs found to sync');
                    return { synced: 0, total: 0 };
                }

                // Bulk insert using AsinManagementService
                const insertedCount = await asinManagementService.bulkInsertAsins(
                    newAsins,
                    seller.idSellerAccount,
                    amazonSellerID
                );

                logger.info({
                    sellerId: seller.idSellerAccount,
                    totalAsins: newAsins.length,
                    newAsins: insertedCount
                }, 'ASINs synced successfully');

                return {
                    synced: insertedCount,
                    total: newAsins.length
                };

            } catch (error) {
                logger.error({
                    error: error.message,
                    userId,
                    amazonSellerID
                }, 'Error syncing ASINs');
                throw error;
            }
        });
    }
}

module.exports = new AsinSyncService();

