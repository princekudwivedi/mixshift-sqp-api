const { SuccessHandler, ErrorHandler } = require('../middleware/response.handlers');
const { ValidationHelpers } = require('../helpers/sqp.helpers');
const { loadDatabase } = require('../db/tenant.db');
const master = require('../models/sequelize/user.model');
const AuthToken = require('../models/authToken.model');
const StsToken = require('../models/stsToken.model');
const sellerModel = require('../models/sequelize/seller.model');
const ctrl = require('./sqp.cron.controller');
const jsonProcessingService = require('../services/sqp.json.processing.service');
const sqpfileProcessingService = require('../services/sqp.file.processing.service');
const logger = require('../utils/logger.utils');

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
            const users = validatedUserId ? [{ ID: validatedUserId }] : await master.getAllAgencyUserList();
            
            let totalProcessed = 0;
            let totalErrors = 0;

            for (const user of users) {                 
                try {
                    await loadDatabase(user.ID);
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
            const users = validatedUserId ? [{ ID: validatedUserId }] : await master.getAllAgencyUserList();
            
            let totalProcessed = 0;
            let totalErrors = 0;
            
            for (const user of users) {     
                try {
                    await loadDatabase(user.ID);
                    
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
            const users = validatedUserId ? [{ ID: validatedUserId }] : await master.getAllAgencyUserList();
            let totalProcessed = 0;
            let totalErrors = 0;
            
            for (const user of users) {           
                try {
                    await loadDatabase(user.ID);
                    
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
            const users = validatedUserId ? [{ ID: validatedUserId }] : await master.getAllAgencyUserList();
            
            let totalProcessed = 0;
            let totalErrors = 0;

            // Step 1: Request reports
            for (const user of users) {
                try {
                    await loadDatabase(user.ID);
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
            const users = validatedUserId ? [{ ID: validatedUserId }] : await master.getAllAgencyUserList();
            
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
            const users = validatedUserId ? [{ ID: validatedUserId }] : await master.getAllAgencyUserList();
            
            let totalProcessed = 0;
            let totalCopied = 0;
            let totalErrors = 0;
            
            for (const user of users) {
                try {
                    await loadDatabase(user.ID);
                    
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
     * Get processing statistics (legacy endpoint)
     */
    async getProcessingStats(req, res) {
        try {
            const { userId } = req.query;
            
            // Validate inputs
            const validatedUserId = userId ? ValidationHelpers.validateUserId(userId) : null;

            logger.info({ 
                userId: validatedUserId,
                hasToken: !!req.authToken 
            }, 'Get processing stats (legacy)');

            await loadDatabase(0);
            const users = validatedUserId ? [{ ID: validatedUserId }] : await master.getAllAgencyUserList();
            
            const stats = await jsonProcessingService.getProcessingStats();
            
            return SuccessHandler.sendStatsSuccess(res, stats, 'Statistics retrieved successfully');

        } catch (error) {
            logger.error({ 
                error: error.message,
                stack: error.stack,
                query: req.query 
            }, 'Error in get processing stats');
            
            return ErrorHandler.sendError(res, error, 'Failed to retrieve statistics');
        }
    }
}

module.exports = new SqpCronApiController();
