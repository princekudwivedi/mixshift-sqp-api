const { SuccessHandler, ErrorHandler } = require('../middleware/response.handlers');
const { ValidationHelpers } = require('../helpers/sqp.helpers');
const { loadDatabase } = require('../db/tenant.db');
const { getAllAgencyUserList } = require('../models/sequelize/user.model');
const { getModel: getSellerAsinList } = require('../models/sequelize/sellerAsinList.model');
const { getModel: getMwsItems } = require('../models/sequelize/mwsItems.model');
const AuthToken = require('../models/authToken.model');
const StsToken = require('../models/stsToken.model');
const sellerModel = require('../models/sequelize/seller.model');
const ctrl = require('./sqp.cron.controller');
const jsonProcessingService = require('../services/sqp.json.processing.service');
const model = require('../models/sqp.cron.model');
const logger = require('../utils/logger.utils');
const env = require('../config/env.config');
const isDevEnv = ["local", "development"].includes(env.NODE_ENV);
const allowedUsers = [8, 3];

/**
 * SQP Cron API Controller
 * Handles legacy cron endpoints with proper error handling and validation
 */
class SqpCronApiController {
    /**
     * Build authentication overrides for a seller
     */
    async buildAuthOverrides(amazonSellerID) {
        try {
            // Simple in-memory TTL cache for auth overrides
            if (!this._authCache) this._authCache = new Map();
            const ttlMs = Number(process.env.AUTH_CACHE_TTL_MS || 5 * 60 * 1000);
            const cacheKey = `auth:${amazonSellerID}`;
            const now = Date.now();
            const cached = this._authCache.get(cacheKey);
            if (cached && (now - cached.storedAt) < ttlMs) {
                return cached.value;
            }

            const authOverrides = {};
            const tokenRow = await AuthToken.getSavedToken(amazonSellerID);
            
            if (tokenRow && tokenRow.access_token) {
                authOverrides.accessToken = tokenRow.access_token;
                logger.info({ 
                    amazonSellerID, 
                    hasAccessToken: !!tokenRow.access_token,
                    tokenId: tokenRow.id,
                    expiresIn: tokenRow.expires_in
                }, 'Token details for seller');
            } else {
                logger.warn({ amazonSellerID }, 'No access token found for seller');
            }
            
            // Get AWS STS credentials for SigV4 signing
            const sts = await StsToken.getLatestTokenDetails();
            if (sts) {
                authOverrides.awsAccessKeyId = sts.accessKeyId;
                authOverrides.awsSecretAccessKey = sts.secretAccessKey;
                authOverrides.awsSessionToken = sts.SessionToken;
            }
            
            // Store in cache
            this._authCache.set(cacheKey, { value: authOverrides, storedAt: now });
            return authOverrides;
        } catch (error) {
            logger.error({ error: error.message, amazonSellerID }, 'Error building auth overrides');
            throw error;
        }
    }

    /**
     * Run all cron operations (request, status check, download)
     */
    async runAllCronOperations(req, res) {
        try {
            const { userId, sellerId } = req.query;
            
            // Validate inputs
            const validatedUserId = userId ? ValidationHelpers.validateUserId(userId) : null;
            const validatedSellerId = sellerId ? ValidationHelpers.validateUserId(sellerId) : null;

            logger.info({ 
                userId: validatedUserId, 
                sellerId: validatedSellerId,
                hasToken: !!req.authToken 
            }, 'Run all cron operations');

            await loadDatabase(0);
            const users = validatedUserId ? [{ ID: validatedUserId }] : await getAllAgencyUserList();
            
            // Check cron limit logic            
            let totalProcessed = 0;
            let totalErrors = 0;
            let breakUserProcessing = false;
            // Process one user → one seller per run, exit after completing that seller
            for (const user of users) {
                try {
                    await loadDatabase(user.ID);
                    if (isDevEnv && !allowedUsers.includes(user.ID)) {
                        continue;
                    }

                    // Check cron limits for this user
                    const cronLimits = await this.checkCronLimits(user.ID);
                    if (cronLimits.shouldProcess) {                        
                        const sellers = validatedSellerId
                            ? [await sellerModel.getProfileDetailsByID(validatedSellerId)]
                            : await sellerModel.getSellersProfilesForCronAdvanced({ pullAll: 0 });
                        
                        logger.info({ userId: user.ID, sellerCount: sellers.length }, 'Processing sellers for user');

                        // Check if user has eligible seller which has eligible ASINs before processing
                        const hasEligibleUser = await model.hasEligibleASINs(null, false);
                        if (!hasEligibleUser) {
                            logger.info({ 
                                sellerId: 'ALL Sellers Check', 
                                amazonSellerID: 'ALL Sellers Check',
                                userId: user.ID
                            }, 'Skipping Full Run - no eligible ASINs for all sellers');
                            continue;
                        }

                        for (const s of sellers) {
                            if (!s) continue;                        
                            try {
                                // Check if seller has eligible ASINs before processing
                                const hasEligible = await model.hasEligibleASINs(s.idSellerAccount);
                                if (!hasEligible) {
                                    logger.info({ 
                                        sellerId: s.idSellerAccount, 
                                        amazonSellerID: s.AmazonSellerID 
                                    }, 'Skipping seller - no eligible ASINs');
                                    breakUserProcessing = false;
                                    continue;
                                }
                                breakUserProcessing = true;
                                logger.info({ 
                                    sellerId: s.idSellerAccount, 
                                    amazonSellerID: s.AmazonSellerID 
                                }, 'Processing seller with eligible ASINs');
                                
                                const authOverrides = await this.buildAuthOverrides(s.AmazonSellerID);
                                
                                // Step 1: Request report and create cron detail
                                const cronDetailIDs = await ctrl.requestForSeller(s, authOverrides, env.GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT);
                                totalProcessed++;
                                
                                logger.info({ delay: process.env.INITIAL_DELAY_SECONDS * 1000 || 30000 }, 'Delaying');
                                // delay 30 seconds
                                await new Promise(resolve => setTimeout(resolve, process.env.INITIAL_DELAY_SECONDS * 1000 || 30000));

                                logger.info({ delay: process.env.INITIAL_DELAY_SECONDS * 1000 || 30000 }, 'Delay completed');

                                if (cronDetailIDs.length > 0) {                            
                                    // Step 2: Check status only for this cronDetailId
                                    try {
                                        await ctrl.checkReportStatuses(authOverrides, { cronDetailID: cronDetailIDs });
                                        totalProcessed++;
                                    } catch (error) {
                                        logger.error({ error: error.message, cronDetailID: cronDetailIDs }, 'Error checking report statuses (scoped)');
                                        totalErrors++;
                                    }

                                    // Step 3: Download only for this cronDetailId
                                    try {
                                        await ctrl.downloadCompletedReports(authOverrides, { cronDetailID: cronDetailIDs });
                                        totalProcessed++;
                                    } catch (error) {
                                        logger.error({ error: error.message, cronDetailID: cronDetailIDs }, 'Error downloading reports (scoped)');
                                        totalErrors++;
                                    }

                                    // Step 4: Process saved JSON only for this cronDetailId
                                    try {
                                        await jsonProcessingService.processSavedJsonFiles({ cronDetailID: cronDetailIDs });
                                        totalProcessed++;
                                    } catch (error) {
                                        logger.error({ error: error.message, cronDetailID: cronDetailIDs }, 'Error processing saved JSON files (scoped)');
                                        totalErrors++;
                                    }
                                }
                                
                                logger.info({ 
                                    sellerId: s.idSellerAccount, 
                                    amazonSellerID: s.AmazonSellerID,
                                    cronDetailIDs,
                                    processed: totalProcessed,
                                    errors: totalErrors
                                }, 'Completed processing for seller - exiting cron run');

                                break; // done after one seller
                                
                            } catch (error) {
                                logger.error({ 
                                    error: error.message, 
                                    sellerId: s.AmazonSellerID 
                                }, 'Error processing seller in all operations');
                                totalErrors++;
                                // Continue to next seller on error
                            }                        
                        }                    
                        if (breakUserProcessing) {
                            break;
                        }
                    }
                } catch (error) {
                    logger.error({ 
                        error: error.message, 
                        userId: user.ID 
                    }, 'Error processing user in all operations');
                    totalErrors++;
                }
            }
            return SuccessHandler.sendProcessingSuccess(
                res,
                totalProcessed,
                totalErrors,
                `All cron operations completed successfully`
            );

        } catch (error) {
            logger.error({ 
                error: error.message,
                stack: error.stack,
                query: req.query 
            }, 'Error in run all cron operations');
            
            return ErrorHandler.sendError(res, error, 'Failed to run all cron operations');
        }
    }

    /**
     * Sync ASINs from mws_items into seller_ASIN_list for a single seller
     * GET: /cron/sqp/syncSellerAsins/{userId}/{amazonSellerID}
     */
    async syncSellerAsins(req, res) {
        try {
            const { userId, amazonSellerID } = req.params;
            
            // Validate parameters
            const validatedUserId = ValidationHelpers.sanitizeNumber(userId);
            const validatedAmazonSellerID = ValidationHelpers.validateAmazonSellerId(amazonSellerID);

            if (!validatedUserId || validatedUserId <= 0 || !validatedAmazonSellerID) {
                return ErrorHandler.sendError(res, 'Invalid userId/AmazonSellerID', 400);
            }            
            // Load tenant database
            await loadDatabase(validatedUserId);
            // Use the helper function
            const result = await this._syncSellerAsinsInternal(validatedAmazonSellerID, 0, 'AmazonSellerID');

            if (result.error) {
                return ErrorHandler.sendError(res, result.error, 500);
            }

            // Get seller info for response
            // Use sellerModel directly for tenant-aware operations
            const seller = await sellerModel.getProfileDetailsByID(validatedAmazonSellerID, 'AmazonSellerID');

            const response = {
                success: true,
                seller: {
                    id: seller.idSellerAccount,
                    amazon_seller_id: seller.AmazonSellerID,
                    name: seller.SellerName
                },
                inserted_asins: result.insertedCount,
                total_seller_asins: result.totalCount,
                message: result.insertedCount > 0 
                    ? `Sync complete: ${result.insertedCount} new ASINs inserted, ${result.totalCount} total ASINs`
                    : `Sync complete: No new ASINs to insert, ${result.totalCount} total ASINs`
            };

            logger.info({
                userId: validatedUserId,
                sellerID: seller.idSellerAccount,
                insertedCount: result.insertedCount,
                totalCount: result.totalCount
            }, 'syncSellerAsins completed successfully');

            return SuccessHandler.sendSuccess(res, response);

        } catch (error) {
            logger.error({ error: error.message, userId: req.params.userId, amazonSellerID: req.params.amazonSellerID }, 'syncSellerAsins failed');
            return ErrorHandler.sendError(res, error, 'Internal server error', 500);
        }
    }

    /**
     * Sync ASINs for all sellers under a specific user
     * GET: /cron/sqp/cronSyncAllSellerAsins/{userId}
     */
    async cronSyncAllSellerAsins(req, res) {
        try {
            const { userId } = req.params;
            
            // Validate parameters
            const validatedUserId = ValidationHelpers.sanitizeNumber(userId);

            if (!validatedUserId || validatedUserId <= 0) {
                return ErrorHandler.sendError(res, 'Invalid userId', 400);
            }

            // Load tenant database
            await loadDatabase(validatedUserId);

            // Get all active sellers
            // Use sellerModel directly for tenant-aware operations
            const sellers = await sellerModel.getSellersProfilesForCronAdvanced({ pullAll: 0 });

            const results = [];
            let totalInserted = 0;
            let totalErrors = 0;

            for (const seller of sellers) {
                const sellerID = seller.idSellerAccount;

                // Use the helper function (set IsActive = 0 for cron sync)
                const result = await this._syncSellerAsinsInternal(sellerID);

                if (result.error) {
                    totalErrors++;
                    results.push({
                        seller_id: sellerID,
                        status: 'error',
                        error: result.error,
                        inserted_asins: 0,
                        total_seller_asins: 0
                    });
                } else {
                    totalInserted += result.insertedCount;
                    results.push({
                        seller_id: sellerID,
                        status: 'success',
                        inserted_asins: result.insertedCount,
                        total_seller_asins: result.totalCount
                    });
                }
            }

            const response = {
                success: true,
                userId: validatedUserId,
                sellers_processed: sellers.length,
                total_asins_inserted: totalInserted,
                total_errors: totalErrors,
                summary: results
            };

            logger.info({
                userId: validatedUserId,
                sellersProcessed: sellers.length,
                totalInserted,
                totalErrors
            }, 'cronSyncAllSellerAsins completed successfully');

            return SuccessHandler.sendSuccess(res, response);

        } catch (error) {
            logger.error({ error: error.message, userId: req.params.userId }, 'cronSyncAllSellerAsins failed');
            return ErrorHandler.sendError(res, error, 'Internal server error', 500);
        }
    }

    /**
     * Sync ASINs for all users (cron job)
     * GET: /cron/sqp/cronSyncAllUsersSellerAsins
     */
    async cronSyncAllUsersSellerAsins(req, res) {
        try {
            // Get all agency users
            const userList = await getAllAgencyUserList();
            const summary = [];
            if (userList && userList.length > 0) {
                for (const user of userList) {
                    const userId = user.ID;
                    if (isDevEnv && !allowedUsers.includes(userId)) {
                        continue;
                    } 
                    try {
                        // Execute per-tenant seller ASIN sync
                        const result = await this.cronSyncAllSellerAsins({ params: { userId } }, { 
                            json: (data) => {
                                // Capture the response data
                                return data;
                            },
                            status: () => ({
                                json: (data) => data
                            })
                        });

                        summary.push({
                            userId: userId,
                            agency: user.AgencyName || '',
                            cron: result
                        });

                    } catch (error) {
                        summary.push({
                            userId: userId,
                            agency: user.AgencyName || '',
                            cron: { success: false, error: error.message }
                        });
                    }
                }
            }

            const response = {
                success: true,
                users_processed: summary.length,
                summary: summary
            };

            logger.info({
                usersProcessed: summary.length
            }, 'cronSyncAllUsersSellerAsins completed successfully');

            return SuccessHandler.sendSuccess(res, response);

        } catch (error) {
            logger.error({ error: error.message }, 'cronSyncAllUsersSellerAsins failed');
            return ErrorHandler.sendError(res, 'Internal server error', 500);
        }
    }

    /**
     * Check cron limits and active sellers count
     * @param {number} userId 
     * @param {number} totalActiveCronSellers - Total active cron sellers across all users
     * @returns {Promise<{activeCronSellers: number, shouldProcess: boolean}>}
     */
    async checkCronLimits(userId) {
        try {
            const largeAgencyFlag = process.env.LARGE_AGENCY_FLAG === 'true';
            // Check active cron sellers for this user
            const activeCRONSellerAry = await model.checkCronDetailsOfSellersByDate(0, 0, true);            
            const activeCronSellers = activeCRONSellerAry.length;
            // Check max user count for cron
            const maxUserForCRON = largeAgencyFlag ? 100 : (process.env.MAX_USER_COUNT_FOR_CRON || 50);
            if (activeCronSellers >= maxUserForCRON) {
                logger.info({ 
                    userId, 
                    activeCronSellers,
                    maxUserForCRON,
                    largeAgencyFlag 
                }, 'Cron limit reached - skipping user');
                return { activeCronSellers, shouldProcess: false };
            }
            
            logger.info({ 
                userId, 
                activeCronSellers,
                maxUserForCRON,
                largeAgencyFlag 
            }, 'Cron limits check');

            return { 
                activeCronSellers, 
                shouldProcess: true 
            };
        } catch (error) {
            logger.error({ error: error.message, userId }, 'Error checking cron limits');
            return { activeCronSellers: 0, shouldProcess: false };
        }
    }

    /**
     * Private helper function to sync ASINs for a seller from mws_items (reusable)
     * @param {number} sellerID
     * @param {number} isActive Default ASIN status (1=Active, 0=Inactive)
     * @returns {Promise<{insertedCount: number, totalCount: number, error: string|null}>}
     */
    async _syncSellerAsinsInternal(sellerIdentifier, isActive = 0, key = 'ID') {
        try {
            // Get models
            // Use sellerModel directly for tenant-aware operations
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
                logger.error({ sellerID, seller }, 'Seller AmazonSellerID is missing');
                return { insertedCount: 0, totalCount: 0, error: 'Seller AmazonSellerID is missing' };
            }

            logger.info({ sellerID: seller.idSellerAccount, amazonSellerID: seller.AmazonSellerID }, 'Seller validation passed');

            // Count existing ASINs before sync
            const beforeCount = await SellerAsinList.count({
                where: { SellerID: seller.idSellerAccount }
            });
            // Get ASINs from mws_items that don't exist in seller_ASIN_list
            const existingAsins = await SellerAsinList.findAll({
                where: { SellerID: seller.idSellerAccount },
                attributes: ['ASIN']
            });

            const existingAsinSet = new Set(existingAsins.map(item => item.ASIN.toUpperCase()));
            
            logger.info({ 
                sellerID: seller.idSellerAccount, 
                beforeCount, 
                existingAsinsCount: existingAsins.length,
                existingAsinsSample: existingAsins.slice(0, 5).map(item => item.ASIN)
            }, 'Existing ASINs check completed');

            // Get new ASINs from mws_items
            logger.info({ sellerID: seller.idSellerAccount, amazonSellerID: seller.AmazonSellerID }, 'Fetching ASINs from mws_items');
            const newAsins = await MwsItems.findAll({
                where: {
                    AmazonSellerID: seller.AmazonSellerID,
                    ASIN: {
                        [require('sequelize').Op.ne]: null,
                        [require('sequelize').Op.ne]: ''
                    }
                },
                attributes: ['ASIN'],
                raw: true,
                group: ['ASIN']
            });
            logger.info({ sellerID: seller.idSellerAccount, amazonSellerID: seller.AmazonSellerID, newAsinsCount: newAsins.length }, 'Retrieved ASINs from mws_items');

            // Filter out existing ASINs and prepare for bulk insert
            const asinsToInsert = newAsins
                .filter(item => {
                    const asin = item.ASIN ? item.ASIN.trim().toUpperCase() : '';
                    return asin && asin.length > 0 && asin.length <= 20 && !existingAsinSet.has(asin);
                })
                .map(item => {
                    const asin = item.ASIN.trim().toUpperCase();
                    return {
                        SellerID: seller.idSellerAccount,
                        AmazonSellerID: seller.AmazonSellerID,
                        ASIN: asin,
                        IsActive: isActive,
                        dtCreatedOn: new Date()
                    };
                });

            logger.info({ 
                sellerID: seller.idSellerAccount, 
                totalNewAsins: newAsins.length, 
                existingAsins: existingAsinSet.size,
                asinsToInsert: asinsToInsert.length 
            }, 'Data preparation completed');

            // Bulk insert new ASINs with chunks
            let insertedCount = 0;
            if (asinsToInsert.length > 0) {
                const chunkSize = 50; // Process 50 records at a time
                const chunks = [];
                
                // Split into chunks
                for (let i = 0; i < asinsToInsert.length; i += chunkSize) {
                    chunks.push(asinsToInsert.slice(i, i + chunkSize));
                }
                
                logger.info({ 
                    sellerID: seller.idSellerAccount, 
                    totalRecords: asinsToInsert.length, 
                    chunkSize, 
                    totalChunks: chunks.length 
                }, 'Starting chunked bulk insert');
                
                // Process each chunk
                for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
                    const chunk = chunks[chunkIndex];
                    
                    try {
                        // Try bulk insert for this chunk
                        await SellerAsinList.bulkCreate(chunk, {
                            ignoreDuplicates: true, // Ignore duplicate key errors
                            validate: true
                        });
                        insertedCount += chunk.length;
                        logger.info({ 
                            sellerID: seller.idSellerAccount, 
                            chunkIndex: chunkIndex + 1, 
                            chunkSize: chunk.length,
                            totalInserted: insertedCount 
                        }, 'Chunk inserted successfully');
                        
                    } catch (chunkError) {
                        logger.error({
                            error: chunkError.message,
                            sellerID: seller.idSellerAccount,
                            chunkIndex: chunkIndex + 1,
                            chunkSize: chunk.length,
                            chunkSample: chunk.slice(0, 2)
                        }, 'Chunk insert failed, trying individual inserts for this chunk');
                        
                        // If chunk fails, try individual inserts for this chunk
                        for (let i = 0; i < chunk.length; i++) {
                            try {
                                await SellerAsinList.create(chunk[i], {
                                    ignoreDuplicates: true
                                });
                                insertedCount++;
                            } catch (individualError) {
                                // Log but continue - likely duplicate key error
                                logger.warn({
                                    error: individualError.message,
                                    record: chunk[i],
                                    sellerID: seller.idSellerAccount
                                }, 'Individual insert skipped (likely duplicate)');
                            }
                        }
                    }
                }
            }

            // Count total ASINs after sync
            const afterCount = await SellerAsinList.count({
                where: { SellerID: seller.idSellerAccount }
            });

            return { insertedCount, totalCount: afterCount, error: null };

        } catch (error) {
            logger.error({
                error: error.message,
                stack: error.stack,
                sellerIdentifier,
                isActive: isActive
            }, 'syncSellerAsinsInternal failed');
            return { insertedCount: 0, totalCount: 0, error: `Database error: ${error.message}` };
        }
    }
}

module.exports = new SqpCronApiController();