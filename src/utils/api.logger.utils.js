/**
 * API Logger Utility
 * Creates hierarchical logs organized by user, date, and seller
 * 
 * Structure: logs/api_logs/user__{userId}/{date}/{sellerId}/
 * Log Files:
 *  - request_report__{sellerId}.log
 *  - request_status__{sellerId}.log
 *  - download__{sellerId}.log
 */

const fs = require('fs');
const path = require('path');

class APILogger {
    constructor() {
        this.baseLogPath = path.join(process.cwd(), 'logs', 'api_logs');
        this.ensureLogDirectory(this.baseLogPath);
    }

    /**
     * Ensure directory exists, create if not
     */
    ensureLogDirectory(dirPath) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }

    /**
     * Get log file path based on user, date, seller account ID, and Amazon seller ID
     */
    getLogFilePath(userId, sellerAccountId, amazonSellerID, logType) {
        const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const userFolder = `user__${userId}`;
        const dateFolder = date;
        const sellerAccountFolder = sellerAccountId.toString();
        const amazonSellerFolder = amazonSellerID;

        const logDir = path.join(this.baseLogPath, userFolder, dateFolder, sellerAccountFolder, amazonSellerFolder);
        this.ensureLogDirectory(logDir);

        const logFileName = `${logType}__${amazonSellerID}.log`;
        return path.join(logDir, logFileName);
    }

    /**
     * Format log entry with timestamp
     */
    formatLogEntry(data) {
        const timestamp = new Date().toISOString();
        const separator = '='.repeat(80);
        
        let logEntry = `\n${separator}\n`;
        logEntry += `[${timestamp}]\n`;
        logEntry += `${separator}\n`;
        
        // Format data as readable JSON
        logEntry += JSON.stringify(data, null, 2);
        logEntry += `\n${separator}\n\n`;
        
        return logEntry;
    }

    /**
     * Write log entry to file
     */
    writeLog(filePath, logEntry) {
        try {
            fs.appendFileSync(filePath, logEntry, 'utf8');
        } catch (error) {
            console.error(`Failed to write log to ${filePath}:`, error.message);
        }
    }

    /**
     * Log Request Report operation
     * 
     * @param {Object} params - Log parameters
     * @param {number} params.userId - User ID
     * @param {string} params.sellerId - Amazon Seller ID
     * @param {string} params.sellerAccountId - Internal seller account ID
     * @param {string} params.endpoint - API endpoint called
     * @param {Object} params.requestPayload - Request body/params
     * @param {Object} params.requestHeaders - Request headers (optional)
     * @param {Object} params.response - Response data
     * @param {string} params.startTime - Request start timestamp
     * @param {string} params.endTime - Request end timestamp
     * @param {number} params.executionTime - Execution time in seconds
     * @param {string} params.status - success/failure
     * @param {string} params.reportId - Report ID returned
     * @param {string} params.reportType - WEEK/MONTH/QUARTER
     * @param {string} params.range - Date range
     * @param {Object} params.error - Error object (if failure)
     * @param {number} params.retryCount - Number of retries
     * @param {number} params.attempt - Current attempt number
     */
    logRequestReport(params) {
        const {
            userId,
            sellerId,
            sellerAccountId,
            endpoint = 'SP-API Create Report',
            requestPayload,
            requestHeaders,
            response,
            startTime,
            endTime,
            executionTime,
            status,
            reportId,
            reportType,
            range,
            error,
            retryCount = 0,
            attempt = 1
        } = params;

        const logData = {
            operation: 'REQUEST_REPORT',
            userId,
            sellerId,
            sellerAccountId,
            endpoint,
            reportType,
            range,
            reportId,
            status,
            request: {
                payload: requestPayload,
                headers: requestHeaders ? this.sanitizeHeaders(requestHeaders) : undefined
            },
            response: response ? {
                reportId: response.reportId || reportId,
                status: response.processingStatus,
                raw: response
            } : undefined,
            timing: {
                startTime,
                endTime,
                executionTimeSeconds: executionTime
            },
            retry: {
                attempt,
                retryCount
            },
            error: error ? {
                message: error.message || error,
                stack: error.stack,
                code: error.code,
                statusCode: error.statusCode || error.status
            } : undefined
        };

        const filePath = this.getLogFilePath(userId, sellerAccountId, sellerId, 'request_report');
        const logEntry = this.formatLogEntry(logData);
        this.writeLog(filePath, logEntry);

        return logData;
    }

    /**
     * Log Request Status operation
     * 
     * @param {Object} params - Log parameters
     * @param {number} params.userId - User ID
     * @param {string} params.sellerId - Amazon Seller ID
     * @param {string} params.sellerAccountId - Internal seller account ID
     * @param {string} params.reportId - Report ID being checked
     * @param {string} params.reportType - WEEK/MONTH/QUARTER
     * @param {string} params.range - Date range
     * @param {string} params.currentStatus - Current status (Pending, InProgress, Done, Fatal, etc.)
     * @param {Object} params.response - Full response from status check
     * @param {number} params.retryCount - Number of retries
     * @param {number} params.attempt - Current attempt number
     * @param {string} params.startTime - Check start timestamp
     * @param {string} params.endTime - Check end timestamp
     * @param {number} params.executionTime - Execution time in seconds
     * @param {string} params.status - success/failure
     * @param {Object} params.error - Error object (if failure)
     * @param {string} params.reportDocumentId - Document ID (if Done)
     */
    logRequestStatus(params) {
        const {
            userId,
            sellerId,
            sellerAccountId,
            reportId,
            reportType,
            range,
            currentStatus,
            response,
            retryCount = 0,
            attempt = 1,
            startTime,
            endTime,
            executionTime,
            status,
            error,
            reportDocumentId
        } = params;

        const logData = {
            operation: 'REQUEST_STATUS',
            userId,
            sellerId,
            sellerAccountId,
            reportId,
            reportType,
            range,
            currentStatus,
            reportDocumentId,
            status,
            response: response ? {
                processingStatus: response.processingStatus,
                reportDocumentId: response.reportDocumentId,
                processingStartTime: response.processingStartTime,
                processingEndTime: response.processingEndTime,
                raw: response
            } : undefined,
            timing: {
                startTime,
                endTime,
                executionTimeSeconds: executionTime
            },
            retry: {
                attempt,
                retryCount
            },
            error: error ? {
                message: error.message || error,
                stack: error.stack,
                code: error.code,
                statusCode: error.statusCode || error.status
            } : undefined
        };

        const filePath = this.getLogFilePath(userId, sellerAccountId, sellerId, 'request_status');
        const logEntry = this.formatLogEntry(logData);
        this.writeLog(filePath, logEntry);

        return logData;
    }

    /**
     * Log Download operation
     * 
     * @param {Object} params - Log parameters
     * @param {number} params.userId - User ID
     * @param {string} params.sellerId - Amazon Seller ID
     * @param {string} params.sellerAccountId - Internal seller account ID
     * @param {string} params.reportId - Report ID
     * @param {string} params.reportDocumentId - Report Document ID
     * @param {string} params.reportType - WEEK/MONTH/QUARTER
     * @param {string} params.range - Date range
     * @param {string} params.fileUrl - Download URL
     * @param {string} params.filePath - Local file path where saved
     * @param {number} params.fileSize - File size in bytes
     * @param {number} params.rowCount - Number of data rows
     * @param {Object} params.downloadPayload - Payload used for download
     * @param {string} params.startTime - Download start timestamp
     * @param {string} params.endTime - Download end timestamp
     * @param {number} params.executionTime - Execution time in seconds
     * @param {string} params.status - success/failure
     * @param {Object} params.error - Error object (if failure)
     * @param {number} params.retryCount - Number of retries
     * @param {number} params.attempt - Current attempt number
     */
    logDownload(params) {
        const {
            userId,
            sellerId,
            sellerAccountId,
            reportId,
            reportDocumentId,
            reportType,
            range,
            fileUrl,
            filePath,
            fileSize,
            rowCount,
            downloadPayload,
            startTime,
            endTime,
            executionTime,
            status,
            error,
            retryCount = 0,
            attempt = 1
        } = params;

        const logData = {
            operation: 'DOWNLOAD',
            userId,
            sellerId,
            sellerAccountId,
            reportId,
            reportDocumentId,
            reportType,
            range,
            status,
            download: {
                fileUrl,
                filePath,
                fileSizeBytes: fileSize,
                fileSizeMB: fileSize ? (fileSize / (1024 * 1024)).toFixed(2) : undefined,
                rowCount
            },
            payload: downloadPayload,
            timing: {
                startTime,
                endTime,
                executionTimeSeconds: executionTime
            },
            retry: {
                attempt,
                retryCount
            },
            error: error ? {
                message: error.message || error,
                stack: error.stack,
                code: error.code,
                statusCode: error.statusCode || error.status
            } : undefined
        };

        const logFilePath = this.getLogFilePath(userId, sellerAccountId, sellerId, 'download');
        const logEntry = this.formatLogEntry(logData);
        this.writeLog(logFilePath, logEntry);

        return logData;
    }

    /**
     * Sanitize headers to remove sensitive data
     */
    sanitizeHeaders(headers) {
        const sanitized = { ...headers };
        const sensitiveKeys = ['authorization', 'x-amz-access-token', 'x-api-key', 'cookie'];
        
        sensitiveKeys.forEach(key => {
            if (sanitized[key]) {
                sanitized[key] = '[REDACTED]';
            }
        });

        return sanitized;
    }

    /**
     * Clean old logs (optional utility)
     * Remove logs older than specified days
     */
    cleanOldLogs(daysToKeep = 30) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

        try {
            const userFolders = fs.readdirSync(this.baseLogPath);
            
            userFolders.forEach(userFolder => {
                const userPath = path.join(this.baseLogPath, userFolder);
                if (!fs.statSync(userPath).isDirectory()) return;

                const dateFolders = fs.readdirSync(userPath);
                
                dateFolders.forEach(dateFolder => {
                    const datePath = path.join(userPath, dateFolder);
                    if (!fs.statSync(datePath).isDirectory()) return;

                    const folderDate = new Date(dateFolder);
                    if (folderDate < cutoffDate) {
                        fs.rmSync(datePath, { recursive: true, force: true });
                        console.log(`Cleaned old logs: ${datePath}`);
                    }
                });
            });
        } catch (error) {
            console.error('Error cleaning old logs:', error.message);
        }
    }
}

module.exports = new APILogger();

