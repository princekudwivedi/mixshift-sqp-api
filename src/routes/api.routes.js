const express = require('express');
const router = express.Router();
const logger = require('../utils/logger.utils');
const sqpCronApiController = require('../controllers/sqp.cron.api.controller');
const initialPullController = require('../controllers/initial.pull.controller');
const AuthMiddleware = require('../middleware/auth.middleware');

// Apply shared middleware to all routes
// router.use(AuthMiddleware.requestLogger);
router.use(AuthMiddleware.securityHeaders);
router.use(AuthMiddleware.sanitizeInput);

// Cron routes - Lower rate limit for cron operations
router.use('/cron/sqp', AuthMiddleware.rateLimit(50, 15 * 60 * 1000)); // 50 requests per 15 minutes for cron endpoints
router.get('/cron/sqp/all', (req, res) => sqpCronApiController.runAllCronOperations(req, res));

// Notification retry cron route
router.get('/cron/sqp/retry-report', (req, res) => sqpCronApiController.retryNotifications(req, res));

// ASIN sync cron routes
router.get('/cron/asin/syncSellerAsins/:userId/:amazonSellerID', (req, res) => sqpCronApiController.syncSellerAsins(req, res));

//router.get('/cron/sqp/cronSyncAllSellerAsins/:userId', (req, res) => sqpCronApiController.cronSyncAllSellerAsins(req, res));

// ASIN reset cron routes
router.get('/cron/asin-reset', (req, res) => sqpCronApiController.resetAsinStatus(req, res));

// Initial Pull cron route
router.get('/cron/sqp/initial/pull', (req, res) => initialPullController.runInitialPull(req, res));

// Retry failed initial pull route
router.get('/cron/sqp/initial/retry', (req, res) => initialPullController.retryFailedInitialPull(req, res));

module.exports = router;
