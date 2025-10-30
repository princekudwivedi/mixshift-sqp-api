const jwt = require('jsonwebtoken');
const { ErrorHandler } = require('./response.handlers');
const logger = require('../utils/logger.utils');
const { ValidationHelpers } = require('../helpers/sqp.helpers');
const { env } = require('../config/env.config');

/**
 * Authentication middleware
 */
class AuthMiddleware {
    /**
     * Rate limiting middleware
     */
    static rateLimit(maxRequests = 100, windowMs = 15 * 60 * 1000) { // 100 requests per 15 minutes
        const requests = new Map();

        return (req, res, next) => {
            try {
                const key = req.ip || 'unknown';
                const now = Date.now();
                const windowStart = now - windowMs;

                // Clean old entries
                for (const [ip, data] of requests.entries()) {
                    if (data.windowStart < windowStart) {
                        requests.delete(ip);
                    }
                }

                // Get or create request data for this IP
                let requestData = requests.get(key);
                if (!requestData) {
                    requestData = {
                        count: 0,
                        windowStart: now
                    };
                    requests.set(key, requestData);
                }

                // Reset window if needed
                if (requestData.windowStart < windowStart) {
                    requestData.count = 0;
                    requestData.windowStart = now;
                }

                // Check rate limit
                if (requestData.count >= maxRequests) {
                    logger.warn({ 
                        ip: key,
                        count: requestData.count,
                        maxRequests 
                    }, 'Rate limit exceeded');
                    return ErrorHandler.sendRateLimitError(res, 'Too many requests');
                }

                // Increment counter
                requestData.count++;

                // Add rate limit info to response headers
                res.set({
                    'X-RateLimit-Limit': maxRequests,
                    'X-RateLimit-Remaining': Math.max(0, maxRequests - requestData.count),
                    'X-RateLimit-Reset': new Date(requestData.windowStart + windowMs).toISOString()
                });

                next();
            } catch (error) {
                logger.error({ 
                    error: error.message 
                }, 'Rate limiting error');
                next(); // Continue on rate limiting errors
            }
        };
    }

    /**
     * Request logging middleware
     */
    static requestLogger(req, res, next) {
        const start = Date.now();
        
        // Log request
        logger.info({
            method: req.method,
            url: req.url,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            hasToken: !!req.authToken,
            timestamp: new Date().toISOString()
        }, 'Incoming request');

        // Override res.end to log response
        const originalEnd = res.end;
        res.end = function(chunk, encoding) {
            const duration = Date.now() - start;
            
            logger.info({
                method: req.method,
                url: req.url,
                statusCode: res.statusCode,
                duration: `${duration}ms`,
                ip: req.ip,
                timestamp: new Date().toISOString()
            }, 'Request completed');

            originalEnd.call(this, chunk, encoding);
        };

        next();
    }

    /**
     * Security headers middleware
     */
    static securityHeaders(req, res, next) {
        // Set security headers
        res.set({
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'X-XSS-Protection': '1; mode=block',
            'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'Content-Security-Policy': "default-src 'self'"
        });

        next();
    }

    /**
     * Input sanitization middleware
     */
    static sanitizeInput(req, res, next) {
        try {
            // Sanitize query parameters
            if (req.query) {
                for (const [key, value] of Object.entries(req.query)) {
                    if (typeof value === 'string') {
                        req.query[key] = ValidationHelpers.sanitizeString(value);
                    }
                }
            }

            // Sanitize body parameters
            if (req.body) {
                for (const [key, value] of Object.entries(req.body)) {
                    if (typeof value === 'string') {
                        req.body[key] = ValidationHelpers.sanitizeString(value);
                    }
                }
            }

            next();
        } catch (error) {
            logger.error({ 
                error: error.message 
            }, 'Input sanitization error');
            return ErrorHandler.sendError(res, error, 'Input sanitization failed', 400);
        }
    }
}

module.exports = AuthMiddleware;
