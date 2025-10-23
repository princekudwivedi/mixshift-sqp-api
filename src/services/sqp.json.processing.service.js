const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { uploadJson } = require('../utils/s3.utils');
const model = require('../models/sqp.cron.model');
const { getModel: getSqpWeekly } = require('../models/sequelize/sqpWeekly.model');
const { getModel: getSqpMonthly } = require('../models/sequelize/sqpMonthly.model');
const { getModel: getSqpQuarterly } = require('../models/sequelize/sqpQuarterly.model');
const { getModel: getSqpCronDetails } = require('../models/sequelize/sqpCronDetails.model');
const { env } = require('../config/env.config');
const nodeEnv = (env.NODE_ENV || 'development').toLowerCase();
const downloadUrls = require('../models/sqp.download.urls.model');
const { getModel: getSqpDownloadUrls } = require('../models/sequelize/sqpDownloadUrls.model');
const dates = require('../utils/dates.utils');
const { DateHelpers } = require('../helpers/sqp.helpers');
const logger = require('../utils/logger.utils');
const { Op, literal } = require('sequelize');

/**
 * Handle report completion - unified function for both data and no-data scenarios
 * This function handles the complete flow for report completion including date ranges
 */
async function handleReportCompletion(cronJobID, reportType, amazonSellerID = null, jsonData = null, hasData = true) {
	try {
		console.log(`📘 Handling report completion for ${reportType}`, { 
			cronJobID, 
			amazonSellerID, 
			hasData,
			dataLength: Array.isArray(jsonData) ? jsonData.length : 0
		});

		// 🧩 Step 1: Fetch cron details
		const SqpCronDetails = getSqpCronDetails();
		const cronDetail = await SqpCronDetails.findOne({ 
			where: { ID: cronJobID }, 
			attributes: [
				'AmazonSellerID',
				'SellerID',
				'ASIN_List',
				'WeeklySQPDataPullStatus',
				'MonthlySQPDataPullStatus',
				'QuarterlySQPDataPullStatus'
			] 
		});

		if (!cronDetail) {
			console.warn(`⚠️ No cron details found for ID ${cronJobID}`);
			return;
		}

		let finalAmazonSellerID = amazonSellerID || cronDetail.AmazonSellerID;
		let cronAsins = [];

		if (cronDetail.ASIN_List) {
			cronAsins = cronDetail.ASIN_List.split(/\s+/).filter(Boolean).map(a => a.trim());
		}

		console.log(`✅ Retrieved cron details`, { 
			cronJobID, 
			amazonSellerID: finalAmazonSellerID, 
			asinCount: cronAsins.length
		});

		// 🧩 Step 2: Update Download URL Process Status
		const SqpDownloadUrls = getSqpDownloadUrls();
		const latest = await SqpDownloadUrls.findOne({
			where: { CronJobID: cronJobID, ReportType: reportType },
			order: [['dtUpdatedOn', 'DESC']]
		});

		if (latest && !hasData) {
			await downloadUrls.updateProcessStatusById(latest.ID, 'SUCCESS', {
				ProcessAttempts: 1,
				LastProcessAt: new Date(),
				fullyImported: 1
			});
			console.log(`✅ Marked download URL as SUCCESS (no data)`);
		}

		// 🧩 Step 3: Update Cron detail process statuses
		await model.setProcessRunningStatus(cronJobID, reportType, 4);
		await model.updateSQPReportStatus(cronJobID, reportType, 1, undefined, new Date(), 2);

		// 🧩 Step 4: Determine correct model
		const { getModel: getSqpWeekly } = require('../models/sequelize/sqpWeekly.model');
		const { getModel: getSqpMonthly } = require('../models/sequelize/sqpMonthly.model');
		const { getModel: getSqpQuarterly } = require('../models/sequelize/sqpQuarterly.model');

		const SqpModel = reportType === 'WEEK' ? getSqpWeekly()
			: reportType === 'MONTH' ? getSqpMonthly()
			: reportType === 'QUARTER' ? getSqpQuarterly()
			: null;

		if (!SqpModel) {
			console.error(`❌ Invalid report type: ${reportType}`);
			return;
		}

		const sellerId = parseInt(cronDetail.SellerID) || 0;

		// 🧩 Step 5: Update each ASIN’s date range
		for (const asin of cronAsins) {
			try {
				const dateRanges = await SqpModel.findOne({
					where: { ASIN: asin, SellerID: sellerId, AmazonSellerID: finalAmazonSellerID },
					attributes: [
						[literal('MAX(StartDate)'), 'minStartDate'],
						[literal('MAX(EndDate)'), 'maxEndDate']
					],
					raw: true
				});

				let minRange = null;
				let maxRange = null;
				let isDataAvailable = 2; // default: no data

				if (hasData && dateRanges?.minStartDate && dateRanges?.maxEndDate) {
					minRange = dateRanges.minStartDate;
					maxRange = dateRanges.maxEndDate;
					isDataAvailable = 1;
				}

				console.log(`🔹 Processing ASIN ${asin}`, {
					reportType,
					minRange,
					maxRange,
					isDataAvailable
				});

				await updateSellerAsinLatestRanges({
					cronJobID,
					amazonSellerID: finalAmazonSellerID,
					reportType,
					minRange: minRange || '',
					maxRange: maxRange || '',
					jsonAsins: [asin],
					IsDataAvailable: isDataAvailable
				});
			} catch (asinError) {
				console.error(`❌ Error processing ASIN ${asin}:`, asinError.message);
			}
		}

		console.log(`✅ Completed ASIN range updates for ${reportType}`, {
			cronJobID,
			reportType,
			hasData,
			totalAsins: cronAsins.length
		});

		// 🧩 Step 6: Update ASIN-level completion status
		const statusForThisReport = 2; // 2 = completed
		const endTime = new Date();

		await model.ASINsBySellerUpdated(
			sellerId,
			finalAmazonSellerID, 
			cronAsins, 
			statusForThisReport, 
			reportType,  
			null,        // startTime already set earlier
			endTime
		);

		console.log(`✅ Updated ${reportType} ASIN status`, {
			cronJobID,
			reportType,
			asinCount: cronAsins.length,
			status: statusForThisReport,
			endTime: endTime.toISOString()
		});

		console.log(`🎯 Successfully handled report completion for ${reportType}`, { 
			cronJobID, 
			reportType, 
			hasData,
			amazonSellerID: finalAmazonSellerID,
			asinCount: cronAsins.length
		});

		return true;

	} catch (error) {
		console.error(`🚨 Failed to handle report completion for ${reportType}:`, error.message, { 
			cronJobID, 
			reportType, 
			hasData 
		});
		throw error;
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
		const defaultReportDate = DateHelpers.getReportDateForPeriod(download.ReportType);

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
        let minRange = null;
        let maxRange = null;
		for (const record of records) {
			const row = buildMetricsRow(download, defaultReportDate, record, filePath, reportDateOverride);
			if (row) rows.push(row);
            const s = record.startDate || null;
            const e = record.endDate || null;
            if (s) minRange = !minRange || s < minRange ? s : minRange;
            if (e) maxRange = !maxRange || e > maxRange ? e : maxRange;
		}

		const total = records.length;
		const success = rows.length;
		const failed = total - success;

		console.log(`parseAndStoreJsonData: Date range calculation`, { 
			total, 
			success, 
			failed, 
			minRange, 
			maxRange,
			recordsSample: records.slice(0, 2).map(r => ({ startDate: r.startDate, endDate: r.endDate }))
		});
		if (rows.length > 0) {
            const type = (download.ReportType || '').toUpperCase();
            if (type === 'WEEK') {
                const SqpWeekly = getSqpWeekly();
                await SqpWeekly.bulkCreate(rows, { validate: false, ignoreDuplicates: false });
            } else if (type === 'MONTH') {
                const SqpMonthly = getSqpMonthly();
                await SqpMonthly.bulkCreate(rows, { validate: false, ignoreDuplicates: false });
            } else if (type === 'QUARTER') {
                const SqpQuarterly = getSqpQuarterly();
                await SqpQuarterly.bulkCreate(rows, { validate: false, ignoreDuplicates: false });
            } 
		}

		console.log(`Successfully parsed and stored ${rows.length}/${records.length} records for report`);
        return { total, success, failed, minRange, maxRange };

	} catch (error) {
		throw new Error(`JSON parsing failed: ${error.message}`);
	}
}

/**
 * Import with up to 3 retries. On interim failures, set status 3 (retry failed). On final failure, set 2.
 */
async function importJsonWithRetry(download, jsonContent, filePath, reportDateOverride, maxAttempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const stats = await parseAndStoreJsonData(download, jsonContent, filePath, reportDateOverride);
            return stats;
        } catch (e) {
            lastError = e;
            const isFinal = attempt === maxAttempts;
            if (download.CronJobID && download.ReportType) {
                const status = isFinal ? 2 : 3; // 3 while retrying, 2 on final fail
                await model.updateSQPReportStatus(download.CronJobID, download.ReportType, status, null, new Date());
            }
            if (isFinal) throw e;
        }
    }
    // Should not reach here
    throw lastError || new Error('Unknown import error');
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
		const amazonSellerID = download.AmazonSellerID || null;
		const sellerID = download.SellerID || 0;		

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
			AmazonSellerID: amazonSellerID,
			SellerID: sellerID,
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
			dtCreatedOn: new Date()
		};
	} catch (_) {
		return null;
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

// Update LatestRecordDateRange* on seller_ASIN_list for ASINs in ASIN_List (cron) or JSON
async function updateSellerAsinLatestRanges({
    cronJobID,
    amazonSellerID,
    reportType,
    minRange,
    maxRange,
    jsonAsins = [],
    IsDataAvailable = 1
}) {
    console.log(`updateSellerAsinLatestRanges called with:`, {
        cronJobID,
        amazonSellerID,
        reportType,
        minRange,
        maxRange,
        jsonAsinsCount: jsonAsins.length
    });

    // 🧩 Validate inputs
    if (!cronJobID || !reportType || (IsDataAvailable !== 2 && (!minRange || !maxRange))) {
        console.log(`updateSellerAsinLatestRanges: Missing required parameters`, {
            cronJobID: !!cronJobID,
            reportType: !!reportType,
            minRange: !!minRange,
            maxRange: !!maxRange
        });
        return;
    }

    // 🧩 Determine column and availability flag based on report type
    const col =
        reportType === 'WEEK'
            ? 'LatestRecordDateRangeWeekly'
            : reportType === 'MONTH'
            ? 'LatestRecordDateRangeMonthly'
            : reportType === 'QUARTER'
            ? 'LatestRecordDateRangeQuarterly'
            : null;

    const IsDataAvl =
        reportType === 'WEEK'
            ? 'IsWeekDataAvailable'
            : reportType === 'MONTH'
            ? 'IsMonthDataAvailable'
            : reportType === 'QUARTER'
            ? 'IsQuarterDataAvailable'
            : 0;

    if (!col || !IsDataAvl) {
        console.log(`updateSellerAsinLatestRanges: Invalid reportType`, { reportType });
        return;
    }

    const rangeStr = minRange && maxRange ? `${minRange} - ${maxRange}` : null;
    console.log(`updateSellerAsinLatestRanges: Range string`, { rangeStr, column: col });

    const SqpCronDetails = getSqpCronDetails();

    console.log(`updateSellerAsinLatestRanges: Fetching cron details for ID`, { cronJobID });
    const cronRow = await SqpCronDetails.findOne({
        where: { ID: cronJobID },
        attributes: ['ASIN_List', 'SellerID']
    }).catch((error) => {
        console.error(`updateSellerAsinLatestRanges: Error fetching cron details`, {
            cronJobID,
            error: error.message
        });
        return null;
    });

    // 🧩 Combine ASINs from cron and JSON input
    const asinSet = new Set();

    if (cronRow?.ASIN_List) {
        const cronAsins = cronRow.ASIN_List.split(/\s+/).filter(Boolean).map((a) => a.trim());
        cronAsins.forEach((a) => asinSet.add(a));
        console.log(`updateSellerAsinLatestRanges: Found ASINs from cron details`, {
            cronAsinsCount: cronAsins.length,
            cronAsins: cronAsins.slice(0, 5)
        });
    } else {
        console.log(`updateSellerAsinLatestRanges: No ASIN_List found in cron details`, {
            cronJobID,
            hasCronRow: !!cronRow
        });
    }

    jsonAsins.forEach((a) => asinSet.add(String(a).trim()));
    const asins = Array.from(asinSet).filter(Boolean);

    console.log(`updateSellerAsinLatestRanges: Final ASIN list`, {
        asinsCount: asins.length,
        asins: asins.slice(0, 5)
    });

    if (asins.length === 0) {
        console.log(`updateSellerAsinLatestRanges: No ASINs to update`);
        return;
    }

    
    const { getModel: getSellerAsinList } = require('../models/sequelize/sellerAsinList.model');
    const SellerAsinList = getSellerAsinList();

    
    const where = {
        AmazonSellerID: amazonSellerID,
        ASIN: asins
    };

    if (cronRow?.SellerID) {
        where.SellerID = cronRow.SellerID;
    }

    console.log(`updateSellerAsinLatestRanges: Updating seller_ASIN_list`, {
        amazonSellerID,
        column: col,
        rangeStr,
        asinsCount: asins.length,
        where
    });
    
    const existingRecords = await SellerAsinList.findAll({
        where,
        attributes: ['ID', 'AmazonSellerID', 'ASIN', col],
        raw: true
    });

    console.log(`updateSellerAsinLatestRanges: Found existing records`, {
        amazonSellerID,
        existingRecordsCount: existingRecords.length,
        existingRecords: existingRecords.slice(0, 3)
    });
    
    let result;
    if (IsDataAvailable === 2) {
        // Mark data unavailable (nullify date range)
        result = await SellerAsinList.update(
            { [IsDataAvl]: IsDataAvailable, dtUpdatedOn: new Date() },
            { where }
        );
    } else {
        result = await SellerAsinList.update(
            { [col]: rangeStr, [IsDataAvl]: IsDataAvailable, dtUpdatedOn: new Date() },
            { where }
        );
    }

    console.log(`updateSellerAsinLatestRanges: Update completed`, {
        amazonSellerID,
        column: col,
        rangeStr,
        asinsCount: asins.length,
        updatedRows: result?.[0] || 0,
        existingRecordsCount: existingRecords.length
    });
}

async function __importJson(row, processed = 0, errors = 0, iInitialPull = 0){
	try {
		await downloadUrls.updateProcessStatusById(row.ID, 'PROCESSING', { incrementAttempts: true });

		// Read file from disk
		const filePath = row.FilePath;
		const content = await fs.readFile(filePath, 'utf-8');
		const json = JSON.parse(content);

		// Check if JSON contains no data
		if (!Array.isArray(json) || json.length === 0) {
			console.log(`JSON file contains no data for ${row.ReportType}`, { 
				cronJobID: row.CronJobID, 
				reportType: row.ReportType,
				filePath 
			});
			
			if(iInitialPull === 0){
				// Use the unified completion handler for no-data scenario
				await handleReportCompletion(row.CronJobID, row.ReportType, row.AmazonSellerID, null, false);
			}			
			processed++;
			return { processed, errors };
		}

		// ReportDate from request start time
		const reportDateOverride = await getRequestStartDate(row.CronJobID, row.ReportType);

		// Parse and store
		// ProcessRunningStatus = 4 (Process Import) and mark cron detail as import in-progress (4)
		if (row.CronJobID && row.ReportType) {
			await model.setProcessRunningStatus(row.CronJobID, row.ReportType, 4);			
		}

		let cronSellerID = 0;
		let cronAmazonSellerID = '';
		if(!row.SellerID){
			const SqpCronDetails = getSqpCronDetails();
			const cronRow = await SqpCronDetails.findOne({ where: { ID: row.CronJobID }, attributes: ['ID', 'SellerID', 'AmazonSellerID'] });
			if (cronRow && cronRow.SellerID) {
				cronSellerID = cronRow.SellerID;
				cronAmazonSellerID = cronRow.AmazonSellerID || '';
			}
		}
		logger.info(`__importJson:before importJsonWithRetry`, {			
			AmazonSellerID: row.AmazonSellerID || cronAmazonSellerID || '',
			SellerID: row.SellerID || cronSellerID || 0,
			ReportType: row.ReportType,
			CronJobID: row.CronJobID,
			cronAmazonSellerID,
			cronSellerID,
		});
		const stats = await importJsonWithRetry({
			ReportID: row.ReportID,
			AmazonSellerID: row.AmazonSellerID || cronAmazonSellerID || '',
			SellerID: row.SellerID || cronSellerID || 0,
			ReportType: row.ReportType,
			CronJobID: row.CronJobID,
		}, json, filePath, reportDateOverride);

		await downloadUrls.updateProcessStatusById(row.ID, 'SUCCESS', {
			fullyImported: 1,
			totalRecords: stats.total,
			successCount: stats.success,
			failCount: stats.failed
		});
		if(iInitialPull === 0){
			// Use the unified completion handler for data scenario
			await handleReportCompletion(row.CronJobID, row.ReportType, row.AmazonSellerID, json, true);
		}
		processed++;
	} catch (e) {
		console.error('Error processing saved file:', e.message);
		await downloadUrls.updateProcessStatusById(row.ID, 'FAILED', { lastError: e.message });
		// Mark cron detail import failed (2) or retry failed (3) if attempts already happened
		if (row.CronJobID && row.ReportType) {
			const status = (row.ProcessAttempts && Number(row.ProcessAttempts) > 0) ? 3 : 2;
			await model.updateSQPReportStatus(row.CronJobID, row.ReportType, status, null, new Date());
		}
		errors++;
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
    downloadJsonFromUrl,
    saveReportJsonFile,
    parseAndStoreJsonData,
    importJsonWithRetry,
    handleReportCompletion,
    getDownloadUrlStats,
	__importJson
};
