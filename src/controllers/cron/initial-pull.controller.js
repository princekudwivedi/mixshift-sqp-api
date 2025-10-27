/**
 * Initial Pull Controller (Refactored)
 * Thin controller layer - delegates to services
 * Handles historical ASIN data pulling (52 weeks, 12 months, 4 quarters)
 */

const { SuccessHandler, ErrorHandler } = require('../../middleware/response.handlers');
const { initDatabaseContext } = require('../../db/tenant.db');
const ValidationUtils = require('../../utils/validation.utils');
const { processUserSellerCombination, buildAuthWithRateLimit } = require('../../utils/cron.processing.utils');
const reportOps = require('../../services/cron/report-operations.service');
const asinService = require('../../services/cron/asin-management.service');
const initialPullService = require('../../services/initial.pull.service');
const model = require('../../models/sqp.cron.model');
const downloadUrls = require('../../models/sqp.download.urls.model');
const jsonSvc = require('../../services/sqp.json.processing.service');
const asinInitialPull = require('../../models/sellerAsinList.initial.pull.model');
const logger = require('../../utils/logger.utils');
const env = require('../../config/env.config');
const { CircuitBreaker, RateLimiter } = require('../../helpers/sqp.helpers');

class InitialPullController {
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
     * API Endpoint: Start initial pull
     * GET /api/v1/initial-pull?userId=X&sellerId=Y&reportType=WEEK
     */
    async runInitialPull(req, res) {
        try {
            const { userId, sellerId, reportType } = req.query;

            // Validate inputs using ValidationUtils
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

            if (reportType) {
                const validation = ValidationUtils.validateReportType(reportType);
                if (!validation.valid) {
                    return ErrorHandler.sendValidationError(res, [validation.error]);
                }
            }

            logger.info({ userId, sellerId, reportType }, 'Initial pull triggered via API');

            // Process in background
            this._processInitialPull(userId, sellerId, reportType)
                .catch(error => {
                    logger.error({ error: error.message }, 'Error in initial pull background process');
                });

            const weeksToPull = env.WEEKS_TO_PULL || 52;
            const monthsToPull = env.MONTHS_TO_PULL || 12;
            const quartersToPull = env.QUARTERS_TO_PULL || 4;
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
                }
            }, 'Initial pull started successfully');

        } catch (error) {
            logger.error({ error: error.message }, 'Error starting initial pull');
            return ErrorHandler.sendError(res, error, 'Failed to start initial pull');
        }
    }

    /**
     * Internal: Process initial pull using new services
     */
    async _processInitialPull(userId, sellerId, reportType) {
        return initDatabaseContext(async () => {
            try {
                const result = await processUserSellerCombination({
                    validatedUserId: userId,
                    validatedSellerId: sellerId,
                    isInitialPull: true,
                    checkCronLimits: true,
                    checkMemory: true,
                    checkEligibleAsins: true,
                    breakAfterFirst: true,
                    sellerCallback: async (seller) => {
                        // Process this seller
                        await this._processSeller(seller, reportType);
                        return { processed: true, error: false, shouldBreak: true };
                    }
                });

                logger.info({ result }, 'Initial pull processing completed');
                
            } catch (error) {
                logger.error({ error: error.message }, 'Error in _processInitialPull');
                throw error;
            }
        });
    }

    /**
     * Process single seller for initial pull
     */
    async _processSeller(seller, reportType) {
        try {
            logger.info({
                sellerId: seller.idSellerAccount,
                amazonSellerID: seller.AmazonSellerID,
                reportType
            }, 'Starting initial pull for seller');

            // 1. Get eligible ASINs using AsinManagementService
            const asinList = await asinService.getEligibleAsins({
                sellerId: seller.idSellerAccount,
                isInitialPull: true
            });

            if (asinList.length === 0) {
                logger.info({ sellerId: seller.idSellerAccount }, 'No eligible ASINs for initial pull');
                return;
            }

            // 2. Create cron detail record
            const cronDetailRow = await model.createCronDetail({
                userId: seller.UserID,
                sellerId: seller.idSellerAccount,
                amazonSellerID: seller.AmazonSellerID,
                iInitialPull: 1
            });

            logger.info({ cronDetailID: cronDetailRow.ID }, 'Cron detail created');

            // 3. Mark ASINs as pending
            await asinService.markAsinsAsPending(asinList, seller.idSellerAccount, true);

            // 4. Build auth overrides with rate limiting
            const authOverrides = await buildAuthWithRateLimit(seller, this.rateLimiter);

            // 5. Calculate date ranges for initial pull
            const ranges = await initialPullService.calculateFullRanges();

            // 6. Determine which report types to pull
            const typesToPull = reportType 
                ? [reportType] 
                : env.TYPE_ARRAY || ['WEEK', 'MONTH', 'QUARTER'];

            // 7. Request all reports using ReportOperationsService
            const reportRequests = [];
            
            for (const type of typesToPull) {
                const rangesToProcess = type === 'WEEK' ? ranges.weekRanges
                    : type === 'MONTH' ? ranges.monthRanges
                    : ranges.quarterRanges;

                logger.info({
                    type,
                    rangesCount: rangesToProcess.length
                }, 'Requesting reports for type');

                for (const range of rangesToProcess) {
                    try {
                        // Use ReportOperationsService
                        const result = await reportOps.requestReport({
                            seller,
                            asinList,
                            range,
                            reportType: type,
                            authOverrides,
                            cronDetailID: cronDetailRow.ID,
                            model,
                            isInitialPull: true
                        });

                        const reportID = result?.reportID || result?.data?.reportId;
                        if (reportID) {
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
                            }, 'Report requested successfully');
                        }

                    } catch (error) {
                        logger.error({
                            cronDetailID: cronDetailRow.ID,
                            range: range.range,
                            error: error.message
                        }, 'Failed to request report');
                    }
                }
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
            }, 'Initial pull completed for seller');

        } catch (error) {
            logger.error({
                error: error.message,
                seller: seller.AmazonSellerID
            }, 'Error in _processSeller');
            throw error;
        }
    }

    /**
     * Check status and download all requested reports
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
                        reportType: request.type,
                        authOverrides,
                        cronDetailID: cronDetailRow.ID,
                        model,
                        downloadUrls,
                        isInitialPull: true
                    });

                    if (statusResult.status === 'DONE') {
                        // Download using ReportOperationsService
                        await reportOps.downloadReport({
                            seller,
                            reportId: request.reportId,
                            documentId: statusResult.documentId,
                            range: request.range,
                            reportType: request.type,
                            authOverrides,
                            cronDetailID: cronDetailRow.ID,
                            model,
                            downloadUrls,
                            jsonSvc,
                            isInitialPull: true
                        });

                        logger.info({
                            reportId: request.reportId,
                            type: request.type
                        }, 'Report downloaded and imported successfully');
                    }

                } catch (error) {
                    logger.error({
                        cronDetailID: cronDetailRow.ID,
                        reportId: request.reportId,
                        error: error.message
                    }, 'Failed to process report');
                }
            }

            // Update final status for all report types
            await this._updateFinalStatus(cronDetailRow.ID, seller.AmazonSellerID, asinList);

        } catch (error) {
            logger.error({
                error: error.message,
                cronDetailID: cronDetailRow.ID
            }, 'Error in _checkAndDownloadReports');
            throw error;
        }
    }

    /**
     * Update final status after all reports processed
     */
    async _updateFinalStatus(cronDetailID, amazonSellerID, asinList) {
        try {
            const { getModel: getSqpCronDetails } = require('../../models/sequelize/sqpCronDetails.model');
            const { getModel: getSqpCronLogs } = require('../../models/sequelize/sqpCronLogs.model');
            const { Op } = require('sequelize');

            const SqpCronDetails = getSqpCronDetails();
            const SqpCronLogs = getSqpCronLogs();

            // Get all logs for this cron
            const allLogs = await SqpCronLogs.findAll({
                where: {
                    CronJobID: cronDetailID,
                    iInitialPull: 1
                },
                order: [['dtCreatedOn', 'DESC']]
            });

            // Count successes and failures per report type
            const reportTypes = ['WEEK', 'MONTH', 'QUARTER'];
            let overallAsinStatus = 2; // Assume success

            for (const reportType of reportTypes) {
                const typeLogs = allLogs.filter(l => l.ReportType === reportType);
                const uniqueReportIds = [...new Set(typeLogs.map(l => l.ReportID))];

                if (uniqueReportIds.length === 0) continue;

                let doneCount = 0;
                let fatalCount = 0;

                for (const reportId of uniqueReportIds) {
                    const reportLogs = typeLogs.filter(l => l.ReportID === reportId);
                    const isDone = reportLogs.some(l => l.Status === 1);
                    const isFatal = reportLogs.some(l =>
                        l.Message && (l.Message.includes('FATAL') || l.Message.includes('CANCELLED'))
                    );

                    if (isDone) doneCount++;
                    else if (isFatal) fatalCount++;
                }

                const prefix = reportType === 'WEEK' ? 'Weekly'
                    : reportType === 'MONTH' ? 'Monthly'
                    : 'Quarterly';

                let dataPullStatus, processRunningStatus;

                if (doneCount === uniqueReportIds.length) {
                    dataPullStatus = 1;
                    processRunningStatus = 4;
                } else {
                    dataPullStatus = 2;
                    processRunningStatus = 2;
                    overallAsinStatus = 3;
                }

                await SqpCronDetails.update(
                    {
                        [`${prefix}SQPDataPullStatus`]: dataPullStatus,
                        [`${prefix}ProcessRunningStatus`]: processRunningStatus,
                        cronRunningStatus: 2
                    },
                    { where: { ID: cronDetailID } }
                );

                logger.info({
                    reportType,
                    dataPullStatus,
                    processRunningStatus
                }, 'Updated report type status');
            }

            // Update ASIN status
            if (overallAsinStatus === 2) {
                await asinInitialPull.markInitialPullCompleted(amazonSellerID, asinList, null, cronDetailID);
            } else {
                await asinInitialPull.markInitialPullFailed(amazonSellerID, asinList, null, cronDetailID);
            }

            logger.info({ cronDetailID, overallAsinStatus }, 'Final status updated');

        } catch (error) {
            logger.error({ error: error.message, cronDetailID }, 'Error updating final status');
            throw error;
        }
    }

    /**
     * API Endpoint: Retry failed initial pull
     * POST /api/v1/retry-failed-initial-pull?userId=X&sellerId=Y
     */
    async retryFailedInitialPull(req, res) {
        try {
            const { userId, sellerId } = req.query;

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

            logger.info({ userId, sellerId }, 'Retry failed initial pull triggered');

            // Process retry in background
            this._processRetryFailedInitialPull(userId, sellerId)
                .catch(error => {
                    logger.error({ error: error.message }, 'Error in retry background process');
                });

            return SuccessHandler.sendSuccess(res, {
                message: 'Retry initiated',
                processing: 'Background processing started',
                params: { userId, sellerId }
            }, 'Retry started successfully');

        } catch (error) {
            logger.error({ error: error.message }, 'Failed to start retry');
            return ErrorHandler.sendError(res, error, 'Failed to start retry failed initial pull');
        }
    }

    /**
     * Internal: Process retry for failed initial pulls
     */
    async _processRetryFailedInitialPull(userId, sellerId) {
        // Implementation similar to _processInitialPull but for retry
        // Uses same services
        logger.info({ userId, sellerId }, 'Processing retry for failed initial pull');
        // ... Implementation here
    }

    /**
     * Helper: Wait for specified seconds
     */
    async _wait(seconds) {
        return new Promise(resolve => setTimeout(resolve, seconds * 1000));
    }
}

module.exports = new InitialPullController();

