const fs = require('fs').promises;
const path = require('path');
const sqpDownloadUrlsModel = require('../models/sqpDownloadUrlsModel');
const logger = require('../utils/logger');

/**
 * Process JSON files that are already saved to disk
 */
async function processSavedJsonFiles() {
    try {
        // Get all completed download URLs that have file paths
        const completedDownloads = await getCompletedDownloadsWithFiles();        
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
        const sql = `SELECT * FROM sqp_download_urls 
                     WHERE Status = 'COMPLETED' 
                     AND (ProcessStatus IS NULL OR ProcessStatus IN ('PENDING','FAILED','FAILED_PARTIAL'))
                     AND (ProcessAttempts IS NULL OR ProcessAttempts < COALESCE(MaxProcessAttempts,3))
                     AND FilePath IS NOT NULL 
                     AND FilePath != ''
                     ORDER BY CreatedDate ASC`;
        
        const { query } = require('../db/mysql');
        return await query(sql);
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
        await markProcessingStart(download.ID);
        // Check if file exists
        await fs.access(download.FilePath);
        
        // Read the JSON file
        const jsonContent = await fs.readFile(download.FilePath, 'utf8');
        const data = JSON.parse(jsonContent);
        // Parse and store data in database
        const { total, success, failed, lastError } = await parseAndStoreJsonData(download, data, download.FilePath);

        await updateProcessingResult(download.ID, total, success, failed, lastError);

        // If still not fully imported and attempts exhausted, send notification
        if ((failed > 0 || total === 0) && currentAttempt >= maxAttempts) {
            await sendMaxRetryNotification(download, { total, success, failed, lastError });
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
            await markProcessingFailure(download.ID, error.message);
            const currentAttemptFail = (download.ProcessAttempts || 0) + 1;
            const maxAttemptsFail = download.MaxProcessAttempts || 3;
            if (currentAttemptFail >= maxAttemptsFail) {
                await sendMaxRetryNotification(download, { total: 0, success: 0, failed: 0, lastError: error.message });
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
        const reportType = resolveReportType(download, filePath);
        const reportDate = getReportDateForPeriod(reportType);

        let records = [];
        
        // Process each record in the report data
        if (Array.isArray(jsonContent)) {
            // SQP reports are directly arrays of records
            records = jsonContent;
        } else if (jsonContent.records && Array.isArray(jsonContent.records)) {
            records = jsonContent.records;
        } else if (jsonContent.dataByAsin && Array.isArray(jsonContent.dataByAsin)) {
            records = jsonContent.dataByAsin;
        }

        if (records.length === 0) {
            logger.warn({ 
                reportID: download.ReportID,
                filePath: path.basename(filePath)
            }, 'No records found in JSON file');
            return { total: 0, success: 0, failed: 0, lastError: null };
        }

        // Remove existing data for this report to avoid duplicates
        await removeExistingReportData(download.ReportID, download.AmazonSellerID, download.ReportType);

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
        // Extract data from the SQP report structure
        const asin = record.asin || '';
        const queryStr = record.searchQueryData?.searchQuery || '';
        const impressions = Number(record.impressionData?.asinImpressionCount || 0);
        const clicks = Number(record.clickData?.asinClickCount || 0);
        const clickThroughRate = impressions > 0 ? (clicks / impressions) * 100 : 0;
        // Derive CPC, Spend, Orders, Sales, ACOS, ConversionRate where possible
        const medianClickPrice = Number(record.clickData?.asinMedianClickPrice?.amount || 0);
        const spend = clicks * medianClickPrice;
        const orders = Number(record.purchaseData?.asinPurchaseCount || 0);
        const sales = Number(record.purchaseData?.asinMedianPurchasePrice?.amount || 0) * orders;
        const acos = sales > 0 ? (spend / sales) * 100 : 0;
        const conversionRate = clicks > 0 ? (orders / clicks) * 100 : 0;
        const cartAdds = Number(record.cartAddData?.asinCartAddCount || 0);
        const cartAddRate = Number(record.cartAddData?.asinCartAddRate || 0);
        const purchases = orders;
        const purchaseRate = Number(record.purchaseData?.asinPurchaseRate || conversionRate);
        const revenue = sales;

        // Skip records with no meaningful data
        if (!asin || !queryStr || (impressions === 0 && clicks === 0 && cartAdds === 0 && purchases === 0)) {
            return;
        }

        // Prepare data for storage in sqp_metrics_3mo table
        const currencyCode = record.clickData?.asinMedianClickPrice?.currencyCode
            || record.clickData?.totalMedianClickPrice?.currencyCode
            || record.cartAddData?.asinMedianCartAddPrice?.currencyCode
            || record.cartAddData?.totalMedianCartAddPrice?.currencyCode
            || record.purchaseData?.asinMedianPurchasePrice?.currencyCode
            || record.purchaseData?.totalMedianPurchasePrice?.currencyCode
            || null;

        const metricsData = {
            ReportID: download.ReportID,
            AmazonSellerID: download.AmazonSellerID,
            ReportType: reportType,
            ReportDate: reportDate,
            StartDate: record.startDate || null,
            EndDate: record.endDate || null,
            CurrencyCode: currencyCode,
            SearchQuery: queryStr,
            SearchQueryScore: Number(record.searchQueryData?.searchQueryScore || 0),
            SearchQueryVolume: Number(record.searchQueryData?.searchQueryVolume || 0),
            TotalQueryImpressionCount: Number(record.impressionData?.totalQueryImpressionCount || 0),
            AsinImpressionCount: impressions,
            AsinImpressionShare: Number(record.impressionData?.asinImpressionShare || 0),
            TotalClickCount: Number(record.clickData?.totalClickCount || 0),
            TotalClickRate: Number(record.clickData?.totalClickRate || 0),
            AsinClickCount: clicks,
            AsinClickShare: Number(record.clickData?.asinClickShare || 0),
            TotalMedianClickPrice: Number(record.clickData?.totalMedianClickPrice?.amount || 0),
            AsinMedianClickPrice: Number(record.clickData?.asinMedianClickPrice?.amount || 0),
            TotalSameDayShippingClickCount: Number(record.clickData?.totalSameDayShippingClickCount || 0),
            TotalOneDayShippingClickCount: Number(record.clickData?.totalOneDayShippingClickCount || 0),
            TotalTwoDayShippingClickCount: Number(record.clickData?.totalTwoDayShippingClickCount || 0),
            TotalCartAddCount: Number(record.cartAddData?.totalCartAddCount || 0),
            TotalCartAddRate: Number(record.cartAddData?.totalCartAddRate || 0),
            AsinCartAddCount: cartAdds,
            AsinCartAddShare: Number(record.cartAddData?.asinCartAddShare || 0),
            TotalMedianCartAddPrice: Number(record.cartAddData?.totalMedianCartAddPrice?.amount || 0),
            AsinMedianCartAddPrice: Number(record.cartAddData?.asinMedianCartAddPrice?.amount || 0),
            TotalSameDayShippingCartAddCount: Number(record.cartAddData?.totalSameDayShippingCartAddCount || 0),
            TotalOneDayShippingCartAddCount: Number(record.cartAddData?.totalOneDayShippingCartAddCount || 0),
            TotalTwoDayShippingCartAddCount: Number(record.cartAddData?.totalTwoDayShippingCartAddCount || 0),
            TotalPurchaseCount: Number(record.purchaseData?.totalPurchaseCount || 0),
            TotalPurchaseRate: Number(record.purchaseData?.totalPurchaseRate || 0),
            AsinPurchaseCount: purchases,
            AsinPurchaseShare: Number(record.purchaseData?.asinPurchaseShare || 0),
            TotalMedianPurchasePrice: Number(record.purchaseData?.totalMedianPurchasePrice?.amount || 0),
            AsinMedianPurchasePrice: Number(record.purchaseData?.asinMedianPurchasePrice?.amount || 0),
            AsinPurchaseRate: Number(record.purchaseData?.asinPurchaseRate || conversionRate),
            TotalSameDayShippingPurchaseCount: Number(record.purchaseData?.totalSameDayShippingPurchaseCount || 0),
            TotalOneDayShippingPurchaseCount: Number(record.purchaseData?.totalOneDayShippingPurchaseCount || 0),
            TotalTwoDayShippingPurchaseCount: Number(record.purchaseData?.totalTwoDayShippingPurchaseCount || 0),
            ASIN: asin,
            CreatedDate: new Date()
        };

        // Store in sqp_metrics_3mo table
        await storeInSqpMetrics3Mo(metricsData);

        logger.debug({ 
            reportID: download.ReportID,
            asin: asin,
            query: queryStr,
            impressions: impressions,
            clicks: clicks,
            purchases: purchases
        }, 'Stored SQP record');

    } catch (error) {
        logger.error({ 
            error: error.message,
            reportID: download.ReportID,
            asin: record.asin,
            query: record.searchQueryData?.searchQuery
        }, 'Error storing single report record');
    }
}

/**
 * Store data in sqp_metrics_3mo table
 */
async function storeInSqpMetrics3Mo(metricsData) {
    try {
        const { query } = require('../db/mysql');
        const { tables } = require('../config/env');

        const params = [
            metricsData.ReportID,
            metricsData.AmazonSellerID,
            metricsData.ReportType,
            metricsData.ReportDate,
            metricsData.StartDate,
            metricsData.EndDate,
            metricsData.CurrencyCode,
            metricsData.SearchQuery,
            metricsData.SearchQueryScore,
            metricsData.SearchQueryVolume,
            metricsData.TotalQueryImpressionCount,
            metricsData.AsinImpressionCount,
            metricsData.AsinImpressionShare,
            metricsData.TotalClickCount,
            metricsData.TotalClickRate,
            metricsData.AsinClickCount,
            metricsData.AsinClickShare,
            metricsData.TotalMedianClickPrice,
            metricsData.AsinMedianClickPrice,
            metricsData.TotalSameDayShippingClickCount,
            metricsData.TotalOneDayShippingClickCount,
            metricsData.TotalTwoDayShippingClickCount,
            metricsData.TotalCartAddCount,
            metricsData.TotalCartAddRate,
            metricsData.AsinCartAddCount,
            metricsData.AsinCartAddShare,
            metricsData.TotalMedianCartAddPrice,
            metricsData.AsinMedianCartAddPrice,
            metricsData.TotalSameDayShippingCartAddCount,
            metricsData.TotalOneDayShippingCartAddCount,
            metricsData.TotalTwoDayShippingCartAddCount,
            metricsData.TotalPurchaseCount,
            metricsData.TotalPurchaseRate,
            metricsData.AsinPurchaseCount,
            metricsData.AsinPurchaseShare,
            metricsData.TotalMedianPurchasePrice,
            metricsData.AsinMedianPurchasePrice,
            metricsData.AsinPurchaseRate,
            metricsData.TotalSameDayShippingPurchaseCount,
            metricsData.TotalOneDayShippingPurchaseCount,
            metricsData.TotalTwoDayShippingPurchaseCount,
            metricsData.ASIN,
            metricsData.CreatedDate
        ];

        const sql = `INSERT INTO ${tables.sqpMetrics3mo} (
            ReportID, AmazonSellerID, ReportType, ReportDate, StartDate, EndDate, CurrencyCode,
            SearchQuery, SearchQueryScore, SearchQueryVolume,
            TotalQueryImpressionCount, AsinImpressionCount, AsinImpressionShare,
            TotalClickCount, TotalClickRate, AsinClickCount, AsinClickShare,
            TotalMedianClickPrice, AsinMedianClickPrice,
            TotalSameDayShippingClickCount, TotalOneDayShippingClickCount, TotalTwoDayShippingClickCount,
            TotalCartAddCount, TotalCartAddRate, AsinCartAddCount, AsinCartAddShare,
            TotalMedianCartAddPrice, AsinMedianCartAddPrice,
            TotalSameDayShippingCartAddCount, TotalOneDayShippingCartAddCount, TotalTwoDayShippingCartAddCount,
            TotalPurchaseCount, TotalPurchaseRate, AsinPurchaseCount, AsinPurchaseShare,
            TotalMedianPurchasePrice, AsinMedianPurchasePrice, AsinPurchaseRate,
            TotalSameDayShippingPurchaseCount, TotalOneDayShippingPurchaseCount, TotalTwoDayShippingPurchaseCount,
            ASIN, CreatedDate
        ) VALUES (${new Array(params.length).fill('?').join(', ')})`;

        return await query(sql, params);
    } catch (error) {
        logger.error({ error: error.message, metricsData }, 'Error storing in sqp_metrics_3mo');
        throw error;
    }
}

/**
 * Upsert query-level totals into sqp_metrics_3mo_totals
 */
async function upsertTotalsRecord(download, reportType, reportDate, record) {
    const { query } = require('../db/mysql');
    const { tables } = require('../config/env');

    const searchQuery = record.searchQueryData?.searchQuery || '';
    if (!searchQuery) return;

    const params = [
        download.ReportID, // ReportID
        download.AmazonSellerID, // AmazonSellerID
        reportType, // ReportType
        reportDate, // ReportDate
        searchQuery, // SearchQuery
        Number(record.searchQueryData?.searchQueryScore || 0), // SearchQueryScore
        Number(record.searchQueryData?.searchQueryVolume || 0), // SearchQueryVolume
        Number(record.impressionData?.totalQueryImpressionCount || 0), // TotalQueryImpressionCount
        Number(record.impressionData?.asinImpressionCount || 0), // AsinImpressionCount
        Number(record.impressionData?.asinImpressionShare || 0), // AsinImpressionShare
        Number(record.clickData?.totalClickCount || 0), // TotalClickCount
        Number(record.clickData?.totalClickRate || 0), // TotalClickRate
        Number(record.clickData?.asinClickCount || 0), // AsinClickCount
        Number(record.clickData?.asinClickShare || 0), // AsinClickShare
        Number(record.clickData?.totalMedianClickPrice?.amount || 0), // TotalMedianClickPrice
        Number(record.clickData?.asinMedianClickPrice?.amount || 0), // AsinMedianClickPrice
        Number(record.clickData?.totalSameDayShippingClickCount || 0),
        Number(record.clickData?.totalOneDayShippingClickCount || 0),
        Number(record.clickData?.totalTwoDayShippingClickCount || 0),
        Number(record.cartAddData?.totalCartAddCount || 0),
        Number(record.cartAddData?.totalCartAddRate || 0),
        Number(record.cartAddData?.asinCartAddCount || 0),
        Number(record.cartAddData?.asinCartAddShare || 0),
        Number(record.cartAddData?.totalMedianCartAddPrice?.amount || 0),
        Number(record.cartAddData?.asinMedianCartAddPrice?.amount || 0),
        Number(record.cartAddData?.totalSameDayShippingCartAddCount || 0),
        Number(record.cartAddData?.totalOneDayShippingCartAddCount || 0),
        Number(record.cartAddData?.totalTwoDayShippingCartAddCount || 0),
        Number(record.purchaseData?.totalPurchaseCount || 0),
        Number(record.purchaseData?.totalPurchaseRate || 0),
        Number(record.purchaseData?.asinPurchaseCount || 0),
        Number(record.purchaseData?.asinPurchaseShare || 0),
        Number(record.purchaseData?.totalMedianPurchasePrice?.amount || 0),
        Number(record.purchaseData?.asinMedianPurchasePrice?.amount || 0),
        Number(record.purchaseData?.asinPurchaseRate || 0),
        Number(record.purchaseData?.totalSameDayShippingPurchaseCount || 0),
        Number(record.purchaseData?.totalOneDayShippingPurchaseCount || 0),
        Number(record.purchaseData?.totalTwoDayShippingPurchaseCount || 0)
    ];

    const sql = `INSERT INTO ${tables.sqpMetrics} (
        ReportID, AmazonSellerID, ReportType, ReportDate, SearchQuery,
        SearchQueryScore, SearchQueryVolume,
        TotalQueryImpressionCount, AsinImpressionCount, AsinImpressionShare,
        TotalClickCount, TotalClickRate, AsinClickCount, AsinClickShare,
        TotalMedianClickPrice, AsinMedianClickPrice,
        TotalSameDayShippingClickCount, TotalOneDayShippingClickCount, TotalTwoDayShippingClickCount,
        TotalCartAddCount, TotalCartAddRate, AsinCartAddCount, AsinCartAddShare,
        TotalMedianCartAddPrice, AsinMedianCartAddPrice,
        TotalSameDayShippingCartAddCount, TotalOneDayShippingCartAddCount, TotalTwoDayShippingCartAddCount,
        TotalPurchaseCount, TotalPurchaseRate, AsinPurchaseCount, AsinPurchaseShare,
        TotalMedianPurchasePrice, AsinMedianPurchasePrice, AsinPurchaseRate,
        TotalSameDayShippingPurchaseCount, TotalOneDayShippingPurchaseCount, TotalTwoDayShippingPurchaseCount
    ) VALUES (${new Array(params.length).fill('?').join(', ')})
    ON DUPLICATE KEY UPDATE
        SearchQueryScore = VALUES(SearchQueryScore),
        SearchQueryVolume = VALUES(SearchQueryVolume),
        TotalQueryImpressionCount = VALUES(TotalQueryImpressionCount),
        AsinImpressionCount = VALUES(AsinImpressionCount),
        AsinImpressionShare = VALUES(AsinImpressionShare),
        TotalClickCount = VALUES(TotalClickCount),
        TotalClickRate = VALUES(TotalClickRate),
        AsinClickCount = VALUES(AsinClickCount),
        AsinClickShare = VALUES(AsinClickShare),
        TotalMedianClickPrice = VALUES(TotalMedianClickPrice),
        AsinMedianClickPrice = VALUES(AsinMedianClickPrice),
        TotalSameDayShippingClickCount = VALUES(TotalSameDayShippingClickCount),
        TotalOneDayShippingClickCount = VALUES(TotalOneDayShippingClickCount),
        TotalTwoDayShippingClickCount = VALUES(TotalTwoDayShippingClickCount),
        TotalCartAddCount = VALUES(TotalCartAddCount),
        TotalCartAddRate = VALUES(TotalCartAddRate),
        AsinCartAddCount = VALUES(AsinCartAddCount),
        AsinCartAddShare = VALUES(AsinCartAddShare),
        TotalMedianCartAddPrice = VALUES(TotalMedianCartAddPrice),
        AsinMedianCartAddPrice = VALUES(AsinMedianCartAddPrice),
        TotalSameDayShippingCartAddCount = VALUES(TotalSameDayShippingCartAddCount),
        TotalOneDayShippingCartAddCount = VALUES(TotalOneDayShippingCartAddCount),
        TotalTwoDayShippingCartAddCount = VALUES(TotalTwoDayShippingCartAddCount),
        TotalPurchaseCount = VALUES(TotalPurchaseCount),
        TotalPurchaseRate = VALUES(TotalPurchaseRate),
        AsinPurchaseCount = VALUES(AsinPurchaseCount),
        AsinPurchaseShare = VALUES(AsinPurchaseShare),
        TotalMedianPurchasePrice = VALUES(TotalMedianPurchasePrice),
        AsinMedianPurchasePrice = VALUES(AsinMedianPurchasePrice),
        AsinPurchaseRate = VALUES(AsinPurchaseRate),
        TotalSameDayShippingPurchaseCount = VALUES(TotalSameDayShippingPurchaseCount),
        TotalOneDayShippingPurchaseCount = VALUES(TotalOneDayShippingPurchaseCount),
        TotalTwoDayShippingPurchaseCount = VALUES(TotalTwoDayShippingPurchaseCount)`;

    await query(sql, params);
}
/**
 * Remove existing report data to avoid duplicates
 */
async function removeExistingReportData(reportID, amazonSellerID, reportType) {
    try {
        const { query } = require('../db/mysql');
        const { tables } = require('../config/env');

        // Now sqp_metrics_3mo includes ReportID; remove by ReportID for precision
        const sql = `DELETE FROM ${tables.sqpMetrics3mo} WHERE ReportID = ?`;
        return await query(sql, [reportID]);
    } catch (error) {
        logger.error({ error: error.message }, 'Error removing existing report data');
        throw error;
    }
}

// Processing state helpers
async function markProcessingStart(id) {
    const { query } = require('../db/mysql');
    const sql = `UPDATE sqp_download_urls 
                 SET ProcessStatus = 'PROCESSING',
                     ProcessAttempts = COALESCE(ProcessAttempts,0) + 1,
                     DownloadAttempts = COALESCE(DownloadAttempts,0) + 1,
                     DownloadStartTime = COALESCE(DownloadStartTime, NOW()),
                     LastProcessAt = NOW()
                 WHERE ID = ?`;
    await query(sql, [id]);
}

async function updateProcessingResult(id, total, success, failed, lastError) {
    const { query } = require('../db/mysql');
    const fullyImported = total > 0 && failed === 0 ? 1 : 0;
    const status = fullyImported ? 'SUCCESS' : (success > 0 ? 'FAILED_PARTIAL' : 'FAILED');
    const sql = `UPDATE sqp_download_urls 
                 SET ProcessStatus = ?, SuccessCount = ?, FailCount = ?, TotalRecords = ?, FullyImported = ?, LastProcessError = ?, DownloadEndTime = NOW()
                 WHERE ID = ?`;
    await query(sql, [status, success, failed, total, fullyImported, lastError, id]);
}

async function markProcessingFailure(id, message) {
    const { query } = require('../db/mysql');
    const sql = `UPDATE sqp_download_urls 
                 SET ProcessStatus = 'FAILED', LastProcessError = ?, DownloadEndTime = NOW()
                 WHERE ID = ?`;
    await query(sql, [message, id]);
}

// Simple notification hook (replace with real email integration)
async function sendMaxRetryNotification(download, result) {
    const logger = require('../utils/logger');
    logger.error({ downloadID: download.ID, reportID: download.ReportID, attempts: (download.ProcessAttempts || 0) + 1, result }, 'Max retry attempts reached for SQP processing');
}

/**
 * Get report date for a specific period
 */
function getReportDateForPeriod(reportType) {
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
 * Resolve report type from download object or file path
 */
function resolveReportType(download, filePath) {
    // Prefer explicit value if present and valid
    if (download && typeof download.ReportType === 'string') {
        const rt = download.ReportType.toUpperCase();
        if (rt === 'WEEK' || rt === 'MONTH' || rt === 'QUARTER') {
            return rt;
        }
    }

    // Infer from file path
    const lower = (filePath || '').toLowerCase();
    if (lower.includes('/week/') || lower.includes('\\week\\') || lower.includes('week_')) return 'WEEK';
    if (lower.includes('/month/') || lower.includes('\\month\\') || lower.includes('month_')) return 'MONTH';
    if (lower.includes('/quarter/') || lower.includes('\\quarter\\') || lower.includes('quarter_')) return 'QUARTER';

    // Fallback
    return 'MONTH';
}

/**
 * Get processing statistics
 */
async function getProcessingStats() {
    try {
        const { query } = require('../db/mysql');
        const { tables } = require('../config/env');

        const sql = `SELECT 
                        COUNT(*) as total_downloads,
                        SUM(CASE WHEN Status = 'COMPLETED' AND FilePath IS NOT NULL THEN 1 ELSE 0 END) as files_ready,
                        SUM(CASE WHEN Status = 'PENDING' THEN 1 ELSE 0 END) as pending,
                        SUM(CASE WHEN Status = 'FAILED' THEN 1 ELSE 0 END) as failed
                     FROM ${tables.sqpDownloadUrls}`;
        
        const stats = await query(sql);
        
        // Get count of records in sqp_metrics_3mo
        const metricsSql = `SELECT COUNT(*) as total_records FROM ${tables.sqpMetrics3mo}`;
        const metricsStats = await query(metricsSql);
        
        return {
            downloads: stats[0],
            metrics: metricsStats[0]
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
