const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger.utils');
const datesUtils = require('../utils/dates.utils');

/**
 * Retry execution helper for cron operations
 */
class RetryHelpers {
    /**
     * Universal retry function for all cron operations
     * @param {Object} options - Configuration object
     * @param {number} options.cronDetailID - Cron detail ID
     * @param {string} options.amazonSellerID - Amazon seller ID
     * @param {string} options.reportType - Report type (WEEK, MONTH, QUARTER)
     * @param {string} options.action - Action name for logging
     * @param {Function} options.operation - The operation function to retry
     * @param {Object} options.context - Additional context data
     * @param {number} options.maxRetries - Maximum number of retries (default: 3)
     * @param {boolean} options.skipIfMaxRetriesReached - Skip if already at max retries (default: true)
     * @param {Object} options.model - Model object for database operations
     * @param {Function} options.sendFailureNotification - Function to send failure notifications
     * @returns {Promise<Object>} Result object with success, data, and error information
     */
    static async executeWithRetry(options) {
        const {
            cronDetailID,
            amazonSellerID,
            reportType,
            action,
            operation,
            context = {},
            maxRetries = 3,
            skipIfMaxRetriesReached = true,
            model,
            sendFailureNotification,
            extraLogFields = {}
        } = options;

        if (!model) {
            throw new Error('Model object is required for retry operations');
        }

        logger.info({
            cronDetailID,
            amazonSellerID,
            reportType,
            action,
            maxRetries
        }, `Starting ${action} with retry logic`);

        // Check if this report type has already reached max retries
        if (skipIfMaxRetriesReached) {
            const currentRetryCount = await model.getRetryCount(cronDetailID, reportType, context.reportId);
            if (currentRetryCount >= maxRetries) {
                logger.info({
                    cronDetailID,
                    reportType,
                    retryCount: currentRetryCount
                }, `Max retries already reached for ${action}, skipping`);
                return {
                    success: false,
                    skipped: true,
                    reason: 'Max retries already reached',
                    retryCount: currentRetryCount
                };
            }
        }

        let attempt = 0;
        let lastError = null;

        while (attempt < maxRetries) {
            attempt++;
            const currentRetry = attempt - 1;

            logger.info({
                cronDetailID,
                reportType,
                action,
                attempt,
                currentRetry,
                maxRetries
            }, `${action} attempt ${attempt} of ${maxRetries}`);

            try {
                const t0 = Date.now();

                // Log attempt start
                await model.logCronActivity({
                    cronJobID: cronDetailID,
                    reportType: reportType,
                    action: action,
                    status: 0,
                    message: `Attempt ${attempt}/${maxRetries}: Starting ${action}`,
                    reportID: (context && (context.reportId || context.reportID)) || null,
                    retryCount: currentRetry,
                    ...extraLogFields
                });

                // Execute the operation
                const result = await operation({
                    attempt,
                    currentRetry,
                    context,
                    startTime: t0
                });

                // Success! Log and return (skip if already logged - e.g., FATAL errors)
                // FATAL errors are already logged in handleFatalOrUnknownStatus with status: 2
                if (!result.skipped) {
                    await model.logCronActivity({
                        cronJobID: cronDetailID,
                        reportType: reportType,
                        action: action,
                        status: 1,
                        message: result.message || `${action} successful on attempt ${attempt}`,
                        reportID: result.reportID || (context && (context.reportId || context.reportID)) || null,
                        reportDocumentID: result.reportDocumentID || null,
                        retryCount: currentRetry,
                        executionTime: (Date.now() - t0) / 1000,
                        ...extraLogFields
                    });
                }

                logger.info({
                    cronDetailID,
                    reportType,
                    action,
                    attempt
                }, `${action} successful, exiting retry loop`);

                return {
                    success: true,
                    attempt,
                    retryCount: currentRetry,
                    data: result.data,
                    executionTime: (Date.now() - t0) / 1000
                };

            } catch (error) {
                lastError = error;
                
                // Classify error type to determine if retryable
                const isRetryable = this.isRetryableError(error);
                
                logger.error({
                    error: error ? (error.message || String(error)) : 'Unknown error',
                    stack: error?.stack,
                    cronDetailID,
                    reportType,
                    action,
                    attempt,
                    maxRetries,
                    isRetryable
                }, `Error in ${action} attempt ${attempt}`);

                // Only retry if error is retryable
                if (!isRetryable) {
                    logger.error({
                        cronDetailID,
                        reportType,
                        action,
                        error: error ? (error.message || String(error)) : 'Unknown error'
                    }, `Non-retryable error encountered, failing immediately`);
                    
                    const errorMsg = error ? (error.message || String(error)) : 'Unknown error';
                    
                    return {
                        success: false,
                        attempt,
                        error: errorMsg,
                        finalFailure: true,
                        nonRetryable: true
                    };
                }

                // Increment retry count for this attempt
                await model.incrementRetryCount(cronDetailID, reportType, context.reportId);
                const newRetryCount = await model.getRetryCount(cronDetailID, reportType, context.reportId);

                // Check if this was the last attempt
                if (attempt >= maxRetries) {
                    logger.error({
                        cronDetailID,
                        reportType,
                        action,
                        attempt,
                        retryCount: newRetryCount
                    }, `Max attempts reached for ${action}, marking as failed`);

                    // Final failure - set status to error and EndDate, but do NOT clear existing ReportID fields
                    try {
                        const existingReportId = (context && (context.reportId || context.reportID)) || null;
                        await model.updateSQPReportStatus(
                            cronDetailID,
                            reportType,
                            2, // error
                            existingReportId,
                            error ? (error.message || String(error)) : 'Unknown error',
                            null, // reportDocumentId unchanged
                            null, // isCompleted unchanged
                            null, // startDate unchanged
                            new Date() // endDate set on failure
                        );                       
                    } catch (updateErr) {
                        logger.error({ error: updateErr.message, cronDetailID, reportType }, 'Failed to set EndDate on failure');
                    }

                    // Also log the failure row
                    const errorMsg = error ? (error.message || String(error)) : 'Unknown error';
                    
                    await model.logCronActivity({
                        cronJobID: cronDetailID,
                        reportType: reportType,
                        action: action,
                        status: 2,
                        message: `${action} failed after ${maxRetries} attempts: ${errorMsg}`,
                        reportID: (context && (context.reportId || context.reportID)) || null,
                        retryCount: newRetryCount,
                        executionTime: 0,
                        ...extraLogFields
                    });

                    // Send notification for final failure if function is provided
                    if (sendFailureNotification && typeof sendFailureNotification === 'function') {
                        const reportId = (context && (context.reportId || context.reportID)) || null;
                        const range = context?.range || null; // Get range from context for initial pull
                        logger.info({
                            cronDetailID,
                            reportType,
                            action,
                            contextKeys: context ? Object.keys(context) : 'no context',
                            reportId,
                            range: range?.range || range,
                            contextReportId: context?.reportId,
                            contextReportID: context?.reportID
                        }, 'Sending failure notification with reportId and range');
                        await sendFailureNotification(cronDetailID, amazonSellerID, reportType, errorMsg, newRetryCount, reportId, false, range);
                    }

                    return {
                        success: false,
                        attempt,
                        retryCount: newRetryCount,
                        error: errorMsg,
                        finalFailure: true
                    };
                } else {
                    // Not the last attempt - log retry and continue
                    logger.warn({
                        cronDetailID,
                        reportType,
                        action,
                        attempt,
                        nextAttempt: attempt + 1,
                        retryCount: newRetryCount
                    }, `${action} attempt ${attempt} failed, will retry (${attempt + 1}/${maxRetries})`);

                    await model.logCronActivity({
                        cronJobID: cronDetailID,
                        reportType: reportType,
                        action: action,
                        status: 3, // Will retry
                        message: `${action} attempt ${attempt} failed, will retry (${attempt + 1}/${maxRetries}): ${error ? (error.message || String(error)) : 'Unknown error'}`,
                        reportID: (context && (context.reportId || context.reportID)) || null,
                        retryCount: newRetryCount,
                        executionTime: 0,
                        ...extraLogFields
                    });

                    // Wait before retry (exponential backoff)
                    const waitTimeMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Max 10 seconds
                    const waitTimeSec = waitTimeMs / 1000;
                    logger.info({ waitTime: waitTimeMs, waitTimeSec, attempt, action }, 'Waiting before retry');
                    await DelayHelpers.wait(waitTimeSec, 'Waiting before retry');
                }
            }
        }

        // This should never be reached, but just in case
        return {
            success: false,
            attempt,
            error: lastError?.message || 'Unknown error',
            finalFailure: true
        };
    }

    /**
     * Classify error type to determine if it's retryable
     * @param {Error} error - The error to classify
     * @returns {boolean} - True if error is retryable, false otherwise
     */
    static isRetryableError(error) {
        if (!error || !error.message) return false;
        
        const message = error.message.toLowerCase();
        const status = error.status || error.statusCode || error.code;
        
        // Non-retryable errors (permanent failures)
        const nonRetryablePatterns = [
            /invalid.*token/i,
            /unauthorized/i,
            /forbidden/i,
            /not found/i,
            /bad request/i,
            /validation error/i,
            /invalid.*parameter/i,
            /missing.*required/i,
            /authentication.*failed/i,
            /permission.*denied/i
        ];
        
        // Check for non-retryable patterns
        if (nonRetryablePatterns.some(pattern => pattern.test(message))) {
            return false;
        }
        
        // Check for non-retryable HTTP status codes
        if (status && [400, 401, 403, 404, 422].includes(status)) {
            return false;
        }
        
        // Retryable errors (temporary failures)
        const retryablePatterns = [
            /timeout/i,
            /network/i,
            /connection/i,
            /rate limit/i,
            /temporary/i,
            /server error/i,
            /service unavailable/i,
            /too many requests/i,
            /internal server error/i,
            /gateway timeout/i,
            /bad gateway/i
        ];
        
        // Check for retryable patterns
        if (retryablePatterns.some(pattern => pattern.test(message))) {
            return true;
        }
        
        // Check for retryable HTTP status codes
        if (status && [429, 500, 502, 503, 504].includes(status)) {
            return true;
        }
        
        // Default to retryable for unknown errors (conservative approach)
        return true;
    }    
}

/**
 * Input validation and sanitization helpers
 */
class ValidationHelpers {
    /**
     * Sanitize string input with comprehensive security measures
     */
    static sanitizeString(input, maxLength = 255) {
        if (typeof input !== 'string') return '';
        
        return input
            .trim()
            .substring(0, maxLength)
            .replace(/[<>\"'&]/g, '')  // XSS protection
            .replace(/[';-]/g, '')  // SQL injection protection
            .replace(/[^\w\s\-\.@]/g, '') // Allow only safe characters
            .replace(/\s+/g, ' ')      // Normalize whitespace
            .trim();
    }

    /**
     * Validate and sanitize numeric input with bounds checking
     */
    static sanitizeNumber(input, defaultValue = 0, min = -Infinity, max = Infinity) {
        if (input === null || input === undefined || input === '') {
            return defaultValue;
        }
        
        const num = Number(input);
        if (isNaN(num) || !isFinite(num)) {
            return defaultValue;
        }
        
        // Apply bounds
        if (num < min) return min;
        if (num > max) return max;
        
        return num;
    }

    /**
     * Validate and sanitize date input
     */
    static sanitizeDate(input) {
        if (!input) return null;
        const date = new Date(input);
        return isNaN(date.getTime()) ? null : date.toISOString().split('T')[0];
    }

    /**
     * Validate Amazon Seller ID
     */
    static validateAmazonSellerId(sellerId) {
        if (!sellerId || typeof sellerId !== 'string') {
            throw new Error('Invalid Amazon Seller ID');
        }
        return this.sanitizeString(sellerId, 50);
    }

    /**
     * Validate user ID with proper bounds checking
     */
    static validateUserId(userId) {
        if (userId === null || userId === undefined || userId === '') {
            throw new Error('Invalid user ID: must be between 1 and 999999999');
        }
        
        const num = Number(userId);
        if (isNaN(num) || !isFinite(num)) {
            throw new Error('Invalid user ID: must be between 1 and 999999999');
        }
        
        if (num < 1 || num > 999999999) {
            throw new Error('Invalid user ID: must be between 1 and 999999999');
        }
        
        return num;
    }

    /**
     * Validate and sanitize email input
     */
    static validateEmail(email) {
        if (!email || typeof email !== 'string') {
            throw new Error('Email is required');
        }
        
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const sanitizedEmail = this.sanitizeString(email.toLowerCase(), 254);
        
        if (!emailRegex.test(sanitizedEmail)) {
            throw new Error('Invalid email format');
        }
        
        return sanitizedEmail;
    }

    /**
     * Validate required fields in an object
     */
    static validateRequiredFields(obj, requiredFields) {
        if (!obj || typeof obj !== 'object') {
            throw new Error('Object is required for validation');
        }
        
        const missingFields = requiredFields.filter(field => {
            const value = obj[field];
            return value === null || value === undefined || value === '';
        });
        
        if (missingFields.length > 0) {
            throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
        }
        
        return true;
    }
}

/**
 * Date calculation helpers
 */
class DateHelpers {
    /**
     * Get report date for a specific period with error handling
     */
    static getReportDateForPeriod(reportType, timezone = datesUtils.DENVER_TZ, useDenverTz = true) {
        try {
            // Validate inputs
            if (!reportType || typeof reportType !== 'string') {
                throw new Error('Report type is required and must be a string');
            }
            
            if (!timezone || typeof timezone !== 'string') {
                throw new Error('Timezone is required and must be a string');
            }
            
            const today = useDenverTz ? datesUtils.getNowInDenver(timezone) : new Date();
            
            // Validate date object
            if (!today || isNaN(today.getTime())) {
                throw new Error('Invalid date object created');
            }
            
            switch (reportType.toUpperCase()) {
                case 'WEEK':
                    // Use the current week's end date (Saturday)
                    const daysUntilSaturday = 6 - today.getDay();
                    const weekEnd = new Date(today);
                    weekEnd.setDate(today.getDate() + daysUntilSaturday);
                    return weekEnd.toISOString().split('T')[0];
                    
                case 'MONTH':
                    // Use the current month's end date
                    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
                    return monthEnd.toISOString().split('T')[0];
                    
                case 'QUARTER':
                    // Use the current quarter's end date
                    const quarter = Math.floor(today.getMonth() / 3);
                    const quarterEnd = new Date(today.getFullYear(), (quarter + 1) * 3, 0);
                    return quarterEnd.toISOString().split('T')[0];
                    
                default:
                    logger.warn({ reportType }, 'Unknown report type, using current date');
                    return today.toISOString().split('T')[0];
            }
        } catch (error) {
            logger.error({ 
                error: error.message, 
                reportType, 
                timezone, 
                useDenverTz 
            }, 'Date calculation failed, using fallback');
            
            // Fallback to current date
            return new Date().toISOString().split('T')[0];
        }
    }

    /**
     * Validate date string format
     */
    static validateDateString(dateString) {
        if (!dateString || typeof dateString !== 'string') {
            throw new Error('Date string is required');
        }
        
        const date = new Date(dateString);
        if (isNaN(date.getTime())) {
            throw new Error('Invalid date format');
        }
        
        return date;
    }

    /**
     * Get date range with validation
     */
    static getDateRange(startDate, endDate) {
        try {
            const start = this.validateDateString(startDate);
            const end = this.validateDateString(endDate);
            
            if (start > end) {
                throw new Error('Start date cannot be after end date');
            }
            
            return {
                start: start.toISOString().split('T')[0],
                end: end.toISOString().split('T')[0],
                days: Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1
            };
        } catch (error) {
            logger.error({ error: error.message, startDate, endDate }, 'Date range validation failed');
            throw error;
        }
    }
}

/**
 * File processing helpers
 */
class FileHelpers {
    /**
     * Check if file exists
     */
    static async fileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Read JSON file safely with size limits and validation
     */
    static async readJsonFile(filePath, maxSizeMB = 100) {
        let stats = null;
        try {
            if (!(await this.fileExists(filePath))) {
                throw new Error(`File not found: ${filePath}`);
            }

            // Check file size before reading
            stats = await fs.stat(filePath);
            const maxSize = maxSizeMB * 1024 * 1024;
            
            if (stats.size > maxSize) {
                throw new Error(`File too large: ${stats.size} bytes (max: ${maxSize} bytes)`);
            }

            // Validate file extension
            if (!filePath.toLowerCase().endsWith('.json')) {
                throw new Error('File must be JSON format');
            }

            const content = await fs.readFile(filePath, 'utf8');
            
            // Validate JSON content
            try {
                return JSON.parse(content);
            } catch (parseError) {
                throw new Error(`Invalid JSON format: ${parseError.message}`);
            }
        } catch (error) {
            logger.error({ 
                error: error.message, 
                filePath, 
                fileSize: stats?.size 
            }, 'Error reading JSON file');
            throw error;
        }
    }

    /**
     * Resolve report type from file path
     */
    static resolveReportTypeFromPath(filePath) {
        if (!filePath) return 'MONTH';
        
        const lower = filePath.toLowerCase();
        if (lower.includes('/week/') || lower.includes('\\week\\') || lower.includes('week_')) return 'WEEK';
        if (lower.includes('/month/') || lower.includes('\\month\\') || lower.includes('month_')) return 'MONTH';
        if (lower.includes('/quarter/') || lower.includes('\\quarter\\') || lower.includes('quarter_')) return 'QUARTER';
        
        return 'MONTH';
    }

    /**
     * Get file size in bytes with validation
     */
    static async getFileSize(filePath) {
        try {
            if (!filePath) {
                throw new Error('File path is required');
            }
            
            const stats = await fs.stat(filePath);
            return stats.size;
        } catch (error) {
            logger.error({ error: error.message, filePath }, 'Error getting file size');
            return 0;
        }
    }

    /**
     * Validate file path for security
     */
    static validateFilePath(filePath) {
        if (!filePath || typeof filePath !== 'string') {
            throw new Error('File path is required');
        }
        
        // Check for path traversal attacks
        if (filePath.includes('..') || filePath.includes('~')) {
            throw new Error('Invalid file path: path traversal detected');
        }
        
        // Check for absolute paths in restricted directories
        const restrictedPaths = ['/etc/', '/sys/', '/proc/', '/dev/'];
        if (restrictedPaths.some(path => filePath.startsWith(path))) {
            throw new Error('Invalid file path: access to restricted directory');
        }
        
        return true;
    }

    /**
     * Create directory safely
     */
    static async createDirectory(dirPath) {
        try {
            await fs.mkdir(dirPath, { recursive: true });
            return true;
        } catch (error) {
            logger.error({ error: error.message, dirPath }, 'Error creating directory');
            throw error;
        }
    }
}

/**
 * Data processing helpers
 */
class DataProcessingHelpers {
    /**
     * Extract records from JSON content
     */
    static extractRecords(jsonContent) {
        if (Array.isArray(jsonContent)) {
            return jsonContent;
        } else if (jsonContent.records && Array.isArray(jsonContent.records)) {
            return jsonContent.records;
        } else if (jsonContent.dataByAsin && Array.isArray(jsonContent.dataByAsin)) {
            return jsonContent.dataByAsin;
        }
        return [];
    }

    /**
     * Calculate derived metrics from SQP record
     */
    static calculateDerivedMetrics(record) {
        const impressions = Number(record.impressionData?.asinImpressionCount || 0);
        const clicks = Number(record.clickData?.asinClickCount || 0);
        const orders = Number(record.purchaseData?.asinPurchaseCount || 0);
        const medianClickPrice = Number(record.clickData?.asinMedianClickPrice?.amount || 0);
        const medianPurchasePrice = Number(record.purchaseData?.asinMedianPurchasePrice?.amount || 0);

        const clickThroughRate = impressions > 0 ? (clicks / impressions) * 100 : 0;
        const spend = clicks * medianClickPrice;
        const sales = orders * medianPurchasePrice;
        const acos = sales > 0 ? (spend / sales) * 100 : 0;
        const conversionRate = clicks > 0 ? (orders / clicks) * 100 : 0;

        return {
            clickThroughRate,
            spend,
            sales,
            acos,
            conversionRate
        };
    }

    /**
     * Validate SQP record structure
     */
    static validateSqpRecord(record) {
        const requiredFields = ['asin'];
        const missingFields = requiredFields.filter(field => !record[field]);
        
        if (missingFields.length > 0) {
            throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
        }

        return true;
    }

    /**
     * Clean and prepare metrics data for storage
     */
    static prepareMetricsData(download, reportType, reportDate, record, filePath) {
        const asin = ValidationHelpers.sanitizeString(record.asin || '');
        const queryStr = ValidationHelpers.sanitizeString(record.searchQueryData?.searchQuery || '');
        const impressions = ValidationHelpers.sanitizeNumber(record.impressionData?.asinImpressionCount || 0);
        const clicks = ValidationHelpers.sanitizeNumber(record.clickData?.asinClickCount || 0);
        const orders = ValidationHelpers.sanitizeNumber(record.purchaseData?.asinPurchaseCount || 0);
        const cartAdds = ValidationHelpers.sanitizeNumber(record.cartAddData?.asinCartAddCount || 0);

        // Skip records with no meaningful data
        if (!asin || !queryStr || (impressions === 0 && clicks === 0 && cartAdds === 0 && orders === 0)) {
            return null;
        }

        const derivedMetrics = this.calculateDerivedMetrics(record);
        const currencyCode = this.extractCurrencyCode(record);

        return {
            ReportID: download.ReportID,
            AmazonSellerID: download.AmazonSellerID,
            ReportType: reportType,
            ReportDate: reportDate,
            StartDate: ValidationHelpers.sanitizeDate(record.startDate),
            EndDate: ValidationHelpers.sanitizeDate(record.endDate),
            CurrencyCode: currencyCode,
            SearchQuery: queryStr,
            SearchQueryScore: ValidationHelpers.sanitizeNumber(record.searchQueryData?.searchQueryScore || 0),
            SearchQueryVolume: ValidationHelpers.sanitizeNumber(record.searchQueryData?.searchQueryVolume || 0),
            TotalQueryImpressionCount: ValidationHelpers.sanitizeNumber(record.impressionData?.totalQueryImpressionCount || 0),
            AsinImpressionCount: impressions,
            AsinImpressionShare: ValidationHelpers.sanitizeNumber(record.impressionData?.asinImpressionShare || 0),
            TotalClickCount: ValidationHelpers.sanitizeNumber(record.clickData?.totalClickCount || 0),
            TotalClickRate: ValidationHelpers.sanitizeNumber(record.clickData?.totalClickRate || 0),
            AsinClickCount: clicks,
            AsinClickShare: ValidationHelpers.sanitizeNumber(record.clickData?.asinClickShare || 0),
            TotalMedianClickPrice: ValidationHelpers.sanitizeNumber(record.clickData?.totalMedianClickPrice?.amount || 0),
            AsinMedianClickPrice: ValidationHelpers.sanitizeNumber(record.clickData?.asinMedianClickPrice?.amount || 0),
            TotalSameDayShippingClickCount: ValidationHelpers.sanitizeNumber(record.clickData?.totalSameDayShippingClickCount || 0),
            TotalOneDayShippingClickCount: ValidationHelpers.sanitizeNumber(record.clickData?.totalOneDayShippingClickCount || 0),
            TotalTwoDayShippingClickCount: ValidationHelpers.sanitizeNumber(record.clickData?.totalTwoDayShippingClickCount || 0),
            TotalCartAddCount: ValidationHelpers.sanitizeNumber(record.cartAddData?.totalCartAddCount || 0),
            TotalCartAddRate: ValidationHelpers.sanitizeNumber(record.cartAddData?.totalCartAddRate || 0),
            AsinCartAddCount: cartAdds,
            AsinCartAddShare: ValidationHelpers.sanitizeNumber(record.cartAddData?.asinCartAddShare || 0),
            TotalMedianCartAddPrice: ValidationHelpers.sanitizeNumber(record.cartAddData?.totalMedianCartAddPrice?.amount || 0),
            AsinMedianCartAddPrice: ValidationHelpers.sanitizeNumber(record.cartAddData?.asinMedianCartAddPrice?.amount || 0),
            TotalSameDayShippingCartAddCount: ValidationHelpers.sanitizeNumber(record.cartAddData?.totalSameDayShippingCartAddCount || 0),
            TotalOneDayShippingCartAddCount: ValidationHelpers.sanitizeNumber(record.cartAddData?.totalOneDayShippingCartAddCount || 0),
            TotalTwoDayShippingCartAddCount: ValidationHelpers.sanitizeNumber(record.cartAddData?.totalTwoDayShippingCartAddCount || 0),
            TotalPurchaseCount: ValidationHelpers.sanitizeNumber(record.purchaseData?.totalPurchaseCount || 0),
            TotalPurchaseRate: ValidationHelpers.sanitizeNumber(record.purchaseData?.totalPurchaseRate || 0),
            AsinPurchaseCount: orders,
            AsinPurchaseShare: ValidationHelpers.sanitizeNumber(record.purchaseData?.asinPurchaseShare || 0),
            TotalMedianPurchasePrice: ValidationHelpers.sanitizeNumber(record.purchaseData?.totalMedianPurchasePrice?.amount || 0),
            AsinMedianPurchasePrice: ValidationHelpers.sanitizeNumber(record.purchaseData?.asinMedianPurchasePrice?.amount || 0),
            AsinPurchaseRate: ValidationHelpers.sanitizeNumber(record.purchaseData?.asinPurchaseRate || derivedMetrics.conversionRate),
            TotalSameDayShippingPurchaseCount: ValidationHelpers.sanitizeNumber(record.purchaseData?.totalSameDayShippingPurchaseCount || 0),
            TotalOneDayShippingPurchaseCount: ValidationHelpers.sanitizeNumber(record.purchaseData?.totalOneDayShippingPurchaseCount || 0),
            TotalTwoDayShippingPurchaseCount: ValidationHelpers.sanitizeNumber(record.purchaseData?.totalTwoDayShippingPurchaseCount || 0),
            ASIN: asin,
            dtCreatedOn: new Date()
        };
    }

    /**
     * Extract currency code from record
     */
    static extractCurrencyCode(record) {
        return record.clickData?.asinMedianClickPrice?.currencyCode
            || record.clickData?.totalMedianClickPrice?.currencyCode
            || record.cartAddData?.asinMedianCartAddPrice?.currencyCode
            || record.cartAddData?.totalMedianCartAddPrice?.currencyCode
            || record.purchaseData?.asinMedianPurchasePrice?.currencyCode
            || record.purchaseData?.totalMedianPurchasePrice?.currencyCode
            || null;
    }
}

/**
 * Notification helpers
 */
const nodemailer = require('nodemailer');
const env = require('../config/env.config');

class NotificationHelpers {
    static buildTransporter() {
        const host = env.SMTP_HOST;
        const port = env.SMTP_PORT;
        const user = env.SMTP_USER;
        const pass = env.SMTP_PASS;
        if (!host || !port || !user || !pass) {
            logger.warn('SMTP not configured; skipping email sending');
            return null;
        }
        return nodemailer.createTransport({
            host,
            port,
            secure: Number(port) === 465,
            auth: { user, pass }
        });
    }

    static parseList(raw) {
        if (!raw) return [];
        return String(raw).split(',').map(s => s.trim()).filter(Boolean);
    }

    static async sendEmail({ subject, html, to, cc, bcc, from }) {
        try {
            const transporter = this.buildTransporter();
            if (!transporter) return false;
            const mailOptions = {
                from: from || env.FROM_EMAIL || 'noreply@example.com',
                to: Array.isArray(to) ? to.join(',') : to,
                cc: Array.isArray(cc) ? cc.join(',') : cc,
                bcc: Array.isArray(bcc) ? bcc.join(',') : bcc,
                subject,
                html
            };
            await transporter.sendMail(mailOptions);
            logger.info({ subject, to: mailOptions.to }, 'Notification email sent');
            return true;
        } catch (error) {
            logger.error({ error: error.message, subject }, 'Failed to send notification email');
            return false;
        }
    }
    /**
     * Send max retry notification
     */
    static async sendMaxRetryNotification(download, result) {
        const attempts = (download.ProcessAttempts || 0) + 1;
        logger.error({ downloadID: download.ID, reportID: download.ReportID, attempts, result }, 'Max retry attempts reached for SQP processing');

        const to = this.parseList(env.NOTIFY_TO);
        const cc = this.parseList(env.NOTIFY_CC);
        const bcc = this.parseList(env.NOTIFY_BCC);
        if ((to.length + cc.length + bcc.length) === 0) {
            logger.warn('Notification recipients not configured (NOTIFY_TO/CC/BCC)');
            return false;
        }

        const subject = `SQP Processing Failed after ${attempts} attempts [ReportID: ${download.ReportID}]`;
        const html = `
            <h3>Max Retry Attempts Reached</h3>
            <p><strong>Download ID:</strong> ${download.ID}</p>
            <p><strong>Report ID:</strong> ${download.ReportID}</p>
            <p><strong>Seller:</strong> ${download.AmazonSellerID || ''}</p>
            <p><strong>File:</strong> ${download.FilePath || ''}</p>
            <p><strong>Attempts:</strong> ${attempts}</p>
            <p><strong>Last Error:</strong> ${result?.lastError || 'N/A'}</p>
            <p><strong>Totals:</strong> total=${result?.total || 0}, success=${result?.success || 0}, failed=${result?.failed || 0}</p>
            <p>Time: ${new Date().toISOString()}</p>
        `;

        return this.sendEmail({ subject, html, to, cc, bcc });
    }
}

/**
 * Delay helpers for timing and waiting
 */
class DelayHelpers {
    /**
     * Wait with logging before status checks or operations
     * @param {Object} options - Configuration object
     * @param {number} options.cronDetailID - Cron detail ID
     * @param {string} options.reportType - Report type
     * @param {string} options.reportId - Report ID
     * @param {number} options.delaySeconds - Delay in seconds (optional, uses env var if not provided)
     * @param {string} options.context - Context description (e.g., 'CHECK_STATUS', 'DOWNLOAD')
     * @param {Object} options.logger - Logger instance
     */
    static async waitWithLogging({ cronDetailID, reportType, reportId, delaySeconds, context = '', logger }) {
        if (!logger) {
            throw new Error('Logger is required for waitWithLogging');
        }

        // Use provided delay or get from environment
        const effectiveDelay = delaySeconds !== undefined 
            ? delaySeconds 
            : Number(process.env.INITIAL_DELAY_SECONDS) || 30;

        logger.info({ 
            initialDelaySeconds: process.env.INITIAL_DELAY_SECONDS,
            effectiveDelay 
        }, `Initial delay seconds${context ? ` ${context}` : ''}`);

        logger.info({ 
            cronDetailID, 
            reportType, 
            reportId, 
            delaySeconds: effectiveDelay,
            context
        }, `Waiting ${effectiveDelay}s before operation${context ? ` (${context})` : ''}`);

        // Wait
        await this.wait(effectiveDelay, context);

        logger.info({ 
            cronDetailID, 
            reportType, 
            reportId,
            context 
        }, `Delay completed${context ? ` (${context})` : ''}, ready to proceed`);

        return effectiveDelay;
    }

    /**
     * Calculate exponential backoff delay
     * @param {number} attempt - Current attempt number (1-based)
     * @param {number} baseDelay - Base delay in seconds
     * @param {number} maxDelay - Maximum delay in seconds
     * @returns {number} Calculated delay in seconds
     */
    static calculateBackoffDelay(attempt, context = '') {
        logger.info({ baseDelay: process.env.RETRY_BASE_DELAY_SECONDS, maxDelay: process.env.RETRY_MAX_DELAY_SECONDS }, context);
        // Report is still processing, add delay before retry
        const baseDelay = Number(process.env.RETRY_BASE_DELAY_SECONDS || process.env.INITIAL_DELAY_SECONDS) || 30;
        const maxDelay = Number(process.env.RETRY_MAX_DELAY_SECONDS) || 120;
        const delaySeconds = Math.min(baseDelay + ((attempt - 1) * 15), maxDelay);
        logger.info({ attempt, baseDelay, maxDelay, delaySeconds }, context);
        return delaySeconds;
    }

    /**
     * Simple delay without logging
     * @param {number} seconds - Delay in seconds
     */
    static async wait(seconds, context = '') {
        const maxWait = 300; // 5 minutes max
        const safeSeconds = Math.min(Math.max(seconds, 0), maxWait);
        
        if (safeSeconds !== seconds) {
            logger.warn({ 
                original: seconds, 
                safe: safeSeconds, 
                context 
            }, 'Wait time capped to prevent excessive delays');
        }
        
        logger.info({ 
            seconds: safeSeconds, 
            original: seconds,
            context 
        }, `Waiting ${safeSeconds}s${context ? ` (${context})` : ''}`);
        
        await new Promise(resolve => setTimeout(resolve, safeSeconds * 1000));
        
        logger.info({ 
            seconds: safeSeconds, 
            context 
        }, `Delay completed${context ? ` (${context})` : ''}, ready to proceed`);
    }
}

/**
 * Circuit Breaker pattern for API calls
 */
class CircuitBreaker {
    constructor(threshold = 5, timeout = 60000) {
        this.failureThreshold = threshold;
        this.timeout = timeout;
        this.failureCount = 0;
        this.lastFailureTime = null;
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
        this.successCount = 0;
        this.halfOpenMaxCalls = 3;
    }
    
    async execute(operation, context = {}) {
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime > this.timeout) {
                this.state = 'HALF_OPEN';
                this.successCount = 0;
                logger.info({ context }, 'Circuit breaker transitioning to HALF_OPEN');
            } else {
                const error = new Error('Circuit breaker is OPEN - service unavailable');
                error.code = 'CIRCUIT_BREAKER_OPEN';
                throw error;
            }
        }
        
        if (this.state === 'HALF_OPEN' && this.successCount >= this.halfOpenMaxCalls) {
            this.state = 'CLOSED';
            this.failureCount = 0;
            logger.info({ context }, 'Circuit breaker transitioning to CLOSED');
        }
        
        try {
            const result = await operation();
            this.onSuccess(context);
            return result;
        } catch (error) {
            this.onFailure(error, context);
            throw error;
        }
    }
    
    onSuccess(context) {
        this.failureCount = 0;
        if (this.state === 'HALF_OPEN') {
            this.successCount++;
        }
        logger.debug({ context, state: this.state }, 'Circuit breaker operation succeeded');
    }
    
    onFailure(error, context) {
        this.failureCount++;
        this.lastFailureTime = Date.now();
        
        if (this.failureCount >= this.failureThreshold) {
            this.state = 'OPEN';
            logger.error({ 
                error: error.message, 
                failureCount: this.failureCount,
                context 
            }, 'Circuit breaker opened due to failures');
        }
    }
    
    getState() {
        return {
            state: this.state,
            failureCount: this.failureCount,
            lastFailureTime: this.lastFailureTime,
            successCount: this.successCount
        };
    }
    
    reset() {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = null;
        logger.info('Circuit breaker reset');
    }
}

/**
 * Rate Limiter for API requests
 */
class RateLimiter {
    constructor(maxRequests = 100, windowMs = 60000) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        this.requests = new Map();
        this.cleanupInterval = setInterval(() => this.cleanup(), windowMs);
    }
    
    async checkLimit(identifier) {
        const now = Date.now();
        const windowStart = now - this.windowMs;
        
        // Clean old requests
        if (this.requests.has(identifier)) {
            const userRequests = this.requests.get(identifier);
            const validRequests = userRequests.filter(time => time > windowStart);
            this.requests.set(identifier, validRequests);
            
            if (validRequests.length >= this.maxRequests) {
                const oldestRequest = Math.min(...validRequests);
                const resetTime = oldestRequest + this.windowMs;
                const waitTime = Math.max(0, resetTime - now);
                
                const error = new Error(`Rate limit exceeded. Try again in ${Math.ceil(waitTime / 1000)} seconds`);
                error.code = 'RATE_LIMIT_EXCEEDED';
                error.retryAfter = Math.ceil(waitTime / 1000);
                throw error;
            }
        }
        
        // Add current request
        if (!this.requests.has(identifier)) {
            this.requests.set(identifier, []);
        }
        this.requests.get(identifier).push(now);
    }
    
    cleanup() {
        const now = Date.now();
        const windowStart = now - this.windowMs;
        
        for (const [identifier, requests] of this.requests.entries()) {
            const validRequests = requests.filter(time => time > windowStart);
            if (validRequests.length === 0) {
                this.requests.delete(identifier);
            } else {
                this.requests.set(identifier, validRequests);
            }
        }
    }
    
    getStats(identifier) {
        if (!this.requests.has(identifier)) {
            return { requests: 0, remaining: this.maxRequests };
        }
        
        const now = Date.now();
        const windowStart = now - this.windowMs;
        const validRequests = this.requests.get(identifier).filter(time => time > windowStart);
        
        return {
            requests: validRequests.length,
            remaining: Math.max(0, this.maxRequests - validRequests.length),
            resetTime: validRequests.length > 0 ? Math.min(...validRequests) + this.windowMs : now
        };
    }
    
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
    }
}

/**
 * Memory monitoring and management
 */
class MemoryMonitor {
    static checkMemoryUsage() {
        const usage = process.memoryUsage();
        const heapUsedMB = usage.heapUsed / 1024 / 1024;
        const heapTotalMB = usage.heapTotal / 1024 / 1024;
        const externalMB = usage.external / 1024 / 1024;
        
        const stats = {
            heapUsed: Math.round(heapUsedMB),
            heapTotal: Math.round(heapTotalMB),
            external: Math.round(externalMB),
            rss: Math.round(usage.rss / 1024 / 1024),
            arrayBuffers: Math.round(usage.arrayBuffers / 1024 / 1024)
        };
        
        // Log warning if memory usage is high
        if (heapUsedMB > 500) { // 500MB threshold
            logger.warn(stats, 'High memory usage detected');
            
            // Force garbage collection if available
            if (global.gc) {
                global.gc();
                logger.info('Forced garbage collection');
            }
        }
        
        return stats;
    }
    
    static getMemoryStats() {
        return this.checkMemoryUsage();
    }
    
    static isMemoryUsageHigh(thresholdMB = 500) {
        const usage = process.memoryUsage();
        const heapUsedMB = usage.heapUsed / 1024 / 1024;
        return heapUsedMB > thresholdMB;
    }
}


module.exports = {
    RetryHelpers,
    ValidationHelpers,
    DateHelpers,
    FileHelpers,
    DataProcessingHelpers,
    NotificationHelpers,
    DelayHelpers,
    CircuitBreaker,
    RateLimiter,
    MemoryMonitor
};















