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

// Safe parsers
function toInt(value, defaultValue) {
    const parsed = parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}

function isProduction() {
    return String(env('NODE_ENV', 'development')).toLowerCase() === 'production';
}

const config = {
    // Application
    NODE_ENV: env('NODE_ENV', 'development'),
    PORT: toInt(env('PORT', '3001'), 3001),
    API_VERSION: env('API_VERSION', 'v1'),
    
    // Database
    DB_HOST: env('DB_HOST', 'localhost'),
    DB_PORT: toInt(env('DB_PORT', '3306'), 3306),
    DB_USER: env('DB_USER', 'root'),
    DB_PASS: env('DB_PASS', ''),
    DB_NAME: env('DB_NAME', 'sqp_database'),
    
    // JWT
    JWT_SECRET: env('JWT_SECRET'),
    JWT_EXPIRES_IN: env('JWT_EXPIRES_IN', '24h'),
    JWT_REFRESH_EXPIRES_IN: env('JWT_REFRESH_EXPIRES_IN', '7d'),

    // API Token (for cron endpoints)
    API_ACCESS_TOKEN: env('API_ACCESS_TOKEN'),
    
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
    LWA_CLIENT_ID: env('LWA_CLIENT_ID'),
    LWA_CLIENT_SECRET: env('LWA_CLIENT_SECRET'),
    
    // Table Names
    TBL_USERS: env('TBL_USERS', 'users'),
    TBL_SQP_DOWNLOAD_URLS: env('TBL_SQP_DOWNLOAD_URLS', 'sqp_download_urls'),
    TBL_SQP_CRON_DETAILS: env('TBL_SQP_CRON_DETAILS', 'sqp_cron_details'),
    TBL_SQP_CRON_LOGS: env('TBL_SQP_CRON_LOGS', 'sqp_cron_logs'),
    TBL_SQP_METRICS_3MO: env('TBL_SQP_METRICS_3MO', 'sqp_metrics_3mo'),
    TBL_SQP_METRICS: env('TBL_SQP_METRICS', 'sqp_metrics'),
    TBL_SELLER: env('TBL_SELLER', 'seller'),
    TBL_MARKET_PLACE: env('TBL_MARKET_PLACE', 'marketplace'),
    TBL_SELLER_MARKET_PLACES_MAPPING: env('TBL_SELLER_MARKET_PLACES_MAPPING', 'seller_marketplaces_mapping'),
    TBL_SELLER_ASIN_LIST: env('TBL_SELLER_ASIN_LIST', 'seller_ASIN_list'),
    TBL_USER_DB_MAP: env('TBL_USER_DB_MAP', 'user_database_mapping'),
    TBL_USER_DATABASES: env('TBL_USER_DATABASES', 'user_databases'),
    TBL_USER_DATABASE_CREDENTIALS: env('TBL_USER_DATABASE_CREDENTIALS', 'user_database_credentials'),
    TBL_TIMEZONES: env('TBL_TIMEZONES', 'timezones'),
    TBL_OAUTH_TOKENS: env('TBL_MWS_OAUTH_TOKEN', 'tbl_mws_oauth_token'),
    TBL_MWS_ACCESS_KEYS: env('TBL_MWS_ACCESS_KEYS', 'mws_access_keys'),
    TBL_STS_TOKENS: env('TBL_SPAPI_STS_TOKEN', 'sp_api_sts'),
    
    // Logging
    LOG_LEVEL: env('LOG_LEVEL', 'info'),
    
    // File Upload
    MAX_FILE_SIZE: toInt(env('MAX_FILE_SIZE', '10485760'), 10485760), // 10MB
    UPLOAD_PATH: env('UPLOAD_PATH', './uploads'),
    
    // Email (if needed)
    SMTP_HOST: env('SMTP_HOST'),
    SMTP_PORT: toInt(env('SMTP_PORT', '587'), 587),
    SMTP_USER: env('SMTP_USER'),
    SMTP_PASS: env('SMTP_PASS'),
    FROM_EMAIL: env('FROM_EMAIL'),
    
    // Redis (if needed for caching)
    REDIS_HOST: env('REDIS_HOST', 'localhost'),
    REDIS_PORT: toInt(env('REDIS_PORT', '6379'), 6379),
    REDIS_PASSWORD: env('REDIS_PASSWORD'),
    
    // Rate Limiting
    RATE_LIMIT_WINDOW_MS: toInt(env('RATE_LIMIT_WINDOW_MS', '900000'), 900000), // 15 minutes
    RATE_LIMIT_MAX_REQUESTS: toInt(env('RATE_LIMIT_MAX_REQUESTS', '100'), 100),
    
    // Security
    BCRYPT_ROUNDS: toInt(env('BCRYPT_ROUNDS', '12'), 12),
    SESSION_SECRET: env('SESSION_SECRET')
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

// Production hardening checks
if (isProduction()) {
    const defaultSecrets = [
        'your-super-secret-jwt-key-change-in-production',
        'your-session-secret-change-in-production'
    ];

    if (!config.JWT_SECRET || defaultSecrets.includes(config.JWT_SECRET)) {
        console.error('Security error: JWT_SECRET must be set to a strong value in production.');
        process.exit(1);
    }
    if (!config.SESSION_SECRET || defaultSecrets.includes(config.SESSION_SECRET)) {
        console.error('Security error: SESSION_SECRET must be set to a strong value in production.');
        process.exit(1);
    }

    // Enforce strict CORS allowlist in production
    const allowedOrigins = (config.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (allowedOrigins.length === 0 || allowedOrigins.includes('*')) {
        console.error('Security error: ALLOWED_ORIGINS must be a non-empty, explicit list in production.');
        process.exit(1);
    }

    // Recommend DB password in production
    if (!config.DB_PASS || config.DB_PASS === '') {
        console.warn('Warning: DB_PASS is empty in production. Consider setting a strong database password.');
    }
}

module.exports = { env, ...config };
