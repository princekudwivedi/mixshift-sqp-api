const fs = require('fs').promises;
const path = require('path');
const sqpDownloadUrlsModel = require('../models/sqp.download.urls.model');
const sqpMetricsModel = require('../models/sqp.metrics.model');
const { ValidationHelpers, DateHelpers, FileHelpers, DataProcessingHelpers, NotificationHelpers } = require('../helpers/sqp.helpers');
const logger = require('../utils/logger.utils');

/**
 * Process JSON files that are already saved to disk
 */
async function processSavedJsonFiles(options = {}) {
    try {
        // Get all completed download URLs that have file paths
        const completedDownloads = await sqpDownloadUrlsModel.getCompletedDownloadsWithFiles();        
        if (!completedDownloads || completedDownloads.length === 0) {
            logger.info('No completed JSON files to process');
            return { processed: 0, errors: 0 };
        }

        logger.info(`Processing ${completedDownloads.length} completed JSON files`);

        let processed = 0;
        let errors = 0;

        for (const download of completedDownloads) {
            try {
                await processSingleSavedJsonFile(download);
                processed++;
            } catch (error) {
                logger.error({ 
                    error: error.message, 
                    reportID: download.ReportID,
                    filePath: download.FilePath 
                }, 'Error processing saved JSON file');
                errors++;
            }
        }

        logger.info({ processed, errors }, 'Completed processing saved JSON files');
        return { processed, errors };

    } catch (error) {
        logger.error({ error: error.message }, 'Error processing saved JSON files');
        throw error;
    }
}

/**
 * Get completed downloads that have file paths
 */
async function getCompletedDownloadsWithFiles() {
    try {
        return await sqpDownloadUrlsModel.getCompletedDownloadsWithFiles();
    } catch (error) {
        logger.error({ error: error.message }, 'Error getting completed downloads with files');
        throw error;
    }
}

/**
 * Process a single saved JSON file
 */
async function processSingleSavedJsonFile(download) {
    logger.info({ 
        reportID: download.ReportID, 
        filePath: download.FilePath 
    }, 'Processing saved JSON file');

    try {
        const currentAttempt = (download.ProcessAttempts || 0) + 1;
        const maxAttempts = download.MaxProcessAttempts || 3;
        await sqpDownloadUrlsModel.markProcessingStart(download.ID);
        
        // Check if file exists
        if (!(await FileHelpers.fileExists(download.FilePath))) {
            throw new Error(`File not found: ${download.FilePath}`);
        }
        
        // Read the JSON file
        const data = await FileHelpers.readJsonFile(download.FilePath);
        
        // Parse and store data in database
        const { total, success, failed, lastError } = await parseAndStoreJsonData(download, data, download.FilePath);

        await sqpDownloadUrlsModel.updateProcessingResult(download.ID, total, success, failed, lastError);

        // If still not fully imported and attempts exhausted, send notification
        if ((failed > 0 || total === 0) && currentAttempt >= maxAttempts) {
            await NotificationHelpers.sendMaxRetryNotification(download, { total, success, failed, lastError });
        }

        logger.info({ 
            reportID: download.ReportID,
            filePath: download.FilePath 
        }, 'Successfully processed saved JSON file');

    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.warn({ 
                reportID: download.ReportID,
                filePath: download.FilePath 
            }, 'JSON file not found on disk');
        } else {
            await sqpDownloadUrlsModel.markProcessingFailure(download.ID, error.message);
            const currentAttemptFail = (download.ProcessAttempts || 0) + 1;
            const maxAttemptsFail = download.MaxProcessAttempts || 3;
            if (currentAttemptFail >= maxAttemptsFail) {
                await NotificationHelpers.sendMaxRetryNotification(download, { total: 0, success: 0, failed: 0, lastError: error.message });
            }
        }
    }
}

/**
 * Parse JSON content and store in sqp_metrics_3mo table
 */
async function parseAndStoreJsonData(download, jsonContent, filePath) {
    try {
        // Resolve report type and report date
        const reportType = FileHelpers.resolveReportTypeFromPath(filePath);
        const reportDate = DateHelpers.getReportDateForPeriod(reportType);

        // Extract records from JSON content
        const records = DataProcessingHelpers.extractRecords(jsonContent);

        if (records.length === 0) {
            logger.warn({ 
                reportID: download.ReportID,
                filePath: path.basename(filePath)
            }, 'No records found in JSON file');
            return { total: 0, success: 0, failed: 0, lastError: null };
        }

        // Remove existing data for this report to avoid duplicates
        await sqpMetricsModel.removeExistingReportData(download.ReportID);

        // Process each record and store a comprehensive row per entry
        let success = 0;
        let failed = 0;
        let lastError = null;
        for (const record of records) {
            try {
                await storeSingleReportRecord(download, reportType, reportDate, record, filePath);
                success++;
            } catch (err) {
                failed++;
                lastError = err.message;
            }
        }

        logger.info({ 
            reportID: download.ReportID,
            recordsProcessed: records.length,
            filePath: path.basename(filePath)
        }, 'Completed parsing and storing records');

        return { total: records.length, success, failed, lastError };

    } catch (error) {
        return { total: 0, success: 0, failed: 0, lastError: error.message };
    }
}

/**
 * Store a single report record in the sqp_metrics_3mo table
 */
async function storeSingleReportRecord(download, reportType, reportDate, record, filePath) {
    try {
        // Validate SQP record structure
        DataProcessingHelpers.validateSqpRecord(record);

        // Prepare metrics data using helper
        const metricsData = DataProcessingHelpers.prepareMetricsData(download, reportType, reportDate, record, filePath);
        
        if (!metricsData) {
            // Skip records with no meaningful data
            return;
        }

        // Store in sqp_metrics_3mo table using ORM
        await sqpMetricsModel.storeMetrics3Mo(metricsData);

        logger.debug({ 
            reportID: download.ReportID,
            asin: metricsData.ASIN,
            query: metricsData.SearchQuery,
            impressions: metricsData.AsinImpressionCount,
            clicks: metricsData.AsinClickCount,
            purchases: metricsData.AsinPurchaseCount
        }, 'Stored SQP record');

    } catch (error) {
        logger.error({ 
            error: error.message,
            reportID: download.ReportID,
            asin: record.asin,
            query: record.searchQueryData?.searchQuery
        }, 'Error storing single report record');
        throw error;
    }
}




/**
 * Get processing statistics
 */
async function getProcessingStats(options = {}) {
    try {
        const downloadStats = await sqpDownloadUrlsModel.getProcessingStats();
        const metricsStats = await sqpMetricsModel.getMetricsStats();
        
        return {
            downloads: downloadStats,
            metrics: metricsStats
        };
    } catch (error) {
        logger.error({ error: error.message }, 'Error getting processing stats');
        throw error;
    }
}

module.exports = {
    processSavedJsonFiles,
    processSingleSavedJsonFile,
    getCompletedDownloadsWithFiles,
    parseAndStoreJsonData,
    storeSingleReportRecord,
    getProcessingStats
};
