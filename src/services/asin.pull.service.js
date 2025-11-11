/**
 * Asin Pull Service
 
 */
const { ValidationHelpers } = require('../helpers/sqp.helpers');
const { initDatabaseContext, loadDatabase } = require('../db/tenant.db');
const { getModel: getSellerAsinList } = require('../models/sequelize/sellerAsinList.model');
const { getModel: getMwsItems } = require('../models/sequelize/mwsItems.model');
const sellerModel = require('../models/sequelize/seller.model');
const logger = require('../utils/logger.utils');
const env = require('../config/env.config');
const dates = require('../utils/dates.utils');

class AsinPullService {

    /**
     * Public method to process ASIN sync
     */
    async processSyncSellerAsins(userId, amazonSellerID) {
        return this._processSyncSellerAsins(userId, amazonSellerID);
    }

    /**
     * Public method to sync seller ASINs internally
     */
    async syncSellerAsinsInternal(sellerIdentifier, isActive = 0, key = 'ID') {
        return this._syncSellerAsinsInternal(sellerIdentifier, isActive, key);
    }

    /**
     * Internal method to process ASIN sync
     */
    async _processSyncSellerAsins(userId, amazonSellerID) {
        return initDatabaseContext(async () => {
        try {
            // Validate parameters
            const validatedUserId = ValidationHelpers.sanitizeNumber(userId);
            const validatedAmazonSellerID = ValidationHelpers.validateAmazonSellerId(amazonSellerID);

            if (!validatedUserId || validatedUserId <= 0 || !validatedAmazonSellerID) {
                logger.error({ userId, amazonSellerID }, 'Invalid parameters for ASIN sync');
                return;
            }            
            
            // Load tenant database
            await loadDatabase(validatedUserId);
            
            // Use the helper function
            const result = await this._syncSellerAsinsInternal(validatedAmazonSellerID, 0, 'AmazonSellerID');

            if (result.error) {
                logger.error({ error: result.error }, 'ASIN sync failed');
                return;
            }

            // Get seller info
            const seller = await sellerModel.getProfileDetailsByID(validatedAmazonSellerID, 'AmazonSellerID');

            logger.info({
                userId: validatedUserId,
                sellerID: seller?.idSellerAccount,
                amazonSellerID: validatedAmazonSellerID,
                insertedCount: result.insertedCount,
                totalCount: result.totalCount
            }, 'ASIN sync completed successfully');

        } catch (error) {
            logger.error({ 
                error: error.message, 
                userId, 
                amazonSellerID 
            }, 'Error in _processSyncSellerAsins');
        }
        });
    }
    /**
     * Private helper function to sync ASINs for a seller from mws_items (reusable)
     * @param {number} sellerID
     * @param {number} isActive Default ASIN status (1=Active, 0=Inactive)
     * @returns {Promise<{insertedCount: number, totalCount: number, error: string|null}>}
     */
    async _syncSellerAsinsInternal(sellerIdentifier, isActive = 0, key = 'ID') {
        try {
            const SellerAsinList = getSellerAsinList();
            const MwsItems = getMwsItems();
    
            // Get seller info for validation
            logger.info({ sellerIdentifier, key }, 'Getting seller profile details');
            const seller = await sellerModel.getProfileDetailsByID(sellerIdentifier, key);
            if (!seller) {
                logger.error({ sellerIdentifier }, 'Seller not found');
                return { insertedCount: 0, totalCount: 0, error: 'Seller not found or inactive' };
            }
    
            if (!seller.AmazonSellerID) {
                logger.error({ sellerID: seller.idSellerAccount, seller }, 'Seller AmazonSellerID is missing');
                return { insertedCount: 0, totalCount: 0, error: 'Seller AmazonSellerID is missing' };
            }
        
            // Get new ASINs from mws_items (group by ASIN only)
            const newAsins = await MwsItems.findAll({
                where: {
                    AmazonSellerID: seller.AmazonSellerID,
                    ASIN: {
                        [require('sequelize').Op.ne]: null,
                        [require('sequelize').Op.ne]: ''
                    }
                },
                attributes: ['SellerID','ASIN','ItemName','SKU','SellerName','MarketPlaceName','AmazonSellerID'],
                raw: true,
                group: ['ASIN']
            });
            // Fetch existing ASINs for this seller
            const existingAsinsInDB = await SellerAsinList.findAll({
                where: { 
                    SellerID: { [require('sequelize').Op.in]: newAsins.map(i => i.SellerID) },
                    ASIN: { [require('sequelize').Op.in]: newAsins.map(i => i.ASIN) }
                },
                attributes: ['ASIN', 'SellerID'],
                raw: true
            });

            // Create a set of existing combinations: ASIN + SellerID
            const existingSet = new Set(existingAsinsInDB.map(item => `${item.ASIN}_${item.SellerID}`));

            // Filter new ASINs: insert only if combination does not exist
            const asinsToInsert = newAsins
                .filter(item => {
                    const key = `${item.ASIN}_${item.SellerID}`;
                    return !existingSet.has(key);
                })
                .map(item => ({
                    SellerID: parseInt(item.SellerID) || 0,
                    SellerName: item.SellerName || '',
                    MarketPlaceName: item.MarketPlaceName || '',
                    AmazonSellerID: item.AmazonSellerID || '',
                    ASIN: (item.ASIN || '').trim().toUpperCase(),
                    ItemName: item.ItemName || '',
                    SKU: item.SKU || '',
                    IsActive: isActive || 0,
                    dtCreatedOn: dates.getNowDateTimeInUserTimezone()
                }));

            let insertedCount = 0;
            if (asinsToInsert.length > 0) {
                const chunkSize = 50;
                for (let i = 0; i < asinsToInsert.length; i += chunkSize) {
                    const chunk = asinsToInsert.slice(i, i + chunkSize);
                    try {
                        await SellerAsinList.bulkCreate(chunk, {
                            ignoreDuplicates: true,
                            validate: true
                        });
                        insertedCount += chunk.length;
                    } catch (chunkError) {
                        logger.error({
                            error: chunkError.message,
                            sellerID: seller.idSellerAccount,
                            chunkSample: chunk.slice(0, 2)
                        }, 'Chunk insert failed, trying individual inserts');
    
                        for (const record of chunk) {
                            try {
                                await SellerAsinList.create(record, { ignoreDuplicates: true });
                                insertedCount++;
                            } catch (individualError) {
                                logger.warn({
                                    error: individualError.message,
                                    record,
                                    sellerID: seller.idSellerAccount
                                }, 'Individual insert skipped (likely duplicate)');
                            }
                        }
                    }
                }
            }
    
            const afterCount = await SellerAsinList.count({
                where: { SellerID: seller.idSellerAccount }
            });
    
            return { insertedCount, totalCount: afterCount, error: null };
    
        } catch (error) {
            logger.error({
                error: error.message,
                stack: error.stack,
                sellerIdentifier,
                isActive
            }, 'syncSellerAsinsInternal failed');
            return { insertedCount: 0, totalCount: 0, error: `Database error: ${error.message}` };
        }
    }
}

module.exports = new AsinPullService();

