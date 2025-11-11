/**
 * Notification Utilities
 * Common functions for determining when to send notifications and error classification
 */

const logger = require('./logger.utils');
const dates = require('./dates.utils');

/**
 * Send failure notification only for critical errors
 * 
 * Notifications are sent ONLY for:
 * - FATAL status from Amazon
 * - CANCELLED status from Amazon
 * - FORBIDDEN (401/403) authentication errors
 * - UNKNOWN status from Amazon
 * - Server errors (500+)
 * - Amazon API errors
 * 
 * Notifications are NOT sent for:
 * - IN_QUEUE or IN_PROGRESS (normal retry scenarios)
 * - Temporary network errors
 * - Rate limiting (will retry)
 * 
 * @param {Object} params - Notification parameters
 * @param {number} params.cronDetailID - Cron detail ID
 * @param {string} params.amazonSellerID - Amazon Seller ID
 * @param {string} params.reportType - Report type (WEEK/MONTH/QUARTER)
 * @param {string} params.errorMessage - Error message
 * @param {number} params.retryCount - Number of retries
 * @param {string} params.reportId - Report ID (optional)
 * @param {boolean} params.isFatalError - Is fatal error (optional)
 * @param {string} params.range - Date range (optional, for initial pull)
 * @param {Object} params.model - Model object for logging
 * @param {Object} params.NotificationHelpers - Notification helpers
 * @param {Object} params.env - Environment config (optional)
 * @param {string} params.context - Context (e.g., 'Initial Pull', 'Cron') - optional
 */
async function sendFailureNotification(params) {
    const {
        cronDetailID,
        amazonSellerID,
        reportType,
        errorMessage,
        retryCount,
        reportId = null,
        isFatalError = false,
        range = null,
        model,
        NotificationHelpers,
        env = null,
        context = ''
    } = params;

    try {
        // Determine if this is a critical error that requires notification
        const isCriticalError = shouldSendNotification(errorMessage, isFatalError);
        
        if (!isCriticalError) {
            logger.info({
                cronDetailID,
                amazonSellerID,
                reportType,
                errorMessage,
                retryCount,
                range,
                context
            }, 'Non-critical error - notification skipped (will retry)');
            return; // Skip notification for non-critical errors
        }
        
        // Determine notification type and message
        const contextPrefix = context ? `${context} - ` : '';
        const notificationType = isFatalError ? `${contextPrefix}FATAL ERROR` : `${contextPrefix}CRITICAL ERROR`;
        const notificationReason = isFatalError 
            ? 'Amazon returned FATAL/CANCELLED status - no retries attempted'
            : `Critical error after ${retryCount} attempts`;
        
        logger.error({
            cronDetailID,
            amazonSellerID,
            reportType,
            errorMessage,
            retryCount,
            isFatalError,
            notificationType,
            context
        }, `SENDING FAILURE NOTIFICATION - ${notificationType}`);
        
        // Log the notification (status 3 for fatal, 2 for retryable)
        const logOptions = {
            cronJobID: cronDetailID,
            reportType: reportType,
            action: isFatalError ? 'Fatal Error' : 'Critical Error Notification',
            status: isFatalError ? 3 : 2,
            message: `NOTIFICATION: Report failed after ${retryCount} attempts. ${notificationReason}. Error: ${errorMessage}`,
            reportID: reportId,
            retryCount: retryCount,
            executionTime: 0
        };
        
        // Add range for initial pull
        if (range) {
            const rangeStr = range?.range || range;
            logOptions.Range = rangeStr;
            logOptions.iInitialPull = 1;
            logOptions.message = `NOTIFICATION: Report failed after ${retryCount} attempts for ${rangeStr}. ${notificationReason}. Error: ${errorMessage}`;
        }
        
        await model.logCronActivity(logOptions);
        
        // Send actual email notification if SMTP and recipients are configured
        const envConfig = env || require('../config/env.config');
        const to = NotificationHelpers.parseList(process.env.NOTIFY_TO || envConfig.NOTIFY_TO);
        const cc = NotificationHelpers.parseList(process.env.NOTIFY_CC || envConfig.NOTIFY_CC);
        const bcc = NotificationHelpers.parseList(process.env.NOTIFY_BCC || envConfig.NOTIFY_BCC);
        
        if ((to.length + cc.length + bcc.length) > 0) {
            // Different subject lines for FATAL vs critical errors
            const rangeInfo = range ? ` (${range?.range || range})` : '';
            const subject = isFatalError 
                ? `⚠️ ${contextPrefix}FATAL Error [${reportType}]${rangeInfo} - ${amazonSellerID}`
                : `⚠️ ${contextPrefix}Critical Error [${reportType}]${rangeInfo} - ${amazonSellerID}`;
            
            const html = `
                <h3>${contextPrefix}${isFatalError ? 'FATAL' : 'Critical'} Error</h3>
                <p><strong>Cron Detail ID:</strong> ${cronDetailID}</p>
                <p><strong>Seller:</strong> ${amazonSellerID}</p>
                <p><strong>Report Type:</strong> ${reportType}</p>
                ${range ? `<p><strong>Date Range:</strong> ${range?.range || range}</p>` : ''}
                <p><strong>Report ID:</strong> ${reportId || 'N/A'}</p>
                <p><strong>Retry Count:</strong> ${retryCount}</p>
                <p><strong>Error Type:</strong> ${getErrorType(errorMessage)}</p>
                <p><strong>Failure Type:</strong> ${isFatalError ? 'Amazon FATAL/CANCELLED (immediate)' : 'Critical error - requires attention'}</p>
                <p><strong>Error:</strong> ${errorMessage}</p>
                <p><strong>Time:</strong> ${dates.getNowDateTimeInUserTimezone().log}</p>
                ${isFatalError ? '<p><em>Note: This report returned a FATAL/CANCELLED status from Amazon and cannot be recovered. No retry attempts were made.</em></p>' : ''}
                <hr>
                <p><small>This notification is sent only for critical errors. Normal retries (IN_QUEUE, IN_PROGRESS) do not trigger notifications.</small></p>
            `;
            
            await NotificationHelpers.sendEmail({ subject, html, to, cc, bcc });
            
            logger.info({
                cronDetailID,
                amazonSellerID,
                reportType,
                range,
                to: to.length,
                cc: cc.length,
                bcc: bcc.length,
                context
            }, 'Critical error notification email sent');
        } else {
            logger.warn('Notification recipients not configured (NOTIFY_TO/CC/BCC)');
        }
        
    } catch (notificationError) {
        logger.error({ 
            notificationError: notificationError ? (notificationError.message || String(notificationError)) : 'Unknown error',
            errorStack: notificationError?.stack,
            cronDetailID,
            amazonSellerID,
            reportType,
            context
        }, 'Failed to send failure notification');
    }
}

/**
 * Determine if error is critical and requires notification
 * 
 * Notifications are sent ONLY for:
 * - FATAL status from Amazon
 * - CANCELLED status from Amazon
 * - FORBIDDEN (401/403) authentication errors
 * - UNKNOWN status from Amazon
 * - Server errors (500+)
 * - Amazon API errors
 * 
 * Notifications are NOT sent for:
 * - IN_QUEUE or IN_PROGRESS (normal retry scenarios)
 * - Temporary network errors
 * - Rate limiting (will retry)
 * 
 * @param {string} errorMessage - Error message
 * @param {boolean} isFatalError - If marked as fatal
 * @returns {boolean} True if notification should be sent
 */
function shouldSendNotification(errorMessage, isFatalError) {
    // Always send notification for fatal errors
    if (isFatalError) {
        return true;
    }
    
    const errorLower = (errorMessage || '').toLowerCase();
    
    // Critical errors that require notification:
    const criticalPatterns = [
        'fatal',                      // FATAL status from Amazon
        'cancelled',                  // CANCELLED status from Amazon
        'forbidden',                  // 403 Forbidden
        'unauthorized',               // 401 Unauthorized
        'unknown',                    // UNKNOWN status from Amazon
        'invalid_grant',              // OAuth errors
        'access_denied',              // Permission errors
        'server error',               // 500+ errors
        'internal server',            // Internal errors
        'service unavailable',        // 503 errors
        'bad gateway',                // 502 errors
        'gateway timeout',            // 504 errors
        'invalid request',            // 400 errors (permanent)
        'not found',                  // 404 errors (permanent)
        'quota exceeded',             // Quota issues (critical)
        'invalid_client',             // OAuth client errors
        'invalid_scope',              // OAuth scope errors
        'access token',               // Token issues (after retries)
        'credentials'                 // Credential errors
    ];
    
    // Check if error matches any critical pattern
    const isCritical = criticalPatterns.some(pattern => errorLower.includes(pattern));
    
    // Non-critical errors (normal retries - DO NOT notify):
    const nonCriticalPatterns = [
        'in_queue',                   // Normal - report is queued
        'in_progress',                // Normal - report is processing
        'still in_queue',             // Normal retry scenario
        'still in_progress',          // Normal retry scenario
        'throttl',                    // Rate limiting (will retry)
        'too many requests',          // Rate limiting (will retry)
        'request limit'               // Rate limiting (will retry)
    ];
    
    // Check if error is non-critical
    const isNonCritical = nonCriticalPatterns.some(pattern => errorLower.includes(pattern));
    
    if (isNonCritical) {
        return false; // Don't send notification for normal retry scenarios
    }
    
    return isCritical;
}

/**
 * Get human-readable error type from error message
 * 
 * @param {string} errorMessage - Error message
 * @returns {string} Error type
 */
function getErrorType(errorMessage) {
    const errorLower = (errorMessage || '').toLowerCase();
    
    if (errorLower.includes('fatal')) return 'FATAL';
    if (errorLower.includes('cancelled')) return 'CANCELLED';
    if (errorLower.includes('forbidden') || errorLower.includes('403')) return 'FORBIDDEN (403)';
    if (errorLower.includes('unauthorized') || errorLower.includes('401')) return 'UNAUTHORIZED (401)';
    if (errorLower.includes('unknown')) return 'UNKNOWN STATUS';
    if (errorLower.includes('500') || errorLower.includes('internal server')) return 'SERVER ERROR (500)';
    if (errorLower.includes('502') || errorLower.includes('bad gateway')) return 'BAD GATEWAY (502)';
    if (errorLower.includes('503') || errorLower.includes('service unavailable')) return 'SERVICE UNAVAILABLE (503)';
    if (errorLower.includes('504') || errorLower.includes('gateway timeout')) return 'GATEWAY TIMEOUT (504)';
    if (errorLower.includes('quota')) return 'QUOTA EXCEEDED';
    if (errorLower.includes('access token')) return 'ACCESS TOKEN ERROR';
    if (errorLower.includes('invalid_grant')) return 'OAUTH ERROR';
    
    return 'CRITICAL ERROR';
}

module.exports = {
    sendFailureNotification,
    shouldSendNotification,
    getErrorType
};

