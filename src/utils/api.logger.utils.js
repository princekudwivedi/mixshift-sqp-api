/**
 * API Logger Utility
 * Creates hierarchical logs organized by user, date, Amazon seller ID, and seller account ID
 * 
 * Structure: logs/api_logs/user__{userId}/{date}/{amazonSellerID}/{sellerAccountId}/
 * Log Files:
 *  - request_report__{reportType}_{date}.log  (e.g., request_report__WEEK_2025-11-04.log)
 *  - request_status__{reportType}_{date}.log  (e.g., request_status__MONTH_2025-11-04.log)
 *  - download__{reportType}_{date}.log        (e.g., download__QUARTER_2025-11-04.log)
 * 
 * Example Path:
 *  logs/api_logs/user__8/2025-11-04/A256DU7MGIQT7P/600/request_report__WEEK_2025-11-04.log
 */

const fs = require('fs');
const path = require('path');
const dates = require('./dates.utils');

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
     * Get log file path based on user, date, Amazon seller ID, and seller account ID
     * Returns null if userId is missing (don't create logs without user context)
     * 
     * Structure: api_logs/user__{userId}/{date}/{amazonSellerID}/{sellerAccountId}/
     * Filename: {logType}__{name}_{date}.log
     * 
     * @param {number} userId - User ID
     * @param {number} sellerAccountId - Internal seller account ID
     * @param {string} amazonSellerID - Amazon Seller ID
     * @param {string} logType - Log type (request_report, request_status, download)
     * @param {string} name - Additional identifier (reportType like WEEK/MONTH/QUARTER, or reportId)
     */
    getLogFilePath(userId, sellerAccountId, amazonSellerID, logType, name = null) {
        // Don't create logs if userId is missing
        if (!userId || userId === null || userId === undefined) {
            return null;
        }

        const date = dates.getDateTime().split('T')[0]; // YYYY-MM-DD
        const userFolder = `user__${userId}`;
        const dateFolder = date;
        const sellerAccountFolder = sellerAccountId.toString();

        // New structure: amazonSellerID comes before sellerAccountId
        const logDir = path.join(this.baseLogPath, userFolder, dateFolder, sellerAccountFolder);
        this.ensureLogDirectory(logDir);

        // Add name and date to filename
        const namePrefix = name ? `${name}_` : '';
        const logFileName = `${logType}__${namePrefix}${date}.log`;
        return path.join(logDir, logFileName);
    }

    /**
     * Format log entry with timestamp
     */
    formatLogEntry(data) {
        const timestamp = dates.getDateTime();
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
     * Skip if filePath is null (no user context)
     */
    writeLog(filePath, logEntry) {
        if (!filePath) {
            // Skip logging when there's no valid file path (e.g., no userId)
            return;
        }
        
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

        const filePath = this.getLogFilePath(userId, sellerAccountId, sellerId, 'request_report', reportType);
        if (filePath) {
            const logEntry = this.formatLogEntry(logData);
            this.writeLog(filePath, logEntry);
        }

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

        const filePath = this.getLogFilePath(userId, sellerAccountId, sellerId, 'request_status', reportType);
        if (filePath) {
            const logEntry = this.formatLogEntry(logData);
            this.writeLog(filePath, logEntry);
        }

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

        const logFilePath = this.getLogFilePath(userId, sellerAccountId, sellerId, 'download', reportType);
        if (logFilePath) {
            const logEntry = this.formatLogEntry(logData);
            this.writeLog(logFilePath, logEntry);
        }

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
    /**
     * Clean old logs (remove logs older than specified days)
     * Handles both:
     * - Root date folders: logs/<DD-MM-YYYY>/
     * - API user logs: logs/api_logs/user_X/<DD-MM-YYYY>/
     * @param {number} daysToKeep - Number of days to keep (default: 15)
     */
    cleanOldLogs(daysToKeep = 15) {
        const cutoffDate = dates.getDateTime();
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

        console.log(`\n🧹 Cleaning logs older than ${daysToKeep} days (before ${cutoffDate.toISOString().split('T')[0]})...`);

        // Helper function to parse date from folder name (DD-MM-YYYY or YYYY-MM-DD)
        const parseDateFolder = (folderName) => {
            // Format: DD-MM-YYYY (e.g., 07-11-2025)
            const ddmmyyyyMatch = folderName.match(/^(\d{2})-(\d{2})-(\d{4})$/);
            if (ddmmyyyyMatch) {
                const [, day, month, year] = ddmmyyyyMatch;
                return new Date(year, month - 1, day);
            }
            
            // Format: YYYY-MM-DD (e.g., 2025-11-04)
            const yyyymmddMatch = folderName.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (yyyymmddMatch) {
                const [, year, month, day] = yyyymmddMatch;
                return new Date(year, month - 1, day);
            }
            
            return null;
        };

        // Helper function to calculate directory size
        const getSize = (dir) => {
            let size = 0;
            try {
                const files = fs.readdirSync(dir);
                files.forEach((file) => {
                    const filePath = path.join(dir, file);
                    const stat = fs.statSync(filePath);
                    if (stat.isDirectory()) {
                        size += getSize(filePath);
                    } else {
                        size += stat.size;
                    }
                });
            } catch (error) {
                console.error(`Error calculating size for ${dir}:`, error.message);
            }
            return size;
        };

        let totalDeletedCount = 0;
        let totalBytesFreed = 0;

        try {
            // Get the parent logs directory (one level up from api_logs)
            const logsRootDir = path.dirname(this.baseLogPath);
            
            if (!fs.existsSync(logsRootDir)) {
                console.log(`Logs directory not found: ${logsRootDir}`);
                return;
            }

            // 1. Clean root date folders (logs/<DD-MM-YYYY>/)
            console.log('\n📂 Cleaning root date folders...');
            const rootFolders = fs.readdirSync(logsRootDir);
            
            rootFolders.forEach(folder => {
                const folderPath = path.join(logsRootDir, folder);
                
                if (!fs.statSync(folderPath).isDirectory()) return;

                // Skip api_logs folder (will be processed separately)
                if (folder === 'api_logs') return;

                // Parse date from folder name
                const folderDate = parseDateFolder(folder);
                if (!folderDate) return; // Not a date folder

                if (folderDate < cutoffDate) {
                    const folderSize = getSize(folderPath);
                    
                    // Remove folder recursively
                    fs.rmSync(folderPath, { recursive: true, force: true });
                    
                    totalDeletedCount++;
                    totalBytesFreed += folderSize;
                    console.log(`   ✓ Deleted: ${folder} (${(folderSize / 1024 / 1024).toFixed(2)} MB)`);
                }
            });

            // 2. Clean API logs (logs/api_logs/user_X/<DD-MM-YYYY>/)
            if (fs.existsSync(this.baseLogPath)) {
                console.log('\n📂 Cleaning API user logs...');
                console.log(`   Path: ${this.baseLogPath}`);
                
                const userFolders = fs.readdirSync(this.baseLogPath);
                console.log(`   Found ${userFolders.length} items in api_logs`);
                
                let apiLogsDeleted = 0;
                
                userFolders.forEach(userFolder => {
                    const userPath = path.join(this.baseLogPath, userFolder);
                    
                    // Check if it's a directory
                    try {
                        if (!fs.statSync(userPath).isDirectory()) {
                            console.log(`   ⊘ Skipped (not a directory): ${userFolder}`);
                            return;
                        }
                    } catch (err) {
                        console.log(`   ⊘ Error accessing: ${userFolder} - ${err.message}`);
                        return;
                    }

                    // Check if it's a user folder (user_X or user__X pattern)
                    if (!userFolder.match(/^user_+\d+$/)) {
                        console.log(`   ⊘ Skipped (not user_X pattern): ${userFolder}`);
                        return;
                    }

                    console.log(`   📁 Processing: ${userFolder}`);
                    const dateFolders = fs.readdirSync(userPath);
                    console.log(`      Found ${dateFolders.length} date folders`);
                    
                    dateFolders.forEach(dateFolder => {
                        const datePath = path.join(userPath, dateFolder);
                        
                        if (!fs.statSync(datePath).isDirectory()) return;

                        // Parse date from folder name (DD-MM-YYYY format)
                        const folderDate = parseDateFolder(dateFolder);
                        if (!folderDate) {
                            console.log(`      ⊘ Invalid date format: ${dateFolder}`);
                            return; // Not a valid date folder
                        }

                        if (folderDate < cutoffDate) {
                            const folderSize = getSize(datePath);
                            
                            // Remove folder recursively
                            fs.rmSync(datePath, { recursive: true, force: true });
                            
                            totalDeletedCount++;
                            totalBytesFreed += folderSize;
                            apiLogsDeleted++;
                            console.log(`      ✓ Deleted: ${dateFolder} (${(folderSize / 1024 / 1024).toFixed(2)} MB)`);
                        } else {
                            console.log(`      ✓ Keeping (recent): ${dateFolder}`);
                        }
                    });

                    // Remove empty user folder if no date folders remain
                    try {
                        const remainingItems = fs.readdirSync(userPath);
                        if (remainingItems.length === 0) {
                            fs.rmdirSync(userPath);
                            console.log(`      ✓ Removed empty user folder: ${userFolder}`);
                        }
                    } catch (err) {
                        // Ignore errors for empty folder removal
                    }
                });

                if (apiLogsDeleted === 0) {
                    console.log(`   ℹ️  No old API log folders found to delete`);
                }
            } else {
                console.log('\n📂 API logs directory not found');
                console.log(`   Expected path: ${this.baseLogPath}`);
            }

            console.log(`\n✅ Cleanup complete: ${totalDeletedCount} folders deleted, ${(totalBytesFreed / 1024 / 1024).toFixed(2)} MB freed\n`);
        } catch (error) {
            console.error('Error cleaning old logs:', error.message);
        }
    }
}

module.exports = new APILogger();

