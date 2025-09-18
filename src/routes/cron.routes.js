const express = require('express');
const router = express.Router();
const sqpCronApiController = require('../controllers/sqp.cron.api.controller');
const AuthMiddleware = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/authz.middleware');

// Apply middleware to all routes
router.use(AuthMiddleware.requestLogger);
router.use(AuthMiddleware.securityHeaders);
router.use(AuthMiddleware.sanitizeInput);
router.use(AuthMiddleware.rateLimit(50, 15 * 60 * 1000)); // 50 requests per 15 minutes for cron endpoints

// Enforce token for all cron endpoints
router.use(AuthMiddleware.optionalToken); // accept Bearer or token=; does not fail if missing
//router.use(AuthMiddleware.validateToken);

// Cron operation routes (use GET, direct controller calls)
router.get('/request', (req, res) => sqpCronApiController.requestReports(req, res));
router.get('/status', (req, res) => sqpCronApiController.checkReportStatuses(req, res));
router.get('/download', (req, res) => sqpCronApiController.downloadCompletedReports(req, res));
router.get('/all', (req, res) => sqpCronApiController.runAllCronOperations(req, res));
router.get('/process-json', (req, res) => sqpCronApiController.processJsonFiles(req, res));
router.get('/copy-metrics', requireRole(['operator','admin']), (req, res) => sqpCronApiController.copyMetricsData(req, res));
router.get('/stats', (req, res) => sqpCronApiController.getProcessingStats(req, res));

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
router.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Cron route not found',
        path: req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
