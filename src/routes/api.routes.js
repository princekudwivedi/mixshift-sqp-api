const express = require('express');
const router = express.Router();
const logger = require('../utils/logger.utils');
const initialPullController = require('../controllers/cron/initial-pull.controller');
const mainCronController = require('../controllers/cron/main-cron.controller')
const asinSyncController = require('../controllers/cron/asin-sync.controller')
const AuthMiddleware = require('../middleware/auth.middleware');

// Apply shared middleware to all routes
router.use(AuthMiddleware.securityHeaders);
router.use(AuthMiddleware.sanitizeInput);

// Cron routes - Lower rate limit for cron operations (NO AUTH REQUIRED)
router.use('/cron/sqp', AuthMiddleware.rateLimit(50, 15 * 60 * 1000)); // 50 requests per 15 minutes for cron endpoints
// NEW: Using refactored main cron controller
router.get('/cron/sqp/all', (req, res) => mainCronController.runMainCron(req, res));

// Notification retry cron route (NO AUTH REQUIRED)
router.get('/cron/sqp/retry-report', (req, res) => mainCronController.retryNotifications(req, res));

// ASIN sync cron routes (NO AUTH REQUIRED)
router.get('/cron/asin/syncSellerAsins/:userId/:amazonSellerID', (req, res) => asinSyncController.syncSellerAsins(req, res));

// ASIN reset cron routes (NO AUTH REQUIRED)
router.get('/cron/asin-reset', (req, res) => asinSyncController.resetAsinStatus(req, res));

// Initial Pull cron route (NO AUTH REQUIRED)
router.get('/cron/sqp/initial/pull', (req, res) => initialPullController.runInitialPull(req, res));

// Retry failed initial pull route (NO AUTH REQUIRED)
router.get('/cron/sqp/initial/retry', (req, res) => initialPullController.retryFailedInitialPull(req, res));

// Shared error handling middleware for all routes
router.use((err, req, res, next) => {
	logger.error({ error: err.message, path: req.path }, 'API route error');
	res.status(500).json({
		success: false,
		message: 'Internal server error',
		timestamp: new Date().toISOString()
	});
});

// 404 handler for undefined routes
router.use((req, res) => {
	res.status(404).json({
		success: false,
		message: 'API route not found',
		path: req.originalUrl,
		method: req.method,
		timestamp: new Date().toISOString()
	});
});

module.exports = router;
