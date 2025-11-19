const { SuccessHandler, ErrorHandler } = require('../middleware/response.handlers');
const { ValidationHelpers, CircuitBreaker, RateLimiter, MemoryMonitor, RetryHelpers, Helpers,DelayHelpers } = require('../helpers/sqp.helpers');
const { initDatabaseContext, loadDatabase } = require('../db/tenant.db');
const sellerModel = require('../models/sequelize/seller.model');
const logger = require('../utils/logger.utils');
const { isValidSellerID, sanitizeLogData } = require('../utils/security.utils');
const env = require('../config/env.config');
const asinResetService = require('../services/asin.reset.service');
const cronApiService = require('../services/cron.api.service');
const asinPullService = require('../services/asin.pull.service');
/**
 * SQP Cron API Controller
 * Handles legacy cron endpoints with proper error handling and validation
 */
class SqpCronApiController {
    constructor() {
        // Initialize efficiency helpers
        this.circuitBreaker = new CircuitBreaker(
            Number(process.env.CIRCUIT_BREAKER_THRESHOLD) || 5,
            Number(process.env.CIRCUIT_BREAKER_TIMEOUT_MS) || 60000
        );
        this.rateLimiter = new RateLimiter(
            Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
            Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000
        );
        
        // MemoryMonitor uses static methods, no instance needed
    }   

    /**
     * Run all cron operations (request, status check, download)
     * Returns immediately and processes in background
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
            }, 'Run all cron operations - starting background process');

            // Process in background (don't wait)
            cronApiService.processAllCronOperations(validatedUserId, validatedSellerId)
                .catch(error => {
                    logger.error({ error: error.message }, 'Error in background cron processing');
                });

            return SuccessHandler.sendSuccess(res, {
                message: 'Cron operations started',
                processing: 'Background processing initiated',
                params: { userId: validatedUserId, sellerId: validatedSellerId }
            }, 'Cron job started successfully');

        } catch (error) {
            logger.error({ 
                error: error.message,
                stack: error.stack,
                query: req.query 
            }, 'Error starting cron operations');
            
            return ErrorHandler.sendError(res, error, 'Failed to start cron operations');
        }
    }

    /**
     * Sync ASINs from mws_items into seller_ASIN_list for a single seller
     * Returns immediately and processes in background
     * GET: /cron/asin/syncSellerAsins/{userId}/{amazonSellerID}
     */
    async syncSellerAsins(req, res) {
        try {
            const { userId, amazonSellerID } = req.params;
            
            if (!isValidSellerID(amazonSellerID)) {
                return ErrorHandler.sendValidationError(res, ['Invalid Amazon Seller ID format']);
            }
            
            // Sanitize log data
            logger.info(sanitizeLogData({ userId, amazonSellerID }), 'ASIN sync started - background processing');

            // Process in background
            asinPullService.processSyncSellerAsins(userId, amazonSellerID)
                .catch(error => {
                    logger.error({ error: error.message }, 'Error in background ASIN sync');
                });

            return SuccessHandler.sendSuccess(res, {
                message: 'ASIN sync started',
                processing: 'Background processing initiated',
                params: { userId, amazonSellerID }
            }, 'ASIN sync started successfully');

        } catch (error) {
            logger.error({ error: error.message }, 'Error starting ASIN sync');
            return ErrorHandler.sendError(res, error, 'Failed to start ASIN sync');
        }
    }

    /**
     * Sync ASINs for all sellers under a specific user
     * GET: /cron/sqp/cronSyncAllSellerAsins/{userId}
     */
    async cronSyncAllSellerAsins(req, res) {
        return initDatabaseContext(async () => {
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
                    const result = await asinPullService.syncSellerAsinsInternal(sellerID);

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
        });
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
            }, 'Starting notification retry scan - background process');
            
            // Process in background
            this.circuitBreaker.execute(
                () => cronApiService.processRetryNotifications(validatedUserId),
                { userId: validatedUserId, operation: 'processRetryNotifications' }
            );

            return SuccessHandler.sendSuccess(res, {
                message: 'Notification retry started',
                processing: 'Background processing initiated',
                params: { userId: validatedUserId }
            }, 'Notification retry started successfully');

        } catch (error) {
            logger.error({ error: error.message }, 'Error starting retry notifications');
            return ErrorHandler.sendError(res, error, 'Failed to start retry notifications');
        }
    }

    /**
     * Automatic reset based on current date
     * Detects if it's start of new week/month/quarter and resets accordingly
     * - Weekly: Every Tuesday
     * - Monthly: 3rd of each month (reports available after 3rd)
     * - Quarterly: 20th of Jan/Apr/Jul/Oct (reports available around 20th)
     */
    async resetAsinStatus(req, res) {
        try {
            logger.info({'userId': null, operation: 'resetAsinStatus'}, 'Automatic ASIN reset check triggered - background process');       

            // Process in background
            this.circuitBreaker.execute(
                () => asinResetService.resetAsinStatus(),
                { userId: null, operation: 'resetAsinStatus' }
            );

            return SuccessHandler.sendSuccess(res, {
                message: 'ASIN reset started',
                processing: 'Background processing initiated'
            }, 'ASIN reset started successfully');

        } catch (error) {
            logger.error({ error: error.message }, 'Error in resetAsinStatus');
            return ErrorHandler.sendError(res, error, 'Failed to run automatic ASIN reset');
        }
    }
}

module.exports = new SqpCronApiController();