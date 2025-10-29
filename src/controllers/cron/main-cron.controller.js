/**
 * Main Cron Controller (Refactored)
 * Thin controller layer - delegates to services
 * Handles regular SQP data pulling for current periods
 */

const { SuccessHandler, ErrorHandler } = require('../../middleware/response.handlers');
const { initDatabaseContext } = require('../../db/tenant.db');
const ValidationUtils = require('../../utils/validation.utils');
const { processUserSellerCombination, buildAuthWithRateLimit } = require('../../utils/cron.processing.utils');
const reportOps = require('../../services/cron/report-operations.service');
const asinService = require('../../services/cron/asin-management.service');
const model = require('../../models/sqp.cron.model');
const downloadUrls = require('../../models/sqp.download.urls.model');
const jsonSvc = require('../../services/sqp.json.processing.service');
const sellerModel = require('../../models/sequelize/seller.model');
const logger = require('../../utils/logger.utils');
const env = require('../../config/env.config');
const { CircuitBreaker, RateLimiter, DelayHelpers } = require('../../helpers/sqp.helpers');
const { Op } = require('sequelize');

class MainCronController {
    constructor() {
        this.circuitBreaker = new CircuitBreaker(
            Number(process.env.CIRCUIT_BREAKER_THRESHOLD) || 5,
            Number(process.env.CIRCUIT_BREAKER_TIMEOUT_MS) || 60000
        );
        this.rateLimiter = new RateLimiter(
            Number(process.env.API_RATE_LIMIT_PER_MINUTE) || 100,
            Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000
        );
    }

    /**
     * API Endpoint: Run main cron
     * GET /api/v1/main-cron?userId=X&sellerId=Y
     */
    async runMainCron(req, res) {
        try {
            const { userId, sellerId } = req.query;

            // Validate inputs
            if (userId) {
                const validation = ValidationUtils.validateUserId(userId);
                if (!validation.valid) {
                    return ErrorHandler.sendValidationError(res, [validation.error]);
                }
            }

            if (sellerId) {
                const validation = ValidationUtils.validateSellerId(sellerId);
                if (!validation.valid) {
                    return ErrorHandler.sendValidationError(res, [validation.error]);
                }
            }

            logger.info({ userId, sellerId }, 'Main cron triggered via API');

            // Process in background
            this._processMainCron(userId, sellerId)
                .catch(error => {
                    logger.error({ error: error.message }, 'Error in main cron background process');
                });

            const reportTypes = env.TYPE_ARRAY || ['WEEK', 'MONTH', 'QUARTER'];

            return SuccessHandler.sendSuccess(res, {
                message: 'Main cron started',
                processing: 'Background processing initiated',
                params: { userId, sellerId },
                configuration: {
                    reportTypes
                }
            }, 'Main cron started successfully');

        } catch (error) {
            logger.error({ error: error.message }, 'Error starting main cron');
            return ErrorHandler.sendError(res, error, 'Failed to start main cron');
        }
    }

    /**
     * Internal: Process main cron
     */
    async _processMainCron(userId, sellerId) {
        return initDatabaseContext(async () => {
            try {
                const result = await processUserSellerCombination({
                    validatedUserId: userId,
                    validatedSellerId: sellerId,
                    isInitialPull: false,
                    checkCronLimits: true,
                    checkMemory: true,
                    checkEligibleAsins: true,
                    breakAfterFirst: true,
                    sellerCallback: async (seller) => {
                        // Process this seller
                        //await this._processSeller(seller);
                        logger.info({ seller }, 'Processing seller');
                        logger.info({ totalProcessed, totalErrors, shouldBreak }, 'Seller result');
                        return { processed: true, error: false, shouldBreak: true };
                    }
                });

                logger.info({ result }, 'Main cron processing completed');

            } catch (error) {
                logger.error({ error: error.message }, 'Error in _processMainCron');
                throw error;
            }
        });
    }

    /**
     * Process single seller for main cron
     */
    async _processSeller(seller) {
        try {
            logger.info({
                sellerId: seller.idSellerAccount,
                amazonSellerID: seller.AmazonSellerID
            }, 'Starting main cron for seller');

            // 1. Get eligible ASINs            
            const { asins:asinList, reportTypes:reportTypeList } = await asinService.getEligibleAsins({
                sellerId: seller.idSellerAccount,
                isInitialPull: false
            });

            if (asinList.length === 0 && reportTypeList.length === 0) {
                logger.info({ sellerId: seller.idSellerAccount }, 'No eligible ASINs for main cron');
                return;
            }

            const datesUtils = require('../../utils/dates.utils');
            const weekRange = datesUtils.getDateRangeForPeriod('WEEK');
			const monthRange = datesUtils.getDateRangeForPeriod('MONTH');
			const quarterRange = datesUtils.getDateRangeForPeriod('QUARTER');
			const FullWeekRange = `${weekRange.start} to ${weekRange.end}`;
			const FullMonthRange = `${monthRange.start} to ${monthRange.end}`;
			const FullQuarterRange = `${quarterRange.start} to ${quarterRange.end}`;
			

            // 2. Create cron detail record
            const cronDetailRow = await model.createSQPCronDetail(seller.AmazonSellerID, asinList.join(','), seller.idSellerAccount, { SellerName: seller.SellerName, FullWeekRange: FullWeekRange, FullMonthRange: FullMonthRange, FullQuarterRange: FullQuarterRange });

            logger.info({ cronDetailID: cronDetailRow.ID }, 'Cron detail created');

            
            // 3. Build auth overrides with rate limiting
            const authOverrides = await buildAuthWithRateLimit(seller, this.rateLimiter);

            // 4. Request reports for all types
            for (const reportType of reportTypeList) {
                try {
                    // Use ReportOperationsService
                    const result = await reportOps.requestReport({
                        seller,
                        asinList,
                        range,
                        reportType,
                        authOverrides,
                        cronDetailID: cronDetailRow.ID,
                        model,
                        isInitialPull: true
                    });

                    const reportID = result?.reportID || result?.data?.reportId;
                    if (reportID) {
                        reportRequests.push({
                            reportType,
                            range,
                            cronDetailID: cronDetailRow.ID,
                            reportId: reportID
                        });

                        logger.info({
                            reportId: reportID,
                            reportType,
                            range: range.range
                        }, 'Report requested successfully');
                    }


                } catch (error) {
                    logger.error({
                        cronDetailID: cronDetailRow.ID,
                        reportType: reportType,
                        error: error.message
                    }, 'Failed to process report type');
                }
            }

            logger.info({
                cronDetailID: cronDetailRow.ID,
                amazonSellerID: seller.AmazonSellerID
            }, 'Main cron completed for seller');

        } catch (error) {
            logger.error({
                error: error.message,
                seller: seller.AmazonSellerID
            }, 'Error in _processSeller');
            throw error;
        }


        // 8. Wait for reports to be ready
        const initialDelay = Number(process.env.INITIAL_DELAY_SECONDS) || 30;
        await this._wait(initialDelay);

        // 9. Check status and download all reports
        await this._checkAndDownloadReports(
            cronDetailRow,
            seller,
            reportRequests,
            asinList,
            authOverrides
        );

        logger.info({
            cronDetailID: cronDetailRow.ID,
            amazonSellerID: seller.AmazonSellerID
        }, 'Main cron completed for seller');
    }

    /**
     * Get current date range for report type
     */
    _getCurrentRange(reportType) {
        const now = new Date();
        const dateUtils = require('../../utils/dates.utils');

        if (reportType === 'WEEK') {
            return dateUtils.getCurrentWeekRange();
        } else if (reportType === 'MONTH') {
            return dateUtils.getCurrentMonthRange();
        } else if (reportType === 'QUARTER') {
            return dateUtils.getCurrentQuarterRange();
        }

        throw new Error(`Unknown report type: ${reportType}`);
    }

    /**
     * Check status and download all reports
     */
    async _checkAndDownloadReports(cronDetailRow, seller, reportRequests, asinList, authOverrides) {
        try {
            logger.info({
                cronDetailID: cronDetailRow.ID,
                reportCount: reportRequests.length
            }, 'Checking status for all reports');
            
            for (const request of reportRequests) {
                try {
                    // Check status using ReportOperationsService
                    const statusResult = await reportOps.checkReportStatus({
                        seller,
                        reportId: request.reportId,
                        range: request.range,
                        reportType: request.reportType,
                        authOverrides,
                        cronDetailID: cronDetailRow.ID,
                        model,
                        downloadUrls,
                        isInitialPull: false
                    });
                    
                    if (statusResult.status === 'DONE') {
                        // Download using ReportOperationsService
                        await reportOps.downloadReport({
                            seller,
                            reportId: request.reportId,
                            documentId: statusResult.documentId,
                            range: request.range,
                            reportType: request.reportType,
                            authOverrides,
                            cronDetailID: cronDetailRow.ID,
                            model,
                            downloadUrls,
                            jsonSvc,
                            isInitialPull: false
                        });

                        logger.info({
                            reportId: request.reportId,
                            reportType: request.reportType
                        }, 'Report downloaded and imported successfully');
                    }
                } catch (error) {
                    logger.error({
                        cronDetailID: cronDetailRow.ID,
                        reportType: request.reportType,
                        error: error.message
                    }, 'Failed to process report type');
                }
            }

            logger.info({
                cronDetailID: cronDetailRow.ID,
                amazonSellerID: seller.AmazonSellerID
            }, 'Main cron completed for seller');

        } catch (error) {
            logger.error({
                error: error.message,
                seller: seller.AmazonSellerID
            }, 'Error in _checkAndDownloadReports');
            throw error;
        }
    }

    /**
     * API Endpoint: Retry failed notifications
     * GET /api/v1/retry-report?userId=X
     */
    async retryNotifications(req, res) {
        try {
            const { userId } = req.query;

            // Validate userId if provided
            if (userId) {
                const validation = ValidationUtils.validateUserId(userId);
                if (!validation.valid) {
                    return ErrorHandler.sendValidationError(res, [validation.error]);
                }
            }

            logger.info({ userId }, 'Retry notifications triggered');

            // Process in background
            this._processRetryNotifications(userId)
                .catch(error => {
                    logger.error({ error: error.message }, 'Error in retry notifications background process');
                });

            return SuccessHandler.sendSuccess(res, {
                message: 'Notification retry started',
                processing: 'Background processing initiated',
                params: { userId }
            }, 'Notification retry started successfully');

        } catch (error) {
            logger.error({ error: error.message }, 'Error starting retry notifications');
            return ErrorHandler.sendError(res, error, 'Failed to start retry notifications');
        }
    }

    /**
     * Internal: Process retry notifications
     */
    async _processRetryNotifications(userId) {
        return initDatabaseContext(async () => {
            try {
                // Use status check service
                const statusCheckService = require('../../services/cron/status-check.service');
                
                await statusCheckService.checkReportStatuses({}, { retryNotifications: true }, true);
                
                logger.info({ userId }, 'Notification retry completed');

            } catch (error) {
                logger.error({ error: error.message, userId }, 'Error in retry notifications');
                throw error;
            }
        });
    }


    /**
     * API Endpoint: Cleanup old records
     * POST /api/v1/cleanup
     */
    async cleanup(req, res) {
        try {
            logger.info('Cleanup triggered');

            // Process cleanup in background
            this._performCleanup()
                .catch(error => {
                    logger.error({ error: error.message }, 'Error in cleanup background process');
                });

            return SuccessHandler.sendSuccess(res, {
                message: 'Cleanup started',
                processing: 'Background cleanup initiated'
            }, 'Cleanup started successfully');

        } catch (error) {
            logger.error({ error: error.message }, 'Error starting cleanup');
            return ErrorHandler.sendError(res, error, 'Failed to start cleanup');
        }
    }

    /**
     * Internal: Perform cleanup
     */
    async _performCleanup() {
        return initDatabaseContext(async () => {
            try {
                const { getModel: getSqpCronDetails } = require('../../models/sequelize/sqpCronDetails.model');
                const { getModel: getSqpCronLogs } = require('../../models/sequelize/sqpCronLogs.model');
                const SqpCronDetails = getSqpCronDetails();
                const SqpCronLogs = getSqpCronLogs();

                const thirtyDaysAgo = new Date();
                thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

                // Delete old cron details
                const deletedDetails = await SqpCronDetails.destroy({
                    where: {
                        cronRunningStatus: 2,
                        dtUpdatedOn: { [Op.lte]: thirtyDaysAgo }
                    }
                });

                // Delete old cron logs
                const deletedLogs = await SqpCronLogs.destroy({
                    where: {
                        dtCreatedOn: { [Op.lte]: thirtyDaysAgo }
                    }
                });

                logger.info({
                    deletedDetails,
                    deletedLogs
                }, 'Cleanup completed');

            } catch (error) {
                logger.error({ error: error.message }, 'Error in cleanup');
                throw error;
            }
        });
    }
}

module.exports = new MainCronController();

