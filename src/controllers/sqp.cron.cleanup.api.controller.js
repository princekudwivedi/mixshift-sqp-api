const { SuccessHandler, ErrorHandler } = require('../middleware/response.handlers');
const { initDatabaseContext, loadDatabase } = require('../db/tenant.db');
const logger = require('../utils/logger.utils');
const { isValidSellerID, sanitizeLogData } = require('../utils/security.utils');
const cleanupService = require('../services/cleanup.service');
const { CircuitBreaker, RateLimiter } = require('../helpers/sqp.helpers');
/**
 * SQP Cron API Controller
 * Handles legacy cron endpoints with proper error handling and validation
 */
class SqpCronCleanupApiController {
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
     * Clean up old records from SQP tables
     * Removes old records from sqp_cron_details, sqp_cron_logs, and sqp_download_urls
     * GET/POST: /cron/sqp/cleanup?daysToKeep=30
     */
    async cleanupOldRecords(req, res) {
        try {
            // Get daysToKeep from env variable default to 30
            const daysToKeep = process.env.DAYS_TO_KEEP || 30;
            
            const daysToKeepNumber = Number(daysToKeep);
            
            // Validate daysToKeep - enforce minimum 30 days for security
            if (isNaN(daysToKeepNumber)) {
                return ErrorHandler.sendValidationError(res, ['Invalid daysToKeep parameter. Must be a valid number.']);
            }
            
            if (daysToKeepNumber < 30) {
                return ErrorHandler.sendValidationError(res, [
                    'Security Error: daysToKeep must be at least 30 days to prevent accidental deletion of recent critical data.',
                    `Requested: ${daysToKeepNumber} days`,
                    'Minimum allowed: 30 days'
                ]);
            }
            
            if (daysToKeepNumber > 365) {
                logger.warn({ daysToKeep: daysToKeepNumber }, 'Large retention period requested (>1 year)');
            }
            
            logger.info({ daysToKeep: daysToKeepNumber }, 'Starting cleanup of old records - background process');
       
            this.circuitBreaker.execute(
                async () => await cleanupService.cleanupAllOldRecords(daysToKeepNumber),
                { daysToKeep: daysToKeepNumber, operation: 'cleanupAllOldRecords' }
            );

            return SuccessHandler.sendSuccess(res, {
                message: 'Cleanup operation started',
                processing: 'Background processing initiated',
                params: { daysToKeep: daysToKeepNumber }
            }, 'Cleanup started successfully');

        } catch (error) {
            logger.error({ error: error.message, stack: error.stack }, 'Error starting cleanup operation');
            return ErrorHandler.sendError(res, error, 'Failed to start cleanup operation');
        }
    }
}

module.exports = new SqpCronCleanupApiController();