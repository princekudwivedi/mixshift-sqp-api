const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { uploadJson } = require('../utils/s3.utils');
const { getModel: getSqpMetrics3mo } = require('../models/sequelize/sqpMetrics3mo.model');
const { getModel: getSqpCronDetails } = require('../models/sequelize/sqpCronDetails.model');
const { env } = require('../config/env.config');
const nodeEnv = (env.NODE_ENV || 'development').toLowerCase();
const downloadUrls = require('../models/sqp.download.urls.model');

/**
 * Process pending JSON files from download URLs
 */
async function processPendingJsonFiles() {
	try {
		// Process saved files that were already downloaded (COMPLETED) and not yet processed
		const pendingDownloads = await downloadUrls.getCompletedDownloadsWithFiles(10);
		if (!pendingDownloads || pendingDownloads.length === 0) {
			console.log('No saved JSON files to process');
			return;
		}

		console.log(`Processing ${pendingDownloads.length} saved JSON files`);

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
		// Mark processing start and increment ProcessAttempts
		await downloadUrls.updateProcessStatusById(download.ID, 'PROCESSING', { incrementAttempts: true });

		// Obtain JSON content from FilePath (S3 https URL or local path)
		const filePath = download.FilePath;
		if (!filePath) {
			throw new Error('Missing FilePath for JSON download record');
		}

		let jsonContent = null;
		if (typeof filePath === 'string' && /^https?:\/\//i.test(filePath)) {
			// Remote (e.g., S3 pre-signed URL)
			jsonContent = await downloadJsonFromUrl(filePath);
		} else {
			// Local file path
			const content = await fs.readFile(filePath, 'utf-8');
			jsonContent = JSON.parse(content);
		}

		if (!jsonContent) {
			throw new Error('Failed to load JSON content from FilePath');
		}

		// Set ReportDate to the time the report was requested
		const reportDateOverride = await getRequestStartDate(download.CronJobID, download.ReportType);

		// Parse and store data in database
		const { total, success, failed } = await parseAndStoreJsonData(download, jsonContent, filePath, reportDateOverride);

		// Update status to COMPLETED
		const fileStats = (!/^https?:\/\//i.test(filePath) && filePath)
			? await fs.stat(filePath)
			: { size: Buffer.byteLength(JSON.stringify(jsonContent)) };
		await downloadUrls.updateDownloadUrlStatus(
			download.ID,
			'COMPLETED',
			null,
			filePath,
			fileStats.size
		);
		// Mark processing success with counts
		await downloadUrls.updateProcessStatusById(download.ID, 'SUCCESS', { fullyImported: 1, totalRecords: total, successCount: success, failCount: failed });

		console.log(`Successfully processed JSON file for report ${download.ReportID}`);

	} catch (error) {
		console.error(`Error processing JSON file for report ${download.ReportID}:`, error.message);		
		// Mark processing failed
		await downloadUrls.updateProcessStatusById(download.ID, 'FAILED', { lastError: error.message });
	}
}

/**
 * Download JSON content from URL
 */
async function downloadJsonFromUrl(url) {
    try {
        console.log('Downloading JSON from URL:', url);
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
        
        if (nodeEnv === 'development' || nodeEnv === 'local') {
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
async function parseAndStoreJsonData(download, jsonContent, filePath, reportDateOverride) {
	try {
		// Get the report date based on the report type (fallback)
		const defaultReportDate = getReportDateForPeriod(download.ReportType);

		let records = [];
		
		// Handle different JSON shapes
		if (Array.isArray(jsonContent)) {
			records = jsonContent;
		} else if (jsonContent && Array.isArray(jsonContent.records)) {
			records = jsonContent.records;
		} else if (jsonContent && typeof jsonContent === 'object' && (jsonContent.startDate || jsonContent.searchQueryData)) {
			// Single record object in SQP structure
			records = [jsonContent];
		}

		if (!records.length) {
			console.log(`No records found in JSON for report ${download.ReportID}`);
			return { total: 0, success: 0, failed: 0 };
		}

		const rows = [];
		for (const record of records) {
			const row = buildMetricsRow(download, defaultReportDate, record, filePath, reportDateOverride);
			if (row) rows.push(row);
		}

		const total = records.length;
		const success = rows.length;
		const failed = total - success;

		if (rows.length > 0) {
			const SqpMetrics3mo = getSqpMetrics3mo();
			await SqpMetrics3mo.bulkCreate(rows, { validate: false, ignoreDuplicates: false });
		}

		console.log(`Successfully parsed and stored ${rows.length}/${records.length} records for report ${download.ReportID}`);
		return { total, success, failed };

	} catch (error) {
		throw new Error(`JSON parsing failed: ${error.message}`);
	}
}

/**
 * Store a single report record in the database
 */
function buildMetricsRow(download, reportDate, record, filePath, reportDateOverride) {
	try {
		// SQP structured fields
		const startDate = record.startDate || null;
		const endDate = record.endDate || null;
		const asin = record.asin || record.ASIN || '';

		const sq = record.searchQueryData || {};
		const impressions = record.impressionData || {};
		const clicks = record.clickData || {};
		const cart = record.cartAddData || {};
		const purchase = record.purchaseData || {};

		// Currency preference: clickData, then cartAddData, then purchaseData
		const currencyCode = 
			(clicks.totalMedianClickPrice && clicks.totalMedianClickPrice.currencyCode) ||
			(cart.totalMedianCartAddPrice && cart.totalMedianCartAddPrice.currencyCode) ||
			(purchase.totalMedianPurchasePrice && purchase.totalMedianPurchasePrice.currencyCode) ||
			null;

		return {
			ReportID: download.ReportID,
			AmazonSellerID: download.AmazonSellerID,
			ReportType: download.ReportType,
			ReportDate: reportDateOverride || endDate || reportDate,
			StartDate: startDate,
			EndDate: endDate,
			CurrencyCode: currencyCode,
			SearchQuery: sq.searchQuery || '',
			SearchQueryScore: sq.searchQueryScore || 0,
			SearchQueryVolume: sq.searchQueryVolume || 0,
			TotalQueryImpressionCount: impressions.totalQueryImpressionCount || 0,
			AsinImpressionCount: impressions.asinImpressionCount || 0,
			AsinImpressionShare: impressions.asinImpressionShare || 0,
			TotalClickCount: clicks.totalClickCount || 0,
			TotalClickRate: clicks.totalClickRate || 0,
			AsinClickCount: clicks.asinClickCount || 0,
			AsinClickShare: clicks.asinClickShare || 0,
			TotalMedianClickPrice: (clicks.totalMedianClickPrice && clicks.totalMedianClickPrice.amount) || 0,
			AsinMedianClickPrice: (clicks.asinMedianClickPrice && clicks.asinMedianClickPrice.amount) || 0,
			TotalSameDayShippingClickCount: clicks.totalSameDayShippingClickCount || 0,
			TotalOneDayShippingClickCount: clicks.totalOneDayShippingClickCount || 0,
			TotalTwoDayShippingClickCount: clicks.totalTwoDayShippingClickCount || 0,
			TotalCartAddCount: cart.totalCartAddCount || 0,
			TotalCartAddRate: cart.totalCartAddRate || 0,
			AsinCartAddCount: cart.asinCartAddCount || 0,
			AsinCartAddShare: cart.asinCartAddShare || 0,
			TotalMedianCartAddPrice: (cart.totalMedianCartAddPrice && cart.totalMedianCartAddPrice.amount) || 0,
			AsinMedianCartAddPrice: (cart.asinMedianCartAddPrice && cart.asinMedianCartAddPrice.amount) || 0,
			TotalSameDayShippingCartAddCount: cart.totalSameDayShippingCartAddCount || 0,
			TotalOneDayShippingCartAddCount: cart.totalOneDayShippingCartAddCount || 0,
			TotalTwoDayShippingCartAddCount: cart.totalTwoDayShippingCartAddCount || 0,
			TotalPurchaseCount: purchase.totalPurchaseCount || 0,
			TotalPurchaseRate: purchase.totalPurchaseRate || 0,
			AsinPurchaseCount: purchase.asinPurchaseCount || 0,
			AsinPurchaseShare: purchase.asinPurchaseShare || 0,
			TotalMedianPurchasePrice: (purchase.totalMedianPurchasePrice && purchase.totalMedianPurchasePrice.amount) || 0,
			AsinMedianPurchasePrice: (purchase.asinMedianPurchasePrice && purchase.asinMedianPurchasePrice.amount) || 0,
			AsinPurchaseRate: purchase.asinPurchaseRate || 0,
			TotalSameDayShippingPurchaseCount: purchase.totalSameDayShippingPurchaseCount || 0,
			TotalOneDayShippingPurchaseCount: purchase.totalOneDayShippingPurchaseCount || 0,
			TotalTwoDayShippingPurchaseCount: purchase.totalTwoDayShippingPurchaseCount || 0,
			ASIN: asin,
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
        return await downloadUrls.getDownloadUrlStats();
    } catch (error) {
        console.error('Error getting download URL stats:', error);
        throw error;
    }
}

async function processSavedJsonFiles(limit = 25) {
	const rows = await downloadUrls.getCompletedDownloadsWithFiles(limit);
	if (!rows || rows.length === 0) {
		console.log('No saved JSON files to process');
		return { processed: 0, errors: 0 };
	}

	let processed = 0;
	let errors = 0;

	for (const row of rows) {
		try {
			await downloadUrls.updateProcessStatusById(row.ID, 'PROCESSING', { incrementAttempts: true });

			// Read file from disk
			const filePath = row.FilePath;
			const content = await fs.readFile(filePath, 'utf-8');
			const json = JSON.parse(content);

			// ReportDate from request start time
			const reportDateOverride = await getRequestStartDate(row.CronJobID, row.ReportType);

			// Parse and store
			const stats = await parseAndStoreJsonData({
				ReportID: row.ReportID,
				AmazonSellerID: row.AmazonSellerID,
				ReportType: row.ReportType,
				CronJobID: row.CronJobID,
			}, json, filePath, reportDateOverride);

			await downloadUrls.updateProcessStatusById(row.ID, 'SUCCESS', {
				fullyImported: 1,
				totalRecords: stats.total,
				successCount: stats.success,
				failCount: stats.failed
			});
			processed++;
		} catch (e) {
			console.error('Error processing saved file:', e.message);
			await downloadUrls.updateProcessStatusById(row.ID, 'FAILED', { lastError: e.message });
			errors++;
		}
	}

	return { processed, errors };
}

async function getRequestStartDate(cronJobID, reportType) {
	try {
		if (!cronJobID || !reportType) return null;
		const SqpCronDetails = getSqpCronDetails();
		const row = await SqpCronDetails.findOne({ where: { ID: cronJobID } });
		if (!row) return null;
		const prefix = reportType === 'WEEK' ? 'Weekly' : reportType === 'MONTH' ? 'Monthly' : reportType === 'QUARTER' ? 'Quarterly' : '';
		const field = `${prefix}SQPDataPullStartDate`;
		return row[field] ? new Date(row[field]) : null;
	} catch (_) {
		return null;
	}
}

module.exports = {
    processPendingJsonFiles,
    processSingleJsonFile,
    processSavedJsonFiles,
    downloadJsonFromUrl,
    saveReportJsonFile,
    parseAndStoreJsonData,
    getReportDateForPeriod,
    getDownloadUrlStats
};
