/**
 * Security Utilities
 * Minimal security functions for sensitive data handling
 */

/**
 * Mask sensitive seller ID (show first 2 and last 2 characters)
 * @param {string} sellerID - Seller ID to mask
 * @returns {string} - Masked seller ID
 */
function maskSellerID(sellerID) {
    if (!sellerID || typeof sellerID !== 'string' || sellerID.length <= 4) {
        return '***';
    }
    return `${sellerID.substring(0, 2)}***${sellerID.substring(sellerID.length - 2)}`;
}

/**
 * Sanitize log data - masks sensitive fields
 * @param {Object} data - Data to sanitize
 * @returns {Object} - Sanitized data
 */
function sanitizeLogData(data) {
    if (!data || typeof data !== 'object') {
        return data;
    }

    const sanitized = { ...data };
    
    // Mask seller IDs
    if (sanitized.amazonSellerID) {
        sanitized.amazonSellerID = maskSellerID(sanitized.amazonSellerID);
    }
    if (sanitized.AmazonSellerID) {
        sanitized.AmazonSellerID = maskSellerID(sanitized.AmazonSellerID);
    }
    
    // Redact tokens and secrets
    const redactFields = ['accessToken', 'access_token', 'refreshToken', 'refresh_token', 
                          'password', 'secret', 'apiKey', 'api_key', 'token'];
    
    for (const field of redactFields) {
        if (field in sanitized) {
            sanitized[field] = '[REDACTED]';
        }
    }
    
    return sanitized;
}

/**
 * Validate Amazon Seller ID format
 * @param {string} sellerID - Seller ID to validate
 * @returns {boolean} - True if valid
 */
function isValidSellerID(sellerID) {
    if (!sellerID || typeof sellerID !== 'string') {
        return false;
    }
    // Amazon Seller IDs: A[0-9A-Z]{12,14}
    return /^A[0-9A-Z]{12,14}$/.test(sellerID);
}

/**
 * Get allowed user IDs from environment
 * @returns {Array<number>} - Array of allowed user IDs
 */
function getAllowedUsers() {
    const envUsers = process.env.ALLOWED_USER_IDS;
    if (!envUsers) {
        throw new Error('ALLOWED_USER_IDS not configured in environment');
    }
    return envUsers;
}

/**
 * Check if user is allowed
 * @param {number} userId - User ID to check
 * @returns {boolean} - True if allowed
 */
function isUserAllowed(userId) {
    try {
        const allowed = getAllowedUsers();
        return allowed.includes(parseInt(userId, 10));
    } catch (error) {
        // In production, deny access if configuration is missing
        if (process.env.NODE_ENV === 'production') {
            return false;
        }
    }
}

/**
 * Secure CORS origin validator
 * @param {string} origin - Origin to validate
 * @param {Function} callback - Callback function
 */
function corsOriginValidator(origin, callback) {
    const allowedOrigins = process.env.ALLOWED_ORIGINS;
    
    // Production: MUST have configured origins
    if (process.env.NODE_ENV === 'production') {
        if (!allowedOrigins) {
            return callback(new Error('CORS not configured for production'));
        }
        
        const allowed = allowedOrigins.split(',').map(o => o.trim());
        
        // Allow requests with no origin (mobile apps, curl, etc)
        if (!origin || allowed.includes(origin)) {
            return callback(null, true);
        }
        
        return callback(new Error('Not allowed by CORS'));
    }
    
    // Development: Use configured or safe defaults
    const devAllowed = allowedOrigins 
        ? allowedOrigins.split(',').map(o => o.trim())
        : ['http://localhost:3000', 'http://localhost:3001'];
    
    if (!origin || devAllowed.includes(origin)) {
        return callback(null, true);
    }
    
    callback(null, true); // Allow in development
}

module.exports = {
    maskSellerID,
    sanitizeLogData,
    isValidSellerID,
    getAllowedUsers,
    isUserAllowed,
    corsOriginValidator
};

