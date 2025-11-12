/**
 * Initial Pull Service
 * Handles historical ASIN data pulling for weeks, months, and quarters
 * 
 * Requirements:
 * - Pull 7 weeks historical (skip most recent)
 * - Pull 36 months historical (skip current month)
 * - Pull 8 quarters historical (skip current quarter)
 */

const { initDatabaseContext, loadDatabase } = require('../db/tenant.db');
const { getAllAgencyUserList } = require('../models/sequelize/user.model');
const { getModel: getSqpCronDetails } = require('../models/sequelize/sqpCronDetails.model');
const { getModel: getSqpCronLogs } = require('../models/sequelize/sqpCronLogs.model');
const { getModel: getSellerAsinList } = require('../models/sequelize/sellerAsinList.model');
const sellerModel = require('../models/sequelize/seller.model');
const model = require('../models/sqp.cron.model');
const sp = require('../spapi/client.spapi');
const authService = require('../services/auth.service');
const jsonSvc = require('../services/sqp.json.processing.service');
const downloadUrls = require('../models/sqp.download.urls.model');
const asinInitialPull = require('../models/sellerAsinList.initial.pull.model');
const logger = require('../utils/logger.utils');
const apiLogger = require('../utils/api.logger.utils');
const { sendFailureNotification, shouldSendNotification, getErrorType } = require('../utils/notification.utils');
const { isUserAllowed, sanitizeLogData } = require('../utils/security.utils');
const env = require('../config/env.config');
const isDevEnv = ["local", "development","production"].includes(env.NODE_ENV);
const { getModel: getSqpDownloadUrls } = require('../models/sequelize/sqpDownloadUrls.model');
const { Op, literal } = require('sequelize');
const { CircuitBreaker, RateLimiter, MemoryMonitor, DelayHelpers, NotificationHelpers, RetryHelpers, Helpers } = require('../helpers/sqp.helpers');
const dates = require('../utils/dates.utils');

class InitialPullService {
    
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
     * Internal method to process retry for failed initial pull
     */
    async _processRetryFailedInitialPull(validatedUserId, validatedSellerId, validatedCronDetailID) {
        return initDatabaseContext(async () => {
            try {
                await loadDatabase(0);
                const users = validatedUserId ? [{ ID: parseInt(validatedUserId) }] : await getAllAgencyUserList();
                
                let totalRetried = 0;
                let totalSuccess = 0;
                let totalFailed = 0;
                const allResults = [];
                
                // Process each user
                for (const user of users) {
                    try {                        
                        if (isDevEnv && !isUserAllowed(user.ID)) {
                            continue;
                        }
                        
                        await loadDatabase(user.ID);

                        // Find failed records
                        let failedRecords = await this.findFailedInitialPullRecords(user);
                        logger.info({ failedRecordsCount: failedRecords.length }, 'Found failed initial pull records to retry');
                        
                        // Filter by cronDetailID if specified
                        if (validatedCronDetailID) {
                            failedRecords = failedRecords.filter(r => r.ID === parseInt(validatedCronDetailID));
                        }
                        
                        // Filter by sellerId if specified
                        if (validatedSellerId) {
                            const sellerDetails = await sellerModel.getProfileDetailsByID(validatedSellerId);
                            if (sellerDetails) {
                                failedRecords = failedRecords.filter(r => r.AmazonSellerID === sellerDetails.AmazonSellerID);
                            }
                        }
                        
                        if (failedRecords.length === 0) {
                            logger.info({ userId: user.ID }, 'No failed initial pull records found for user');
                            continue;
                        }
                        
                        logger.info({ 
                            userId: user.ID,
                            failedRecordsCount: failedRecords.length,
                            records: failedRecords.map(r => ({
                                id: r.ID,
                                amazonSellerID: r.AmazonSellerID,
                                stuckReportTypes: r.stuckReportTypes
                            }))
                        }, 'Found failed initial pull records to retry');
                        // Retry each failed record
                        for (const rec of failedRecords) {
                            const authOverrides = await authService.buildAuthOverrides(rec.AmazonSellerID);
                            // status update
                            const updateData = {
                                InitialPullStatus: 1,
                                InitialPullStartTime: dates.getNowDateTimeInUserTimezone().db,
                                InitialPullEndTime: null,
                                dtUpdatedOn: dates.getNowDateTimeInUserTimezone().db
                            };
                            await asinInitialPull.updateInitialPullStatusByASIN(rec.AmazonSellerID, rec.ASIN_List, rec.SellerID, updateData);

                            // Process each failed log entry individually
                            for (const log of rec.failedLogs) {
                                try {
                                    logger.info({ 
                                        cronDetailID: log.cronJobID, 
                                        amazonSellerID: rec.AmazonSellerID,
                                        reportType: log.reportType,
                                        range: log.range,
                                        action: log.action
                                    }, 'Retrying failed initial pull report');
                                    
                                    const startDate = dates.getNowDateTimeInUserTimezone().db;
                                    
                                    // Reset the failed status to pending (0) to allow retry
                                    await model.updateSQPReportStatus(log.cronJobID, log.reportType, 0, startDate, null, 4, true);
                                    await model.setProcessRunningStatus(log.cronJobID, log.reportType, 1);
                                    
                                    // Log retry attempt
                                    await model.logCronActivity({
                                        cronJobID: log.cronJobID,
                                        reportType: log.reportType,
                                        action: 'Initial Pull - Retry Started',
                                        status: 1,
                                        message: `Retrying ${log.action} for ${log.range}`,
                                        retryCount: 0,
                                        reportID: log.reportId,
                                        iInitialPull: 1,
                                        Range: log.range,
                                        reportDocumentID: log.reportDocumentID,
                                        executionTime: 0
                                    });
                                    
                                    const result = await this.retryStuckRecord(rec, log.reportType, authOverrides, log, user);
                                    
                                    if (result.success) {
                                        totalSuccess++;
                                        logger.info({ 
                                            cronDetailID: log.cronJobID, 
                                            reportType: log.reportType,
                                            range: log.range
                                        }, 'Initial pull retry succeeded');
                                    } else {
                                        totalFailed++;
                                        logger.warn({ 
                                            cronDetailID: log.cronJobID, 
                                            reportType: log.reportType,
                                            range: log.range
                                        }, 'Initial pull retry failed');
                                    }
                                    
                                    allResults.push(result);
                                    totalRetried++;
                                    
                                } catch (e) {
                                    logger.error({ 
                                        cronDetailID: log.cronJobID, 
                                        reportType: log.reportType, 
                                        range: log.range,
                                        error: e.message 
                                    }, 'Error retrying failed initial pull report');
                                    
                                    allResults.push({
                                        cronDetailID: log.cronJobID,
                                        amazonSellerID: rec.AmazonSellerID,
                                        reportType: log.reportType,
                                        range: log.range,
                                        retried: true,
                                        success: false,
                                        error: e.message
                                    });
                                    totalRetried++;
                                    totalFailed++;
                                }
                            }
                        }
                        
                        // After all retries, update final status for each unique cronDetailID
                        const processedCronDetails = new Set();
                        for (const rec of failedRecords) {
                            if (!processedCronDetails.has(rec.ID)) {
                                processedCronDetails.add(rec.ID);
                                
                                try {
                                    // Single function call - it fetches all needed data itself
                                    await this._updateInitialPullFinalStatus(rec.ID, rec.AmazonSellerID, null);
                                    
                                    logger.info({
                                        cronDetailID: rec.ID,
                                        amazonSellerID: rec.AmazonSellerID
                                    }, 'Updated final status after retry');
                                    
                                } catch (updateError) {
                                    logger.error({
                                        error: updateError.message,
                                        cronDetailID: rec.ID
                                    }, 'Error updating final status after retry');
                                }
                            }
                        }
                        
                        logger.info({
                            userId: user.ID,
                            totalRetried,
                            totalSuccess,
                            totalFailed
                        }, 'Failed initial pull retry completed for user');
                        
                    } catch (error) {
                        logger.error({ 
                            error: error.message,
                            userId: user.ID 
                        }, 'Error processing user in failed initial pull retry');
                    }
                }
                
                logger.info({
                    totalRetried,
                    totalSuccess,
                    totalFailed
                }, 'Failed initial pull retry process completed');
                
                return {
                    totalRetried,
                    totalSuccess,
                    totalFailed,
                    results: allResults
                };
                
            } catch (error) {
                logger.error({ error: error.message }, 'Error in _processRetryFailedInitialPull');
                throw error;
            }
        });
    }

    /**
     * Retry a stuck record's pipeline for a specific report type, then finalize status.
     */
    async retryStuckRecord(record, reportType, authOverrides, recordLog, user = null) {
        // Check memory usage before processing
        const memoryStats = MemoryMonitor.getMemoryStats();
        if (MemoryMonitor.isMemoryUsageHigh(Number(process.env.MAX_MEMORY_USAGE_MB) || 500)) {
            logger.warn({ 
                memoryUsage: memoryStats.heapUsed,
                threshold: process.env.MAX_MEMORY_USAGE_MB || 500
            }, 'High memory usage detected, skipping seller processing');            
            return { success: false, error: 'High memory usage' };
        }
        
        const cronDetailID = recordLog.cronJobID;
        const reportId = recordLog.reportId;
        const range = recordLog.range;
        
        // Get seller profile
        const seller = await sellerModel.getProfileDetailsByAmazonSellerID(record.AmazonSellerID);
        if (!seller) {
            logger.error({ amazonSellerID: record.AmazonSellerID }, 'Seller not found for retry');
            return { success: false, error: 'Seller not found' };
        }
        
        // Create range object
        const rangeObj = { 
            range, 
            startDate: range ? range.split(' to ')[0] : null, 
            endDate: range ? range.split(' to ')[1] : null, 
            type: reportType 
        };

        try {
            // STEP 1: Check status and trigger download (reuse existing function)
            const statusResult = await this.circuitBreaker.execute(
                () => this._checkInitialPullReportStatus(
                    cronDetailID,
                    seller,
                    reportId,
                    rangeObj,
                    reportType,
                    authOverrides,
                    true, // retry flag
                    user
                ),
                { sellerId: seller.idSellerAccount, operation: 'recheckInitialPullReportStatus' }
            );

            const requestDelaySeconds = Number(process.env.REQUEST_DELAY_SECONDS) || 30;
            await DelayHelpers.wait(requestDelaySeconds, 'Between report status checks and downloads (rate limiting)');
            
            // Verify final status from database
            const SqpCronDetails = getSqpCronDetails();
            const refreshed = await SqpCronDetails.findOne({
                where: { ID: cronDetailID },
                attributes: [
                    'WeeklySQPDataPullStatus','MonthlySQPDataPullStatus','QuarterlySQPDataPullStatus',
                    'WeeklyProcessRunningStatus','MonthlyProcessRunningStatus','QuarterlyProcessRunningStatus'
                ]
            });
            
            const prefix = model.mapPrefix(reportType);
            const statusField = `${prefix}SQPDataPullStatus`;
            const current = refreshed ? refreshed[statusField] : null;
            
            logger.info({ 
                cronDetailID, 
                reportType, 
                range,
                currentStatus: current,
                expectedStatus: 1
            }, 'Checking final status after retry');
            
            if (current === 1) {
                logger.info({ cronDetailID, reportType, range }, 'Retry succeeded - report completed and imported');
                return { 
                    success: true, 
                    cronDetailID, 
                    amazonSellerID: record.AmazonSellerID, 
                    reportType, 
                    retried: true 
                };
            }
            
            // If not success, mark as failed
            logger.warn({ cronDetailID, reportType, range, currentStatus: current }, 'Retry completed but status not success');
            
            return { 
                success: false, 
                cronDetailID, 
                amazonSellerID: record.AmazonSellerID, 
                reportType, 
                retried: true,
                error: `Final status: ${current}`
            };
            
        } catch (e) {
            logger.error({ id: record.ID, reportType, range, error: e.message }, 'Retry failed with exception');
            
            return { 
                success: false, 
                cronDetailID, 
                amazonSellerID: record.AmazonSellerID, 
                reportType, 
                retried: true,
                error: e.message 
            };
        }
    }
    
    /**
     * Public method to process initial pull
     */
    async processInitialPull(validatedUserId, validatedSellerId, reportType) {
        return this._processInitialPull(validatedUserId, validatedSellerId, reportType);
    }
    
    /**
     * Public method to process retry for failed initial pull
     */
    async processRetryFailedInitialPull(validatedUserId, validatedSellerId, validatedCronDetailID) {
        return this._processRetryFailedInitialPull(validatedUserId, validatedSellerId, validatedCronDetailID);
    }
    
    /**
     * Internal method to process initial pull for users and sellers
     */
    async _processInitialPull(validatedUserId, validatedSellerId, reportType) {
        return initDatabaseContext(async () => {
            try {
                await loadDatabase(0);
                const users = validatedUserId ? [{ ID: parseInt(validatedUserId) }] : await getAllAgencyUserList();
                let breakUserProcessing = false;
                for (const user of users) {
                    try {
                        if (isDevEnv && !isUserAllowed(user.ID)) {
                            continue;
                        }
                        logger.info(sanitizeLogData({ userId: user.ID }), 'Process user started');
                        await loadDatabase(user.ID);
                        // Check cron limits for this user
                        const cronLimits = await Helpers.checkCronLimits(user.ID, 1);                        
                        if (cronLimits.shouldProcess) {
                            // Check if user has eligible seller which has eligible ASINs before processing
                            const hasEligibleUser = await model.hasEligibleASINsInitialPull(null, false);
                            if (!hasEligibleUser) {
                                logger.info({ 
                                    sellerId: 'ALL Sellers Check', 
                                    amazonSellerID: 'ALL Sellers Check',
                                    userId: user.ID
                                }, 'Skipping Full Run - no eligible ASINs for all sellers');
                                continue;
                            }
                            const sellers = validatedSellerId
                                ? [await sellerModel.getProfileDetailsByID(validatedSellerId)]
                                : await sellerModel.getSellersProfilesForCronAdvanced({ pullAll: 0 });                        

                            for (const seller of sellers) {
                                if (!seller) continue;

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
                                const hasEligible = await model.hasEligibleASINsInitialPull(seller.idSellerAccount); 
                                if (!hasEligible) {
                                    logger.info({ 
                                        sellerId: seller.idSellerAccount, 
                                        amazonSellerID: seller.AmazonSellerID 
                                    }, 'Skipping seller - no eligible ASINs');
                                    breakUserProcessing = false;
                                    continue;
                                }
                                breakUserProcessing = true;

                                logger.info({ 
                                    userId: validatedUserId,
                                    sellerId: seller.idSellerAccount,
                                    amazonSellerID: seller.AmazonSellerID,
                                }, 'Processing seller for initial pull');

                                // Check rate limit before making API calls
                                await this.rateLimiter.checkLimit(seller.AmazonSellerID);

                                // Get access token
                                const authOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID);
                                if (!authOverrides.accessToken) {				
                                    logger.error({ amazonSellerID: seller.AmazonSellerID }, 'No access token available for request');
                                    throw new Error('No access token available for report request');
                                }
                                // Start initial pull for seller with circuit breaker protection
                                await this.circuitBreaker.execute(
                                    () => this._startInitialPullForSeller(seller, reportType, authOverrides, user),
                                    { sellerId: seller.idSellerAccount, operation: 'startInitialPullForSeller' }
                                );
                                break; // done after one seller
                            }
                        }
                    } catch (userError) {
                        logger.error({ userId: validatedUserId, error: userError.message }, 'Error in initial pull processing');
                    }
                    if (breakUserProcessing) {
                        break;
                    }
                }
            } catch (error) {
                logger.error({ error: error.message }, 'Error in _processInitialPull');
            }
        });
    }

    /**
     * Start initial pull for a specific seller
     * Phase 1: Request all reports
     * Phase 2: Check status for all reports
     * Phase 3: Download and import all completed reports
     */
    async _startInitialPullForSeller(seller, reportType = null, authOverrides = {}, user = null) {
        try {
            const timezone = await model.getUserTimezone(user);
            const ranges = dates.calculateFullRanges(timezone);
            
            const { asins } = await model.getActiveASINsBySellerInitialPull(seller.idSellerAccount, true);            
            if (asins.length === 0) return;
            const asinList = asins;
            const options =   {
                iInitialPull: 1,
                FullWeekRange: ranges.fullWeekRange,
                FullMonthRange: ranges.fullMonthRange,
                FullQuarterRange: ranges.fullQuarterRange,
                SellerName: seller.SellerName || seller.MerchantAlias || `Seller_${seller.AmazonSellerID}`
            }
			const cronDetailRow = await model.createSQPCronDetail(seller.AmazonSellerID, asinList.join(' '), seller.idSellerAccount, options);
            const typesToPull = reportType ? [reportType] : env.TYPE_ARRAY;            
            logger.info({
                weekRangesCount: ranges.weekRanges.length,
                monthRangesCount: ranges.monthRanges.length,
                quarterRangesCount: ranges.quarterRanges.length,
                typesToPull: typesToPull
            }, 'Initial pull ranges calculated');
            
            // Mark initial pull as started
            try {
                await asinInitialPull.markInitialPullStarted(
                    seller.AmazonSellerID,
                    asinList,
                    seller.idSellerAccount,
                    cronDetailRow.ID,
                    timezone
                );
                
                logger.info({
                    amazonSellerID: seller.AmazonSellerID,
                    asinCount: asinList.length,
                    typesToPull: typesToPull
                }, 'Marked initial pull as started for ASINs');
            } catch (statusError) {
                logger.error({
                    error: statusError.message
                }, 'Failed to mark initial pull as started');
            }
            
            // PHASE 1: Request ALL reports first (don't check status yet)
            const reportRequests = []; // Track all requested reports with their IDs
            
            for (const type of typesToPull) {
                const rangesToProcess = type === 'WEEK' ? ranges.weekRanges 
                    : type === 'MONTH' ? ranges.monthRanges 
                    : ranges.quarterRanges;
                
                logger.info({
                    type: type,
                    rangesCount: rangesToProcess.length
                }, 'Requesting reports for type');
                for (const range of rangesToProcess) {
                    try {                      

                        const result = await this.circuitBreaker.execute(
                            () => this._requestInitialPullReport(
                                cronDetailRow.ID,
                                seller,
                                asinList,
                                range,
                                type,
                                authOverrides,
                                user
                            ),
                            { sellerId: seller.idSellerAccount, operation: 'requestInitialPullReport' }
                        );                        
                        
                        // Store the reportId with the request for later status check
                        // RetryHelpers wraps the result, so check both formats
                        const reportID = result?.reportId || result?.data?.reportId;                        
                        if (result && reportID) {
                            reportRequests.push({ 
                                type, 
                                range, 
                                cronDetailID: cronDetailRow.ID,
                                reportId: reportID 
                            });
                            logger.info({ 
                                reportId: reportID,
                                type,
                                range: range.range 
                            }, 'Report request added to tracking array');
                        } else {
                            logger.warn({ 
                                type,
                                range: range.range,
                                result 
                            }, 'Report request failed - no reportID returned');
                        }
                        
                        const requestDelaySeconds = Number(process.env.REQUEST_DELAY_SECONDS) || 30;
                        await DelayHelpers.wait(requestDelaySeconds, 'Between report requests (rate limiting)');
                    } catch (error) {
                        logger.error({ 
                            cronDetailID: cronDetailRow.ID,
                            range: range.range,
                            error: error.message 
                        }, 'Failed to request initial pull report');
                    }
                }
            }
            
            logger.info({ 
                totalRequests: reportRequests.length,
                cronDetailID: cronDetailRow.ID 
            }, 'All initial pull reports requested, waiting before status check');
            
            // PHASE 2: Wait then check status for all reports
            const initialDelaySeconds = Number(process.env.INITIAL_DELAY_SECONDS) || 30;
            await DelayHelpers.wait(initialDelaySeconds, 'Before initial pull status check');
            
            await this.circuitBreaker.execute(
                () => this._checkAllInitialPullStatuses(cronDetailRow, seller, reportRequests, asinList, authOverrides, false, user),
                { sellerId: seller.idSellerAccount, operation: 'checkAllInitialPullStatuses' }
            );

            // PHASE 3: Download and import (already handled in status check when DONE)
            logger.info({ 
                cronDetailID: cronDetailRow.ID,
                amazonSellerID: seller.AmazonSellerID 
            }, 'Initial pull process completed for seller');
            
        } catch (error) {
            logger.error({ error: error.message }, 'Error in _startInitialPullForSeller');
        }
    }

    /**
     * Request a single initial pull report (Step 1: Create Report)
     */
    async _requestInitialPullReport(cronDetailID, seller, asinList, range, reportType, authOverrides = {}, user = null) {
        const result = await RetryHelpers.executeWithRetry({
            cronDetailID,
            amazonSellerID: seller.AmazonSellerID,
            reportType,
            action: 'Initial Pull - Request Report',
            context: { seller, asinList, range, reportType, reportId: null, user },
            model,
            sendFailureNotification: (cronDetailID, amazonSellerID, reportType, errorMessage, retryCount, reportId, isFatalError, range) => {
                return sendFailureNotification({
                    cronDetailID,
                    amazonSellerID,
                    reportType,
                    errorMessage,
                    retryCount,
                    reportId,
                    isFatalError,
                    range,
                    model,
                    NotificationHelpers,
                    env,
                    context: 'Initial Pull'
                });
            },
            maxRetries: 3, // Strict limit of 3 retries per report
            skipIfMaxRetriesReached: true, // Now safe to check because each range is tracked independently
            // Pass these to RetryHelpers so attempt logs have correct values
            extraLogFields: {
                Range: range.range,
                iInitialPull: 1
            },
            operation: async ({ attempt, currentRetry, context, startTime }) => {
                const { seller, asinList, range, reportType, user } = context;
                const requestStartTime = dates.getNowDateTimeInUserTimezone().db;
                
                // Set ProcessRunningStatus = 1 (Report Request)
                await model.setProcessRunningStatus(cronDetailID, reportType, 1);
                
                const asinString = asinList.slice(0, 20).join(' ').substring(0, 200);
                const payload = {
                    reportType: env.GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT,
                    dataStartTime: `${range.startDate}T00:00:00Z`,
                    dataEndTime: `${range.endDate}T23:59:59Z`,
                    marketplaceIds: [seller.AmazonMarketplaceId],
                    reportOptions: { asin: asinString, reportPeriod: range.type }
                };

                // Get access token
                let currentAuthOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID);
                if (!currentAuthOverrides.accessToken) {
                    logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for request');
                    
                    // API Logger - Failed Request (No Token)
                    const userId = user ? user.ID : null;
                    apiLogger.logRequestReport({
                        userId,
                        sellerId: seller.AmazonSellerID,
                        sellerAccountId: seller.idSellerAccount,
                        endpoint: 'SP-API Create Report',
                        requestPayload: payload,
                        response: null,
                        startTime: requestStartTime,
                        endTime: dates.getNowDateTimeInUserTimezone().log,
                        executionTime: (Date.now() - startTime) / 1000,
                        status: 'failure',
                        reportId: null,
                        reportType,
                        range: range.range,
                        error: { message: 'No access token available for report request' },
                        retryCount: currentRetry,
                        attempt
                    });
                    
                    throw new Error('No access token available for report request');
                }

                // Create report via SP-API
                let resp;
                let requestError = null;
                try {
                    resp = await sp.createReport(seller, payload, currentAuthOverrides);
                } catch (err) {
                    const status = err.status || err.statusCode || err.response?.status;
                    if (status === 401 || status === 403) {
                        currentAuthOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID, true);
                        if (!currentAuthOverrides.accessToken) {
                            logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for request after forced refresh');
                            requestError = new Error('No access token available for report request after forced refresh');
                            
                            // API Logger - Failed Request (No Token After Refresh)
                            const userId = user ? user.ID : null;
                            apiLogger.logRequestReport({
                                userId,
                                sellerId: seller.AmazonSellerID,
                                sellerAccountId: seller.idSellerAccount,
                                endpoint: 'SP-API Create Report',
                                requestPayload: payload,
                                response: null,
                                startTime: requestStartTime,
                                endTime: dates.getNowDateTimeInUserTimezone().log,
                                executionTime: (Date.now() - startTime) / 1000,
                                status: 'failure',
                                reportId: null,
                                reportType,
                                range: range.range,
                                error: requestError,
                                retryCount: currentRetry,
                                attempt
                            });
                            
                            throw requestError;
                        }
                        resp = await sp.createReport(seller, payload, currentAuthOverrides);
                    } else {
                        requestError = err;
                        throw err;
                    }
                }
                const reportId = resp.reportId;
                const requestEndTime = dates.getNowDateTimeInUserTimezone().log;
                
                logger.info({ reportId, range: range.range, attempt }, 'Initial pull report created');
                
                // API Logger - Successful Request Report
                const userId = user ? user.ID : null;
                apiLogger.logRequestReport({
                    userId,
                    sellerId: seller.AmazonSellerID,
                    sellerAccountId: seller.idSellerAccount,
                    endpoint: 'SP-API Create Report',
                    requestPayload: payload,
                    response: resp,
                    startTime: requestStartTime,
                    endTime: requestEndTime,
                    executionTime: (Date.now() - startTime) / 1000,
                    status: reportId ? 'success' : 'failure',
                    reportId,
                    reportType,
                    range: range.range,
                    error: requestError,
                    retryCount: currentRetry,
                    attempt
                });
                
                // Update status column based on report type with start date
                const startDate = range.startDate;
                
                if(range.range !== '' && range.range !== null && range.range !== undefined){
                    await model.updateSQPReportStatus(cronDetailID, reportType, 0, dates.getNowDateTimeInUserTimezone().db);
                    // Log report creation
                    await model.logCronActivity({
                        cronJobID: cronDetailID,
                        reportType,
                        action: 'Initial Pull - Request Report',
                        status: 1,
                        message: `Initial pull report requested: ${range.range}`,
                        reportID: reportId,
                        Range: range.range,
                        iInitialPull: 1,
                        retryCount: 0,
                        executionTime: (Date.now() - startTime) / 1000
                    });
                }                
                
                const requestDelaySeconds = Number(process.env.REQUEST_DELAY_SECONDS) || 30;
                await DelayHelpers.wait(requestDelaySeconds, 'Between report requests (rate limiting)');
                
                return {
                    message: `Report requested successfully. Report ID: ${reportId}. Range: ${range.range}`,
                    reportID: reportId,
                    data: { reportId, range: range.range },
                    logData: {
                        Range: range.range,
                        iInitialPull: 1
                    }
                };
            }
        });
        
        return result;
    }

    async _checkAllInitialPullStatuses(cronDetailRow, seller, reportRequests, asinList = null, authOverrides = {}, retry = false, user = null) {
        try {
          logger.info({
            cronDetailID: cronDetailRow.ID,
            totalReports: reportRequests.length
          }, 'Checking status for all initial pull reports');
      
          // Count totals per type
          const totalWeek = reportRequests.filter(r => r.type === 'WEEK').length;
          const totalMonth = reportRequests.filter(r => r.type === 'MONTH').length;
          const totalQuarter = reportRequests.filter(r => r.type === 'QUARTER').length;
      
          let doneWeek = 0, doneMonth = 0, doneQuarter = 0;
          let totalSuccess = 0, totalFailed = 0;
      
          for (const request of reportRequests) {
            if (!request.reportId) {
              logger.warn({
                cronDetailID: cronDetailRow.ID,
                reportType: request.type,
                range: request.range.range
              }, 'No report ID found for request');
              totalFailed++;
              continue;
            }
      
            logger.info({
              reportType: request.type,
              reportId: request.reportId,
              range: request.range.range
            }, 'Checking status for initial pull report');
      
            try {
              await this.circuitBreaker.execute(
                () => this._checkInitialPullReportStatus(
                  cronDetailRow.ID,
                  seller,
                  request.reportId,
                  request.range,
                  request.type,
                  authOverrides,
                  retry,
                  user
                ),
                { sellerId: seller.idSellerAccount, operation: 'checkInitialPullReportStatus' }
              );
      
              totalSuccess++;
      
              // Count completed by type
              if (request.type === 'WEEK') doneWeek++;
              if (request.type === 'MONTH') doneMonth++;
              if (request.type === 'QUARTER') doneQuarter++;
      
              // 🕒 Delay to respect API limits
              const delaySeconds = Number(process.env.REQUEST_DELAY_SECONDS) || 30;
              await DelayHelpers.wait(delaySeconds, 'Between report status checks (rate limiting)');
      
              // ✅ Check if all of a type are processed → update pull status
              if (request.type === 'WEEK' && doneWeek === totalWeek) {
                await this._checkAndUpdateTypeCompletion(cronDetailRow.ID, 'WEEK', user);
              } else if (request.type === 'MONTH' && doneMonth === totalMonth) {
                await this._checkAndUpdateTypeCompletion(cronDetailRow.ID, 'MONTH', user);
              } else if (request.type === 'QUARTER' && doneQuarter === totalQuarter) {
                await this._checkAndUpdateTypeCompletion(cronDetailRow.ID, 'QUARTER', user);
              }
      
            } catch (error) {
              logger.error({
                cronDetailID: cronDetailRow.ID,
                reportType: request.type,
                reportId: request.reportId,
                range: request.range.range,
                error: error.message
              }, 'Failed to check initial pull report status');
              totalFailed++;
            }
          }
      
          // Final summary update (for all types)
          await this._updateInitialPullFinalStatus(cronDetailRow.ID, seller.AmazonSellerID, asinList, user);
      
        } catch (error) {
          logger.error({ error: error.message }, 'Error in _checkAllInitialPullStatuses');
        }
    }
      
    async _checkAndUpdateTypeCompletion(cronDetailID, type, user = null) {
        const { done, fatal, progress, total } = await this.analyzeReports(cronDetailID, type);
        let pull = 2; // default in-progress
      
        if (done === total) {
          pull = 1; // ✅ all done
        } else if (fatal === total) {
          pull = 3; // ❌ all fatal
        } else if ((done > 0 && progress > 0) || (progress > 0 && fatal > 0)) {
          pull = 2; // ⚙️ mixed state (some done + some progress/fatal)
        } else if(done > 0 && fatal > 0){
          pull = 3; // ❌ some done and some fatal
        }
      
        await this.updateStatus(cronDetailID, type, pull, user);
    }

    // analyze logs and determine counts
    async analyzeReports(cronDetailID, type) {
        const SqpCronLogs = getSqpCronLogs();
        const logs = await SqpCronLogs.findAll({
            where: { CronJobID: cronDetailID, ReportType: type, iInitialPull: 1, ReportID: { [Op.ne]: null } },
            attributes: ['ReportID', 'Status', 'Action', 'Message'],
            order: [['dtUpdatedOn', 'DESC']]
        });
        
        const uniqueIDs = [...new Set(logs.map(l => l.ReportID))];
        let done = 0, fatal = 0, progress = 0, fatalIDs = [];
        
        for (const id of uniqueIDs) {
            const rLogs = logs.filter(l => l.ReportID === id);
            const latest = rLogs[0];
            const isDone = rLogs.some(l => l.Status === 1);
            const isFatal = rLogs.some(l => /FATAL|CANCELLED/.test(l.Message || ''));
            const isInProgress = !isDone && !isFatal && (latest.Status === 0 || latest.Status === 2 || /Failure Notification/.test(latest.Message || ''));
        
            if (isDone) done++;
            else if (isFatal) { fatal++; fatalIDs.push(id); }
            else if (isInProgress) progress++;
        }
        
        return { done, fatal, progress, total: uniqueIDs.length, fatalIDs };
    }
    
    // update status in DB
    async updateStatus(cronDetailID, type, pull, user = null) {
        const SqpCronDetails = getSqpCronDetails();
        const prefix = model.mapPrefix(type);
        await SqpCronDetails.update(
            { [`${prefix}SQPDataPullStatus`]: pull, [`${prefix}SQPDataPullEndDate`]: dates.getNowDateTimeInUserTimezone().db },
            { where: { ID: cronDetailID } }
        );
    }
    
    /**
     * Final overall update after all reports processed
     */
    async _updateInitialPullFinalStatus(cronDetailID, amazonSellerID, asinList, user = null) {
        try {
          const SqpCronDetails = getSqpCronDetails();
          const SqpCronLogs = getSqpCronLogs();
          const timezone = await model.getUserTimezone(user);
      
          const cronDetail = await SqpCronDetails.findOne({
            where: { ID: cronDetailID },
            attributes: ['ASIN_List', 'AmazonSellerID', 'SellerID']
          });
          if (!cronDetail) return;
      
          asinList = asinList?.length
            ? asinList
            : cronDetail.ASIN_List?.split(/\s+/).filter(Boolean) || [];
          amazonSellerID = amazonSellerID || cronDetail.AmazonSellerID;
          const SellerID = cronDetail.SellerID;
      
          // Fetch all logs
          const allLogs = await SqpCronLogs.findAll({
            where: { CronJobID: cronDetailID, iInitialPull: 1, ReportID: { [Op.ne]: null } },
            attributes: ['ReportID', 'ReportType', 'Range'],
            group: ['ReportID', 'ReportType', 'Range']
          });
      
          const reportRequests = allLogs.map(l => ({
            reportId: l.ReportID,
            type: l.ReportType,
            range: { range: l.Range }
          }));
      
          const typeGroups = ['WEEK', 'MONTH', 'QUARTER'].reduce((acc, t) => {
            acc[t] = reportRequests.filter(r => r.type === t);
            return acc;
          }, {});
      
          let overallAsinStatus = 2;
      
          for (const type of Object.keys(typeGroups)) {
            const requests = typeGroups[type];
            if (!requests.length) continue;
      
            const { done, fatal, progress, total } = await this.analyzeReports(cronDetailID, type);
            let pull = 2;
      
            if (done === total) {
              pull = 1;
            } else if (fatal === total) {
              pull = 3;
            } else if ((done > 0 && progress > 0) || (progress > 0 && fatal > 0)) {
              pull = 2;
              overallAsinStatus = 3;
            } else if(done > 0 && fatal > 0){
              pull = 3;
            }
      
            if (pull === 3) overallAsinStatus = 3;
            await this.updateStatus(cronDetailID, type, pull, user);
          }
          
          logger.info({ overallAsinStatus }, 'Overall ASIN pull status');
          // Update ASIN pull status
          if (overallAsinStatus === 2)
            await asinInitialPull.markInitialPullCompleted(amazonSellerID, asinList, SellerID, cronDetailID, timezone);
          else
            await asinInitialPull.markInitialPullFailed(amazonSellerID, asinList, SellerID, cronDetailID, timezone);
      
          // Final cronRunningStatus update
          const row = await SqpCronDetails.findOne({ where: { ID: cronDetailID }, raw: true });          
          if (row) {            
            const statuses = [row.WeeklySQPDataPullStatus, row.MonthlySQPDataPullStatus, row.QuarterlySQPDataPullStatus];
            const anyFatal = statuses.some(s => s === 3);
            const allDone = statuses.every(s => s === 1);
            const needsRetry = statuses.some(s => [0, 2, null].includes(s));
            const newStatus = needsRetry ? 3 : (allDone || anyFatal ? 2 : row.cronRunningStatus);
            if (newStatus !== row.cronRunningStatus){
              await SqpCronDetails.update({ cronRunningStatus: newStatus, dtUpdatedOn: dates.getNowDateTimeInUserTimezone().db }, { where: { ID: cronDetailID } });
            }

            logger.info({ overallAsinStatus }, 'Overall ASIN pull status');
            // Update ASIN pull status
            if (newStatus == 2){
                await asinInitialPull.markInitialPullCompleted(amazonSellerID, asinList, SellerID, cronDetailID, timezone);
            } else {
                await asinInitialPull.markInitialPullFailed(amazonSellerID, asinList, SellerID, cronDetailID, timezone);
            }
          }
        } catch (error) {
          logger.error({ error: error.message }, 'Error in _updateInitialPullFinalStatus');
          throw error;
        }
    }
      
    /**
     * Check initial pull report status (Step 2: Check Status)
     */
    async _checkInitialPullReportStatus(cronDetailID, seller, reportId, range, reportType, authOverrides = {}, retry = false, user = null) {
        const result = await RetryHelpers.executeWithRetry({
            cronDetailID,
            amazonSellerID: seller.AmazonSellerID,
            reportType,
            action: retry ? 'Initial Pull - Retry Check Status' : 'Initial Pull - Check Status',
            context: { seller, reportId, range, reportType, retry, user },
            model,
            sendFailureNotification: (cronDetailID, amazonSellerID, reportType, errorMessage, retryCount, reportId, isFatalError, range) => {
                return sendFailureNotification({
                    cronDetailID,
                    amazonSellerID,
                    reportType,
                    errorMessage,
                    retryCount,
                    reportId,
                    isFatalError,
                    range,
                    model,
                    NotificationHelpers,
                    env,
                    context: 'Initial Pull'
                });
            },
            maxRetries: 3, // Strict limit of 3 retries per report
            skipIfMaxRetriesReached: true, // Now safe to check because each range is tracked independently
            extraLogFields: {
                Range: range.range,
                iInitialPull: 1
            },
            operation: async ({ attempt, currentRetry, context, startTime }) => {
                const { seller, reportId, range, reportType, retry, user } = context;
                const statusStartTime = dates.getNowDateTimeInUserTimezone().db;
                
                // Set ProcessRunningStatus = 2 (Status Check)
                await model.setProcessRunningStatus(cronDetailID, reportType, 2);
                // Get access token
                const currentAuthOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID);
                if (!currentAuthOverrides.accessToken) {				
                    logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for request');
                    
                    // API Logger - Failed Status Check (No Token)
                    const userId = user ? user.ID : null;
                    apiLogger.logRequestStatus({
                        userId,
                        sellerId: seller.AmazonSellerID,
                        sellerAccountId: seller.idSellerAccount,
                        reportId,
                        reportType,
                        range: range.range,
                        currentStatus: 'UNKNOWN',
                        response: null,
                        retryCount: currentRetry,
                        attempt,
                        startTime: statusStartTime,
                        endTime: dates.getNowDateTimeInUserTimezone().log,
                        executionTime: (Date.now() - startTime) / 1000,
                        status: 'failure',
                        error: { message: 'No access token available for report request but retry again on catch block' }
                    });
                    
                    throw new Error('No access token available for report request but retry again on catch block');
                }
                // Check report status with force refresh+retry on 401/403
                let res;
                let statusError = null;
                try {
                    res = await sp.getReportStatus(seller, reportId, currentAuthOverrides);
                } catch (err) {
                    const status = err.status || err.statusCode || err.response?.status;
                    if (status === 401 || status === 403) {
                        const refreshedOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID, true);
                        if(!refreshedOverrides.accessToken) {
                            logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for request after forced refresh');
                            statusError = new Error('No access token available for report request after forced refresh');
                            
                            // API Logger - Failed Status Check (No Token After Refresh)
                            const userId = user ? user.ID : null;
                            apiLogger.logRequestStatus({
                                userId,
                                sellerId: seller.AmazonSellerID,
                                sellerAccountId: seller.idSellerAccount,
                                reportId,
                                reportType,
                                range: range.range,
                                currentStatus: 'UNKNOWN',
                                response: null,
                                retryCount: currentRetry,
                                attempt,
                                startTime: statusStartTime,
                                endTime: dates.getNowDateTimeInUserTimezone().log,
                                executionTime: (Date.now() - startTime) / 1000,
                                status: 'failure',
                                error: statusError
                            });
                            
                            throw statusError;
                        }
                        res = await sp.getReportStatus(seller, reportId, refreshedOverrides);
                    } else {
                        statusError = err;
                        throw err;
                    }
                }
                const status = res.processingStatus;
                const statusEndTime = dates.getNowDateTimeInUserTimezone().log;
                
                // API Logger - Status Check
                const userId = user ? user.ID : null;
                apiLogger.logRequestStatus({
                    userId,
                    sellerId: seller.AmazonSellerID,
                    sellerAccountId: seller.idSellerAccount,
                    reportId,
                    reportType,
                    range: range.range,
                    currentStatus: status,
                    response: res,
                    retryCount: currentRetry,
                    attempt,
                    startTime: statusStartTime,
                    endTime: statusEndTime,
                    executionTime: (Date.now() - startTime) / 1000,
                    status: status ? 'success' : 'failure',
                    error: statusError,
                    reportDocumentId: res.reportDocumentId || null
                });
                if (status === 'DONE') {
                    const documentId = res.reportDocumentId || null;

                    // Store for download queue                    
                    await downloadUrls.storeDownloadUrl({
                        CronJobID: cronDetailID,
                        ReportID: reportId,
                        ReportType: reportType,
                        DownloadURL: '',
                        Status: 'PENDING',
                        DownloadAttempts: 0,
                        MaxDownloadAttempts: 3
                    });
                    
                    // Log status
                    await model.logCronActivity({
                        cronJobID: cronDetailID,
                        reportType,
                        action: retry ? 'Initial Pull - Retry Check Status' : 'Initial Pull - Check Status',
                        status: 1,
                        message: `Report ready: ${range.range}`,
                        reportID: reportId,
                        reportDocumentID: documentId,
                        Range: range.range,
                        iInitialPull: 1,
                        executionTime: (Date.now() - startTime) / 1000
                    });
                    
                    const requestDelaySeconds = Number(process.env.REQUEST_DELAY_SECONDS) || 30;
                    await DelayHelpers.wait(requestDelaySeconds, 'Between report status checks and downloads (rate limiting)');

                    const downloadResult = await this.circuitBreaker.execute(
                        () => this._downloadInitialPullReport(cronDetailID, seller, reportId, documentId, range, reportType, authOverrides, retry, user),
                        { sellerId: seller.idSellerAccount, operation: 'downloadInitialPullReport' }
                    );

                    return {
                        ...downloadResult,
                        reportDocumentID: documentId,
                        skipped: true
                    };
                    
                } else if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') {
                    const delaySeconds = await DelayHelpers.calculateBackoffDelay(attempt, `Initial Pull Status Check (${range.range})`);
                    
                    await model.logCronActivity({
                        cronJobID: cronDetailID,
                        reportType,
                        action: retry ? 'Initial Pull - Retry Check Status' : 'Initial Pull - Check Status',
                        status: 0,
                        message: `Report ${status} for ${range.range}, waiting ${delaySeconds}s`,
                        reportID: reportId,
                        Range: range.range,
                        iInitialPull: 1,
                        retryCount: currentRetry,
                        executionTime: (Date.now() - startTime) / 1000
                    });
                    
                    await DelayHelpers.wait(delaySeconds, `Initial Pull Status Retry (${range.range})`);
                    throw new Error(`Report still ${status} - retrying`);
                    
                } else if (status === 'FATAL' || status === 'CANCELLED') {

                    logger.fatal({ 
                        cronDetailID: cronDetailID, 
                        reportType, 
                        status, 
                    }, `Initial Pull - Report ${status} - Permanent failure for ${range.range}`);
                    

                    await model.logCronActivity({
                        cronJobID: cronDetailID,
                        reportType,
                        action: retry ? 'Initial Pull - Retry Check Status' : 'Initial Pull - Check Status',
                        status: 3,
                        message: `Report ${status} for ${range.range}`,
                        reportID: reportId,
                        Range: range.range,
                        iInitialPull: 1,
                        executionTime: (Date.now() - startTime) / 1000
                    });
                    
                    const requestDelaySeconds = Number(process.env.REQUEST_DELAY_SECONDS) || 30;
                    await DelayHelpers.wait(requestDelaySeconds, 'Between report status checks and fatal/cancelled (rate limiting)');

                    throw new Error(`Report status: ${status}`);
                }
            }
        });
        
        return result;
    }

    /**
     * Download initial pull report (Step 3: Download)
     */
    async _downloadInitialPullReport(cronDetailID, seller, reportId, documentId, range, reportType, authOverrides = {}, retry = false, user = null) {
        const result = await RetryHelpers.executeWithRetry({
            cronDetailID,
            amazonSellerID: seller.AmazonSellerID,
            reportType,
            action: retry ? 'Initial Pull - Retry Download Report' : 'Initial Pull - Download Report',
            context: { seller, reportId, documentId, range, reportType, user },
            model,
            sendFailureNotification: (cronDetailID, amazonSellerID, reportType, errorMessage, retryCount, reportId, isFatalError, range) => {
                return sendFailureNotification({
                    cronDetailID,
                    amazonSellerID,
                    reportType,
                    errorMessage,
                    retryCount,
                    reportId,
                    isFatalError,
                    range,
                    model,
                    NotificationHelpers,
                    env,
                    context: 'Initial Pull'
                });
            },
            maxRetries: 3, // Strict limit of 3 retries per report
            skipIfMaxRetriesReached: true, // Now safe to check because each range is tracked independently
            extraLogFields: {
                Range: range.range,
                iInitialPull: 1
            },            
            operation: async ({ attempt, currentRetry, context, startTime }) => {
                const { seller, reportId, documentId, range, reportType, retry, user } = context;
                const downloadStartTime = dates.getNowDateTimeInUserTimezone().db;
                const timezone = await model.getUserTimezone(user);
                logger.info({ reportId, documentId, range: range.range, attempt, timezone }, 'Starting initial pull download');
                
                // Set ProcessRunningStatus = 3 (Download) and update start date
                await model.setProcessRunningStatus(cronDetailID, reportType, 3);
                
                // Log download start
                await model.logCronActivity({
                    cronJobID: cronDetailID,
                    reportType,
                    action: retry ? 'Initial Pull - Retry Download Report' : 'Initial Pull - Download Report',
                    status: 1,
                    message: `Starting download for ${range.range}`,
                    reportID: reportId,
                    reportDocumentID: documentId,
                    Range: range.range,
                    iInitialPull: 1
                });
                
                // Update download status
                await downloadUrls.updateDownloadUrlStatusByCriteria(
                    cronDetailID,
                    reportType,
                    'DOWNLOADING',
                    null,
                    null,
                    null,
                    true,
                    reportId
                );
                
                // Get access token
                const currentAuthOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID);
                if (!currentAuthOverrides.accessToken) {				
                    logger.error({ amazonSellerID: seller.AmazonSellerID, attempt, timezone }, 'No access token available for request');
                    
                    // API Logger - Failed Download (No Token)
                    const userId = user ? user.ID : null;
                    apiLogger.logDownload({
                        userId,
                        sellerId: seller.AmazonSellerID,
                        sellerAccountId: seller.idSellerAccount,
                        reportId,
                        reportDocumentId: documentId,
                        reportType,
                        range: range.range,
                        fileUrl: null,
                        filePath: null,
                        fileSize: 0,
                        rowCount: 0,
                        downloadPayload: { documentId: documentId || reportId },
                        startTime: downloadStartTime,
                        endTime: dates.getNowDateTimeInUserTimezone().log,
                        executionTime: (Date.now() - startTime) / 1000,
                        status: 'failure',
                        error: { message: 'No access token available for report request but retry again on catch block' },
                        retryCount: currentRetry,
                        attempt
                    });
                    
                    throw new Error('No access token available for report request but retry again on catch block');
                }
                
                // Download report with force refresh+retry on 401/403
                let res;
                let downloadError = null;
                try {
                    res = await sp.downloadReport(seller, documentId || reportId, currentAuthOverrides);
                } catch (err) {
                    const status = err.status || err.statusCode || err.response?.status;
                    if (status === 401 || status === 403) {
                        const refreshedOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID, true);
                        if(!refreshedOverrides.accessToken) {
                            logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for request after forced refresh');
                            downloadError = new Error('No access token available for report request after forced refresh');
                            
                            // API Logger - Failed Download (No Token After Refresh)
                            const userId = user ? user.ID : null;
                            apiLogger.logDownload({
                                userId,
                                sellerId: seller.AmazonSellerID,
                                sellerAccountId: seller.idSellerAccount,
                                reportId,
                                reportDocumentId: documentId,
                                reportType,
                                range: range.range,
                                fileUrl: null,
                                filePath: null,
                                fileSize: 0,
                                rowCount: 0,
                                downloadPayload: { documentId: documentId || reportId },
                                startTime: downloadStartTime,
                                endTime: dates.getNowDateTimeInUserTimezone().log,
                                executionTime: (Date.now() - startTime) / 1000,
                                status: 'failure',
                                error: downloadError,
                                retryCount: currentRetry,
                                attempt
                            });
                            
                            throw downloadError;
                        }
                        res = await sp.downloadReport(seller, documentId || reportId, refreshedOverrides);
                    } else {
                        downloadError = err;
                        throw err;
                    }
                }
                
                // Extract data
                let data = [];
                if (Array.isArray(res?.data)) {
                    data = res.data;
                } else if (Array.isArray(res?.data?.records)) {
                    data = res.data.records;
                } else if (Array.isArray(res?.data?.dataByAsin)) {
                    data = res.data.dataByAsin;
                }
                
                logger.info({ rows: data.length, range: range.range, attempt }, 'Initial pull report data received');
                // Set ProcessRunningStatus = 4 (Process Import)
                await model.setProcessRunningStatus(cronDetailID, reportType, 4);

                if (data.length > 0) {
                    // Save JSON file
                    const downloadMeta = { 
                        AmazonSellerID: seller.AmazonSellerID, 
                        ReportType: reportType, 
                        ReportID: documentId || reportId,
                        SellerID: seller.idSellerAccount,
                        UserID: user ? user.ID : null
                    };
                    let filePath = null;
                    let fileSize = 0;
                    const downloadEndTime = dates.getNowDateTimeInUserTimezone().log;
                    
                    try {
                        const saveResult = await jsonSvc.saveReportJsonFile(downloadMeta, data);
                        filePath = saveResult?.path || saveResult?.url || null;
                        if (filePath) {
                            const fs = require('fs');
                            const stat = await fs.promises.stat(filePath).catch(() => null);
                            fileSize = stat ? stat.size : 0;
                            logger.info({ filePath, fileSize, range: range.range }, 'Initial pull JSON saved');
                        }
                        
                        // API Logger - Successful Download with Data
                        const userId = user ? user.ID : null;
                        apiLogger.logDownload({
                            userId,
                            sellerId: seller.AmazonSellerID,
                            sellerAccountId: seller.idSellerAccount,
                            reportId,
                            reportDocumentId: documentId,
                            reportType,
                            range: range.range,
                            fileUrl: res?.url || null,
                            filePath,
                            fileSize,
                            rowCount: data.length,
                            downloadPayload: { documentId: documentId || reportId },
                            startTime: downloadStartTime,
                            endTime: downloadEndTime,
                            executionTime: (Date.now() - startTime) / 1000,
                            status: 'success',
                            error: downloadError,
                            retryCount: currentRetry,
                            attempt
                        });
                        
                    } catch (fileErr) {
                        logger.warn({ error: fileErr.message, range: range.range }, 'Failed to save JSON file');
                        
                        // API Logger - Download Success but File Save Failed
                        const userId = user ? user.ID : null;
                        apiLogger.logDownload({
                            userId,
                            sellerId: seller.AmazonSellerID,
                            sellerAccountId: seller.idSellerAccount,
                            reportId,
                            reportDocumentId: documentId,
                            reportType,
                            range: range.range,
                            fileUrl: res?.url || null,
                            filePath: null,
                            fileSize: 0,
                            rowCount: data.length,
                            downloadPayload: { documentId: documentId || reportId },
                            startTime: downloadStartTime,
                            endTime: dates.getNowDateTimeInUserTimezone().log,
                            executionTime: (Date.now() - startTime) / 1000,
                            status: 'partial_success',
                            error: fileErr,
                            retryCount: currentRetry,
                            attempt
                        });
                    }
                    
                    // Update download URL record with completed status
                    await downloadUrls.updateDownloadUrlStatusByCriteria(
                        cronDetailID,
                        reportType,
                        'COMPLETED',
                        null,          // errorMessage
                        filePath,      // filePath
                        fileSize,      // fileSize
                        false,         // incrementAttempts
                        reportId       // reportID
                    );
                    
                    // Log download report action (download in progress)
                    await model.logCronActivity({
                        cronJobID: cronDetailID,
                        reportType,
                        action: retry ? 'Initial Pull - Retry Download Report' : 'Initial Pull - Download Report',
                        status: 1,
                        message: `Downloading report for ${range.range}`,
                        reportID: reportId,
                        reportDocumentID: documentId,
                        Range: range.range,
                        iInitialPull: 1,
                        executionTime: (Date.now() - startTime) / 1000
                    });
                    
                    // Now import the data immediately (Step 4: Import)
                    const newRow = await downloadUrls.getCompletedDownloadsWithFiles({ cronDetailID, ReportType: reportType, ReportID: reportId });
                    
                    if (newRow.length > 0) {
                        try {
                            
                            // Convert to plain object and enrich with required fields
                            const plainRow = newRow[0].toJSON ? newRow[0].toJSON() : newRow[0];
                            const enrichedRow = { ...plainRow, AmazonSellerID: seller.AmazonSellerID, ReportID: reportId, SellerID: seller.idSellerAccount };
                            
                            logger.info({ 
                                cronDetailID,
                                reportType,
                                range: range.range,
                                filePath 
                            }, retry ? 'Starting initial pull import (retry)' : 'Starting initial pull import', 'Starting initial pull import');
                            
                            // Import JSON data into database
                            const importResult = await jsonSvc.__importJson(enrichedRow, 0, 0, 1, timezone);
                            
                            logger.info({ 
                                cronDetailID,
                                reportType,
                                range: range.range,
                                importResult 
                            }, retry ? 'Initial pull import completed successfully (retry)' : 'Initial pull import completed successfully', 'Initial pull import completed successfully');
                            
                            //await model.updateSQPReportStatus(cronDetailID, reportType, 0, null, dates.getNowDateTimeInUserTimezone().db);
                            
                            // Log import success
                            await model.logCronActivity({
                                cronJobID: cronDetailID,
                                reportType,
                                action: retry ? 'Initial Pull - Import Done (retry)' : 'Initial Pull - Import Done',
                                status: 1,
                                message: `Imported data for ${range.range}`,
                                reportID: reportId,
                                reportDocumentID: documentId,
                                Range: range.range,
                                iInitialPull: 1,
                                executionTime: (Date.now() - startTime) / 1000
                            });

                        } catch (importError) {
                            logger.error({ 
                                error: importError ? (importError.message || String(importError)) : 'Unknown error',
                                stack: importError?.stack,
                                cronDetailID,
                                reportType,
                                range: range.range,
                                retry
                            }, retry ? 'Error during initial pull import - file saved but import failed (retry)' : 'Error during initial pull import - file saved but import failed', 'Error during initial pull import - file saved but import failed');
                            
                            //await model.updateSQPReportStatus(cronDetailID, reportType, 0, null, dates.getNowDateTimeInUserTimezone().db);
                            
                            // Log import failure
                            await model.logCronActivity({
                                cronJobID: cronDetailID,
                                reportType,
                                action: retry ? 'Initial Pull - Import Failed (retry)' : 'Initial Pull - Import Failed',
                                status: 2,
                                message: `Import failed for ${range.range}: ${importError.message}`,
                                reportID: reportId,
                                reportDocumentID: documentId,
                                Range: range.range,
                                iInitialPull: 1,
                                executionTime: (Date.now() - startTime) / 1000
                            });
                            // Don't throw - file is saved, import can be retried later
                        }
                    } 
                    
                    return {
                        action: 'Initial Pull - Download and Import Done',
                        message: `Downloaded and imported ${data.length} rows for ${range.range}`,
                        reportID: reportId,
                        data: { rows: data.length, filePath, fileSize, range: range.range },
                        logData: {
                            Range: range.range,
                            iInitialPull: 1
                        },
                        skipped: true
                    };
                } else {
                    // No data returned from report (0 rows)
                    logger.warn({ 
                        reportId, 
                        documentId, 
                        range: range.range,
                        retry
                    }, 'Report returned 0 rows - no search query data for this period');
                    
                    // API Logger - Download with No Data
                    const userId = user ? user.ID : null;
                    apiLogger.logDownload({
                        userId,
                        sellerId: seller.AmazonSellerID,
                        sellerAccountId: seller.idSellerAccount,
                        reportId,
                        reportDocumentId: documentId,
                        reportType,
                        range: range.range,
                        fileUrl: res?.url || null,
                        filePath: null,
                        fileSize: 0,
                        rowCount: 0,
                        downloadPayload: { documentId: documentId || reportId },
                        startTime: downloadStartTime,
                        endTime: dates.getNowDateTimeInUserTimezone().log,
                        executionTime: (Date.now() - startTime) / 1000,
                        status: 'success',
                        error: null,
                        retryCount: currentRetry,
                        attempt
                    });
                    
                    // Update download status as completed but with no data
                    await downloadUrls.updateDownloadUrlStatusByCriteria(
                        cronDetailID,
                        reportType,
                        'COMPLETED',
                        'No data in report',
                        null,          // filePath
                        0,             // fileSize
                        false,         // incrementAttempts
                        reportId       // reportID - IMPORTANT!
                    );

                    const SqpDownloadUrls = getSqpDownloadUrls();
                    // Find latest row for this CronJobID+ReportType
                    const latest = await SqpDownloadUrls.findOne({
                        where: { CronJobID: cronDetailID, ReportType: reportType, ReportID: reportId },
                        order: [['dtUpdatedOn', 'DESC']]
                    });
                    if (latest) {                        
                        // Update download URLs process status to SUCCESS
                        await downloadUrls.updateProcessStatusById(latest.ID, 'SUCCESS', {
                            ProcessAttempts: 1,
                            LastProcessAt: dates.getNowDateTimeInUserTimezone().db,
                            fullyImported: 1
                        });
                    }
                    
                    // Set ProcessRunningStatus = 4 (Import) even though no data
                    await model.setProcessRunningStatus(cronDetailID, reportType, 4);                    
                    await model.updateSQPReportStatus(cronDetailID, reportType, 0, null, dates.getNowDateTimeInUserTimezone().db);
                    
                    // Log import done (nothing to import but process complete)
                    await model.logCronActivity({
                        cronJobID: cronDetailID,
                        reportType,
                        action: retry ? 'Initial Pull - Import Done (retry)' : 'Initial Pull - Import Done',
                        status: 1,
                        message: `No data to import for ${range.range} (report was empty)`,
                        reportID: reportId,
                        reportDocumentID: documentId,
                        Range: range.range,
                        iInitialPull: 1,
                        executionTime: (Date.now() - startTime) / 1000
                    });
                    
                    return {
                        action: 'Initial Pull - Download and Import Done',
                        message: `No data for ${range.range}`,
                        reportID: reportId,
                        data: { rows: 0, range: range.range },
                        logData: {
                            Range: range.range,
                            iInitialPull: 1
                        },
                        skipped: true
                    };
                }
            }
        });
        
        return result;
    }

    /**
     * Find failed initial pull records
     * @returns {Promise<Array>} Failed records that need retry
     */
    async findFailedInitialPullRecords(user = null) {
        const SqpCronDetails = getSqpCronDetails();
        
        // Calculate time (6 hours ago)
        const cutoffTime = dates.getNowDateTimeInUserTimezoneAgo(new Date(), { hours: 6 });
        
        logger.info({ cutoffTime: cutoffTime }, 'Scanning for records stuck since cutoff time');
                
        // Find initial pull records with failed status (3)
        const failedRecords = await SqpCronDetails.findAll({
            where: {
                iInitialPull: 1,                
                [Op.or]: [                    
                    {
                        [Op.and]: [
                            { cronRunningStatus: { [Op.in]: [1, 3, 4] } },
                            { WeeklyProcessRunningStatus: { [Op.in]: [1, 2, 3, 4] } },
                            { WeeklySQPDataPullStatus: { [Op.in]: [0, 2] } },
                            {
                                [Op.or]: [
                                    { dtUpdatedOn: { [Op.lte]: literal(`'${cutoffTime}'`) } },
                                    literal('dtUpdatedOn < dtCronStartDate')
                                ]
                            }
                            
                        ]
                    },
                    {
                        [Op.and]: [
                            { cronRunningStatus: { [Op.in]: [1, 3, 4] } },
                            { MonthlyProcessRunningStatus: { [Op.in]: [1, 2, 3, 4] } },
                            { MonthlySQPDataPullStatus: { [Op.in]: [0,2] } },
                            {
                                [Op.or]: [
                                    { dtUpdatedOn: { [Op.lte]: literal(`'${cutoffTime}'`) } },
                                    literal('dtUpdatedOn < dtCronStartDate')
                                ]
                            }
                        ]
                    },
                    {
                        [Op.and]: [
                            { cronRunningStatus: { [Op.in]: [1, 3, 4] } },
                            { QuarterlyProcessRunningStatus: { [Op.in]: [1, 2, 3, 4] } },
                            { QuarterlySQPDataPullStatus: { [Op.in]: [0,2] } },
                            {
                                [Op.or]: [
                                    { dtUpdatedOn: { [Op.lte]: literal(`'${cutoffTime}'`) } },
                                    literal('dtUpdatedOn < dtCronStartDate')
                                ]
                            }
                        ]
                    }
                ]
            },
            attributes: [
                'ID', 'AmazonSellerID', 'ASIN_List', 'dtCreatedOn', 'dtUpdatedOn', 'SellerID',
                'cronRunningStatus', 'WeeklyProcessRunningStatus', 'WeeklySQPDataPullStatus', 'WeeklySQPDataPullEndDate', 'WeeklySQPDataPullStartDate',
                'MonthlyProcessRunningStatus', 'MonthlySQPDataPullStatus', 'MonthlySQPDataPullEndDate', 'MonthlySQPDataPullStartDate',
                'QuarterlyProcessRunningStatus', 'QuarterlySQPDataPullStatus', 'QuarterlySQPDataPullEndDate', 'QuarterlySQPDataPullStartDate'
            ],
            limit: 1
        });
        
        // Enrich records with failed report types and get related logs
        const SqpCronLogs = getSqpCronLogs();
        
        const enrichedRecords = await Promise.all(failedRecords.map(async (record) => {
            let stuckReportTypes = [];
            
            // Check which report types failed (status 0 = pending, status 2 = error/stuck)
            if (record.WeeklySQPDataPullStatus === 0 || record.WeeklySQPDataPullStatus === 2) {
                stuckReportTypes.push('WEEK');
            }
            if (record.MonthlySQPDataPullStatus === 0 || record.MonthlySQPDataPullStatus === 2) {
                stuckReportTypes.push('MONTH');
            }
            if (record.QuarterlySQPDataPullStatus === 0 || record.QuarterlySQPDataPullStatus === 2) {
                stuckReportTypes.push('QUARTER');
            }
            
            // Get failed log entries from sqp_cron_logs for this record
            // Exclude FATAL and CANCELLED messages
            const failedLogs = await SqpCronLogs.findAll({
                where: {
                  CronJobID: record.ID,
                  iInitialPull: 1,
                  [Op.and]: [
                    {
                      [Op.or]: [
                        {
                          Status: { [Op.in]: [0, 2, 3] },
                        },
                        {
                          Status: 1,
                          Action: { [Op.like]: '%Request Report%' }
                        }
                      ]
                    },
                    { Message: { [Op.notLike]: '%FATAL%' } },
                    { Message: { [Op.notLike]: '%CANCELLED%' } }
                  ]
                },
                order: [['dtCreatedOn', 'ASC']],
                limit: 70
            });
              
              
            if(failedLogs.length > 0) {
                return {    
                    ...record.toJSON(),            
                    stuckReportTypes,
                    failedCount: stuckReportTypes.length,
                    failedLogs: failedLogs.map(log => ({
                        action: log.Action,
                        iInitialPull: log.iInitialPull,
                        cronJobID: log.CronJobID,
                        reportType: log.ReportType,
                        status: log.Status,
                        message: log.Message,
                        range: log.Range,
                        retryCount: log.RetryCount,
                        reportId: log.ReportID,
                        createdOn: log.dtCreatedOn,
                        reportDocumentID: log.ReportDocumentID,
                        executionTime: log.ExecutionTime
                    }))
                };
            }
        }));
        
        // Filter out undefined records (records with no failed logs)
        const validRecords = enrichedRecords.filter(r => r !== undefined && r !== null);
        
        logger.info({ 
            totalFailedRecords: validRecords.length,
            totalFailedReports: validRecords.reduce((sum, r) => sum + r.failedCount, 0)
        }, 'Failed initial pull records scan complete');
        
        
        return validRecords;
    }

}

module.exports = new InitialPullService();

