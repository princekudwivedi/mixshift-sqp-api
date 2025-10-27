/**
 * Validation Utilities
 * Centralized validation logic for all operations
 */

const logger = require('./logger.utils');

class ValidationUtils {
    /**
     * Validate user ID
     */
    static validateUserId(userId) {
        if (!userId) {
            return { valid: false, error: 'User ID is required' };
        }
        
        const parsed = parseInt(userId);
        if (isNaN(parsed) || parsed < 0) {
            return { valid: false, error: 'Invalid user ID format' };
        }
        
        return { valid: true, userId: parsed };
    }

    /**
     * Validate seller ID
     */
    static validateSellerId(sellerId) {
        if (!sellerId) {
            return { valid: false, error: 'Seller ID is required' };
        }
        
        const parsed = parseInt(sellerId);
        if (isNaN(parsed) || parsed < 0) {
            return { valid: false, error: 'Invalid seller ID format' };
        }
        
        return { valid: true, sellerId: parsed };
    }

    /**
     * Validate report type
     */
    static validateReportType(reportType, allowedTypes = ['WEEK', 'MONTH', 'QUARTER']) {
        if (!reportType) {
            return { valid: false, error: 'Report type is required' };
        }
        
        if (!allowedTypes.includes(reportType)) {
            return { 
                valid: false, 
                error: `Invalid report type. Must be one of: ${allowedTypes.join(', ')}` 
            };
        }
        
        return { valid: true, reportType };
    }

    /**
     * Validate seller object
     */
    static validateSeller(seller) {
        if (!seller) {
            return { valid: false, error: 'Seller object is required' };
        }
        
        const required = ['idSellerAccount', 'AmazonSellerID', 'AmazonMarketplaceId'];
        const missing = required.filter(field => !seller[field]);
        
        if (missing.length > 0) {
            return { 
                valid: false, 
                error: `Seller missing required fields: ${missing.join(', ')}` 
            };
        }
        
        return { valid: true, seller };
    }

    /**
     * Validate ASIN list
     */
    static validateAsinList(asinList) {
        if (!Array.isArray(asinList)) {
            return { valid: false, error: 'ASIN list must be an array' };
        }
        
        if (asinList.length === 0) {
            return { valid: false, error: 'ASIN list cannot be empty' };
        }
        
        // Validate ASIN format (10 characters, alphanumeric)
        const invalidAsins = asinList.filter(asin => 
            !asin || typeof asin !== 'string' || asin.length !== 10 || !/^[A-Z0-9]+$/.test(asin)
        );
        
        if (invalidAsins.length > 0) {
            return { 
                valid: false, 
                error: `Invalid ASINs found: ${invalidAsins.slice(0, 5).join(', ')}...` 
            };
        }
        
        return { valid: true, asinList };
    }

    /**
     * Validate date range
     */
    static validateDateRange(range) {
        if (!range || typeof range !== 'object') {
            return { valid: false, error: 'Range must be an object' };
        }
        
        const required = ['startDate', 'endDate', 'type'];
        const missing = required.filter(field => !range[field]);
        
        if (missing.length > 0) {
            return { 
                valid: false, 
                error: `Range missing required fields: ${missing.join(', ')}` 
            };
        }
        
        // Validate date format (YYYY-MM-DD)
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(range.startDate) || !dateRegex.test(range.endDate)) {
            return { valid: false, error: 'Invalid date format. Expected: YYYY-MM-DD' };
        }
        
        // Validate type
        const validTypes = ['WEEK', 'MONTH', 'QUARTER'];
        if (!validTypes.includes(range.type)) {
            return { 
                valid: false, 
                error: `Invalid range type. Must be one of: ${validTypes.join(', ')}` 
            };
        }
        
        return { valid: true, range };
    }

    /**
     * Validate cron detail ID
     */
    static validateCronDetailId(cronDetailID) {
        if (!cronDetailID) {
            return { valid: false, error: 'Cron detail ID is required' };
        }
        
        const parsed = parseInt(cronDetailID);
        if (isNaN(parsed) || parsed < 0) {
            return { valid: false, error: 'Invalid cron detail ID format' };
        }
        
        return { valid: true, cronDetailID: parsed };
    }

    /**
     * Sanitize string input
     */
    static sanitizeString(input, maxLength = 1000) {
        if (!input) return '';
        
        let sanitized = String(input).trim();
        sanitized = sanitized.substring(0, maxLength);
        
        // Remove potentially harmful characters
        sanitized = sanitized.replace(/[<>]/g, '');
        
        return sanitized;
    }

    /**
     * Validate and sanitize query parameters
     */
    static validateQueryParams(query, schema) {
        const errors = [];
        const sanitized = {};
        
        for (const [key, rules] of Object.entries(schema)) {
            const value = query[key];
            
            // Check required
            if (rules.required && !value) {
                errors.push(`${key} is required`);
                continue;
            }
            
            // Skip if not required and not provided
            if (!value && !rules.required) {
                continue;
            }
            
            // Type validation
            if (rules.type === 'number') {
                const parsed = parseInt(value);
                if (isNaN(parsed)) {
                    errors.push(`${key} must be a number`);
                } else {
                    sanitized[key] = parsed;
                }
            } else if (rules.type === 'string') {
                sanitized[key] = this.sanitizeString(value, rules.maxLength || 1000);
            } else if (rules.type === 'enum') {
                if (!rules.values.includes(value)) {
                    errors.push(`${key} must be one of: ${rules.values.join(', ')}`);
                } else {
                    sanitized[key] = value;
                }
            }
        }
        
        if (errors.length > 0) {
            return { valid: false, errors };
        }
        
        return { valid: true, data: sanitized };
    }

    /**
     * Validate environment configuration
     */
    static validateEnvironment(env) {
        const errors = [];
        
        // Required env vars
        const required = [
            'DB_HOST', 'DB_USER', 'DB_PASS', 'DB_NAME',
            'S3_BUCKET', 'S3_REGION',
            'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT'
        ];
        
        for (const key of required) {
            if (!env[key]) {
                errors.push(`Missing required environment variable: ${key}`);
            }
        }
        
        // Validate numeric env vars
        const numeric = [
            'REQUEST_DELAY_SECONDS',
            'INITIAL_DELAY_SECONDS',
            'RETRY_MAX_DELAY_SECONDS'
        ];
        
        for (const key of numeric) {
            if (env[key] && isNaN(parseInt(env[key]))) {
                errors.push(`${key} must be a number`);
            }
        }
        
        if (errors.length > 0) {
            return { valid: false, errors };
        }
        
        return { valid: true };
    }

    /**
     * Batch validation helper
     */
    static validateBatch(items, validator) {
        const errors = [];
        const valid = [];
        
        items.forEach((item, index) => {
            const result = validator(item);
            if (result.valid) {
                valid.push(item);
            } else {
                errors.push({ index, error: result.error });
            }
        });
        
        return {
            valid: errors.length === 0,
            validItems: valid,
            errors
        };
    }
}

module.exports = ValidationUtils;

