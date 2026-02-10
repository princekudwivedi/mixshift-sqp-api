/**
 * Initial Pull Controller
 * Handles historical ASIN data pulling
 */

const { SuccessHandler, ErrorHandler } = require('../middleware/response.handlers');
const { ValidationHelpers, CircuitBreaker, RateLimiter, MemoryMonitor, NotificationHelpers, RetryHelpers, DelayHelpers, Helpers } = require('../helpers/sqp.helpers');
const logger = require('../utils/logger.utils');
const env = require('../config/env.config');
const initialPullService = require('../services/initial.pull.service');
const backfillService = require('../services/backfill.service');

class InitialPullController {

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
     * Run initial pull for all users or specific user/seller
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
            initialPullService.processInitialPull(validatedUserId, validatedSellerId, reportType)
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
            initialPullService.processRetryFailedInitialPull(validatedUserId, validatedSellerId, validatedCronDetailID)
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
     * Run backfill for historical data (e.g. after token re-enabled).
     * Fetches only missing date ranges per seller. Use a separate cron schedule for this.
     * Query params: userId (optional), sellerId (optional), startDate (YYYY-MM-DD), endDate (YYYY-MM-DD), onlyWithPending (1 = only sellers with BackfillPending=1)
     */
    async runBackfill(req, res) {
        try {
            const { userId, sellerId, startDate, endDate, onlyWithPending } = req.query;
            const validatedUserId = userId ? ValidationHelpers.validateUserId(userId) : null;
            const validatedSellerId = sellerId ? ValidationHelpers.validateUserId(sellerId) : null;
            const options = {};
            if (startDate && endDate) options.startDate = startDate;
            if (endDate) options.endDate = endDate;
            if (onlyWithPending === '1' || onlyWithPending === 'true') options.onlyWithPending = true;

            logger.info({ validatedUserId, validatedSellerId, startDate, endDate, onlyWithPending }, 'Backfill cron triggered via API');

            backfillService.processBackfill(validatedUserId, validatedSellerId, options)
                .catch(error => {
                    logger.error({ error: error.message }, 'Error in backfill background process');
                });

            return SuccessHandler.sendSuccess(res, {
                message: 'Backfill started',
                processing: 'Background processing initiated',
                params: { userId, sellerId, startDate, endDate, onlyWithPending },
                note: 'Fetches historical data for missing periods only. Use startDate/endDate for a custom range, or onlyWithPending=1 to process only sellers with BackfillPending flag set.'
            }, 'Backfill started successfully');
        } catch (error) {
            logger.error({ error: error.message }, 'Error starting backfill');
            return ErrorHandler.sendError(res, error, 'Failed to start backfill');
        }
    }

}

module.exports = new InitialPullController();
