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
const model = require('../models/sqp.cron.model');
const { getModel: getSqpCronDetails } = require('../models/sequelize/sqpCronDetails.model');
const { getModel: getSqpCronLogs } = require('../models/sequelize/sqpCronLogs.model');
const { Op } = require('sequelize');
const logger = require('../utils/logger.utils');
const env = require('../config/env.config');
const isDevEnv = ["local", "development"].includes(env.NODE_ENV);
const allowedUsers = [8, 3];
const { DelayHelpers } = require('../helpers/sqp.helpers');
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
            // if (!this._authCache) this._authCache = new Map();
            // const ttlMs = Number(process.env.AUTH_CACHE_TTL_MS || 5 * 60 * 1000);
            // const cacheKey = `auth:${amazonSellerID}`;
            // const now = Date.now();
            // const cached = this._authCache.get(cacheKey);
            // if (cached && (now - cached.storedAt) < ttlMs) {
            //     return cached.value;
            // }

            const authOverrides = {};
            const tokenRow = await AuthToken.getSavedToken(amazonSellerID);
            
            if (tokenRow && tokenRow.access_token) {
                authOverrides.accessToken = tokenRow.access_token;
                logger.info({ 
                    amazonSellerID, 
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
            //this._authCache.set(cacheKey, { value: authOverrides, storedAt: now });
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
                console.log('user.ID', user.ID);                    
                if (isDevEnv && !allowedUsers.includes(user.ID)) {
                    logger.info({ userId: user.ID }, 'Skip user as it is not allowed');
                    continue;
                } else {
                    logger.info({ userId: user.ID }, 'Process user started');
                    console.log(`🔄 Switching to database for user ${user.ID}...`);
                    await loadDatabase(user.ID);
                    console.log(`✅ Database switched for user ${user.ID}`);
                    // Check cron limits for this user
                    const cronLimits = await this.checkCronLimits(user.ID);
                    console.log('cronLimits', cronLimits);
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

                                if (cronDetailIDs.length > 0) {
                                    await DelayHelpers.wait(Number(process.env.INITIAL_DELAY_SECONDS) || 30, 'Before status check');
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
                                }
                                
                                logger.info({ 
                                    sellerId: s.idSellerAccount, 
                                    amazonSellerID: s.AmazonSellerID,
                                    cronDetailIDs,
                                    processed: totalProcessed,
                                    errors: totalErrors
                                }, 'Completed processing for seller - exiting cron run');
                                
                            } catch (error) {
                                logger.error({ 
                                    error: error.message, 
                                    sellerId: s.AmazonSellerID 
                                }, 'Error processing seller in all operations');
                                totalErrors++;
                                // Continue to next seller on error
                            }
                            break; // done after one seller
                        }                    
                        if (breakUserProcessing) {
                            break;
                        }
                    }
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

    /**
     * retry notifications for stuck records
     */
    async retryNotifications(req, res) {
        try {
            const { userId } = req.query;
            
            // Validate inputs
            const validatedUserId = userId ? ValidationHelpers.validateUserId(userId) : null;

            logger.info({ 
                userId: validatedUserId,
                hasToken: !!req.authToken 
            }, 'Starting notification retry scan');

            await loadDatabase(0);
            const users = validatedUserId ? [{ ID: validatedUserId }] : await getAllAgencyUserList();
            
            let totalRetryNotifications = 0;
            let totalErrors = 0;
            const allResults = [];
            
            // Process each user
            for (const user of users) {
                try {
                    if (isDevEnv && !allowedUsers.includes(user.ID)) {
                        continue;
                    }
                    await loadDatabase(user.ID);
                    //stuck in progress/pending status for 8-9 hours
                    const stuckRecords = await this.findStuckRecords();                    
                    if (stuckRecords.length === 0) {
                        logger.info({ userId: user.ID }, 'No stuck records found for user');
                        continue;
                    }
                    
                    logger.warn({ 
                        userId: user.ID,
                        stuckRecordsCount: stuckRecords.length,
                        records: stuckRecords.map(r => ({
                            id: r.ID,
                            amazonSellerID: r.AmazonSellerID,
                            stuckForHours: r.stuckForHours,
                            reportTypes: r.stuckReportTypes
                        }))
                    }, 'Found stuck records that need notification retry');
                    // Retry each stuck record's report types before deciding final status
                    const retryResults = [];
                    for (const rec of stuckRecords) {
                        const authOverrides = await this.buildAuthOverrides(rec.AmazonSellerID);
                        for (const type of rec.stuckReportTypes) {
                            try {                                
                                const rr = await this.retryStuckRecord(rec, type, authOverrides);
                                retryResults.push(rr);
                            } catch (e) {
                                retryResults.push({
                                    cronDetailID: rec.ID,
                                    amazonSellerID: rec.AmazonSellerID,
                                    reportType: type,
                                    retried: true,
                                    success: false,
                                    error: e.message
                                });
                            }
                        }
                    }
                    allResults.push(...retryResults);                    
                    logger.info({
                        userId: user.ID,
                        totalStuckRecords: stuckRecords.length,
                        retryNotificationsCount: retryResults.length
                    }, 'Notification retry completed for user');
                    
                } catch (error) {
                    logger.error({ 
                        error: error.message,
                        userId: user.ID 
                    }, 'Error processing user in notification retry');
                    totalErrors++;
                }
            }
            
            if (totalRetryNotifications === 0) {
                logger.info('No stuck records found across all users');
                return SuccessHandler.sendSuccess(res, {
                    message: 'No stuck records found',
                    suppressedCount: 0,
                    records: []
                });
            }
            
            logger.info({
                totalRetryNotifications: allResults.length,
                totalErrors,
                results: allResults
            }, 'Notification retry completed');
            
            return SuccessHandler.sendSuccess(res, {
                message: `Retry notifications for ${totalRetryNotifications} stuck records`,
                retryNotificationsCount: allResults.length,
                records: allResults
            });
            
        } catch (error) {
            logger.error({ 
                error: error.message,
                stack: error.stack 
            }, 'Error in notification suppression scan');
            
            return ErrorHandler.sendError(res, error, 'Failed to suppress notifications');
        }
    }

    async findStuckRecords() {
        const SqpCronDetails = getSqpCronDetails();
        
        // Calculate time (8.5 hours ago)
        const cutoffTime = new Date();
        cutoffTime.setHours(cutoffTime.getHours() - 8.5);
        
        logger.info({ cutoffTime: cutoffTime.toISOString() }, 'Scanning for records stuck since cutoff time');
        
        // Find records that are stuck in progress or pending status
        const stuckRecords = await SqpCronDetails.findAll({
            where: {
                [Op.or]: [                    
                    {
                        [Op.and]: [
                            { WeeklyProcessRunningStatus: { [Op.in]: [1, 2, 3] } },
                            { WeeklySQPDataPullStatus: { [Op.in]: [0, 2 ] } },
                            { dtUpdatedOn: { [Op.lte]: cutoffTime } }
                        ]
                    },
                    {
                        [Op.and]: [
                            { MonthlyProcessRunningStatus: { [Op.in]: [1, 2, 3] } },
                            { MonthlySQPDataPullStatus: { [Op.in]: [0, 2] } },
                            { dtUpdatedOn: { [Op.lte]: cutoffTime } }
                        ]
                    },
                    {
                        [Op.and]: [
                            { QuarterlyProcessRunningStatus: { [Op.in]: [1, 2, 3] } },
                            { QuarterlySQPDataPullStatus: { [Op.in]: [0, 2] } },
                            { dtUpdatedOn: { [Op.lte]: cutoffTime } }
                        ]
                    }
                ]
            },
            attributes: [
                'ID', 'AmazonSellerID', 'dtCreatedOn', 'dtUpdatedOn',
                'WeeklyProcessRunningStatus', 'WeeklySQPDataPullStatus',
                'MonthlyProcessRunningStatus', 'MonthlySQPDataPullStatus',
                'QuarterlyProcessRunningStatus', 'QuarterlySQPDataPullStatus'
            ]
        });
        
        // Enrich records with additional information
        const enrichedRecords = await Promise.all(
            stuckRecords.map(async (record) => {
                const stuckReportTypes = [];
                const stuckForHours = Math.round((Date.now() - new Date(record.dtUpdatedOn).getTime()) / (1000 * 60 * 60) * 10) / 10;
                
                // Check which report types are stuck
                if (this.isReportTypeStuck(record.WeeklyProcessRunningStatus, record.WeeklySQPDataPullStatus)) {
                    stuckReportTypes.push('WEEK');
                }
                if (this.isReportTypeStuck(record.MonthlyProcessRunningStatus, record.MonthlySQPDataPullStatus)) {
                    stuckReportTypes.push('MONTH');
                }
                if (this.isReportTypeStuck(record.QuarterlyProcessRunningStatus, record.QuarterlySQPDataPullStatus)) {
                    stuckReportTypes.push('QUARTER');
                }
                
                return {
                    ...record.toJSON(),
                    stuckReportTypes,
                    stuckForHours
                };
            })
        );
        
        // Filter out records that don't have any stuck report types
        return enrichedRecords.filter(record => record.stuckReportTypes.length > 0);
    }

    isReportTypeStuck(processStatus, dataPullStatus) {
        return (
            (processStatus === 1 || processStatus === 2 || processStatus === 3 || processStatus === 4) &&
            (dataPullStatus === 0 || dataPullStatus === 2)
        );
    }
    
    async retryNotificationsForRecords(stuckRecords) {
        const retryResults = [];
        
        for (const record of stuckRecords) {
            try {
                // Mark each stuck report type as having retry notifications
                for (const reportType of record.stuckReportTypes) {
                    retryResults.push({
                        cronDetailID: record.ID,
                        amazonSellerID: record.AmazonSellerID,
                        reportType,
                        stuckForHours: record.stuckForHours,
                        retryAt: new Date().toISOString()
                    });
                }
                
                logger.warn({
                    cronDetailID: record.ID,
                    amazonSellerID: record.AmazonSellerID,
                    stuckReportTypes: record.stuckReportTypes,
                    stuckForHours: record.stuckForHours
                }, 'Retry notifications for stuck record');
                
            } catch (error) {
                logger.error({
                    error: error.message,
                    cronDetailID: record.ID,
                    amazonSellerID: record.AmazonSellerID,
                    stuckReportTypes: record.stuckReportTypes
                }, 'Failed to retry notifications for record');
                
                retryResults.push({
                    cronDetailID: record.ID,
                    amazonSellerID: record.AmazonSellerID,
                    reportType: 'ALL',
                    error: error.message,
                    retryAt: null
                });
            }
        }
        
        return retryResults;
    }

    /**
     * Retry a stuck record's pipeline for a specific report type, then finalize status.
     */
    async retryStuckRecord(record, reportType, authOverrides) {        
        let res = null;
        try {
            res =await ctrl.checkReportStatuses(authOverrides, { cronDetailID: [record.ID], reportType: reportType }, true );            
        } catch (e) {
            logger.error({ id: record.ID, reportType, error: e.message }, 'Retry status check failed');
        }        
        if(res && res[0] && res[0].success) {
            try {
                await ctrl.downloadCompletedReports(authOverrides, { cronDetailID: [record.ID], reportType: reportType }, true);
            } catch (e) {
                logger.error({ id: record.ID, reportType, error: e.message }, 'Retry download failed');
            }
        }
        
        // Re-fetch status and finalize
        const SqpCronDetails = getSqpCronDetails();
        const refreshed = await SqpCronDetails.findOne({
            where: { ID: record.ID },
            attributes: [
                'WeeklySQPDataPullStatus','MonthlySQPDataPullStatus','QuarterlySQPDataPullStatus',
                'WeeklyProcessRunningStatus','MonthlyProcessRunningStatus','QuarterlyProcessRunningStatus',
                'dtUpdatedOn'
            ]
        });
        const prefix = model.mapPrefix(reportType);
        const statusField = `${prefix}SQPDataPullStatus`;
        const current = refreshed ? refreshed[statusField] : null;

        if (current === 1) {
            logger.info({ id: record.ID, reportType }, 'Retry succeeded - marked as success');
            return { cronDetailID: record.ID, amazonSellerID: record.AmazonSellerID, reportType, retried: true, success: true };
        }

        // Get the actual retry count for notification
        const actualRetryCount = await model.getRetryCount(record.ID, reportType);
        await model.logCronActivity({ 
            cronJobID: record.ID, 
            reportType, 
            action: 'Check Status', 
            status: 2, 
            message: `Report ${statusField} on attempt ${actualRetryCount + 1}`, 
            reportID: current === 2 ? await model.getLatestReportId(record.ID, reportType) : null, 
            retryCount: actualRetryCount,  // Fix: Use actual retry count instead of null
            executionTime: (Date.now() - new Date(record.dtCreatedOn).getTime()) / 1000 
        });        

        // Mark failed if still not success
        const latestReportId = await model.getLatestReportId(record.ID, reportType);
        await model.updateSQPReportStatus(record.ID, reportType, 3, latestReportId, 'Retry after 8h failed');
        await model.logCronActivity({
            cronJobID: record.ID,
            reportType,
            action: 'Retry Finalize',
            status: 2,
            message: 'Marked as failed after retry of stuck record',
            reportID: latestReportId,
            retryCount: actualRetryCount  // Fix: Use actual retry count instead of null
        });
        
        // Only send notification if retry count has reached maximum (3)
        if (actualRetryCount >= 3) {
            await ctrl.sendFailureNotification(record.ID, record.AmazonSellerID, reportType, 'Retry after 8h failed', actualRetryCount, latestReportId);
        }
        
        logger.warn({ id: record.ID, reportType }, 'Retry failed - marked as failure');
        return { cronDetailID: record.ID, amazonSellerID: record.AmazonSellerID, reportType, retried: true, success: false };
    }
}

module.exports = new SqpCronApiController();