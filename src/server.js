const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const logger = require('./utils/logger.utils');
const apiRoutes = require('./routes/api.routes');
const { AsyncErrorHandler } = require('./middleware/response.handlers');
const { addConnectionStats, getHealthCheckData } = require('./middleware/connection.monitor');

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    credentials: true
}));

// Compression middleware
app.use(compression());

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Trust proxy for accurate IP addresses
app.set('trust proxy', 1);

// Add connection monitoring middleware
app.use(addConnectionStats);

app.get('/', (req, res) => {
    res.status(200).json({ status: 'ok', time: new Date().toISOString() });
});

// Health check endpoint
app.get('/health', (req, res) => {
    const healthData = getHealthCheckData();
    const statusCode = healthData.database.connected ? 200 : 503;
    res.status(statusCode).json(healthData);
});

app.use('/api/v1', apiRoutes);

// Global error handler
app.use(AsyncErrorHandler.globalErrorHandler);

// 404 handler for undefined routes (Express 5: no wildcard string)
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route not found',
        path: req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3001;
function validateEnv() {
    const errors = [];
    if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
        if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME) errors.push('DB_* env missing');
        if (!process.env.S3_BUCKET || !process.env.S3_REGION) errors.push('S3_* env missing');
    }
    if (errors.length) {
        logger.error({ errors }, 'Environment validation failed');
        process.exit(1);
    }
}

validateEnv();

app.listen(PORT, () => {
    logger.info({ 
        PORT, 
        environment: process.env.NODE_ENV || 'development',
        version: process.env.npm_package_version || '1.0.0'
    }, 'SQP API server running');
});