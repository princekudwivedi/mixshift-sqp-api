const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

/**
 * Environment Configuration
 * Centralized environment variable management
 */
function env(name, defaultValue = null) {
    if (process.env[name] !== undefined && process.env[name] !== '') {
        return process.env[name];
    }
    return defaultValue;
}

const config = {
    // Application
    NODE_ENV: env('NODE_ENV', 'development'),
    PORT: env('PORT', 3001),
    API_VERSION: env('API_VERSION', 'v1'),
    
    // Database
    DB_HOST: env('DB_HOST', 'localhost'),
    DB_PORT: parseInt(env('DB_PORT', '3306')),
    DB_USER: env('DB_USER', 'root'),
    DB_PASS: env('DB_PASS', ''),
    DB_NAME: env('DB_NAME', 'sqp_database'),
    
    // JWT
    JWT_SECRET: env('JWT_SECRET', 'your-super-secret-jwt-key-change-in-production'),
    JWT_EXPIRES_IN: env('JWT_EXPIRES_IN', '24h'),
    JWT_REFRESH_EXPIRES_IN: env('JWT_REFRESH_EXPIRES_IN', '7d'),
    
    // CORS
    ALLOWED_ORIGINS: env('ALLOWED_ORIGINS', 'http://localhost:3000,http://localhost:3001'),
    
    // AWS Configuration
    AWS_ACCESS_KEY_ID: env('AWS_ACCESS_KEY_ID'),
    AWS_SECRET_ACCESS_KEY: env('AWS_SECRET_ACCESS_KEY'),
    AWS_ROLE_ARN: env('AWS_ROLE_ARN'),
    AWS_STS_REGION: env('AWS_STS_REGION', 'us-east-1'),
    
    // Amazon SP API
    AMAZON_SP_API_BASE_URL: env('AMAZON_SP_API_BASE_URL', 'https://sellingpartnerapi-na.amazon.com'),
    AMAZON_SP_API_ASIA_BASE_URL: env('AMAZON_SP_API_ASIA_BASE_URL', 'https://sellingpartnerapi-fe.amazon.com'),
    AMAZON_SP_API_EUROPE_BASE_URL: env('AMAZON_SP_API_EUROPE_BASE_URL', 'https://sellingpartnerapi-eu.amazon.com'),
    
    // Table Names
    TBL_USERS: env('TBL_USERS', 'users'),
    TBL_SQP_DOWNLOAD_URLS: env('TBL_SQP_DOWNLOAD_URLS', 'sqp_download_urls'),
    TBL_SQP_METRICS_3MO: env('TBL_SQP_METRICS_3MO', 'sqp_metrics_3mo'),
    TBL_SQP_METRICS: env('TBL_SQP_METRICS', 'sqp_metrics'),
    TBL_SELLER: env('TBL_SELLER', 'seller'),
    TBL_MARKET_PLACE: env('TBL_MARKET_PLACE', 'marketplace'),
    TBL_SELLER_MARKET_PLACES_MAPPING: env('TBL_SELLER_MARKET_PLACES_MAPPING', 'seller_marketplaces_mapping'),
    TBL_OAUTH_TOKENS: env('TBL_MWS_OAUTH_TOKEN', 'tbl_mws_oauth_token'),
    TBL_MWS_ACCESS_KEYS: env('TBL_MWS_ACCESS_KEYS', 'mws_access_keys'),
    TBL_STS_TOKENS: env('TBL_SPAPI_STS_TOKEN', 'sp_api_sts'),
    
    // Logging
    LOG_LEVEL: env('LOG_LEVEL', 'info'),
    
    // File Upload
    MAX_FILE_SIZE: parseInt(env('MAX_FILE_SIZE', '10485760')), // 10MB
    UPLOAD_PATH: env('UPLOAD_PATH', './uploads'),
    
    // Email (if needed)
    SMTP_HOST: env('SMTP_HOST'),
    SMTP_PORT: parseInt(env('SMTP_PORT', '587')),
    SMTP_USER: env('SMTP_USER'),
    SMTP_PASS: env('SMTP_PASS'),
    FROM_EMAIL: env('FROM_EMAIL', 'noreply@example.com'),
    
    // Redis (if needed for caching)
    REDIS_HOST: env('REDIS_HOST', 'localhost'),
    REDIS_PORT: parseInt(env('REDIS_PORT', '6379')),
    REDIS_PASSWORD: env('REDIS_PASSWORD'),
    
    // Rate Limiting
    RATE_LIMIT_WINDOW_MS: parseInt(env('RATE_LIMIT_WINDOW_MS', '900000')), // 15 minutes
    RATE_LIMIT_MAX_REQUESTS: parseInt(env('RATE_LIMIT_MAX_REQUESTS', '100')),
    
    // Security
    BCRYPT_ROUNDS: parseInt(env('BCRYPT_ROUNDS', '12')),
    SESSION_SECRET: env('SESSION_SECRET', 'your-session-secret-change-in-production')
};

// Validation
const requiredEnvVars = [
    'DB_HOST',
    'DB_USER',
    'DB_NAME',
    'JWT_SECRET'
];

const missingVars = requiredEnvVars.filter(varName => !config[varName]);

if (missingVars.length > 0) {
    console.error('Missing required environment variables:', missingVars);
    process.exit(1);
}

module.exports = { env, ...config };
