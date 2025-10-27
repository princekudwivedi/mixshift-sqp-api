/**
 * Application Constants
 * Centralized constants following Node.js best practices
 */

module.exports = Object.freeze({
    // HTTP Status Codes
    HTTP_STATUS: {
        OK: 200,
        CREATED: 201,
        BAD_REQUEST: 400,
        UNAUTHORIZED: 401,
        FORBIDDEN: 403,
        NOT_FOUND: 404,
        CONFLICT: 409,
        TOO_MANY_REQUESTS: 429,
        INTERNAL_SERVER_ERROR: 500,
        SERVICE_UNAVAILABLE: 503
    },

    // Report Types
    REPORT_TYPES: {
        WEEK: 'WEEK',
        MONTH: 'MONTH',
        QUARTER: 'QUARTER'
    },

    // Process Status
    PROCESS_STATUS: {
        PENDING: 0,
        COMPLETED: 1,
        FAILED: 2,
        RUNNING: 3,
        IMPORT_DONE: 4
    },

    // ASIN Status
    ASIN_STATUS: {
        PENDING: 0,
        COMPLETED: 1,
        FAILED: 3
    },

    // Initial Pull Status
    INITIAL_PULL_STATUS: {
        PENDING: 0,
        COMPLETED: 1,
        PROCESSING: 2,
        FAILED: 3
    },

    // Amazon Report Processing Status
    AMAZON_STATUS: {
        IN_QUEUE: 'IN_QUEUE',
        IN_PROGRESS: 'IN_PROGRESS',
        DONE: 'DONE',
        CANCELLED: 'CANCELLED',
        FATAL: 'FATAL'
    },

    // Circuit Breaker States
    CIRCUIT_BREAKER_STATES: {
        CLOSED: 'CLOSED',
        OPEN: 'OPEN',
        HALF_OPEN: 'HALF_OPEN'
    },

    // Default Limits
    DEFAULTS: {
        MAX_ASINS_PER_REQUEST: 20,
        MAX_ASIN_STRING_LENGTH: 200,
        REQUEST_DELAY_SECONDS: 30,
        INITIAL_DELAY_SECONDS: 30,
        RETRY_MAX_DELAY_SECONDS: 120,
        MAX_RETRIES: 3,
        WEEKS_TO_PULL: 52,
        MONTHS_TO_PULL: 12,
        QUARTERS_TO_PULL: 4,
        MAX_MEMORY_MB: 500,
        RATE_LIMIT_PER_MINUTE: 100,
        CIRCUIT_BREAKER_THRESHOLD: 5,
        CIRCUIT_BREAKER_TIMEOUT_MS: 60000
    },

    // Error Messages
    ERRORS: {
        NO_ACCESS_TOKEN: 'No access token available for report request',
        NO_SELLER_FOUND: 'Seller not found',
        NO_USER_FOUND: 'User not found',
        NO_ELIGIBLE_ASINS: 'No eligible ASINs found',
        INVALID_REPORT_TYPE: 'Invalid report type',
        CIRCUIT_BREAKER_OPEN: 'Circuit breaker is OPEN - service unavailable',
        DATABASE_CONTEXT_NOT_INITIALIZED: 'Database context not initialized',
        TENANT_ISOLATION_BREACH: 'Database context mismatch - possible tenant isolation breach'
    },

    // Success Messages
    SUCCESS: {
        MAIN_CRON_STARTED: 'Main cron started successfully',
        INITIAL_PULL_STARTED: 'Initial pull started successfully',
        ASIN_SYNC_STARTED: 'ASIN sync started successfully',
        ASIN_RESET_STARTED: 'ASIN reset started successfully',
        CLEANUP_STARTED: 'Cleanup started successfully',
        RETRY_STARTED: 'Retry started successfully'
    },

    // Development Settings
    DEV: {
        ALLOWED_USERS: [8, 3],
        ENVIRONMENTS: ['local', 'development']
    }
});

