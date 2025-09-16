const express = require('express');
const router = express.Router();
const sqpCronApiController = require('../controllers/sqp.cron.api.controller');
const AuthMiddleware = require('../middleware/auth.middleware');
const { AsyncErrorHandler } = require('../middleware/response.handlers');
const { ValidationHelpers } = require('../helpers/sqp.helpers');

// Note: Inputs are sanitized globally; explicit per-route validators are removed per request

// Apply middleware to all routes
router.use(AuthMiddleware.requestLogger);
router.use(AuthMiddleware.securityHeaders);
router.use(AuthMiddleware.sanitizeInput);
router.use(AuthMiddleware.rateLimit(50, 15 * 60 * 1000)); // 50 requests per 15 minutes for cron endpoints

// Cron operation routes (use GET, direct controller calls)
router.get('/request', sqpCronApiController.requestReports);
router.get('/status', sqpCronApiController.checkReportStatuses);
router.get('/download', sqpCronApiController.downloadCompletedReports);
router.get('/all', sqpCronApiController.runAllCronOperations);
router.get('/process-json', sqpCronApiController.processJsonFiles);
router.get('/stats', sqpCronApiController.getProcessingStats);

// Error handling middleware for routes
router.use((err, req, res, next) => {
    console.error('Cron route error:', err);
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// 404 handler for undefined routes
router.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        message: 'Cron route not found',
        path: req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
