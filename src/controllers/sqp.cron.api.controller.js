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
const sqpfileProcessingService = require('../services/sqp.file.processing.service');
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
     * Request reports for sellers
     */
    async requestReports(req, res) {
        try {
            const { userId, sellerId } = req.query;
            
            // Validate inputs
            const validatedUserId = userId ? ValidationHelpers.validateUserId(userId) : null;
            const validatedSellerId = sellerId ? ValidationHelpers.validateUserId(sellerId) : null;

            logger.info({ 
                userId: validatedUserId, 
                sellerId: validatedSellerId,
                hasToken: !!req.authToken 
            }, 'Request reports for sellers');

            await loadDatabase(0);
            // Cache user list to avoid repeated master queries in high-frequency runs
            if (!this._userListCache) this._userListCache = { data: null, at: 0 };
            const userTtl = Number(process.env.USER_LIST_CACHE_TTL_MS || 60 * 1000);
            const useCache = !validatedUserId && (Date.now() - this._userListCache.at) < userTtl;
            const users = validatedUserId ? [{ ID: validatedUserId }] : (useCache && this._userListCache.data) || await getAllAgencyUserList();
            if (!validatedUserId && !useCache) this._userListCache = { data: users, at: Date.now() };
            let totalProcessed = 0;
            let totalErrors = 0;

            for (const user of users) {                 
                try {
                    await loadDatabase(user.ID);
                    if (isDevEnv && !allowedUsers.includes(user.ID)) {
                        continue;
                    }
                    const sellers = validatedSellerId
                        ? await sellerModel.getSellersProfilesForCronAdvanced({ idSellerAccount: validatedSellerId, pullAll: 1 })
                        : await sellerModel.getSellersProfilesForCronAdvanced({ pullAll: 0 });
                    for (const s of sellers) {         
                        if (!s) continue;
                        try {
                            const authOverrides = await this.buildAuthOverrides(s.AmazonSellerID);
                            await ctrl.requestForSeller(s, authOverrides);
                            totalProcessed++;
                        } catch (error) {
                            logger.error({ 
                                error: error.message, 
                                sellerId: s.AmazonSellerID 
                            }, 'Error requesting report for seller');
                            
                            // Log error to cron logs for this seller
                            try {
                                await ctrl.logCronActivity({
                                    cronJobID: 0, // Use 0 for API-level errors
                                    amazonSellerID: s.AmazonSellerID,
                                    reportType: 'ALL',
                                    action: 'Request Report',
                                    status: 2, // Error status
                                    message: `API Error: ${error.message}`,
                                    retryCount: 0
                                });
                            } catch (logError) {
                                logger.error({ logError: logError.message }, 'Failed to log cron activity');
                            }
                            
                            totalErrors++;
                        }
                    }
                } catch (error) {
                    logger.error({ 
                        error: error.message, 
                        userId: user.ID 
                    }, 'Error processing user');
                    totalErrors++;
                }
            }
			if (totalErrors > 0) {
				return ErrorHandler.sendProcessingError(
					res,
					new Error('One or more report requests failed'),
					totalProcessed,
					totalErrors,
					'Report requests failed'
				);
			}
			return SuccessHandler.sendProcessingSuccess(
				res, 
				totalProcessed, 
				totalErrors, 
				'Report requests processed successfully'
			);

        } catch (error) {
            logger.error({ 
                error: error.message,
                stack: error.stack,
                query: req.query 
            }, 'Error in request reports');
            
            return ErrorHandler.sendError(res, error, 'Failed to request reports');
        }
    }

    /**
     * Check report statuses
     */
    async checkReportStatuses(req, res) {
        try {
            const { userId } = req.query;
            
            // Validate inputs
            const validatedUserId = userId ? ValidationHelpers.validateUserId(userId) : null;

            logger.info({ 
                userId: validatedUserId,
                hasToken: !!req.authToken 
            }, 'Check report statuses');

            await loadDatabase(0);
            const users = validatedUserId ? [{ ID: validatedUserId }] : await getAllAgencyUserList();
            
            let totalProcessed = 0;
            let totalErrors = 0;
            
            for (const user of users) {     
                try {
                    await loadDatabase(user.ID);
                    if (isDevEnv && !allowedUsers.includes(user.ID)) {
                        continue;
                    }
                    const sts = await StsToken.getLatestTokenDetails();
                    const authOverrides = sts ? {
                        awsAccessKeyId: sts.accessKeyId,
                        awsSecretAccessKey: sts.secretAccessKey,
                        awsSessionToken: sts.SessionToken,
                    } : {};
                    
                    await ctrl.checkReportStatuses(authOverrides);
                    totalProcessed++;
                } catch (error) {
                    logger.error({ 
                        error: error.message, 
                        userId: user.ID 
                    }, 'Error checking report statuses for user');
                    totalErrors++;
                }
            }

            return SuccessHandler.sendProcessingSuccess(
                res, 
                totalProcessed, 
                totalErrors, 
                'Report status checks completed successfully'
            );

        } catch (error) {
            logger.error({ 
                error: error.message,
                stack: error.stack,
                query: req.query 
            }, 'Error in check report statuses');
            
            return ErrorHandler.sendError(res, error, 'Failed to check report statuses');
        }
    }

    /**
     * Download completed reports
     */
    async downloadCompletedReports(req, res) {
        try {
            const { userId } = req.query;
            
            // Validate inputs
            const validatedUserId = userId ? ValidationHelpers.validateUserId(userId) : null;

            logger.info({ 
                userId: validatedUserId,
                hasToken: !!req.authToken 
            }, 'Download completed reports');

            await loadDatabase(0);
            const users = validatedUserId ? [{ ID: validatedUserId }] : await getAllAgencyUserList();
            let totalProcessed = 0;
            let totalErrors = 0;
            
            for (const user of users) {           
                try {
                    await loadDatabase(user.ID);
                    if (isDevEnv && !allowedUsers.includes(user.ID)) {
                        continue;
                    }
                    const sts = await StsToken.getLatestTokenDetails();
                    const authOverrides = sts ? {
                        awsAccessKeyId: sts.accessKeyId,
                        awsSecretAccessKey: sts.secretAccessKey,
                        awsSessionToken: sts.SessionToken,
                    } : {};
                    
                    await ctrl.downloadCompletedReports(authOverrides);
                    totalProcessed++;
                } catch (error) {
                    logger.error({ 
                        error: error.message, 
                        userId: user.ID 
                    }, 'Error downloading reports for user');
                    totalErrors++;
                }
            }

			if (totalErrors > 0) {
				return ErrorHandler.sendProcessingError(
					res,
					new Error('One or more report downloads failed'),
					totalProcessed,
					totalErrors,
					'Report downloads failed'
				);
			}
			return SuccessHandler.sendProcessingSuccess(
				res, 
				totalProcessed, 
				totalErrors, 
				'Report downloads completed successfully'
			);

        } catch (error) {
            logger.error({ 
                error: error.message,
                stack: error.stack,
                query: req.query 
            }, 'Error in download completed reports');
            
            return ErrorHandler.sendError(res, error, 'Failed to download completed reports');
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
            
            let totalProcessed = 0;
            let totalErrors = 0;

            // Step 1: Request reports
            for (const user of users) {
                try {
                    await loadDatabase(user.ID);
                    if (isDevEnv && !allowedUsers.includes(user.ID)) {
                        continue;
                    }
                    const sellers = validatedSellerId
                        ? [await sellerModel.getProfileDetailsByID(validatedSellerId)]
                        : await sellerModel.getSellersProfilesForCronAdvanced({ pullAll: 0 });
                    
                    for (const s of sellers) {
                        if (!s) continue;
                        try {
                            const authOverrides = await this.buildAuthOverrides(s.AmazonSellerID);
                            await ctrl.requestForSeller(s, authOverrides);
                            totalProcessed++;
                        } catch (error) {
                            logger.error({ 
                                error: error.message, 
                                sellerId: s.AmazonSellerID 
                            }, 'Error requesting report for seller in all operations');
                            totalErrors++;
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

            // Step 2: Check report statuses
            try {
                const authOverrides = {};
                await ctrl.checkReportStatuses(authOverrides);
                totalProcessed++;
            } catch (error) {
                logger.error({ 
                    error: error.message 
                }, 'Error checking report statuses in all operations');
                totalErrors++;
            }

            // Step 3: Download completed reports
            try {
                const authOverrides = {};
                await ctrl.downloadCompletedReports(authOverrides);
                totalProcessed++;
            } catch (error) {
                logger.error({ 
                    error: error.message 
                }, 'Error downloading reports in all operations');
                totalErrors++;
            }

            return SuccessHandler.sendProcessingSuccess(
                res, 
                totalProcessed, 
                totalErrors, 
                'All cron operations completed successfully'
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
     * Process JSON files (legacy endpoint)
     */
    async processJsonFiles(req, res) {
        try {
            const { userId } = req.query;
            
            // Validate inputs
            const validatedUserId = userId ? ValidationHelpers.validateUserId(userId) : null;

            logger.info({ 
                userId: validatedUserId,
                hasToken: !!req.authToken 
            }, 'Process JSON files (legacy)');

            await loadDatabase(0);
            const users = validatedUserId ? [{ ID: validatedUserId }] : await getAllAgencyUserList();
            
            let totalProcessed = 0;
            let totalErrors = 0;
            
            for (const user of users) {
                try {
                    await loadDatabase(user.ID);
                    const result = await jsonProcessingService.processSavedJsonFiles();
                    if (!result) {
                        logger.error({ userId: user.ID }, 'processSavedJsonFiles returned no result');
                        totalErrors += 1;
                        continue;
                    }
                    totalProcessed += (typeof result.processed === 'number' ? result.processed : 0);
                    totalErrors += (typeof result.errors === 'number' ? result.errors : 0);
                } catch (error) {
                    logger.error({ 
                        error: error.message, 
                        userId: user.ID 
                    }, 'Error processing JSON files for user');
                    totalErrors++;
                }
            }
            
            if (totalErrors > 0) {
                return ErrorHandler.sendProcessingError(
                    res,
                    new Error('One or more JSON files failed to process'),
                    totalProcessed,
                    totalErrors,
                    'JSON file processing failed'
                );
            }

            return SuccessHandler.sendProcessingSuccess(
                res, 
                totalProcessed, 
                totalErrors, 
                'JSON files processed successfully'
            );

        } catch (error) {
            logger.error({ 
                error: error.message,
                stack: error.stack,
                query: req.query 
            }, 'Error in process JSON files');
            
            return ErrorHandler.sendProcessingError(
                res, 
                error, 
                0, 
                0, 
                'Failed to process JSON files'
            );
        }
    }    
    /**
     * Copy metrics data from sqp_metrics_3mo to sqp_metrics with bulk insert
     */
    async copyMetricsData(req, res) {
        try {
            const { userId, batchSize, force, dryRun } = req.query;
            
            // Validate inputs
            const validatedUserId = userId ? ValidationHelpers.validateUserId(userId) : null;
            const validatedBatchSize = batchSize ? parseInt(batchSize) || 1000 : 1000;
            const validatedForce = force === 'true' || force === '1';
            const validatedDryRun = dryRun === 'true' || dryRun === '1';

            logger.info({ 
                userId: validatedUserId,
                batchSize: validatedBatchSize,
                force: validatedForce,
                dryRun: validatedDryRun,
                hasToken: !!req.authToken 
            }, 'Copy metrics data from 3mo to main table');

            await loadDatabase(0);
            const users = validatedUserId ? [{ ID: validatedUserId }] : await getAllAgencyUserList();
            
            let totalProcessed = 0;
            let totalCopied = 0;
            let totalErrors = 0;
            
            for (const user of users) {
                try {
                    await loadDatabase(user.ID);
                    if (isDevEnv && !allowedUsers.includes(user.ID)) {
                        continue;
                    }
                    const options = {
                        batchSize: validatedBatchSize,
                        force: validatedForce,
                        dryRun: validatedDryRun
                    };
                    
                    const result = await sqpfileProcessingService.copyDataWithBulkInsert(options);
                    
                    if (result) {
                        totalProcessed += result.processed || 0;
                        totalCopied += result.copied || 0;
                        totalErrors += result.errors || 0;
                    }
                    
                } catch (error) {
                    logger.error({ 
                        error: error.message, 
                        userId: user.ID 
                    }, 'Error copying metrics data for user');
                    totalErrors++;
                }
            }
            
            if (totalErrors > 0) {
                return ErrorHandler.sendProcessingError(
                    res,
                    new Error('One or more metrics copy operations failed'),
                    totalProcessed,
                    totalErrors,
                    'Metrics data copy failed'
                );
            }

            return SuccessHandler.sendProcessingSuccess(
                res, 
                totalProcessed, 
                totalErrors, 
                `Metrics data copy completed successfully. Copied ${totalCopied} records.`
            );

        } catch (error) {
            logger.error({ 
                error: error.message,
                stack: error.stack,
                query: req.query 
            }, 'Error in copy metrics data');
            
            return ErrorHandler.sendError(res, error, 'Failed to copy metrics data');
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