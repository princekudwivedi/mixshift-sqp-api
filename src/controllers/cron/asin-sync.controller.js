/**
 * ASIN Sync Controller
 * Handles ASIN synchronization operations
 */

const { SuccessHandler, ErrorHandler } = require('../../middleware/response.handlers');
const { initDatabaseContext } = require('../../db/tenant.db');
const ValidationUtils = require('../../utils/validation.utils');
const asinSyncService = require('../../services/cron/asin-sync.service');
const logger = require('../../utils/logger.utils');

class AsinSyncController {
    /**
     * API Endpoint: Sync seller ASINs
     * GET /api/v1/cron/asin/syncSellerAsins/:userId/:amazonSellerID
     */
    async syncSellerAsins(req, res) {
        try {
            const { userId, amazonSellerID } = req.params;

            // Validate inputs
            const userValidation = ValidationUtils.validateUserId(userId);
            if (!userValidation.valid) {
                return ErrorHandler.sendValidationError(res, [userValidation.error]);
            }

            if (!amazonSellerID) {
                return ErrorHandler.sendValidationError(res, ['Amazon Seller ID is required']);
            }

            logger.info({ userId, amazonSellerID }, 'ASIN sync triggered');

            // Process sync in background
            asinSyncService.syncSellerAsins(userId, amazonSellerID)
                .catch(error => {
                    logger.error({ error: error.message }, 'Error in ASIN sync background process');
                });

            return SuccessHandler.sendSuccess(res, {
                message: 'ASIN sync started',
                processing: 'Background sync initiated',
                params: { userId, amazonSellerID }
            }, 'ASIN sync started successfully');

        } catch (error) {
            logger.error({ error: error.message }, 'Error starting ASIN sync');
            return ErrorHandler.sendError(res, error, 'Failed to start ASIN sync');
        }
    }

    /**
     * API Endpoint: Reset ASIN status
     * GET /api/v1/cron/asin-reset
     */
    async resetAsinStatus(req, res) {
        try {
            logger.info('ASIN reset triggered');

            // Process reset in background
            const asinResetService = require('../../services/asin.reset.service');
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
            logger.error({ error: error.message }, 'Error starting ASIN reset');
            return ErrorHandler.sendError(res, error, 'Failed to run automatic ASIN reset');
        }
    }
}

module.exports = new AsinSyncController();

