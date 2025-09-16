const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { uploadJson } = require('../utils/s3.utils');
const { SqpMetrics3mo } = require('../models/sequelize');
const { nodeEnv } = require('../config/env.config');
const sqpDownloadUrlsModel = require('../models/sqp.download.urls.model');
const sqpCronModel = require('../models/sqp.cron.model');

/**
 * Process pending JSON files from download URLs
 */
async function processPendingJsonFiles() {
    try {
        const pendingDownloads = await sqpDownloadUrlsModel.getPendingDownloadUrls(10);
        
        if (!pendingDownloads || pendingDownloads.length === 0) {
            console.log('No pending JSON files to process');
            return;
        }

        console.log(`Processing ${pendingDownloads.length} pending JSON files`);

        for (const download of pendingDownloads) {
            await processSingleJsonFile(download);
        }

    } catch (error) {
        console.error('Error processing pending JSON files:', error);
        throw error;
    }
}

/**
 * Process a single JSON file download
 */
async function processSingleJsonFile(download) {
    console.log(`Processing JSON file for report ${download.ReportID}`);

    try {
        // Update status to DOWNLOADING
        await sqpDownloadUrlsModel.updateDownloadUrlStatus(download.ID, 'DOWNLOADING');

        // Download the JSON file
        const jsonContent = await downloadJsonFromUrl(download.DownloadURL);

        if (!jsonContent) {
            throw new Error('Failed to download JSON content from URL');
        }

        // Save JSON file based on environment
        const storageInfo = await saveReportJsonFile(download, jsonContent);

        if (!filePath) {
            throw new Error('Failed to save JSON file to disk');
        }

        // Parse and store data in database
        await parseAndStoreJsonData(download, jsonContent, storageInfo?.url || storageInfo?.path || null);

        // Update status to COMPLETED
        const fileStats = storageInfo?.path
            ? await fs.stat(storageInfo.path)
            : { size: Buffer.byteLength(JSON.stringify(jsonContent)) };
        await sqpDownloadUrlsModel.updateDownloadUrlStatus(
            download.ID,
            'COMPLETED',
            null,
            storageInfo?.url || storageInfo?.path || null,
            fileStats.size
        );

        console.log(`Successfully processed JSON file for report ${download.ReportID}`);

    } catch (error) {
        console.error(`Error processing JSON file for report ${download.ReportID}:`, error.message);

        // Update status to FAILED
        await sqpDownloadUrlsModel.updateDownloadUrlStatus(download.ID, 'FAILED', error.message);
    }
}

/**
 * Download JSON content from URL
 */
async function downloadJsonFromUrl(url) {
    try {
        const response = await axios.get(url, {
            timeout: 60000,
            maxRedirects: 5,
            validateStatus: (status) => status === 200
        });

        return response.data;

    } catch (error) {
        throw new Error(`Download failed: ${error.message}`);
    }
}

/**
 * Save JSON file to S3 in prod, or local reports folder in dev/local
 */
async function saveReportJsonFile(download, jsonContent) {
    try {
        const amazonSellerID = download.AmazonSellerID;
        const date = new Date().toISOString().split('T')[0];
        const reportType = (download.ReportType || download.reportType || '').toString().toLowerCase();

        // Generate filename: {reportType}_{reportID}_{timestamp}.json
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const safeType = reportType || 'sqp';
        const filename = `${safeType}_${download.ReportID}_${timestamp}.json`;

        if ((nodeEnv || '').toLowerCase() === 'development' || (nodeEnv || '').toLowerCase() === 'local') {
            // Save locally outside src: ./reports/{seller}/{type}/{date}/{filename}
            const baseDir = path.join(process.cwd(), 'reports', amazonSellerID, reportType, date);
            await fs.mkdir(baseDir, { recursive: true });
            const filePath = path.join(baseDir, filename);
            await fs.writeFile(filePath, JSON.stringify(jsonContent, null, 2));
            console.log(`JSON file saved locally: ${filePath}`);
            return { path: filePath };
        } else {
            // Upload to S3
            const parts = [amazonSellerID, reportType, date];
            const result = await uploadJson(parts, filename, jsonContent);
            console.log(`JSON file uploaded to S3: ${result.url}`);
            return result;
        }
    } catch (error) {
        console.error('Error saving JSON report:', error);
        return null;
    }
}

/**
 * Parse JSON content and store in database
 */
async function parseAndStoreJsonData(download, jsonContent, filePath) {
    try {
        // Get the report date based on the report type
        const reportDate = getReportDateForPeriod(download.ReportType);

        let records = [];
        
        // Process each record in the report data
        if (jsonContent.records && Array.isArray(jsonContent.records)) {
            records = jsonContent.records;
        } else if (Array.isArray(jsonContent)) {
            records = jsonContent;
        }

        if (records.length === 0) {
            console.log(`No records found in JSON for report ${download.ReportID}`);
            return;
        }

        // Bulk prepare and insert
        const rows = [];
        for (const record of records) {
            const row = buildMetricsRow(download, reportDate, record, filePath);
            if (row) rows.push(row);
        }
        if (rows.length > 0) {
            await SqpMetrics3mo.bulkCreate(rows, { validate: false, ignoreDuplicates: false });
        }

        console.log(`Successfully parsed and stored ${records.length} records for report ${download.ReportID}`);

    } catch (error) {
        throw new Error(`JSON parsing failed: ${error.message}`);
    }
}

/**
 * Store a single report record in the database
 */
function buildMetricsRow(download, reportDate, record, filePath) {
    try {
        const asin = record.asin || record.ASIN || '';
        const query = record.query || record.Query || '';
        const impressions = record.impressions || record.Impressions || 0;
        const clicks = record.clicks || record.Clicks || 0;
        const clickThroughRate = record.clickThroughRate || record.ClickThroughRate || 0;
        const costPerClick = record.costPerClick || record.CostPerClick || 0;
        const spend = record.spend || record.Spend || 0;
        const orders = record.orders || record.Orders || 0;
        const sales = record.sales || record.Sales || 0;
        const acos = record.acos || record.ACoS || 0;
        const conversionRate = record.conversionRate || record.ConversionRate || 0;

        return {
            ReportID: download.ReportID,
            AmazonSellerID: download.AmazonSellerID,
            ReportType: download.ReportType,
            ReportDate: reportDate,
            ASIN: asin,
            SearchQuery: query,
            AsinImpressionCount: impressions,
            AsinClickCount: clicks,
            TotalClickRate: clickThroughRate,
            AsinMedianClickPrice: costPerClick,
            Spend: spend,
            AsinPurchaseCount: orders,
            Sales: sales,
            ACoS: acos,
            AsinPurchaseRate: conversionRate,
            SourceFile: filePath ? path.basename(filePath) : null,
            CreatedDate: new Date()
        };
    } catch (_) {
        return null;
    }
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
 * Get download URL statistics
 */
async function getDownloadUrlStats() {
    try {
        return await sqpDownloadUrlsModel.getDownloadUrlStats();
    } catch (error) {
        console.error('Error getting download URL stats:', error);
        throw error;
    }
}

module.exports = {
    processPendingJsonFiles,
    processSingleJsonFile,
    downloadJsonFromUrl,
    saveReportJsonFile,
    parseAndStoreJsonData,
    getReportDateForPeriod,
    getDownloadUrlStats
};
