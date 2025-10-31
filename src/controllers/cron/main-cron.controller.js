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
                    sellerCallback: async (seller, userDetails) => {
                        // Process this seller
                        await this._processSeller(seller, userDetails);
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
    async _processSeller(seller, userDetails) {
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
            const weekRange = datesUtils.getDateRangeForPeriod('WEEK', userDetails.Timezone);
            const monthRange = datesUtils.getDateRangeForPeriod('MONTH', userDetails.Timezone);
            const quarterRange = datesUtils.getDateRangeForPeriod('QUARTER', userDetails.Timezone);
            const FullWeekRange = `${weekRange.start} to ${weekRange.end}`;
            const FullMonthRange = `${monthRange.start} to ${monthRange.end}`;
            const FullQuarterRange = `${quarterRange.start} to ${quarterRange.end}`;
            
            // Initialize variables
            const userTimezone = userDetails.Timezone;
            const authOverrides = await buildAuthWithRateLimit(seller);
            const reportRequests = [];

            // 2. Create cron detail record
            const cronDetailRow = await model.createSQPCronDetail(seller.AmazonSellerID, asinList.join(','), seller.idSellerAccount, { SellerName: seller.SellerName, FullWeekRange: FullWeekRange, FullMonthRange: FullMonthRange, FullQuarterRange: FullQuarterRange, Timezone: userTimezone, iInitialPull: 0 });

            logger.info({ cronDetailID: cronDetailRow.ID }, 'Cron detail created');

            for (const reportType of reportTypeList) {
                try {
                    const datePeriod = datesUtils.getDateRangeForPeriod(reportType, userDetails.Timezone);
                    const range = {
                        start: datePeriod.start,
                        end: datePeriod.end,
                        range: `${datePeriod.start} to ${datePeriod.end}`
                    };
                    
                    // Use ReportOperationsService
                    const result = await reportOps.requestReport({
                        seller,
                        asinList,
                        range,
                        reportType,
                        authOverrides,
                        cronDetailID: cronDetailRow.ID,
                        model,
                        isInitialPull: false,
                        timezone: userTimezone
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

            // 3. Wait for reports to be ready
            const initialDelay = Number(process.env.INITIAL_DELAY_SECONDS) || 30;
            await this._wait(initialDelay);

            // 4. Check status and download all reports
            await this._checkAndDownloadReports(
                cronDetailRow,
                seller,
                reportRequests,
                asinList,
                authOverrides,
                userTimezone
            );

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
    }    

    /**
     * Check status and download all reports
     */
    async _checkAndDownloadReports(cronDetailRow, seller, reportRequests, asinList, authOverrides, timezone) {
        try {
            logger.info({
                cronDetailID: cronDetailRow.ID,
                reportCount: reportRequests.length
            }, 'Checking status for all reports');
            
            const statusCheckService = require('../../services/cron/status-check.service');
            
            for (const request of reportRequests) {
                try {
                    // Check status using ReportOperationsService (handles retries internally)
                    const statusResult = await reportOps.checkReportStatus({
                        seller,
                        reportId: request.reportId,
                        range: request.range,
                        reportType: request.reportType,
                        authOverrides,
                        cronDetailID: cronDetailRow.ID,
                        model,
                        downloadUrls,
                        isInitialPull: false,
                        timezone: timezone
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
                        
                    } else if (statusResult.status === 'FATAL' || statusResult.status === 'CANCELLED') {
                        // Fatal error - send notification
                        logger.error({
                            reportId: request.reportId,
                            reportType: request.reportType,
                            status: statusResult.status
                        }, 'Report processing failed with fatal status');
                        
                        await statusCheckService.sendFailureNotification(
                            cronDetailRow.ID,
                            seller.AmazonSellerID,
                            request.reportType,
                            `Report status: ${statusResult.status}`,
                            0,
                            request.reportId,
                            true // isFatalError
                        );
                    } else {
                        // Other status (already handled by executeWithRetry)
                        logger.info({
                            reportId: request.reportId,
                            reportType: request.reportType,
                            status: statusResult.status
                        }, 'Report status check completed');
                    }
                    
                } catch (error) {
                    logger.error({
                        cronDetailID: cronDetailRow.ID,
                        reportType: request.reportType,
                        reportId: request.reportId,
                        error: error.message
                    }, 'Error processing report');
                }
            }

            logger.info({
                cronDetailID: cronDetailRow.ID,
                amazonSellerID: seller.AmazonSellerID
            }, 'Report status check and download completed');

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
                const { getModel: getSqpCronDetails } = require('../../models/sequelize/sqpCronDetails.model');
                const SqpCronDetails = getSqpCronDetails();
                
                // Get failed cron details that need retry
                const failedCrons = await SqpCronDetails.findAll({
                    where: {
                        cronRunningStatus: { [Op.in]: [2, 3] }, // Failed or retry marked
                        [Op.or]: [
                            { WeeklySQPDataPullStatus: 2 },
                            { MonthlySQPDataPullStatus: 2 },
                            { QuarterlySQPDataPullStatus: 2 }
                        ]
                    },
                    order: [['dtCreatedOn', 'DESC']],
                    limit: 50
                });

                logger.info({ count: failedCrons.length }, 'Found failed crons for retry');

                if (failedCrons.length === 0) {
                    logger.info('No failed crons to retry');
                    return;
                }

                // Process each failed cron
                for (const cronDetail of failedCrons) {
                    try {
                        await statusCheckService.checkReportStatuses(
                            {},
                            {
                                cronDetailID: cronDetail.ID,
                                cronDetailData: [cronDetail.toJSON()]
                            },
                            true // retry mode
                        );
                    } catch (error) {
                        logger.error({
                            cronDetailID: cronDetail.ID,
                            error: error.message
                        }, 'Error retrying cron detail');
                    }
                }

                logger.info({ userId, count: failedCrons.length }, 'Notification retry completed');

            } catch (error) {
                logger.error({ error: error.message, userId }, 'Error in retry notifications');
                throw error;
            }
        });
    }

    /**
     * Wait helper method
     */
    async _wait(seconds) {
        return new Promise(resolve => setTimeout(resolve, seconds * 1000));
    }
}

module.exports = new MainCronController();

