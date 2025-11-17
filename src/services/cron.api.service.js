/**
 * Cron API Service
 
 */

const { MemoryMonitor, RetryHelpers, Helpers,DelayHelpers, CircuitBreaker, RateLimiter } = require('../helpers/sqp.helpers');
const { initDatabaseContext, loadDatabase } = require('../db/tenant.db');
const { getAllAgencyUserList } = require('../models/sequelize/user.model');
const sellerModel = require('../models/sequelize/seller.model');
const ctrl = require('../controllers/sqp.cron.controller');
const model = require('../models/sqp.cron.model');
const { getModel: getSqpCronDetails } = require('../models/sequelize/sqpCronDetails.model');
const { getModel: getSqpCronLogs } = require('../models/sequelize/sqpCronLogs.model');
const asinInitialPull = require('../models/sellerAsinList.initial.pull.model');
const { Op, literal } = require('sequelize');
const logger = require('../utils/logger.utils');
const { isUserAllowed, isValidSellerID, sanitizeLogData } = require('../utils/security.utils');
const env = require('../config/env.config');
const isDevEnv = ["local", "development","production"].includes(env.NODE_ENV);
const authService = require('../services/auth.service');
const dates = require('../utils/dates.utils');

class CronApiService {
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
    }
    
    /**
     * Process all cron operations
     */
    async processAllCronOperations(validatedUserId, validatedSellerId) {
        return this._processAllCronOperations(validatedUserId, validatedSellerId);
    }

    /**
     * Process retry notifications
     */
    async processRetryNotifications(validatedUserId) {
        return this._processRetryNotifications(validatedUserId);
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
                                        () => ctrl.requestForSeller(s, authOverrides, env.GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT, user),
                                        { sellerId: s.idSellerAccount, operation: 'requestForSeller' }
                                    );

                                    totalProcessed++;

                                    if (cronDetailIDs.length > 0) {
                                        await DelayHelpers.wait(Number(process.env.INITIAL_DELAY_SECONDS) || 30, 'Before status check');
                                        // Step 2: Check status with circuit breaker protection
                                        try {
                                            await this.circuitBreaker.execute(
                                                () => ctrl.checkReportStatuses(authOverrides, { cronDetailID: cronDetailIDs, cronDetailData: cronDetailData, user: user }),
                                                { sellerId: s.idSellerAccount, operation: 'checkReportStatuses' }
                                            );
                                            totalProcessed++;
                                        } catch (error) {
                                            logger.error({ error: error.message, cronDetailID: cronDetailIDs }, 'Error checking report statuses (scoped)');
                                            totalErrors++;
                                        }                                        
                                    }
                                    
                                    if (cronDetailIDs.length === 0) {
                                        logger.info({ 
                                            sellerId: s.idSellerAccount, 
                                            amazonSellerID: s.AmazonSellerID,
                                        }, 'All report types are skipping. No report types are allowed to be requested.');
                                    } else {
                                        logger.info({ 
                                            sellerId: s.idSellerAccount, 
                                            amazonSellerID: s.AmazonSellerID,
                                            cronDetailIDs,
                                            processed: totalProcessed,
                                            errors: totalErrors
                                        }, 'Completed processing for seller - exiting cron run');
                                    }
                                    
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
                }, 'Error in processAllCronOperations');
            }
        });
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
                                    const rr = await this.retryStuckRecord(rec, type, authOverrides, user);
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
        const cutoffTime = dates.getNowDateTimeInUserTimezoneAgo(new Date(), { hours: 1 });
        
        logger.info({ cutoffTime: cutoffTime }, 'Scanning for records stuck since cutoff time');
        
        // Find records that are stuck in progress or pending status
        // Include records where dtUpdatedOn < dtCronStartDate (stale/stuck)
        const stuckRecords = await SqpCronDetails.findAll({
            where: {
                iInitialPull: 0,
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
                            { MonthlySQPDataPullStatus: { [Op.in]: [0, 2] } },
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
                            { QuarterlySQPDataPullStatus: { [Op.in]: [0, 2] } },
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
                'ID', 'AmazonSellerID', 'dtCronStartDate', 'dtCreatedOn', 'dtUpdatedOn','SellerID', 'ASIN_List',
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
     * Retry a stuck record's pipeline for a specific report type, then finalize status.
     */
    async retryStuckRecord(record, reportType, authOverrides, user) {
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
        const prefix = model.mapPrefix(reportType);
        const startDate = dates.getNowDateTimeInUserTimezone().db;
        // Build update data
        const updateData = {
            [`${prefix}LastSQPDataPullStatus`]: 1,
            [`${prefix}LastSQPDataPullStartTime`]: startDate,
            [`${prefix}LastSQPDataPullEndTime`]: null,
            dtUpdatedOn: dates.getNowDateTimeInUserTimezone().db
        };
        await asinInitialPull.updateInitialPullStatusByASIN(record.AmazonSellerID, record.ASIN_List, record.SellerID, updateData);

        await model.updateSQPReportStatus(record.ID, reportType, 2, startDate, null, 4, true); // 4 is retry mark running status
        let res = null;
        try {
            res = await ctrl.checkReportStatuses(authOverrides, { cronDetailID: [record.ID], reportType: reportType, cronDetailData: [record], user: user }, true);
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
            await model.updateSQPReportStatus(record.ID, reportType, 3, null, dates.getNowDateTimeInUserTimezone().db, 2);
            
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
            
            logger.warn({ id: record.ID, reportType }, 'Retry failed - marked for retry');
            return { cronDetailID: record.ID, amazonSellerID: record.AmazonSellerID, reportType, retried: true, success: false, fatal: false };
        }
    }
}

module.exports = new CronApiService();

