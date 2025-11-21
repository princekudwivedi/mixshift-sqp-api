const path = require('node:path');
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
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}

const config = {
    // Application
    NODE_ENV: env('NODE_ENV', 'development'),
    PORT: toInt(env('PORT', '3001'), 3001),
    
    // Database
    DB_HOST: env('DB_HOST', 'localhost'),
    DB_PORT: toInt(env('DB_PORT', '3306'), 3306),
    DB_USER: env('DB_USER', 'root'),
    DB_PASS: env('DB_PASS', ''),
    DB_NAME: env('DB_NAME', 'sqp_database'),
        
    // CORS
    ALLOWED_ORIGINS: env('ALLOWED_ORIGINS', ''),
    
    // AWS Configuration
    AWS_ACCESS_KEY_ID: env('AWS_ACCESS_KEY_ID'),
    AWS_SECRET_ACCESS_KEY: env('AWS_SECRET_ACCESS_KEY'),
    AWS_ROLE_ARN: env('AWS_ROLE_ARN'),
    AWS_STS_REGION: env('AWS_STS_REGION', 'us-east-1'),
    
    // Amazon SP API
    AMAZON_SP_API_BASE_URL: env('AMAZON_SP_API_BASE_URL', ''),
    AMAZON_SP_API_ASIA_BASE_URL: env('AMAZON_SP_API_ASIA_BASE_URL', ''),
    AMAZON_SP_API_EUROPE_BASE_URL: env('AMAZON_SP_API_EUROPE_BASE_URL', ''),
    LWA_CLIENT_ID: env('LWA_CLIENT_ID'),
    LWA_CLIENT_SECRET: env('LWA_CLIENT_SECRET'),
    
    // Table Names
    TBL_USERS: env('TBL_USERS', 'users'),
    TBL_SQP_DOWNLOAD_URLS: env('TBL_SQP_DOWNLOAD_URLS', 'sqp_download_urls'),
    TBL_SQP_CRON_DETAILS: env('TBL_SQP_CRON_DETAILS', 'sqp_cron_details'),
    TBL_SQP_CRON_LOGS: env('TBL_SQP_CRON_LOGS', 'sqp_cron_logs'),
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
    TBL_MWS_ITEMS: env('TBL_MWS_ITEMS', 'mws_items'),
    
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
    NOTIFY_TO: env('NOTIFY_TO'),
    NOTIFY_CC: env('NOTIFY_CC'),
    NOTIFY_BCC: env('NOTIFY_BCC'),

    
    // Redis (if needed for caching)
    REDIS_HOST: env('REDIS_HOST', 'localhost'),
    REDIS_PORT: toInt(env('REDIS_PORT', '6379'), 6379),
    REDIS_PASSWORD: env('REDIS_PASSWORD'),
    
    // Rate Limiting
    RATE_LIMIT_WINDOW_MS: toInt(env('RATE_LIMIT_WINDOW_MS', '900000'), 900000), // 15 minutes
    RATE_LIMIT_MAX_REQUESTS: toInt(env('RATE_LIMIT_MAX_REQUESTS', '100'), 100),
    
    // Security
    BCRYPT_ROUNDS: toInt(env('BCRYPT_ROUNDS', '12'), 12),
    
    // report Types
    GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT: env('GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT', 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT'),
    MAX_ASINS_PER_REQUEST: toInt(env('MAX_ASINS_PER_REQUEST', '15'), 15),
    MAX_DAYS_AGO: toInt(env('MAX_DAYS_AGO', '2'), 2),
    
    // Timeout settings
    HTTP_TIMEOUT_MS: toInt(env('HTTP_TIMEOUT_MS', '120000'), 120000), // 2 minutes
    DOWNLOAD_TIMEOUT_MS: toInt(env('DOWNLOAD_TIMEOUT_MS', '300000'), 300000), // 5 minutes
    API_TIMEOUT_MS: toInt(env('API_TIMEOUT_MS', '60000'), 60000), // 1 minute
    
    // Memory limits
    MAX_FILE_SIZE_MB: toInt(env('MAX_FILE_SIZE_MB', '100'), 100),
    MAX_MEMORY_USAGE_MB: toInt(env('MAX_MEMORY_USAGE_MB', '500'), 500),
    MAX_JSON_SIZE_MB: toInt(env('MAX_JSON_SIZE_MB', '50'), 50),
    
    // Retry settings    
    INITIAL_DELAY_SECONDS: toInt(env('INITIAL_DELAY_SECONDS', '30'), 30),
    
    // Circuit breaker
    CIRCUIT_BREAKER_THRESHOLD: toInt(env('CIRCUIT_BREAKER_THRESHOLD', '5'), 5),
    CIRCUIT_BREAKER_TIMEOUT_MS: toInt(env('CIRCUIT_BREAKER_TIMEOUT_MS', '60000'), 60000),
    
    // Database connection limits
    DB_CONNECTION_POOL_MAX: toInt(env('DB_CONNECTION_POOL_MAX', '5'), 5),
    DB_CONNECTION_POOL_MIN: toInt(env('DB_CONNECTION_POOL_MIN', '0'), 0),
    DB_CONNECTION_TIMEOUT_MS: toInt(env('DB_CONNECTION_TIMEOUT_MS', '60000'), 60000),

    // Report Types
    TYPE_ARRAY: env('TYPE_ARRAY', ['WEEK', 'MONTH', 'QUARTER']),
    WEEKS_TO_PULL: toInt(env('WEEKS_TO_PULL'), 2),
    MONTHS_TO_PULL: toInt(env('MONTHS_TO_PULL'), 2),
    QUARTERS_TO_PULL: toInt(env('QUARTERS_TO_PULL'), 2),
};

module.exports = { env, ...config };
