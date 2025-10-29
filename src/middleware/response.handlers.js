const logger = require('../utils/logger.utils');
const { sanitizeLogData } = require('../utils/security.utils');

/**
 * Success response handler
 */
class SuccessHandler {
    /**
     * Send success response with data
     */
    static sendSuccess(res, data = null, message = 'Operation completed successfully', statusCode = 200) {
        const response = {
            success: true,
            message,
            timestamp: new Date().toISOString(),
            ...(data && { data })
        };

        logger.info({ 
            statusCode, 
            message,
            hasData: !!data 
        }, 'Success response sent');

        return res.status(statusCode).json(response);
    }

    /**
     * Send success response for processing operations
     */
    static sendProcessingSuccess(res, processed, errors = 0, message = 'Processing completed') {
        const response = {
            success: true,
            message,
            processed,
            errors,
            timestamp: new Date().toISOString()
        };

        logger.info({ 
            processed, 
            errors, 
            message 
        }, 'Processing success response sent');

        return res.status(200).json(response);
    }

    /**
     * Send success response for statistics
     */
    static sendStatsSuccess(res, stats, message = 'Statistics retrieved successfully') {
        const response = {
            success: true,
            message,
            stats,
            timestamp: new Date().toISOString()
        };

        logger.info({ 
            stats, 
            message 
        }, 'Stats success response sent');

        return res.status(200).json(response);
    }

    /**
     * Send success response for file operations
     */
    static sendFileSuccess(res, fileInfo, message = 'File operation completed successfully') {
        const response = {
            success: true,
            message,
            file: fileInfo,
            timestamp: new Date().toISOString()
        };

        logger.info({ 
            fileInfo, 
            message 
        }, 'File success response sent');

        return res.status(200).json(response);
    }
}

/**
 * Error response handler
 */
class ErrorHandler {
    /**
     * Send error response
     */
    static sendError(res, error, message = 'An error occurred', statusCode = 500) {
        const response = {
            success: false,
            message,
            error: error.message || error,
            timestamp: new Date().toISOString()
        };

        logger.error(sanitizeLogData({ 
            statusCode, 
            message, 
            error: error.message || error,
            errorName: error.name
        }), 'Error response sent');

        return res.status(statusCode).json(response);
    }

    /**
     * Send validation error response
     */
    static sendValidationError(res, validationErrors, message = 'Validation failed') {
        const response = {
            success: false,
            message,
            errors: validationErrors,
            timestamp: new Date().toISOString()
        };

        logger.warn({ 
            validationErrors, 
            message 
        }, 'Validation error response sent');

        return res.status(400).json(response);
    }

    /**
     * Send authentication error response
     */
    static sendAuthError(res, message = 'Authentication failed') {
        const response = {
            success: false,
            message,
            timestamp: new Date().toISOString()
        };

        logger.warn({ message }, 'Authentication error response sent');

        return res.status(401).json(response);
    }

    /**
     * Send authorization error response
     */
    static sendAuthzError(res, message = 'Access denied') {
        const response = {
            success: false,
            message,
            timestamp: new Date().toISOString()
        };

        logger.warn({ message }, 'Authorization error response sent');

        return res.status(403).json(response);
    }

    /**
     * Send not found error response
     */
    static sendNotFoundError(res, message = 'Resource not found') {
        const response = {
            success: false,
            message,
            timestamp: new Date().toISOString()
        };

        logger.warn({ message }, 'Not found error response sent');

        return res.status(404).json(response);
    }

    /**
     * Send processing error response
     */
    static sendProcessingError(res, error, processed = 0, errors = 0, message = 'Processing failed') {
        const response = {
            success: false,
            message,
            error: error.message || error,
            processed,
            errors,
            timestamp: new Date().toISOString()
        };

        logger.error({ 
            error: error.message || error,
            processed, 
            errors, 
            message 
        }, 'Processing error response sent');

        return res.status(500).json(response);
    }

    /**
     * Send database error response
     */
    static sendDatabaseError(res, error, message = 'Database operation failed') {
        const response = {
            success: false,
            message,
            error: 'Database operation failed',
            timestamp: new Date().toISOString()
        };

        logger.error(sanitizeLogData({ 
            error: error.message,
            message,
            code: error.code
        }), 'Database error response sent');

        return res.status(500).json(response);
    }

    /**
     * Send file error response
     */
    static sendFileError(res, error, message = 'File operation failed') {
        const response = {
            success: false,
            message,
            error: error.message || error,
            timestamp: new Date().toISOString()
        };

        logger.error({ 
            error: error.message || error,
            message 
        }, 'File error response sent');

        return res.status(500).json(response);
    }

    /**
     * Send rate limit error response
     */
    static sendRateLimitError(res, message = 'Rate limit exceeded') {
        const response = {
            success: false,
            message,
            timestamp: new Date().toISOString()
        };

        logger.warn({ message }, 'Rate limit error response sent');

        return res.status(429).json(response);
    }
}

/**
 * Async error handler wrapper
 */
class AsyncErrorHandler {
    /**
     * Wrap async route handlers to catch errors
     */
    static wrap(fn) {
        return (req, res, next) => {
            Promise.resolve(fn(req, res, next)).catch(next);
        };
    }

    /**
     * Global error handler middleware
     */
    static globalErrorHandler(err, req, res, next) {
        //Sanitize error logs
        logger.error(sanitizeLogData({
            error: err.message,
            url: req.url,
            method: req.method,
            ip: req.ip,
            userAgent: req.get('User-Agent')
        }), 'Unhandled error in request');

        // Send appropriate error response
        if (err.name === 'ValidationError') {
            return ErrorHandler.sendValidationError(res, err.errors, 'Validation failed');
        } else if (err.name === 'UnauthorizedError') {
            return ErrorHandler.sendAuthError(res, 'Authentication required');
        } else if (err.name === 'ForbiddenError') {
            return ErrorHandler.sendAuthzError(res, 'Access denied');
        } else if (err.name === 'NotFoundError') {
            return ErrorHandler.sendNotFoundError(res, 'Resource not found');
        } else if (err.code === 'ER_DUP_ENTRY') {
            return ErrorHandler.sendError(res, err, 'Duplicate entry', 409);
        } else if (err.code === 'ER_NO_REFERENCED_ROW_2') {
            return ErrorHandler.sendError(res, err, 'Referenced record not found', 400);
        } else {
            return ErrorHandler.sendError(res, err, 'Internal server error', 500);
        }
    }
}

module.exports = {
    SuccessHandler,
    ErrorHandler,
    AsyncErrorHandler
};
