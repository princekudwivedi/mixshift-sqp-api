/**
 * Initial Pull Controller
 * Handles historical ASIN data pulling (6 weeks, 35 months, 7 quarters)
 */

const { SuccessHandler, ErrorHandler } = require('../middleware/response.handlers');
const { loadDatabase } = require('../db/tenant.db');
const { ValidationHelpers, CircuitBreaker, RateLimiter, MemoryMonitor, NotificationHelpers, RetryHelpers, DelayHelpers } = require('../helpers/sqp.helpers');
const { getAllAgencyUserList } = require('../models/sequelize/user.model');
const { getModel: getSellerAsinList } = require('../models/sequelize/sellerAsinList.model');
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
                            const hasEligible = await model.hasEligibleASINs(seller.idSellerAccount);
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

            const SellerAsinList = getSellerAsinList();
            const asins = await SellerAsinList.findAll({
                where: { AmazonSellerID: seller.AmazonSellerID, IsActive: 1, InitialPullStatus: null },
                attributes: ['ASIN', 'InitialPullStatus'],
                limit: 15,
                raw: true
            });

            if (asins.length === 0) return;

            const asinList = asins.map(a => a.ASIN);            
            const cronDetailRow = await model.createSQPCronDetail(
                seller.AmazonSellerID,
                asinList.join(' '),
                {
                    iInitialPull: 1,
                    FullWeekRange: ranges.fullWeekRange,
                    FullMonthRange: ranges.fullMonthRange,
                    FullQuarterRange: ranges.fullQuarterRange,
                    SellerName: seller.SellerName || seller.MerchantAlias || `Seller_${seller.AmazonSellerID}`
                }
            );
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
                    asinList
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

                        // // PHASE 2: Wait then check status for all reports
                        // const initialDelaySeconds = Number(process.env.INITIAL_DELAY_SECONDS) || 30;
                        // await DelayHelpers.wait(initialDelaySeconds, 'After report request');
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
                () => this._checkAllInitialPullStatuses(cronDetailRow, seller, reportRequests, asinList, authOverrides),
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
            context: { seller, asinList, range, reportType },
            model,
            sendFailureNotification: this._sendInitialPullFailureNotification.bind(this),
            skipIfMaxRetriesReached: false, // Each initial pull report is independent
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
                const currentAuthOverrides = { ...authOverrides };
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
                    await model.updateSQPReportStatus(cronDetailID, reportType, 0, reportId, null, null, null, new Date());
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
    async _checkAllInitialPullStatuses(cronDetailRow, seller, reportRequests, asinList = null, authOverrides = {}) {
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
                            authOverrides
                        ),
                        { sellerId: seller.idSellerAccount, operation: 'checkInitialPullReportStatus' }
                    );
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
            
            // Update overall initial pull status (DO NOT update LastSQPDataPull* fields - those are for regular cron)
            try {
                if (totalFailed > 0) {
                    // If any report failed, mark as failed
                    await asinInitialPull.markInitialPullFailed(
                        seller.AmazonSellerID,
                        asinList
                    );
                    
                    logger.warn({
                        totalSuccess,
                        totalFailed,
                        totalReports: reportRequests.length,
                        amazonSellerID: seller.AmazonSellerID
                    }, 'Marked initial pull as failed');
                } else if (totalSuccess === reportRequests.length && reportRequests.length > 0) {
                    // If all reports succeeded, mark as completed
                    await asinInitialPull.markInitialPullCompleted(
                        seller.AmazonSellerID,
                        asinList
                    );
                    
                    logger.info({
                        totalSuccess,
                        totalReports: reportRequests.length,
                        amazonSellerID: seller.AmazonSellerID
                    }, 'Marked initial pull as completed');
                }
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
     * Check initial pull report status (Step 2: Check Status)
     */
    async _checkInitialPullReportStatus(cronDetailID, seller, reportId, range, reportType, authOverrides = {}) {
        const result = await RetryHelpers.executeWithRetry({
            cronDetailID,
            amazonSellerID: seller.AmazonSellerID,
            reportType,
            action: 'Initial Pull - Check Status',
            context: { seller, reportId, range, reportType },
            model,
            sendFailureNotification: this._sendInitialPullFailureNotification.bind(this),
            skipIfMaxRetriesReached: false, // Each initial pull report is independent
            extraLogFields: {
                Range: range.range,
                iInitialPull: 1
            },
            operation: async ({ attempt, currentRetry, context, startTime }) => {
                const { seller, reportId, range, reportType } = context;
                // Set ProcessRunningStatus = 2 (Status Check)
                await model.setProcessRunningStatus(cronDetailID, reportType, 2);
                // Get access token
                const currentAuthOverrides = { ...authOverrides };
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
                    await model.updateSQPReportStatus(cronDetailID, reportType, 1, reportId, null, documentId);
                    
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
                        action: 'Initial Pull - Check Status',
                        status: 1,
                        message: `Report ready: ${range.range}`,
                        reportID: reportId,
                        reportDocumentID: documentId,
                        Range: range.range,
                        iInitialPull: 1,
                        executionTime: (Date.now() - startTime) / 1000
                    });
                    
                    await this.circuitBreaker.execute(
                        () => this._downloadInitialPullReport(cronDetailID, seller, reportId, documentId, range, reportType, authOverrides),
                        { sellerId: seller.idSellerAccount, operation: 'downloadInitialPullReport' }
                    );
                    
                    return {
                        message: `Report ready. Document ID: ${documentId}. Range: ${range.range}`,
                        reportID: reportId,
                        reportDocumentID: documentId,
                        data: { status, documentId, range: range.range },
                        logData: {
                            Range: range.range,
                            iInitialPull: 1
                        }
                    };
                    
                } else if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') {
                    const delaySeconds = await DelayHelpers.calculateBackoffDelay(attempt, `Initial Pull Status Check (${range.range})`);
                    
                    await model.logCronActivity({
                        cronJobID: cronDetailID,
                        reportType,
                        action: 'Initial Pull - Check Status',
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
                        action: 'Initial Pull - Check Status',
                        status: 3,
                        message: `Report ${status} for ${range.range}`,
                        reportID: reportId,
                        Range: range.range,
                        iInitialPull: 1,
                        executionTime: (Date.now() - startTime) / 1000
                    });
                    throw new Error(`Report status: ${status}`);
                }
            }
        });
        
        return result;
    }

    /**
     * Download initial pull report (Step 3: Download)
     */
    async _downloadInitialPullReport(cronDetailID, seller, reportId, documentId, range, reportType, authOverrides = {}) {
        const result = await RetryHelpers.executeWithRetry({
            cronDetailID,
            amazonSellerID: seller.AmazonSellerID,
            reportType,
            action: 'Initial Pull - Download Report',
            context: { seller, reportId, documentId, range, reportType },
            model,
            sendFailureNotification: this._sendInitialPullFailureNotification.bind(this),
            skipIfMaxRetriesReached: false, // Each initial pull report is independent
            extraLogFields: {
                Range: range.range,
                iInitialPull: 1
            },
            operation: async ({ attempt, currentRetry, context, startTime }) => {
                const { seller, reportId, documentId, range, reportType } = context;
                
                logger.info({ reportId, documentId, range: range.range, attempt }, 'Starting initial pull download');
                
                // Set ProcessRunningStatus = 3 (Download) and update start date
                await model.setProcessRunningStatus(cronDetailID, reportType, 3);
                
                // Log download start
                await model.logCronActivity({
                    cronJobID: cronDetailID,
                    reportType,
                    action: 'Initial Pull - Download Report',
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
                    reportId  // Pass reportId to match the correct record
                );
                
                // Get access token
                const currentAuthOverrides = { ...authOverrides };
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
                        action: 'Initial Pull - Download Report',
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
                            const enrichedRow = { ...plainRow, AmazonSellerID: seller.AmazonSellerID, ReportID: reportId };
                            
                            logger.info({ 
                                cronDetailID,
                                reportType,
                                range: range.range,
                                filePath 
                            }, 'Starting initial pull import');
                            
                            // Import JSON data into database
                            const importResult = await jsonSvc.__importJson(enrichedRow, 0, 0, 1);
                            
                            logger.info({ 
                                cronDetailID,
                                reportType,
                                range: range.range,
                                importResult 
                            }, 'Initial pull import completed successfully');
                            
                            // Update status to success (1) after successful import
                            await model.updateSQPReportStatus(cronDetailID, reportType, 1, reportId, null, documentId, 1, null, new Date());
                            
                            // Log import success
                            await model.logCronActivity({
                                cronJobID: cronDetailID,
                                reportType,
                                action: 'Initial Pull - Import Done',
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
                                range: range.range
                            }, 'Error during initial pull import - file saved but import failed');
                            
                            // Update status to failed (3) after import failure
                            await model.updateSQPReportStatus(cronDetailID, reportType, 3, reportId, importError.message, documentId, 1, null, new Date());
                            
                            // Log import failure
                            await model.logCronActivity({
                                cronJobID: cronDetailID,
                                reportType,
                                action: 'Initial Pull - Import Failed',
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
                        message: `Downloaded and imported ${data.length} rows for ${range.range}`,
                        reportID: reportId,
                        data: { rows: data.length, filePath, fileSize, range: range.range },
                        logData: {
                            Range: range.range,
                            iInitialPull: 1
                        }
                    };
                } else {
                    // No data returned from report (0 rows)
                    logger.warn({ 
                        reportId, 
                        documentId, 
                        range: range.range 
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
                    await model.updateSQPReportStatus(cronDetailID, reportType, 1, reportId, null, documentId, 1, null, new Date());
                    
                    // Log import done (nothing to import but process complete)
                    await model.logCronActivity({
                        cronJobID: cronDetailID,
                        reportType,
                        action: 'Initial Pull - Import Done',
                        status: 1,
                        message: `No data to import for ${range.range} (report was empty)`,
                        reportID: reportId,
                        reportDocumentID: documentId,
                        Range: range.range,
                        iInitialPull: 1,
                        executionTime: (Date.now() - startTime) / 1000
                    });
                    
                    return {
                        message: `No data for ${range.range}`,
                        reportID: reportId,
                        data: { rows: 0, range: range.range },
                        logData: {
                            Range: range.range,
                            iInitialPull: 1
                        }
                    };
                }
            }
        });
        
        return result;
    }

    /**
     * Send failure notification for initial pull
     */
    async _sendInitialPullFailureNotification(cronDetailID, amazonSellerID, reportType, errorMessage, retryCount, reportId = null, isFatalError = false) {
        try {
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
                message: `NOTIFICATION: Initial pull failed after ${retryCount} attempts. ${notificationReason}. Error: ${errorMessage}`,
                reportID: reportId,
                iInitialPull: 1,
                retryCount: retryCount,
                executionTime: 0
            });
            
            // Send email if configured
            const to = NotificationHelpers.parseList(process.env.NOTIFY_TO || env.NOTIFY_TO);
            const cc = NotificationHelpers.parseList(process.env.NOTIFY_CC || env.NOTIFY_CC);
            const bcc = NotificationHelpers.parseList(process.env.NOTIFY_BCC || env.NOTIFY_BCC);
            
            if ((to.length + cc.length + bcc.length) > 0) {
                const subject = isFatalError 
                    ? `⚠️ Initial Pull FATAL Error - ${reportType} - ${amazonSellerID}`
                    : `⚠️ Initial Pull Failed - ${reportType} - ${amazonSellerID}`;
                
                const html = `
                    <h3>Initial Pull Report Failure</h3>
                    <p><strong>Cron Detail ID:</strong> ${cronDetailID}</p>
                    <p><strong>Amazon Seller ID:</strong> ${amazonSellerID}</p>
                    <p><strong>Report Type:</strong> ${reportType}</p>
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
     * Check cron limits and active sellers count
     * @param {number} userId 
     * @param {number} totalActiveCronSellers - Total active cron sellers across all users
     * @returns {Promise<{activeCronSellers: number, shouldProcess: boolean}>}
     */
    async checkCronLimits(userId) {
        try {
            const largeAgencyFlag = process.env.LARGE_AGENCY_FLAG === 'true';
            // Check active cron sellers for this user
            const activeCRONSellerAry = await model.checkCronDetailsOfSellersByDate(0, 0, true, 1);            
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

}

module.exports = new InitialPullController();


