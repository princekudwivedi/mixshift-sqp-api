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
     * Validate API token
     */
    static validateToken(req, res, next) {
        try {
            const authHeader = req.headers.authorization;
            const token = req.query.token || req.body.token;

            if (!authHeader && !token) {
                return ErrorHandler.sendAuthError(res, 'No token provided');
            }

            let authToken = null;
            
            if (authHeader) {
                const parts = authHeader.split(' ');
                if (parts.length !== 2 || parts[0] !== 'Bearer') {
                    return ErrorHandler.sendAuthError(res, 'Invalid authorization header format');
                }
                authToken = parts[1];
            } else {
                authToken = token;
            }

            if (!authToken) {
                return ErrorHandler.sendAuthError(res, 'No token provided');
            }

            // Validate token format (basic validation)
            if (typeof authToken !== 'string' || authToken.length < 10) {
                return ErrorHandler.sendAuthError(res, 'Invalid token format');
            }

            // Sanitize token
            const sanitizedToken = ValidationHelpers.sanitizeString(authToken, 1000);

            // If token looks like JWT (header.payload.signature), verify it
            const looksLikeJwt = sanitizedToken.split('.').length === 3;
            if (looksLikeJwt) {
                try {
                    const decoded = jwt.verify(sanitizedToken, env.JWT_SECRET);
                    req.user = decoded;
                    req.authToken = sanitizedToken;
                    req.authenticated = true;
                } catch (e) {
                    return ErrorHandler.sendAuthError(res, 'Invalid or expired JWT');
                }
            } else {
                // Compare with expected static token from ENV
                const expectedToken = env.API_ACCESS_TOKEN || env.API_KEY || null;
                if (expectedToken && sanitizedToken !== expectedToken) {
                    return ErrorHandler.sendAuthError(res, 'Invalid token');
                }
                req.authToken = sanitizedToken;
                req.authenticated = true;
            }

            logger.info({ 
                hasToken: !!sanitizedToken,
                tokenLength: sanitizedToken.length,
                ip: req.ip,
                userAgent: req.get('User-Agent')
            }, 'Token validated successfully');

            next();
        } catch (error) {
            logger.error({ 
                error: error.message,
                ip: req.ip 
            }, 'Token validation error');
            return ErrorHandler.sendAuthError(res, 'Token validation failed');
        }
    }

    /**
     * Optional token validation (doesn't fail if no token)
     */
    static optionalToken(req, res, next) {
        try {
            const authHeader = req.headers.authorization;
            const token = req.query.token || req.body.token;

            if (authHeader) {
                const parts = authHeader.split(' ');
                if (parts.length === 2 && parts[0] === 'Bearer') {
                    req.authToken = ValidationHelpers.sanitizeString(parts[1], 1000);
                    req.authenticated = true;
                }
            } else if (token) {
                req.authToken = ValidationHelpers.sanitizeString(token, 1000);
                req.authenticated = true;
            }

            next();
        } catch (error) {
            logger.error({ 
                error: error.message,
                ip: req.ip 
            }, 'Optional token validation error');
            next(); // Continue even if token validation fails
        }
    }

    /**
     * Validate user permissions
     */
    static validateUserPermissions(requiredPermissions = []) {
        return (req, res, next) => {
            try {
                // This would typically check user permissions from database
                // For now, we'll implement a basic check
                if (!req.authenticated) {
                    return ErrorHandler.sendAuthError(res, 'Authentication required');
                }

                // TODO: Implement actual permission checking logic
                // const userPermissions = await getUserPermissions(req.userId);
                // const hasPermission = requiredPermissions.every(permission => 
                //     userPermissions.includes(permission)
                // );

                // if (!hasPermission) {
                //     return ErrorHandler.sendAuthzError(res, 'Insufficient permissions');
                // }

                next();
            } catch (error) {
                logger.error({ 
                    error: error.message,
                    requiredPermissions 
                }, 'Permission validation error');
                return ErrorHandler.sendAuthzError(res, 'Permission validation failed');
            }
        };
    }

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
