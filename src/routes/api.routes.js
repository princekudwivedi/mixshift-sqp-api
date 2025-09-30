const express = require('express');
const router = express.Router();
const sqpApiController = require('../controllers/sqp.api.controller');
const sqpCronApiController = require('../controllers/sqp.cron.api.controller');
const AuthMiddleware = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/authz.middleware');

// Apply shared middleware to all routes
router.use(AuthMiddleware.requestLogger);
router.use(AuthMiddleware.securityHeaders);
router.use(AuthMiddleware.sanitizeInput);
//router.use(AuthMiddleware.optionalToken); // accept Bearer or token=; does not fail if missing

// SQP API routes (non-cron) - Higher rate limit for regular API usage
router.use('/sqp', AuthMiddleware.rateLimit(100, 15 * 60 * 1000)); // 100 requests per 15 minutes
router.get('/sqp/getAsinSkuList/:userId/:sellerID', (req, res) => sqpApiController.getAsinSkuList(req, res));
router.put('/sqp/updateAsinStatus/:userId/:sellerID/:asin', (req, res) => sqpApiController.updateAsinStatus(req, res));

// Cron routes - Lower rate limit for cron operations
router.use('/cron/sqp', AuthMiddleware.rateLimit(50, 15 * 60 * 1000)); // 50 requests per 15 minutes for cron endpoints
router.get('/cron/sqp/all', (req, res) => sqpCronApiController.runAllCronOperations(req, res));

// Notification suppression cron route
router.get('/cron/sqp/suppress-notifications', (req, res) => sqpCronApiController.suppressNotifications(req, res));

// ASIN sync cron routes
router.get('/cron/asin/syncSellerAsins/:userId/:amazonSellerID', (req, res) => sqpCronApiController.syncSellerAsins(req, res));
router.get('/cron/asin/cronSyncAllSellerAsins/:userId', (req, res) => sqpCronApiController.cronSyncAllSellerAsins(req, res));
router.get('/cron/asin/cronSyncAllUsersSellerAsins', (req, res) => sqpCronApiController.cronSyncAllUsersSellerAsins(req, res));

// Shared error handling middleware for all routes
router.use((err, req, res, next) => {
    console.error('API route error:', err);
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
