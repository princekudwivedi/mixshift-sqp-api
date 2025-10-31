/**
 * Status Check Service
 * Handles report status checking operations
 * Extracted from sqp.cron.controller.js
 */

const logger = require('../../utils/logger.utils');
const model = require('../../models/sqp.cron.model');
const sp = require('../../spapi/client.spapi');
const downloadUrls = require('../../models/sqp.download.urls.model');
const sellerModel = require('../../models/sequelize/seller.model');
const authService = require('../../services/auth.service');
const { RetryHelpers } = require('../../helpers/sqp.helpers');
const { getModel: getSqpCronDetails } = require('../../models/sequelize/sqpCronDetails.model');
const { getModel: getSqpCronLogs } = require('../../models/sequelize/sqpCronLogs.model');
const { Op } = require('sequelize');

class StatusCheckService {
    /**
     * Check report statuses for cron details
     * @param {Object} authOverrides - Authentication overrides
     * @param {Object} filter - Filter criteria
     * @param {boolean} retry - Whether this is a retry operation
     * @returns {Promise<Array>} Results
     */
    async checkReportStatuses(authOverrides = {}, filter = {}, retry = false) {
        logger.info('Starting checkReportStatuses');
        
        const { cronDetailID, cronDetailData } = filter;
        const rows = cronDetailData;
        
        logger.info({ reportCount: rows.length }, 'Found reports for status check');
        
        if (rows.length === 0) {
            logger.info('No reports found for status check');
            return [];
        }
        
        const res = [];
        
        for (const row of rows) {
            logger.info({ rowId: row.ID }, 'Processing report row');
            
            let loop = [];
            if (retry && filter.reportType) {
                loop = [filter.reportType];
            } else {
                loop = await model.getReportsForStatusType(row, retry);
            }
            
            logger.info({ loop }, `Loop status check ${cronDetailID}`);
            
            for (const type of loop) {
                const statusField = `${model.mapPrefix(type)}SQPDataPullStatus`;
                const processStatusField = row[statusField];

                if (processStatusField === 0 || (retry && processStatusField === 2)) {
                    // Set running status
                    await model.setProcessRunningStatus(row.ID, type, 2);

                    const reportID = await model.getLatestReportId(row.ID, type);

                    await model.logCronActivity({
                        cronJobID: row.ID,
                        reportType: type,
                        action: 'Check Status',
                        status: 1,
                        message: 'Checking report status',
                        reportID
                    });

                    logger.info({ type }, 'Checking status for report');

                    const result = await this.checkReportStatusByType(
                        row, 
                        type, 
                        authOverrides, 
                        reportID, 
                        retry
                    );

                    if (result.success) {
                        res.push(result);
                    }
                }
            }
        }

        return retry ? res : undefined;
    }

    /**
     * Check report status by type
     * @param {Object} row - Cron detail row
     * @param {string} reportType - Report type
     * @param {Object} authOverrides - Authentication overrides
     * @param {string} reportID - Report ID
     * @param {boolean} retry - Whether this is a retry
     * @returns {Promise<Object>} Result
     */
    async checkReportStatusByType(row, reportType, authOverrides = {}, reportID = null, retry = false) {
        const reportId = reportID || await model.getLatestReportId(row.ID, reportType);
        
        if (!reportId) {
            logger.warn({ 
                cronDetailID: row.ID, 
                reportType 
            }, 'No report ID found for status check');
            return { success: false };
        }

        const result = await RetryHelpers.executeWithRetry({
            cronDetailID: row.ID,
            amazonSellerID: row.AmazonSellerID,
            reportType,
            action: 'Check Status',
            context: { row, reportType, reportId, retry },
            model,
            maxRetries: Number(process.env.RETRY_MAX_ATTEMPTS) || 5,
            sendFailureNotification: this.sendFailureNotification.bind(this),
            operation: async ({ attempt, currentRetry, context, startTime }) => {
                const { row, reportType, reportId } = context;

                // Get seller profile
                const seller = await sellerModel.getProfileDetailsByAmazonSellerID(row.AmazonSellerID);
                if (!seller) {
                    throw new Error(`Seller not found: ${row.AmazonSellerID}`);
                }

                // Get current auth overrides
                const currentAuthOverrides = await authService.buildAuthOverrides(row.AmazonSellerID);
                if (!currentAuthOverrides.accessToken) {
                    throw new Error('No access token available');
                }

                // Check report status
                const statusResp = await sp.getReportStatus(seller, reportId, currentAuthOverrides);
                const status = statusResp.processingStatus;

                logger.info({ 
                    reportId, 
                    status, 
                    reportType 
                }, 'Report status checked');

                if (status === 'DONE') {
                    const documentId = statusResp.reportDocumentId;

                    // Update status
                    await model.updateSQPReportStatus(row.ID, reportType, 1);

                    // Store download URL
                    await downloadUrls.storeDownloadUrl({
                        CronJobID: row.ID,
                        ReportID: reportId,
                        ReportType: reportType,
                        DownloadURL: '',
                        Status: 'PENDING',
                        DownloadAttempts: 0,
                        MaxDownloadAttempts: 3
                    });

                    logger.info({ 
                        reportId, 
                        documentId 
                    }, 'Report ready for download - starting download process');

                    // Now download the report
                    const reportOps = require('./report-operations.service');
                    const jsonSvc = require('../sqp.json.processing.service');
                    
                    try {
                        await reportOps.downloadReport({
                            seller,
                            reportId,
                            documentId,
                            range: { range: 'N/A' }, // Range not available in retry context
                            reportType,
                            authOverrides: currentAuthOverrides,
                            cronDetailID: row.ID,
                            model,
                            downloadUrls,
                            jsonSvc,
                            isInitialPull: false,
                            retry: true
                        });

                        logger.info({ 
                            reportId, 
                            documentId 
                        }, 'Report downloaded and imported successfully');

                    } catch (downloadErr) {
                        logger.error({ 
                            error: downloadErr.message,
                            reportId,
                            documentId
                        }, 'Failed to download report after status check');
                        
                        // Don't throw - let retry mechanism handle it
                        return {
                            success: false,
                            status: 'DOWNLOAD_FAILED',
                            error: downloadErr.message,
                            reportId,
                            documentId
                        };
                    }

                    return {
                        success: true,
                        status: 'DONE',
                        documentId,
                        reportId
                    };
                    
                } else if (status === 'IN_QUEUE' || status === 'IN_PROGRESS' || status === 'PROCESSING') {
                    // Report still processing - calculate delay and trigger retry
                    const { DelayHelpers } = require('../../helpers/sqp.helpers');
                    const delaySeconds = DelayHelpers.calculateBackoffDelay(attempt, `Delay for ${status}`);
                    
                    // Log the status
                    await model.logCronActivity({
                        cronJobID: row.ID,
                        reportType,
                        action: 'Check Status',
                        status: 0,
                        message: `Report ${status.toLowerCase().replace('_', ' ')} on attempt ${attempt}, waiting ${delaySeconds}s before retry`,
                        reportID: reportId,
                        retryCount: currentRetry,
                        executionTime: (Date.now() - startTime) / 1000
                    });
                    
                    logger.info({ 
                        reportId, 
                        status, 
                        attempt, 
                        delaySeconds
                    }, `Report still processing, waiting ${delaySeconds}s before retry`);
                    
                    // Wait before retrying
                    await DelayHelpers.wait(delaySeconds, `Before retry ${status}`);
                    
                    // Throw error to trigger retry mechanism
                    throw new Error(`Report still ${status.toLowerCase().replace('_', ' ')} after ${delaySeconds}s wait - retrying`);
                    
                } else if (status === 'FATAL' || status === 'CANCELLED') {
                    // Fatal or cancelled status
                    logger.error({ reportId, status }, `Report failed with ${status} status`);
                    
                    await model.logCronActivity({
                        cronJobID: row.ID,
                        reportType,
                        action: 'Check Status',
                        status: 2,
                        message: `Report ${status}: No retries attempted`,
                        reportID: reportId,
                        retryCount: currentRetry,
                        executionTime: (Date.now() - startTime) / 1000
                    });
                    
                    return {
                        success: false,
                        status,
                        message: `Report ${status}`,
                        reportId,
                        noRetryNeeded: true
                    };
                    
                } else {
                    // Unknown status
                    const unknownStatus = status || 'UNKNOWN';
                    logger.warn({ reportId, status: unknownStatus }, 'Unknown report status');
                    
                    return {
                        success: false,
                        status: unknownStatus,
                        message: `Unknown status: ${unknownStatus}`,
                        reportId
                    };
                }
            }
        });

        return result;
    }

    /**
     * Send failure notification
     * @param {number} cronDetailID - Cron detail ID
     * @param {string} amazonSellerID - Amazon seller ID
     * @param {string} reportType - Report type
     * @param {string} errorMessage - Error message
     * @param {number} retryCount - Retry count
     * @param {string} reportId - Report ID
     * @param {boolean} isFatalError - Whether this is a fatal error
     * @returns {Promise<void>}
     */
    async sendFailureNotification(cronDetailID, amazonSellerID, reportType, errorMessage, retryCount, reportId = null, isFatalError = false) {
        try {
            const notificationType = isFatalError ? 'FATAL ERROR' : 'MAX RETRIES REACHED';
            const notificationReason = isFatalError 
                ? 'Amazon returned FATAL/CANCELLED status - no retries attempted'
                : `Max retries (${retryCount}) exhausted`;
            
            logger.error({
                cronDetailID,
                amazonSellerID,
                reportType,
                errorMessage,
                retryCount,
                isFatalError,
                notificationType
            }, `SENDING FAILURE NOTIFICATION - ${notificationType}`);
            
            // Log the notification
            await model.logCronActivity({
                cronJobID: cronDetailID,
                reportType: reportType,
                action: 'Failure Notification',
                status: 2,
                message: `NOTIFICATION: Report failed after ${retryCount} attempts. ${notificationReason}. Error: ${errorMessage}`,
                reportID: reportId,
                retryCount: retryCount,
                executionTime: 0
            });
            
            // Send email if configured
            const NotificationHelpers = require('../../helpers/sqp.helpers').NotificationHelpers;
            const to = NotificationHelpers.parseList(process.env.NOTIFY_TO);
            const cc = NotificationHelpers.parseList(process.env.NOTIFY_CC);
            const bcc = NotificationHelpers.parseList(process.env.NOTIFY_BCC);
            
            if ((to.length + cc.length + bcc.length) > 0) {
                const subject = `[SQP Alert] ${notificationType}: ${reportType} Report`;
                const body = `
Report Processing Failed
=======================

Type: ${notificationType}
Report Type: ${reportType}
Amazon Seller ID: ${amazonSellerID}
Cron Detail ID: ${cronDetailID}
Report ID: ${reportId || 'N/A'}
Retry Count: ${retryCount}
Error: ${errorMessage}

Reason: ${notificationReason}

Please check the logs for more details.
                `.trim();

                await NotificationHelpers.sendEmail({
                    to, cc, bcc,
                    subject,
                    text: body,
                    html: `<pre>${body}</pre>`
                });

                logger.info({ to, cc, bcc }, 'Failure notification email sent');
            }
            
        } catch (error) {
            logger.error({ 
                error: error.message, 
                cronDetailID 
            }, 'Error sending failure notification');
        }
    }
}

// Export singleton
module.exports = new StatusCheckService();

