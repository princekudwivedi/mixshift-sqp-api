/**
 * Asin Pull Service
 
 */
const { ValidationHelpers } = require('../helpers/sqp.helpers');
const { initDatabaseContext, loadDatabase, getCurrentSequelize } = require('../db/tenant.db');
const { getModel: getSellerAsinList } = require('../models/sequelize/sellerAsinList.model');
const { getModel: getMwsItems } = require('../models/sequelize/mwsItems.model');
const sellerModel = require('../models/sequelize/seller.model');
const logger = require('../utils/logger.utils');
const env = require('../config/env.config');
const dates = require('../utils/dates.utils');
const { Op, literal,QueryTypes } = require("sequelize");
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
            logger.info({
                userId: validatedUserId,
                amazonSellerID: validatedAmazonSellerID,
                insertedCount: result.insertedCount,
                totalCount: result.totalCount,
                updatedCount: result.updatedCount
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
    
            // Get new ASINs from mws_items - select newest ItemName per ASIN
            // Priority: InCatalog = 1 first, then by highest ID or most recent dtUpdatedOn
            const sequelize = getCurrentSequelize();
            const newAsinsList = await sequelize.query(`
                SELECT 
                    main.ID,
                    main.SellerID,
                    main.ASIN,
                    main.AmazonSellerID,
                    main.SKU,
                    main.MarketPlaceName,
                    main.SellerName,
                    latest.ItemName

                FROM mws_items main
                JOIN (
                    SELECT 
                        sub.SellerID,
                        sub.ASIN,
                        sub.AmazonSellerID,
                        MAX(sub.ID) AS maxID
                    FROM mws_items sub
                    WHERE sub.AmazonSellerID = :amazonId
                    AND sub.ASIN IS NOT NULL
                    AND sub.ASIN <> ''
                    GROUP BY sub.SellerID, sub.ASIN, sub.AmazonSellerID
                ) filtered 
                ON filtered.maxID = main.ID

                LEFT JOIN mws_items latest
                    ON latest.ID = (
                        SELECT sub2.ID
                        FROM mws_items sub2
                        WHERE sub2.ASIN = main.ASIN
                        AND sub2.AmazonSellerID = main.AmazonSellerID
                        ORDER BY
                            CASE WHEN sub2.InCatalog = 1 THEN 0 ELSE 1 END,
                            sub2.ID DESC,
                            COALESCE(sub2.dtUpdatedOn, '1970-01-01') DESC
                        LIMIT 1
                    );
                `,
                {
                 replacements: { amazonId: sellerIdentifier },
                 type: QueryTypes.SELECT
            });
            
            // ✅ No need to filter again, newAsinsList already has only the latest rows
            const newAsins = newAsinsList; 
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
            const normalizeKey = (asin, sellerId) => {
                const normalizedAsin = (asin || '').trim().toUpperCase();
                const normalizedSeller = parseInt(sellerId) || 0;
                return `${normalizedAsin}_${normalizedSeller}`;
            };

            const existingSet = new Set(
                existingAsinsInDB.map(item => normalizeKey(item.ASIN, item.SellerID))
            );

            const updates = [];

            // Filter new ASINs: insert only if combination does not exist
            const asinsToInsert = newAsins
                .filter(item => {
                    const normalizedSellerId = parseInt(item.SellerID) || 0;
                    const normalizedAsin = (item.ASIN || '').trim().toUpperCase();
                    const key = normalizeKey(normalizedAsin, normalizedSellerId);
                    if (existingSet.has(key)) {
                        updates.push({
                            SellerID: normalizedSellerId,
                            ASIN: normalizedAsin,
                            SellerName: item.SellerName || '',
                            MarketPlaceName: item.MarketPlaceName || '',
                            ItemName: item.ItemName || '',
                            SKU: item.SKU || '',
                            AmazonSellerID: item.AmazonSellerID || ''
                        });
                        return false;
                    }
                    return true;
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
                    dtCreatedOn: dates.getNowDateTimeInUserTimezone().db
                }));

            let insertedCount = 0;
            let updatedCount = 0;
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
                            sellerID: newAsins.map(i => i.SellerID),
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
            if (updates.length > 0) {
                const chunkSize = 50;
                for (let i = 0; i < updates.length; i += chunkSize) {
                    const chunk = updates.slice(i, i + chunkSize);
                    await Promise.all(
                        chunk.map(record => {
                            const payload = {
                                SellerName: record.SellerName,
                                MarketPlaceName: record.MarketPlaceName,
                                ItemName: record.ItemName,
                                SKU: record.SKU,
                                dtUpdatedOn: dates.getNowDateTimeInUserTimezone().db
                            };
                            return SellerAsinList.update(payload, {
                                where: {
                                    SellerID: parseInt(record.SellerID) || 0,
                                    ASIN: (record.ASIN || '').trim().toUpperCase(),
                                    AmazonSellerID: record.AmazonSellerID
                                }
                            })
                            .then(([affected]) => {
                                if (affected > 0) {
                                    updatedCount += affected;
                                }
                            })
                            .catch(updateError => {
                                logger.warn(
                                    {
                                        error: updateError.message,
                                        record
                                    },
                                    'ASIN update failed'
                                );
                            });
                        })
                    );
                }
            }

            const afterCount = await SellerAsinList.count({
                where: { 
                    SellerID: { [require('sequelize').Op.in]: newAsins.map(i => i.SellerID) }
                }
            });
    
            return { insertedCount, totalCount: afterCount, updatedCount, error: null };
    
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

