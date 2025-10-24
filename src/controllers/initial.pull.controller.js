/**
 * Initial Pull Controller
 * Handles historical ASIN data pulling (6 weeks, 35 months, 7 quarters)
 */

const { SuccessHandler, ErrorHandler } = require('../middleware/response.handlers');
const { initDatabaseContext, loadDatabase } = require('../db/tenant.db');
const { ValidationHelpers, CircuitBreaker, RateLimiter, MemoryMonitor, NotificationHelpers, RetryHelpers, DelayHelpers, Helpers } = require('../helpers/sqp.helpers');
const retryHelpers = new RetryHelpers();
const { getAllAgencyUserList } = require('../models/sequelize/user.model');
const { getModel: getSellerAsinList } = require('../models/sequelize/sellerAsinList.model');
const { getModel: getSqpCronDetails } = require('../models/sequelize/sqpCronDetails.model');
const { getModel: getSqpCronLogs } = require('../models/sequelize/sqpCronLogs.model');
const sellerModel = require('../models/sequelize/seller.model');
const model = require('../models/sqp.cron.model');
const sp = require('../spapi/client.spapi');
const initialPullService = require('../services/initial.pull.service');
const authService = require('../services/auth.service');
const jsonSvc = require('../services/sqp.json.processing.service');
const downloadUrls = require('../models/sqp.download.urls.model');
const asinInitialPull = require('../models/sellerAsinList.initial.pull.model');
const logger = require('../utils/logger.utils');
const env = require('../config/env.config');
const isDevEnv = ["local", "development"].includes(env.NODE_ENV);
const allowedUsers = [8,3];
const { getModel: getSqpDownloadUrls } = require('../models/sequelize/sqpDownloadUrls.model');
const { Op, literal } = require('sequelize');

class InitialPullController {

    constructor() {
        // Initialize efficiency helpers
        this.circuitBreaker = new CircuitBreaker(
            Number(process.env.CIRCUIT_BREAKER_THRESHOLD) || 5,
            Number(process.env.CIRCUIT_BREAKER_TIMEOUT_MS) || 60000
        );
        this.rateLimiter = new RateLimiter(
            Number(process.env.API_RATE_LIMIT_PER_MINUTE) || 100,
            Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000
        );
        // MemoryMonitor uses static methods, no instance needed
    }   
    
    /**
     * Run initial pull for all users or specific user/seller
     * Pulls historical data: 6 weeks, 35 months, 7 quarters
     * 
     * Query params:
     * - userId: Process specific user (optional)
     * - sellerId: Process specific seller (optional)
     * - reportType: WEEK, MONTH, or QUARTER (optional)
     */
    async runInitialPull(req, res) {
        try {
            const { userId, sellerId, reportType } = req.query;
            // Validate inputs
            const validatedUserId = userId ? ValidationHelpers.validateUserId(userId) : null;
            const validatedSellerId = sellerId ? ValidationHelpers.validateUserId(sellerId) : null;   

            logger.info({ validatedUserId, validatedSellerId, reportType}, 'Initial pull triggered via API');

            let loop = env.TYPE_ARRAY;

            // Validate reportType if provided
            if (reportType && !loop.includes(reportType)) {
                return ErrorHandler.sendError(
                    res, 
                    new Error('Invalid reportType'), 
                    'reportType must be ' + loop.join(', '),
                    400
                );
            }

            // Process in background
            this._processInitialPull(validatedUserId, validatedSellerId, reportType)
                .catch(error => {
                    logger.error({ error: error.message }, 'Error in initial pull background process');
                });

            const weeksToPull = env.WEEKS_TO_PULL || 2;
            const monthsToPull = env.MONTHS_TO_PULL || 2;
            const quartersToPull = env.QUARTERS_TO_PULL || 2;
            const totalReports = weeksToPull + monthsToPull + quartersToPull;
            
            return SuccessHandler.sendSuccess(res, {
                message: 'Initial pull started',
                processing: 'Background processing initiated',
                params: { userId, sellerId, reportType },
                configuration: {
                    weeks: weeksToPull,
                    months: monthsToPull,
                    quarters: quartersToPull,
                    totalReportsPerSeller: totalReports
                },
                note: `Historical data pull: ${weeksToPull} weeks, ${monthsToPull} months, ${quartersToPull} quarters (${totalReports} total requests per seller)`
            }, 'Initial pull started successfully');

        } catch (error) {
            logger.error({ error: error.message }, 'Error starting initial pull');
            return ErrorHandler.sendError(res, error, 'Failed to start initial pull');
        }
    }

    /**
     * Process initial pull for users and sellers
     */
    async _processInitialPull(validatedUserId, validatedSellerId, reportType) {
        return initDatabaseContext(async () => {
            try {
                await loadDatabase(0);
                const users = validatedUserId ? [{ ID: parseInt(validatedUserId) }] : await getAllAgencyUserList();
                let breakUserProcessing = false;
                for (const user of users) {
                    try {
                        if (isDevEnv && !allowedUsers.includes(user.ID)) {
                            continue;
                        }
                        logger.info({ userId: user.ID }, 'Process user started');
                        await loadDatabase(user.ID);
                        // Check cron limits for this user
                        const cronLimits = await Helpers.checkCronLimits(user.ID, 1);
                        logger.info({ cronLimits }, 'cronLimits');
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
                                    () => this._startInitialPullForSeller(seller, reportType, authOverrides),
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
    async _startInitialPullForSeller(seller, reportType = null, authOverrides = {}) {
        try {
            const ranges = initialPullService.calculateFullRanges();
            
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
                    cronDetailRow.ID
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
                                authOverrides
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
                () => this._checkAllInitialPullStatuses(cronDetailRow, seller, reportRequests, asinList, authOverrides, false),
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
    async _requestInitialPullReport(cronDetailID, seller, asinList, range, reportType, authOverrides = {}) {
        const result = await RetryHelpers.executeWithRetry({
            cronDetailID,
            amazonSellerID: seller.AmazonSellerID,
            reportType,
            action: 'Initial Pull - Request Report',
            context: { seller, asinList, range, reportType, reportId: null },
            model,
            sendFailureNotification: this._sendInitialPullFailureNotification.bind(this),
            maxRetries: 3, // Strict limit of 3 retries per report
            skipIfMaxRetriesReached: true, // Now safe to check because each range is tracked independently
            // Pass these to RetryHelpers so attempt logs have correct values
            extraLogFields: {
                Range: range.range,
                iInitialPull: 1
            },
            operation: async ({ attempt, currentRetry, context, startTime }) => {
                const { seller, asinList, range, reportType } = context;
                
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
                const currentAuthOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID);
                if (!currentAuthOverrides.accessToken) {
                    logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for request');
                    throw new Error('No access token available for report request');
                }

                // Create report via SP-API
                const resp = await sp.createReport(seller, payload, currentAuthOverrides);
                const reportId = resp.reportId;
                
                logger.info({ reportId, range: range.range, attempt }, 'Initial pull report created');
                
                // Update status column based on report type with start date
                const startDate = range.startDate;
                
                if(range.range !== '' && range.range !== null && range.range !== undefined){
                    await model.updateSQPReportStatus(cronDetailID, reportType, 0, new Date());
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

    /**
     * Check status for all initial pull reports (Phase 2)
     */
    async _checkAllInitialPullStatuses(cronDetailRow, seller, reportRequests, asinList = null, authOverrides = {}, retry = false) {
        try {
            logger.info({ 
                cronDetailID: cronDetailRow.ID,
                totalReports: reportRequests.length 
            }, 'Checking status for all initial pull reports');
            
            // Track overall success/failure
            let totalSuccess = 0;
            let totalFailed = 0;
            // Check status for each report individually with its specific reportId
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
                            retry
                        ),
                        { sellerId: seller.idSellerAccount, operation: 'checkInitialPullReportStatus' }
                    );

                    const requestDelaySeconds = Number(process.env.REQUEST_DELAY_SECONDS) || 30;
                    await DelayHelpers.wait(requestDelaySeconds, 'Between report status checks (rate limiting)');

                    totalSuccess++;
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
            
            // Update status per report type and overall ASIN status
            try {
                await this._updateInitialPullFinalStatus(cronDetailRow.ID, seller.AmazonSellerID, asinList);
            } catch (statusError) {
                logger.error({
                    error: statusError.message,
                    amazonSellerID: seller.AmazonSellerID
                }, 'Failed to update initial pull status');
            }
            
        } catch (error) {
            logger.error({ error: error.message }, 'Error in _checkAllInitialPullStatuses');
        }
    }

    /**
     * Update final status per report type based on all report results
     * Implements complex logic for determining status based on completion/failure/in-progress counts
     * Works for both initial pull and retry - automatically fetches all data from logs
     */
    async _updateInitialPullFinalStatus(cronDetailID, amazonSellerID, asinList) {
        try {
            const SqpCronDetails = getSqpCronDetails();
            const SqpCronLogs = getSqpCronLogs();
            
            // Get all report requests for this cronDetail from logs
            const allLogs = await SqpCronLogs.findAll({
                where: {
                    CronJobID: cronDetailID,
                    iInitialPull: 1,
                    ReportID: { [Op.ne]: null }
                },
                attributes: ['ReportID', 'ReportType', 'Range'],
                group: ['ReportID', 'ReportType', 'Range']
            });
            
            // Convert logs to reportRequests format
            const reportRequests = allLogs.map(log => ({
                reportId: log.ReportID,
                type: log.ReportType,
                range: { range: log.Range }
            }));
            let SellerID = '';
            
            const cronDetail = await SqpCronDetails.findOne({
                where: { ID: cronDetailID },
                attributes: ['ASIN_List', 'AmazonSellerID', 'SellerID']
            });

            if (cronDetail) {
                // Get ASIN list if not provided
                if (!asinList || asinList.length === 0) {
                    asinList = asinList && asinList.length ? asinList : (cronDetail.ASIN_List?.split(/\s+/).filter(Boolean) || []);
                }
                amazonSellerID = amazonSellerID || cronDetail.AmazonSellerID;
                SellerID = cronDetail.SellerID;
            }
            // Group requests by type
            const typeGroups = {
                WEEK: reportRequests.filter(r => r.type === 'WEEK'),
                MONTH: reportRequests.filter(r => r.type === 'MONTH'),
                QUARTER: reportRequests.filter(r => r.type === 'QUARTER')
            };
            
            let overallAsinStatus = 2; // Default to completed
            
            // Check each report type
            for (const [reportType, requests] of Object.entries(typeGroups)) {
                if (requests.length === 0) continue;
                
                const prefix = model.mapPrefix(reportType);
                
                // Get all logs for this type to check individual report statuses
                const logs = await SqpCronLogs.findAll({
                    where: {
                        CronJobID: cronDetailID,
                        ReportType: reportType,
                        iInitialPull: 1,
                        ReportID: { [Op.ne]: null }
                    },
                    attributes: ['ReportID', 'Status', 'Action', 'Message'],
                    order: [['dtUpdatedOn', 'DESC']]
                });
                
                // Count statuses
                let doneCount = 0;
                let fatalCount = 0;
                let inProgressCount = 0;
                
                // Get unique report IDs
                const uniqueReportIds = [...new Set(requests.map(r => r.reportId))];
                
                for (const reportId of uniqueReportIds) {
                    if (!reportId) {
                        inProgressCount++;
                        continue;
                    }
                    
                    // Find all logs for this reportId
                    const reportLogs = logs.filter(l => l.ReportID === reportId);
                    
                    if (reportLogs.length === 0) {
                        inProgressCount++;
                        continue;
                    }
                    
                    // Debug logging
                    logger.info({
                        reportId,
                        reportType,
                        logCount: reportLogs.length,
                        actions: reportLogs.map(l => l.Action),
                        statuses: reportLogs.map(l => l.Status)
                    }, 'Analyzing report status');
                    
                    const latestLog = reportLogs[0];
                    
                    // Check if this report completed successfully
                    // Look for status 1
                    const isDone = reportLogs.some(l => 
                        (l.Status === 1)
                    );
                    
                    // Check if this report failed fatally
                    const isFatal = reportLogs.some(l =>
                        (l.Message && (l.Message.includes('FATAL') || l.Message.includes('CANCELLED')))
                    );
                    
                    // Check if still in progress (latest status is 0 or 2 and not done/fatal)
                    const isInProgress = !isDone && !isFatal && (latestLog.Status === 0 || latestLog.Status === 2 || latestLog.Message.includes('Failure Notification'));
                    
                    logger.info({
                        reportId,
                        isDone,
                        isFatal,
                        isInProgress,
                        latestStatus: latestLog.Status,
                        latestAction: latestLog.Action
                    }, 'Report classification');
                    
                    if (isDone) {
                        doneCount++;
                    } else if (isFatal) {
                        fatalCount++;
                    } else if (isInProgress) {
                        inProgressCount++;
                    }
                }
                
                const totalReports = uniqueReportIds.length;
                
                logger.info({
                    reportType,
                    totalReports,
                    doneCount,
                    fatalCount,
                    inProgressCount
                }, 'Report type status summary');
                
                // Determine status for this report type
                let dataPullStatus;
                let processRunningStatus;
                let cronRunningStatus;
                
                if (doneCount === totalReports) {
                    // All reports done
                    dataPullStatus = 1; // Completed
                    processRunningStatus = 4; // Import done
                    cronRunningStatus = 2; // Cron running status completed
                    logger.info({ reportType }, 'All reports completed successfully');
                    
                } else if (fatalCount > 0 && inProgressCount === 0) {
                    // Some fatal, none in progress, rest done
                    dataPullStatus = 3; // Failed
                    processRunningStatus = 2; // Last was status check
                    overallAsinStatus = 3; // Mark ASIN as failed
                    cronRunningStatus = 2; // Cron running status completed
                    logger.warn({ reportType, fatalCount, totalReports }, 'Some reports failed fatally');
                    
                } else if (inProgressCount > 0 && fatalCount === 0) {
                    // Some in progress, none fatal
                    dataPullStatus = 2; // Error/Stuck
                    processRunningStatus = 2; // Status check
                    overallAsinStatus = 3; // Mark ASIN as failed (stuck)
                    cronRunningStatus = 3; // Cron running retry mark
                    logger.warn({ reportType, inProgressCount, totalReports }, 'Some reports still in progress');
                    
                } else if (fatalCount > 0 && inProgressCount > 0) {
                    // Mixed: some fatal, some in progress
                    dataPullStatus = 2; // Error/Stuck
                    processRunningStatus = 2; // Status check
                    overallAsinStatus = 3; // Mark ASIN as failed
                    cronRunningStatus = 3; // Cron running retry mark
                    logger.warn({ reportType, fatalCount, inProgressCount, totalReports }, 'Mixed status: some fatal, some in progress');
                    
                    // Update sqp_cron_logs: FATAL entries get Status = 4
                    const fatalReportIds = [];
                    for (const reportId of uniqueReportIds) {
                        const reportLogs = logs.filter(l => l.ReportID === reportId);
                        const isFatal = reportLogs.some(l => 
                            l.Message && (l.Message.includes('FATAL') || l.Message.includes('CANCELLED'))
                        );
                        if (isFatal) {
                            fatalReportIds.push(reportId);
                        }
                    }
                    
                    if (fatalReportIds.length > 0) {
                        await SqpCronLogs.update(
                            { Status: 4 }, // Mark FATAL reports with status 4
                            { 
                                where: { 
                                    CronJobID: cronDetailID,
                                    ReportType: reportType,
                                    ReportID: { [Op.in]: fatalReportIds },
                                    iInitialPull: 1
                                }
                            }
                        );
                        logger.info({ reportType, fatalReportIds }, 'Marked FATAL report logs with status 4');
                    }
                } else {
                    // Default to error/stuck
                    dataPullStatus = 2;
                    processRunningStatus = 2;
                    overallAsinStatus = 3;
                    cronRunningStatus = 2;
                }
                
                // Update the report type status in sqp_cron_details
                await SqpCronDetails.update(
                    {
                        [`${prefix}SQPDataPullStatus`]: dataPullStatus,
                        [`${prefix}ProcessRunningStatus`]: processRunningStatus,
                        cronRunningStatus: cronRunningStatus
                    },
                    { where: { ID: cronDetailID } }
                );
                
                logger.info({
                    reportType,
                    dataPullStatus,
                    processRunningStatus
                }, 'Updated report type status in sqp_cron_details');
            }
            
            // Update seller_ASIN_list.InitialPullStatus
            if (overallAsinStatus === 2) {
                await asinInitialPull.markInitialPullCompleted(amazonSellerID, asinList, SellerID, cronDetailID);
                logger.info({ amazonSellerID, asinCount: asinList.length }, 'Marked initial pull as completed for ASINs');
            } else {
                await asinInitialPull.markInitialPullFailed(amazonSellerID, asinList, SellerID, cronDetailID);
                logger.warn({ amazonSellerID, asinCount: asinList.length }, 'Marked initial pull as failed for ASINs');
            }
            
        } catch (error) {
            logger.error({ error: error.message }, 'Error in _updateInitialPullFinalStatus');
            throw error;
        }
    }

    /**
     * Check initial pull report status (Step 2: Check Status)
     */
    async _checkInitialPullReportStatus(cronDetailID, seller, reportId, range, reportType, authOverrides = {}, retry = false) {
        const result = await RetryHelpers.executeWithRetry({
            cronDetailID,
            amazonSellerID: seller.AmazonSellerID,
            reportType,
            action: retry ? 'Initial Pull - Retry Check Status' : 'Initial Pull - Check Status',
            context: { seller, reportId, range, reportType, retry },
            model,
            sendFailureNotification: this._sendInitialPullFailureNotification.bind(this),
            maxRetries: 3, // Strict limit of 3 retries per report
            skipIfMaxRetriesReached: true, // Now safe to check because each range is tracked independently
            extraLogFields: {
                Range: range.range,
                iInitialPull: 1
            },
            operation: async ({ attempt, currentRetry, context, startTime }) => {
                const { seller, reportId, range, reportType, retry } = context;
                // Set ProcessRunningStatus = 2 (Status Check)
                await model.setProcessRunningStatus(cronDetailID, reportType, 2);
                // Get access token
                const currentAuthOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID);
                if (!currentAuthOverrides.accessToken) {				
                    logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for request');
                    throw new Error('No access token available for report request');
                }
                // Check report status
                const res = await sp.getReportStatus(seller, reportId, currentAuthOverrides);
                const status = res.processingStatus;
                if (status === 'DONE') {
                    const documentId = res.reportDocumentId || null;
                    
                    // Update status to indicate report is ready (status 1)
                    await model.updateSQPReportStatus(cronDetailID, reportType, 1);
                    
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
                        () => this._downloadInitialPullReport(cronDetailID, seller, reportId, documentId, range, reportType, authOverrides, retry),
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
                    await model.updateSQPReportStatus(cronDetailID, reportType, 3);
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
    async _downloadInitialPullReport(cronDetailID, seller, reportId, documentId, range, reportType, authOverrides = {}, retry = false) {
        const result = await RetryHelpers.executeWithRetry({
            cronDetailID,
            amazonSellerID: seller.AmazonSellerID,
            reportType,
            action: retry ? 'Initial Pull - Retry Download Report' : 'Initial Pull - Download Report',
            context: { seller, reportId, documentId, range, reportType },
            model,
            sendFailureNotification: this._sendInitialPullFailureNotification.bind(this),
            maxRetries: 3, // Strict limit of 3 retries per report
            skipIfMaxRetriesReached: true, // Now safe to check because each range is tracked independently
            extraLogFields: {
                Range: range.range,
                iInitialPull: 1
            },            
            operation: async ({ attempt, currentRetry, context, startTime }) => {
                const { seller, reportId, documentId, range, reportType, retry } = context;
                
                logger.info({ reportId, documentId, range: range.range, attempt }, 'Starting initial pull download');
                
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
                    logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for request');
                    throw new Error('No access token available for report request');
                }
                
                // Download report
                const res = await sp.downloadReport(seller, documentId || reportId, currentAuthOverrides);
                
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
                        ReportID: documentId || reportId
                    };
                    let filePath = null;
                    let fileSize = 0;
                    
                    try {
                        const saveResult = await jsonSvc.saveReportJsonFile(downloadMeta, data);
                        filePath = saveResult?.path || saveResult?.url || null;
                        if (filePath) {
                            const fs = require('fs');
                            const stat = await fs.promises.stat(filePath).catch(() => null);
                            fileSize = stat ? stat.size : 0;
                            logger.info({ filePath, fileSize, range: range.range }, 'Initial pull JSON saved');
                        }
                    } catch (fileErr) {
                        logger.warn({ error: fileErr.message, range: range.range }, 'Failed to save JSON file');
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
                            const importResult = await jsonSvc.__importJson(enrichedRow, 0, 0, 1);
                            
                            logger.info({ 
                                cronDetailID,
                                reportType,
                                range: range.range,
                                importResult 
                            }, retry ? 'Initial pull import completed successfully (retry)' : 'Initial pull import completed successfully', 'Initial pull import completed successfully');
                            
                            // Update status to success (1) after successful import
                            await model.updateSQPReportStatus(cronDetailID, reportType, 1, null, new Date());
                            
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
                            
                            // Update status to failed (3) after import failure
                            await model.updateSQPReportStatus(cronDetailID, reportType, 3, null, new Date());
                            
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
                            LastProcessAt: new Date(),
                            fullyImported: 1
                        });
                    }
                    
                    // Set ProcessRunningStatus = 4 (Import) even though no data
                    await model.setProcessRunningStatus(cronDetailID, reportType, 4);
                    
                    // Update cron detail status to success (1) with end date
                    await model.updateSQPReportStatus(cronDetailID, reportType, 1, null, new Date());
                    
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
     * Send failure notification for initial pull
     */
    async _sendInitialPullFailureNotification(cronDetailID, amazonSellerID, reportType, errorMessage, retryCount, reportId = null, isFatalError = false, range = null) {
        try {
            // Extract range from context if available
            const rangeStr = range?.range || range || 'Unknown Range';
            
            const notificationType = isFatalError ? 'INITIAL PULL - FATAL ERROR' : 'INITIAL PULL - MAX RETRIES REACHED';
            const notificationReason = isFatalError 
                ? 'Amazon returned FATAL/CANCELLED status - no retries attempted'
                : `Max retries (${retryCount}) exhausted`;
            
            logger.error({
                cronDetailID,
                amazonSellerID,
                reportType,
                errorMessage,
                retryCount,
                isFatalError,
                notificationType
            }, `INITIAL PULL FAILURE - ${notificationType}`);
            
            await model.logCronActivity({
                cronJobID: cronDetailID,
                reportType: reportType,
                action: 'Initial Pull - Failure Notification',
                status: 2,
                message: `NOTIFICATION: Initial pull failed after ${retryCount} attempts for ${rangeStr}. ${notificationReason}. Error: ${errorMessage}`,
                reportID: reportId,
                iInitialPull: 1,
                retryCount: retryCount,
                executionTime: 0,
                Range: rangeStr // ✅ Add Range to create unique entries
            });
            
            // Send email if configured
            const to = NotificationHelpers.parseList(process.env.NOTIFY_TO || env.NOTIFY_TO);
            const cc = NotificationHelpers.parseList(process.env.NOTIFY_CC || env.NOTIFY_CC);
            const bcc = NotificationHelpers.parseList(process.env.NOTIFY_BCC || env.NOTIFY_BCC);
            
            if ((to.length + cc.length + bcc.length) > 0) {
                const subject = isFatalError 
                    ? `⚠️ Initial Pull FATAL Error - ${reportType} (${rangeStr}) - ${amazonSellerID}`
                    : `⚠️ Initial Pull Failed - ${reportType} (${rangeStr}) - ${amazonSellerID}`;
                
                const html = `
                    <h3>Initial Pull Report Failure</h3>
                    <p><strong>Cron Detail ID:</strong> ${cronDetailID}</p>
                    <p><strong>Amazon Seller ID:</strong> ${amazonSellerID}</p>
                    <p><strong>Report Type:</strong> ${reportType}</p>
                    <p><strong>Date Range:</strong> ${rangeStr}</p>
                    <p><strong>Report ID:</strong> ${reportId || 'N/A'}</p>
                    <p><strong>Retry Count:</strong> ${retryCount}</p>
                    <p><strong>Error:</strong> ${errorMessage}</p>
                    <p><strong>Reason:</strong> ${notificationReason}</p>
                    <p><strong>Time:</strong> ${new Date().toISOString()}</p>
                    <p>Please check the logs for more details.</p>
                `;
                
                await NotificationHelpers.sendEmail({ to, cc, bcc, subject, html });
            }
        } catch (err) {
            logger.error({ error: err.message }, 'Failed to send initial pull failure notification');
        }
    }   

    /**
     * Find failed initial pull records
     * @returns {Promise<Array>} Failed records that need retry
     */
    async findFailedInitialPullRecords() {
        const SqpCronDetails = getSqpCronDetails();
        
        // Calculate time (10 hours ago)
        const cutoffTime = new Date();
        cutoffTime.setHours(cutoffTime.getHours() - 10);
        
        logger.info({ cutoffTime: cutoffTime.toISOString() }, 'Scanning for records stuck since cutoff time');
                
        // Find initial pull records with failed status (3)
        const failedRecords = await SqpCronDetails.findAll({
            where: {
                iInitialPull: 1,                
                [Op.or]: [
                    { cronRunningStatus: 3},
                    {
                        [Op.and]: [
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
                            { MonthlyProcessRunningStatus: { [Op.in]: [1, 2, 3, 4] } },
                            { MonthlySQPDataPullStatus: { [Op.in]: [0,2] } },
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
                            { QuarterlyProcessRunningStatus: { [Op.in]: [1, 2, 3, 4] } },
                            { QuarterlySQPDataPullStatus: { [Op.in]: [0,2] } },
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
                'ID', 'AmazonSellerID', 'ASIN_List', 'dtCreatedOn', 'dtUpdatedOn',
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
                          Status: { [Op.in]: [0, 2] },
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
                order: [['dtCreatedOn', 'DESC']],
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

    /**
     * Retry failed initial pull reports
     * This will reset the failed status and re-run the status check and download
     */
    async retryFailedInitialPull(req, res) {
        try {
            const { userId, sellerId, cronDetailID } = req.query;

            const validatedUserId = userId ? ValidationHelpers.validateUserId(userId) : null;
            const validatedSellerId = sellerId ? ValidationHelpers.validateUserId(sellerId) : null;
            const validatedCronDetailID = cronDetailID ? ValidationHelpers.validateCronDetailID(cronDetailID) : null;
            
            logger.info({ userId: validatedUserId, sellerId: validatedSellerId, cronDetailID: validatedCronDetailID }, 'Retry failed initial pull triggered via API');

            SuccessHandler.sendSuccess(res, {
                message: 'Retry failed initial pull started',
                userId: validatedUserId,
                sellerId: validatedSellerId,
                cronDetailID: validatedCronDetailID
            }, 'Retry started successfully');

            // Process in background
            this._processRetryFailedInitialPull(validatedUserId, validatedSellerId, validatedCronDetailID)
                .then(result => {
                    logger.info({ result }, 'Retry failed initial pull completed');
                })
                .catch(error => {
                    logger.error({ error: error.message }, 'Error in retry failed initial pull');
                });

        } catch (error) {
            logger.error({ error: error.message }, 'Failed to start retry failed initial pull');
            return ErrorHandler.sendError(res, error, 'Failed to start retry failed initial pull');
        }
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
                        if (isDevEnv && !allowedUsers.includes(user.ID)) {
                            continue;
                        }
                        
                        await loadDatabase(user.ID);
                        
                        // Find failed records
                        let failedRecords = await this.findFailedInitialPullRecords();
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
                                    
                                    // Reset the failed status to pending (0) to allow retry
                                    await model.updateSQPReportStatus(log.cronJobID, log.reportType, 0, null, null, 4, true);
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
                                    
                                    const result = await this.retryStuckRecord(rec, log.reportType, authOverrides, log);
                                    
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
    async retryStuckRecord(record, reportType, authOverrides, recordLog) {
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
                    true // retry flag
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
            
            await model.updateSQPReportStatus(cronDetailID, reportType, 3);
            
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
            
            // Mark as failed
            await model.updateSQPReportStatus(cronDetailID, reportType, 3);
            
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
}

module.exports = new InitialPullController();
