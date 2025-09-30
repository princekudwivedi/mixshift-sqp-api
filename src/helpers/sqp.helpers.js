const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger.utils');

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
            sendFailureNotification
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
            const currentRetryCount = 0;
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
                    amazonSellerID: amazonSellerID,
                    reportType: reportType,
                    action: action,
                    status: 0,
                    message: `Attempt ${attempt}/${maxRetries}: Starting ${action}`,
                    reportID: (context && (context.reportId || context.reportID)) || null,
                    retryCount: currentRetry
                });

                // Execute the operation
                const result = await operation({
                    attempt,
                    currentRetry,
                    context,
                    startTime: t0
                });

                // Success! Log and return
                await model.logCronActivity({
                    cronJobID: cronDetailID,
                    amazonSellerID: amazonSellerID,
                    reportType: reportType,
                    action: action,
                    status: 1,
                    message: result.message || `${action} successful on attempt ${attempt}`,
                    reportID: result.reportID || (context && (context.reportId || context.reportID)) || null,
                    reportDocumentID: result.reportDocumentID || null,
                    retryCount: currentRetry,
                    executionTime: (Date.now() - t0) / 1000,
                    ...result.logData
                });

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
                logger.error({
                    error: error.message,
                    stack: error.stack,
                    cronDetailID,
                    reportType,
                    action,
                    attempt,
                    maxRetries
                }, `Error in ${action} attempt ${attempt}`);

                // Increment retry count for this attempt
                await model.incrementRetryCount(cronDetailID, reportType);
                const newRetryCount = await model.getRetryCount(cronDetailID, reportType);

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
                            error.message,
                            null, // reportDocumentId unchanged
                            null, // isCompleted unchanged
                            null, // startDate unchanged
                            new Date() // endDate set on failure
                        );                       
                    } catch (updateErr) {
                        logger.error({ error: updateErr.message, cronDetailID, reportType }, 'Failed to set EndDate on failure');
                    }

                    // Also log the failure row
                    await model.logCronActivity({
                        cronJobID: cronDetailID,
                        amazonSellerID: amazonSellerID,
                        reportType: reportType,
                        action: action,
                        status: 2,
                        message: `${action} failed after ${maxRetries} attempts: ${error.message}`,
                        reportID: (context && (context.reportId || context.reportID)) || null,
                        retryCount: newRetryCount,
                        executionTime: 0
                    });

                    // Send notification for final failure if function is provided
                    if (sendFailureNotification && typeof sendFailureNotification === 'function') {
                        const reportId = (context && (context.reportId || context.reportID)) || null;
                        logger.info({
                            cronDetailID,
                            reportType,
                            action,
                            contextKeys: context ? Object.keys(context) : 'no context',
                            reportId,
                            contextReportId: context?.reportId,
                            contextReportID: context?.reportID
                        }, 'Sending failure notification with reportId');
                        await sendFailureNotification(cronDetailID, amazonSellerID, reportType, error.message, newRetryCount, reportId);
                    }

                    return {
                        success: false,
                        attempt,
                        retryCount: newRetryCount,
                        error: error.message,
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
                        message: `${action} attempt ${attempt} failed, will retry (${attempt + 1}/${maxRetries}): ${error.message}`,
                        reportID: (context && (context.reportId || context.reportID)) || null,
                        retryCount: newRetryCount,
                        executionTime: 0
                    });

                    // Wait before retry (exponential backoff)
                    const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Max 10 seconds
                    logger.info({ waitTime, attempt, action }, 'Waiting before retry');
                    await new Promise(resolve => setTimeout(resolve, waitTime));
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
}

/**
 * Input validation and sanitization helpers
 */
class ValidationHelpers {
    /**
     * Sanitize string input
     */
    static sanitizeString(input, maxLength = 255) {
        if (typeof input !== 'string') return '';
        return input.trim().substring(0, maxLength).replace(/[<>\"'&]/g, '');
    }

    /**
     * Validate and sanitize numeric input
     */
    static sanitizeNumber(input, defaultValue = 0) {
        const num = Number(input);
        return isNaN(num) ? defaultValue : num;
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
     * Validate user ID
     */
    static validateUserId(userId) {
        const id = this.sanitizeNumber(userId);
        if (id <= 0) {
            throw new Error('Invalid user ID');
        }
        return id;
    }

    /**
     * Validate report type
     */
    static validateReportType(reportType) {
        const validTypes = ['WEEK', 'MONTH', 'QUARTER'];
        const type = this.sanitizeString(reportType).toUpperCase();
        if (!validTypes.includes(type)) {
            throw new Error('Invalid report type. Must be WEEK, MONTH, or QUARTER');
        }
        return type;
    }
}

/**
 * Date calculation helpers
 */
class DateHelpers {
    /**
     * Get report date for a specific period
     */
    static getReportDateForPeriod(reportType) {
        const today = new Date();
        
        switch (reportType) {
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
                return today.toISOString().split('T')[0];
        }
    }

    /**
     * Get date range for a period
     */
    static getDateRangeForPeriod(reportType) {
        const today = new Date();
        let startDate, endDate;

        switch (reportType) {
            case 'WEEK':
                const daysUntilSaturday = 6 - today.getDay();
                endDate = new Date(today);
                endDate.setDate(today.getDate() + daysUntilSaturday);
                startDate = new Date(endDate);
                startDate.setDate(endDate.getDate() - 6);
                break;
                
            case 'MONTH':
                startDate = new Date(today.getFullYear(), today.getMonth(), 1);
                endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
                break;
                
            case 'QUARTER':
                const quarter = Math.floor(today.getMonth() / 3);
                startDate = new Date(today.getFullYear(), quarter * 3, 1);
                endDate = new Date(today.getFullYear(), (quarter + 1) * 3, 0);
                break;
                
            default:
                startDate = new Date(today);
                endDate = new Date(today);
        }

        return {
            startDate: startDate.toISOString().split('T')[0],
            endDate: endDate.toISOString().split('T')[0]
        };
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
     * Read JSON file safely
     */
    static async readJsonFile(filePath) {
        try {
            if (!(await this.fileExists(filePath))) {
                throw new Error(`File not found: ${filePath}`);
            }

            const content = await fs.readFile(filePath, 'utf8');
            return JSON.parse(content);
        } catch (error) {
            logger.error({ error: error.message, filePath }, 'Error reading JSON file');
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
     * Get file size in bytes
     */
    static async getFileSize(filePath) {
        try {
            const stats = await fs.stat(filePath);
            return stats.size;
        } catch (error) {
            logger.error({ error: error.message, filePath }, 'Error getting file size');
            return 0;
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

module.exports = {
    RetryHelpers,
    ValidationHelpers,
    DateHelpers,
    FileHelpers,
    DataProcessingHelpers,
    NotificationHelpers
};
