const { SuccessHandler, ErrorHandler } = require('../middleware/response.handlers');
const { ValidationHelpers, CircuitBreaker, RateLimiter, MemoryMonitor, RetryHelpers, Helpers,DelayHelpers } = require('../helpers/sqp.helpers');
const retryHelpers = new RetryHelpers();
const { initDatabaseContext, loadDatabase } = require('../db/tenant.db');
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
const { Op, literal } = require('sequelize');
const logger = require('../utils/logger.utils');
const { isUserAllowed, isValidSellerID, sanitizeLogData } = require('../utils/security.utils');
const env = require('../config/env.config');
const isDevEnv = ["local", "development","production"].includes(env.NODE_ENV);
const asinResetService = require('../services/asin.reset.service');
const authService = require('../services/auth.service');
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
            this._processAllCronOperations(validatedUserId, validatedSellerId)
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
     * Internal method to process all cron operations
     */
    async _processAllCronOperations(validatedUserId, validatedSellerId) {
        return initDatabaseContext(async () => {
            try {
                await loadDatabase(0);
                const users = validatedUserId ? [{ ID: validatedUserId }] : await getAllAgencyUserList();
                
                // Check cron limit logic            
                let totalProcessed = 0;
                let totalErrors = 0;
                let breakUserProcessing = false;
                // Process one user → one seller per run, exit after completing that seller            
                for (const user of users) {
                    if (isDevEnv && !isUserAllowed(user.ID)) {
                        logger.info(sanitizeLogData({ userId: user.ID }), 'Skip user as it is not allowed');
                        continue;
                    } else {
                        logger.info({ userId: user.ID }, 'Process user started');
                        await loadDatabase(user.ID);
                        // Check cron limits for this user
                        const cronLimits = await Helpers.checkCronLimits(user.ID);
                        logger.info({ cronLimits }, 'cronLimits');
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
                                    // Check memory usage before processing
                                    const memoryStats = MemoryMonitor.getMemoryStats();
                                    if (MemoryMonitor.isMemoryUsageHigh(Number(process.env.MAX_MEMORY_USAGE_MB) || 500)) {
                                        logger.warn({ 
                                            memoryUsage: memoryStats.heapUsed,
                                            threshold: process.env.MAX_MEMORY_USAGE_MB || 500
                                        }, 'High memory usage detected, skipping seller processing');
                                        breakUserProcessing = false;
                                        continue;
                                    }

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

                                    // Check rate limit before making API calls
                                    await this.rateLimiter.checkLimit(s.AmazonSellerID);
                                    
                                    const authOverrides = await authService.buildAuthOverrides(s.AmazonSellerID);
                                    
                                    // Step 1: Request report with circuit breaker protection
                                    const { cronDetailIDs, cronDetailData } = await this.circuitBreaker.execute(
                                        () => ctrl.requestForSeller(s, authOverrides, env.GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT),
                                        { sellerId: s.idSellerAccount, operation: 'requestForSeller' }
                                    );
                                    
                                    totalProcessed++;

                                    if (cronDetailIDs.length > 0) {
                                        await DelayHelpers.wait(Number(process.env.INITIAL_DELAY_SECONDS) || 30, 'Before status check');
                                        // Step 2: Check status with circuit breaker protection
                                        try {
                                            await this.circuitBreaker.execute(
                                                () => ctrl.checkReportStatuses(authOverrides, { cronDetailID: cronDetailIDs, cronDetailData: cronDetailData }),
                                                { sellerId: s.idSellerAccount, operation: 'checkReportStatuses' }
                                            );
                                            totalProcessed++;
                                        } catch (error) {
                                            logger.error({ error: error.message, cronDetailID: cronDetailIDs }, 'Error checking report statuses (scoped)');
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
                
                // Log final system status
                const finalMemoryStats = MemoryMonitor.getMemoryStats();
                const circuitBreakerState = this.circuitBreaker.getState();
                const rateLimiterStats = this.rateLimiter.getStats();
                
                logger.info({
                    totalProcessed,
                    totalErrors,
                    memoryUsage: finalMemoryStats.heapUsed,
                    circuitBreakerState: circuitBreakerState.state,
                    rateLimiterStats
                }, 'Cron operations completed - system status');

            } catch (error) {
                logger.error({ 
                    error: error.message,
                    stack: error.stack 
                }, 'Error in _processAllCronOperations');
            }
        });
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
            this._processSyncSellerAsins(userId, amazonSellerID)
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
                    dtCreatedOn: new Date()
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
                () => this._processRetryNotifications(validatedUserId),
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
     * Internal method to process retry notifications
     */
    async _processRetryNotifications(validatedUserId) {
        return initDatabaseContext(async () => {
            try {
                await loadDatabase(0);
                const users = validatedUserId ? [{ ID: validatedUserId }] : await getAllAgencyUserList();
                
                let totalRetryNotifications = 0;
                let totalErrors = 0;
                const allResults = [];
                
                // Process each user
                for (const user of users) {
                    try {                        
                        if (isDevEnv && !isUserAllowed(user.ID)) {
                            continue;
                        }
                        await loadDatabase(user.ID);
                        //stuck in progress/pending status for 1 hour
                        const stuckRecords = await this.circuitBreaker.execute(
                            () => this.findStuckRecords(),
                            { userId: user.ID, operation: 'findStuckRecords' }
                        );
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
                            const authOverrides = await authService.buildAuthOverrides(rec.AmazonSellerID);
                            for (const type of rec.stuckReportTypes) {
                                try {
                                    // Check memory usage before processing
                                    const memoryStats = MemoryMonitor.getMemoryStats();
                                    if (MemoryMonitor.isMemoryUsageHigh(Number(process.env.MAX_MEMORY_USAGE_MB) || 500)) {
                                        logger.warn({ 
                                            memoryUsage: memoryStats.heapUsed,
                                            threshold: process.env.MAX_MEMORY_USAGE_MB || 500
                                        }, 'High memory usage detected, skipping record processing');
                                        continue;
                                    }
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
                
                if (allResults.length === 0) {
                    logger.info('No stuck records found across all users');
                } else {
                    logger.info({
                        totalRetryNotifications: allResults.length,
                        totalErrors,
                        results: allResults
                    }, 'Notification retry completed');
                }
                
            } catch (error) {
                logger.error({ 
                    error: error.message,
                    stack: error.stack 
                }, 'Error in _processRetryNotifications');
            }
        });
    }

    async findStuckRecords() {
        const SqpCronDetails = getSqpCronDetails();
        
        // Calculate time (1 hour ago)
        const cutoffTime = new Date();
        cutoffTime.setHours(cutoffTime.getHours() - 1);
        
        logger.info({ cutoffTime: cutoffTime.toISOString() }, 'Scanning for records stuck since cutoff time');
        
        // Find records that are stuck in progress or pending status
        // Include records where dtUpdatedOn < dtCronStartDate (stale/stuck)
        const stuckRecords = await SqpCronDetails.findAll({
            where: {
                iInitialPull: 0,
                [Op.or]: [                    
                    {
                        [Op.and]: [
                            { cronRunningStatus: 3},
                            { WeeklyProcessRunningStatus: { [Op.in]: [1, 2, 3, 4] } },
                            { WeeklySQPDataPullStatus: { [Op.in]: [0, 2] } },
                            {
                                [Op.or]: [
                                    { dtUpdatedOn: { [Op.lte]: cutoffTime } },
                                    literal('dtUpdatedOn < dtCronStartDate')
                                ]
                            }
                        ]
                    },
                    {
                        [Op.and]: [
                            { cronRunningStatus: 3},
                            { MonthlyProcessRunningStatus: { [Op.in]: [1, 2, 3, 4] } },
                            { MonthlySQPDataPullStatus: { [Op.in]: [0, 2] } },
                            {
                                [Op.or]: [
                                    { dtUpdatedOn: { [Op.lte]: cutoffTime } },
                                    literal('dtUpdatedOn < dtCronStartDate')
                                ]
                            }
                        ]
                    },
                    {
                        [Op.and]: [
                            { cronRunningStatus: 3},
                            { QuarterlyProcessRunningStatus: { [Op.in]: [1, 2, 3, 4] } },
                            { QuarterlySQPDataPullStatus: { [Op.in]: [0, 2] } },
                            {
                                [Op.or]: [
                                    { dtUpdatedOn: { [Op.lte]: cutoffTime } },
                                    literal('dtUpdatedOn < dtCronStartDate')
                                ]
                            }
                        ]
                    }
                ]
            },
            attributes: [
                'ID', 'AmazonSellerID', 'dtCronStartDate', 'dtCreatedOn', 'dtUpdatedOn',
                'WeeklyProcessRunningStatus', 'WeeklySQPDataPullStatus', 'WeeklySQPDataPullEndDate', 'WeeklySQPDataPullStartDate',
                'MonthlyProcessRunningStatus', 'MonthlySQPDataPullStatus', 'MonthlySQPDataPullEndDate', 'MonthlySQPDataPullStartDate',
                'QuarterlyProcessRunningStatus', 'QuarterlySQPDataPullStatus', 'QuarterlySQPDataPullEndDate', 'QuarterlySQPDataPullStartDate'
            ],
            limit: 1
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

    /**
     * Automatic reset based on current date
     * Detects if it's start of new week/month/quarter and resets accordingly
     * - Weekly: Every Tuesday
     * - Monthly: 3rd of each month (reports available after 3rd)
     * - Quarterly: 20th of Jan/Apr/Jul/Oct (reports available around 20th)
     */
    async resetAsinStatus(req, res) {
        try {
            logger.info('Automatic ASIN reset check triggered - background process');

            // Process in background
            asinResetService.resetAsinStatus()
                .then(result => {
                    logger.info({ result }, 'ASIN reset completed in background');
                })
                .catch(error => {
                    logger.error({ error: error.message }, 'Error in background ASIN reset');
                });

            return SuccessHandler.sendSuccess(res, {
                message: 'ASIN reset started',
                processing: 'Background processing initiated'
            }, 'ASIN reset started successfully');

        } catch (error) {
            logger.error({ error: error.message }, 'Error in resetAsinStatus');
            return ErrorHandler.sendError(res, error, 'Failed to run automatic ASIN reset');
        }
    }
    /**
     * Retry a stuck record's pipeline for a specific report type, then finalize status.
     */
    async retryStuckRecord(record, reportType, authOverrides) {
        // Lazy load to avoid circular dependencies
        const { getModel: getSqpCronDetails } = require('../models/sequelize/sqpCronDetails.model');
        const ctrl = require('../controllers/sqp.cron.controller');
        const model = require('../models/sqp.cron.model');
        // Check memory usage before processing
        const memoryStats = MemoryMonitor.getMemoryStats();
        if (MemoryMonitor.isMemoryUsageHigh(Number(process.env.MAX_MEMORY_USAGE_MB) || 500)) {
            logger.warn({ 
                memoryUsage: memoryStats.heapUsed,
                threshold: process.env.MAX_MEMORY_USAGE_MB || 500
            }, 'High memory usage detected, skipping seller processing');            
            return;
        }
        await model.updateSQPReportStatus(record.ID, reportType, 2, null, null, 4, true); // 4 is retry mark running status
        let res = null;
        try {
            res = await ctrl.checkReportStatuses(authOverrides, { cronDetailID: [record.ID], reportType: reportType, cronDetailData: [record] }, true);
        } catch (e) {
            logger.error({ id: record.ID, reportType, error: e.message }, 'Retry status check failed');
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
        const processStatusField = `${prefix}ProcessRunningStatus`;
        const current = refreshed ? refreshed[statusField] : null;
        const currentProcess = refreshed ? refreshed[processStatusField] : null;

        logger.info({ 
            id: record.ID, 
            reportType, 
            currentStatus: current,
            currentProcessStatus: currentProcess,
            expectedStatus: 1,
            expectedProcessStatus: 4
        }, 'Checking final status after retry');

        if (current === 1) {  // 1 = Completed in sqp_cron_details
            logger.info({ 
                id: record.ID, 
                reportType, 
                currentStatus: current,
                currentProcessStatus: currentProcess
            }, 'Retry succeeded - report completed and imported');
            return { cronDetailID: record.ID, amazonSellerID: record.AmazonSellerID, reportType, retried: true, success: true };
        }

        // Get the actual retry count for notification
        const actualRetryCount = await model.getRetryCount(record.ID, reportType);
        const latestReportId = await model.getLatestReportId(record.ID, reportType);
        
        // Check if it's a fatal error (status 3) or retryable failure (status 2)
        if (current === 3) {
            // Fatal Error - no retry, mark as completed with error
            logger.fatal({ 
                id: record.ID, 
                reportType, 
                currentStatus: current,
                currentProcessStatus: currentProcess,
                reportId: latestReportId
            }, 'Fatal error detected during retry - marking as permanent failure');
            
            // Update with cronRunningStatus = 2 (completed with fatal error)
            await model.updateSQPReportStatus(record.ID, reportType, 3, null, new Date(), 2);
            
            await model.logCronActivity({
                cronJobID: record.ID,
                reportType,
                action: 'Fatal Error',
                status: 3,
                message: 'Fatal error - permanent failure (no retry)',
                reportID: latestReportId,
                retryCount: actualRetryCount,
                executionTime: (Date.now() - new Date(record.dtCreatedOn).getTime()) / 1000
            });
            
            // // Send notification immediately for fatal errors
            // await ctrl.sendFailureNotification(
            //     record.ID, 
            //     record.AmazonSellerID, 
            //     reportType, 
            //     'Fatal error during retry - report cannot be recovered', 
            //     actualRetryCount, 
            //     latestReportId,
            //     true  // isFatalError flag
            // );
            
            logger.info({ id: record.ID, reportType }, 'Fatal error - notification sent');
            
            return { cronDetailID: record.ID, amazonSellerID: record.AmazonSellerID, reportType, retried: true, success: false, fatal: true };
            
        } else {
            // Retryable failure (status 2 or 0) - mark for retry
            logger.warn({ 
                id: record.ID, 
                reportType, 
                currentStatus: current,
                currentProcessStatus: currentProcess,
                reportId: latestReportId,
                retryCount: actualRetryCount
            }, 'Retry failed - will retry again later');
            
            // Update with cronRunningStatus = 3 (needs retry)
            await model.updateSQPReportStatus(record.ID, reportType, 2, null, null, 3);
            
            await model.logCronActivity({
                cronJobID: record.ID,
                reportType,
                action: 'Retry Failed',
                status: 2,
                message: `Retry failed on attempt ${actualRetryCount + 1} - will retry later`,
                reportID: latestReportId,
                retryCount: actualRetryCount,
                executionTime: (Date.now() - new Date(record.dtCreatedOn).getTime()) / 1000
            });
            
            // // Only send notification if retry count has reached maximum (3)
            // if (actualRetryCount >= 3) {
            //     await ctrl.sendFailureNotification(
            //         record.ID, 
            //         record.AmazonSellerID, 
            //         reportType, 
            //         'Max retry attempts reached after stuck record retry', 
            //         actualRetryCount, 
            //         latestReportId,
            //         false  // Not a fatal error, just max retries
            //     );
            // }
            
            logger.warn({ id: record.ID, reportType }, 'Retry failed - marked for retry');
            return { cronDetailID: record.ID, amazonSellerID: record.AmazonSellerID, reportType, retried: true, success: false, fatal: false };
        }
    }
}

module.exports = new SqpCronApiController();