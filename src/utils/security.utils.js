/**
 * Security Utilities
 * Handles log sanitization, input validation, and security-related functions
 */

const logger = require('./logger.utils');

/**
 * Sensitive fields that should be sanitized from logs
 */
const SENSITIVE_FIELDS = [
    'password',
    'accessToken',
    'access_token',
    'refreshToken',
    'refresh_token',
    'secret',
    'apiKey',
    'api_key',
    'token',
    'authorization',
    'auth',
    'creditCard',
    'ssn',
    'privateKey',
    'private_key',
    'clientSecret',
    'client_secret'
];

/**
 * Sensitive patterns to redact (partial masking)
 */
const PARTIAL_MASK_FIELDS = [
    'email',
    'phone',
    'phoneNumber',
    'amazonSellerID'
];

/**
 * Sanitize object for logging - removes or masks sensitive data
 * @param {Object} obj - Object to sanitize
 * @param {boolean} deep - Whether to perform deep sanitization
 * @returns {Object} - Sanitized object
 */
function sanitizeForLogging(obj, deep = true) {
    if (!obj || typeof obj !== 'object') {
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(item => sanitizeForLogging(item, deep));
    }

    const sanitized = {};

    for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();

        // Check if field should be completely redacted
        if (SENSITIVE_FIELDS.some(field => lowerKey.includes(field.toLowerCase()))) {
            sanitized[key] = '[REDACTED]';
            continue;
        }

        // Check if field should be partially masked
        if (PARTIAL_MASK_FIELDS.some(field => lowerKey.includes(field.toLowerCase()))) {
            sanitized[key] = maskSensitiveData(value);
            continue;
        }

        // Deep sanitization for nested objects
        if (deep && value && typeof value === 'object') {
            sanitized[key] = sanitizeForLogging(value, deep);
        } else {
            sanitized[key] = value;
        }
    }

    return sanitized;
}

/**
 * Mask sensitive data (show first/last few characters)
 * @param {string} value - Value to mask
 * @returns {string} - Masked value
 */
function maskSensitiveData(value) {
    if (!value || typeof value !== 'string') {
        return value;
    }

    if (value.length <= 6) {
        return '***';
    }

    // Show first 2 and last 2 characters
    return `${value.substring(0, 2)}***${value.substring(value.length - 2)}`;
}

/**
 * Sanitize error for client response
 * Removes stack traces and sensitive information in production
 * @param {Error} error - Error object
 * @param {boolean} includeStack - Whether to include stack trace (development only)
 * @returns {Object} - Sanitized error object
 */
function sanitizeError(error, includeStack = false) {
    const isProduction = process.env.NODE_ENV === 'production';
    
    const sanitized = {
        message: error.message || 'An error occurred'
    };

    // Only include stack trace in development if explicitly allowed
    if (!isProduction && includeStack && error.stack) {
        // Sanitize stack trace to remove file system paths that could leak info
        sanitized.stack = error.stack
            .split('\n')
            .map(line => line.replace(/\(.*[\\/]/, '('))  // Remove file paths
            .join('\n');
    }

    // Include error name if available
    if (error.name && error.name !== 'Error') {
        sanitized.name = error.name;
    }

    // For specific error types, include relevant info
    if (error.code) {
        sanitized.code = error.code;
    }

    return sanitized;
}

/**
 * Validate seller ID format
 * @param {string} sellerID - Seller ID to validate
 * @returns {Object} - Validation result
 */
function validateSellerID(sellerID) {
    if (!sellerID || typeof sellerID !== 'string') {
        return {
            valid: false,
            error: 'Seller ID is required and must be a string'
        };
    }

    // Amazon Seller IDs typically follow pattern: A[0-9A-Z]{12,14}
    const sellerIDPattern = /^A[0-9A-Z]{12,14}$/;
    
    if (!sellerIDPattern.test(sellerID)) {
        return {
            valid: false,
            error: 'Invalid Seller ID format'
        };
    }

    return { valid: true };
}

/**
 * Safe logger wrapper that automatically sanitizes sensitive data
 * @param {string} level - Log level (info, error, warn, debug)
 * @param {Object} data - Data to log
 * @param {string} message - Log message
 */
function safeLog(level, data, message) {
    const sanitizedData = sanitizeForLogging(data);
    logger[level](sanitizedData, message);
}

/**
 * Validate and sanitize request parameters
 * @param {Object} params - Request parameters
 * @param {Array<string>} required - Required parameter names
 * @returns {Object} - Validation result
 */
function validateRequestParams(params, required = []) {
    const errors = [];
    const sanitized = {};

    for (const key of required) {
        if (!params[key]) {
            errors.push(`${key} is required`);
        } else {
            // Basic XSS prevention - strip HTML tags
            if (typeof params[key] === 'string') {
                sanitized[key] = params[key].replace(/<[^>]*>/g, '').trim();
            } else {
                sanitized[key] = params[key];
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        sanitized
    };
}

/**
 * Check if CORS origin is allowed
 * @param {string} origin - Origin to check
 * @param {string} allowedOrigins - Comma-separated list of allowed origins
 * @returns {boolean} - Whether origin is allowed
 */
function isOriginAllowed(origin, allowedOrigins) {
    if (!allowedOrigins) {
        return false; // Never allow if not configured
    }

    const allowed = allowedOrigins.split(',').map(o => o.trim());
    return allowed.includes(origin);
}

/**
 * Generate safe CORS configuration
 * @param {string} allowedOrigins - Comma-separated allowed origins from env
 * @returns {Object} - CORS configuration
 */
function generateCorsConfig(allowedOrigins) {
    const isProduction = process.env.NODE_ENV === 'production';

    // In production, NEVER allow wildcard
    if (isProduction) {
        if (!allowedOrigins) {
            logger.error('ALLOWED_ORIGINS not configured in production!');
            throw new Error('CORS origins must be explicitly configured in production');
        }

        return {
            origin: function (origin, callback) {
                // Allow requests with no origin (mobile apps, curl, etc)
                if (!origin) {
                    return callback(null, true);
                }

                if (isOriginAllowed(origin, allowedOrigins)) {
                    callback(null, true);
                } else {
                    logger.warn({ origin }, 'CORS request from unauthorized origin');
                    callback(new Error('Not allowed by CORS'));
                }
            },
            credentials: true,
            optionsSuccessStatus: 200
        };
    }

    // In development, use configured origins or localhost
    const devOrigins = allowedOrigins || 'http://localhost:3000,http://localhost:3001';
    
    return {
        origin: devOrigins.split(',').map(o => o.trim()),
        credentials: true,
        optionsSuccessStatus: 200
    };
}

module.exports = {
    sanitizeForLogging,
    maskSensitiveData,
    sanitizeError,
    validateSellerID,
    safeLog,
    validateRequestParams,
    isOriginAllowed,
    generateCorsConfig,
    SENSITIVE_FIELDS,
    PARTIAL_MASK_FIELDS
};

