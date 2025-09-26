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

/**
 * Handle report completion - unified function for both data and no-data scenarios
 * This function handles the complete flow for report completion including date ranges
 */
async function handleReportCompletion(cronJobID, reportType, amazonSellerID = null, jsonData = null, hasData = true) {
	try {
		console.log(`Handling report completion for ${reportType}`, { 
			cronJobID, 
			amazonSellerID, 
			hasData,
			dataLength: Array.isArray(jsonData) ? jsonData.length : 0
		});
		
		// Get AmazonSellerID and ASINs from cron details if not provided
		let finalAmazonSellerID = amazonSellerID;
		let cronAsins = [];
		
		if (!finalAmazonSellerID || cronAsins.length === 0) {
			const SqpCronDetails = getSqpCronDetails();
			const cronDetail = await SqpCronDetails.findOne({ 
				where: { ID: cronJobID }, 
				attributes: ['AmazonSellerID', 'ASIN_List', 'WeeklySQPDataPullStatus', 'MonthlySQPDataPullStatus', 'QuarterlySQPDataPullStatus'] 
			});
			
			if (cronDetail) {
				finalAmazonSellerID = cronDetail.AmazonSellerID;
				if (cronDetail.ASIN_List) {
					cronAsins = cronDetail.ASIN_List.split(/\s+/).filter(Boolean).map(a => a.trim());
				}
				
				console.log(`Retrieved cron details for completion`, { 
					cronJobID, 
					amazonSellerID: finalAmazonSellerID, 
					asinCount: cronAsins.length,
					weeklyStatus: cronDetail.WeeklySQPDataPullStatus,
					monthlyStatus: cronDetail.MonthlySQPDataPullStatus,
					quarterlyStatus: cronDetail.QuarterlySQPDataPullStatus
				});
			}
		}
		
		const SqpDownloadUrls = getSqpDownloadUrls();
		// Find latest row for this CronJobID+ReportType
		const latest = await SqpDownloadUrls.findOne({
			where: { CronJobID: cronJobID, ReportType: reportType },
			order: [['dtUpdatedOn', 'DESC']]
		});
		if (latest) {
			if(!hasData) {
				// Update download URLs process status to SUCCESS
				await downloadUrls.updateProcessStatusById(latest.ID, 'SUCCESS', {
					ProcessAttempts: 1,
					LastProcessAt: new Date(),
					fullyImported: 1
				});
			}
		}
		
		
		// Update cron detail status
		await model.setProcessRunningStatus(cronJobID, reportType, 4);
		await model.updateSQPReportStatus(cronJobID, reportType, 1, null, null, null, null, undefined, new Date());
		
		// Handle date range updates and ASIN completion
		if (finalAmazonSellerID && cronAsins.length > 0) {
			try {
				// Calculate date ranges from JSON data if available, or use current date for no-data scenarios
				let minRange = null;
				let maxRange = null;
				let jsonAsins = [];
				
				if (hasData && Array.isArray(jsonData) && jsonData.length > 0) {
					// Use actual data from JSON
					jsonAsins = jsonData.map(r => (r.asin || r.ASIN || '')).filter(Boolean);
					if (jsonAsins.length > 0 && jsonData[0]?.startDate) {
						minRange = jsonData.reduce((m, r) => m && m < r.startDate ? m : r.startDate, jsonData[0].startDate);
					}
					if (jsonAsins.length > 0 && jsonData[0]?.endDate) {
						maxRange = jsonData.reduce((m, r) => m && m > r.endDate ? m : r.endDate, jsonData[0].endDate);
					}
				} else {
					// For no-data scenarios, use the existing function to get appropriate date ranges
					const reportDate = dates.getDateRangeForPeriod(reportType);
					minRange = reportDate.start;
					maxRange = reportDate.end;
					jsonAsins = []; // No JSON ASINs for no-data scenarios
					
					console.log(`No data scenario - using calculated date ranges for ${reportType}`, {
						cronJobID,
						reportType,
						minRange,
						maxRange,
						scenario: 'no-data'
					});
				}
				
				console.log(`Updating seller_ASIN_list date ranges for ${reportType}`, {
					cronJobID,
					amazonSellerID: finalAmazonSellerID,
					reportType,
					minRange,
					maxRange,
					jsonAsinsCount: jsonAsins.length,
					hasData,
					scenario: hasData ? 'with-data' : 'no-data'
				});
				
				// Update date ranges in seller_ASIN_list
				await updateSellerAsinLatestRanges({
					cronJobID,
					amazonSellerID: finalAmazonSellerID,
					reportType,
					minRange,
					maxRange,
					jsonAsins
				});
				
				// Check if ALL report types are finished (completed or failed)
				const SqpCronDetails = getSqpCronDetails();
				const cronDetail = await SqpCronDetails.findOne({ 
					where: { ID: cronJobID }, 
					attributes: ['WeeklySQPDataPullStatus', 'MonthlySQPDataPullStatus', 'QuarterlySQPDataPullStatus'] 
				});
				
				if (cronDetail) {
					const weeklyStatus = cronDetail.WeeklySQPDataPullStatus;
					const monthlyStatus = cronDetail.MonthlySQPDataPullStatus;
					const quarterlyStatus = cronDetail.QuarterlySQPDataPullStatus;
					
					// Check if all reports are finished (status 1 = Success, status 2 = Failed, status 3 = Retry Failed)
					const allFinished = weeklyStatus !== null && weeklyStatus !== 0 && 
										monthlyStatus !== null && monthlyStatus !== 0 && 
										quarterlyStatus !== null && quarterlyStatus !== 0;
					
					if (allFinished) {
						// Determine overall status based on results
						const hasAnySuccess = weeklyStatus === 1 || monthlyStatus === 1 || quarterlyStatus === 1;
						const hasAnyFailure = weeklyStatus === 2 || monthlyStatus === 2 || quarterlyStatus === 2;
						
						let finalStatus;
						if (hasAnySuccess && !hasAnyFailure) {
							// All successful
							finalStatus = 'Completed';
						} else if (hasAnySuccess && hasAnyFailure) {
							// Mixed results - some success, some failure
							finalStatus = 'Completed';
						} else {
							// All failed
							finalStatus = 'Failed';
						}
						
						// Mark ASINs with final status
						await model.ASINsBySellerUpdated(finalAmazonSellerID, cronAsins, finalStatus, null, new Date());
						
						console.log(`🎯 ALL REPORTS FINISHED: Marked ${cronAsins.length} ASINs as ${finalStatus} in seller_ASIN_list`, {
							cronJobID,
							amazonSellerID: finalAmazonSellerID,
							asinCount: cronAsins.length,
							weeklyStatus,
							monthlyStatus,
							quarterlyStatus,
							finalStatus,
							hasAnySuccess,
							hasAnyFailure,
							scenario: hasData ? 'with-data' : 'no-data'
						});
					} else {
						console.log(`Not all reports finished yet - ASINs will be marked when all report types complete`, {
							cronJobID,
							reportType,
							weeklyStatus,
							monthlyStatus,
							quarterlyStatus,
							scenario: hasData ? 'with-data' : 'no-data'
						});
					}
				}
				
				console.log(`Successfully updated seller_ASIN_list date ranges for ${reportType}`, {
					cronJobID,
					amazonSellerID: finalAmazonSellerID,
					reportType,
					hasData
				});
			} catch (error) {
				console.error(`Failed to update seller_ASIN_list for ${reportType}:`, error.message, {
					cronJobID,
					amazonSellerID: finalAmazonSellerID,
					reportType,
					hasData
				});
			}
		} else {
			console.warn(`Cannot update seller_ASIN_list: Missing AmazonSellerID or ASINs for CronJobID ${cronJobID}`);
		}
		
		console.log(`Successfully handled report completion for ${reportType}`, { 
			cronJobID, 
			reportType, 
			hasData,
			amazonSellerID: finalAmazonSellerID,
			asinCount: cronAsins.length
		});
		return true;
		
	} catch (error) {
		console.error(`Failed to handle report completion for ${reportType}:`, error.message, { 
			cronJobID, 
			reportType, 
			hasData 
		});
		throw error;
	}
}

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

        // ProcessRunningStatus = 4 (Process Import) and mark cron detail as import in-progress (4)
        if (download.CronJobID && download.ReportType) {
            await model.setProcessRunningStatus(download.CronJobID, download.ReportType, 4);            
        }

        // Parse and store data in database with retry up to 3 attempts
        const { total, success, failed, maxRange, minRange } = await importJsonWithRetry(download, jsonContent, filePath, reportDateOverride);

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

        // Mark cron detail import success (1) and set end date now
        if (download.CronJobID && download.ReportType) {
            await model.updateSQPReportStatus(download.CronJobID, download.ReportType, 1, download.ReportID, null, null, null, null, new Date());
        }
        // Update latest date range on seller_ASIN_list by ASIN list from sqp_cron_details (ASIN_List)
        try {
            console.log(`Updating seller_ASIN_list date ranges for ${download.ReportType} report`, {
                cronJobID: download.CronJobID,
                amazonSellerID: download.AmazonSellerID,
                minRange,
                maxRange,
                jsonAsinsCount: Array.isArray(jsonContent) ? jsonContent.length : 0
            });
            await updateSellerAsinLatestRanges({
                cronJobID: download.CronJobID,
                amazonSellerID: download.AmazonSellerID,
                reportType: download.ReportType,
                minRange,
                maxRange,
                jsonAsins: Array.isArray(jsonContent) ? jsonContent.map(r => (r.asin || r.ASIN || '')).filter(Boolean) : []
            });
            console.log(`Successfully updated seller_ASIN_list date ranges for ${download.ReportType} report`);
        } catch (error) {
            console.error(`Failed to update seller_ASIN_list date ranges for ${download.ReportType} report:`, error.message);
        }

		console.log(`Successfully processed JSON file for report ${download.ReportID}`);

	} catch (error) {
		console.error(`Error processing JSON file for report ${download.ReportID}:`, error.message);		
		// Mark processing failed
		await downloadUrls.updateProcessStatusById(download.ID, 'FAILED', { lastError: error.message });
        // Mark cron detail import failed (2) or retry failed (3) if attempts already happened
        if (download.CronJobID && download.ReportType) {
            const status = (download.ProcessAttempts && Number(download.ProcessAttempts) > 0) ? 3 : 2;
            await model.updateSQPReportStatus(download.CronJobID, download.ReportType, status, download.ReportID, error.message, null, null, null, new Date());
        }
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
                await model.updateSQPReportStatus(download.CronJobID, download.ReportType, status, download.ReportID, e.message, null, null, null, new Date());
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
			CronJobID: download.CronJobID,
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

// Update LatestRecordDateRange* on seller_ASIN_list for ASINs in ASIN_List (cron) or JSON
async function updateSellerAsinLatestRanges({ cronJobID, amazonSellerID, reportType, minRange, maxRange, jsonAsins = [] }) {
    console.log(`updateSellerAsinLatestRanges called with:`, { cronJobID, amazonSellerID, reportType, minRange, maxRange, jsonAsinsCount: jsonAsins.length });
    
    if (!cronJobID || !reportType || !minRange || !maxRange) {
        console.log(`updateSellerAsinLatestRanges: Missing required parameters`, { cronJobID: !!cronJobID, reportType: !!reportType, minRange: !!minRange, maxRange: !!maxRange });
        return;
    }
    
    const col = reportType === 'WEEK' ? 'LatestRecordDateRangeWeekly' : reportType === 'MONTH' ? 'LatestRecordDateRangeMonthly' : reportType === 'QUARTER' ? 'LatestRecordDateRangeQuarterly' : null;
    if (!col) {
        console.log(`updateSellerAsinLatestRanges: Invalid reportType`, { reportType });
        return;
    }
    
    const rangeStr = `${minRange} - ${maxRange}`;
    console.log(`updateSellerAsinLatestRanges: Range string`, { rangeStr, column: col });

    // Retrieve ASIN_List from sqp_cron_details
    const SqpCronDetails = getSqpCronDetails();
    console.log(`updateSellerAsinLatestRanges: Fetching cron details for ID`, { cronJobID });
    const cronRow = await SqpCronDetails.findOne({ where: { ID: cronJobID }, attributes: ['ASIN_List'] }).catch((error) => {
        console.error(`updateSellerAsinLatestRanges: Error fetching cron details`, { cronJobID, error: error.message });
        return null;
    });
    
    let asinSet = new Set();
    if (cronRow && cronRow.ASIN_List) {
        const cronAsins = cronRow.ASIN_List.split(/\s+/).filter(Boolean).map(a => a.trim());
        cronAsins.forEach(a => asinSet.add(a));
        console.log(`updateSellerAsinLatestRanges: Found ASINs from cron details`, { cronAsinsCount: cronAsins.length, cronAsins: cronAsins.slice(0, 5) });
    } else {
        console.log(`updateSellerAsinLatestRanges: No ASIN_List found in cron details`, { cronJobID, hasCronRow: !!cronRow });
    }
    
    // Merge JSON ASINs
    jsonAsins.forEach(a => asinSet.add(String(a).trim()));
    const asins = Array.from(asinSet).filter(Boolean);
    console.log(`updateSellerAsinLatestRanges: Final ASIN list`, { asinsCount: asins.length, asins: asins.slice(0, 5) });
    
    if (asins.length === 0) {
        console.log(`updateSellerAsinLatestRanges: No ASINs to update`);
        return;
    }

    const { getModel: getSellerAsinList } = require('../models/sequelize/sellerAsinList.model');
    const SellerAsinList = getSellerAsinList();
    console.log(`updateSellerAsinLatestRanges: Updating seller_ASIN_list`, { amazonSellerID, column: col, rangeStr, asinsCount: asins.length });
    
    // First, let's check what records exist for this AmazonSellerID and ASINs
    const existingRecords = await SellerAsinList.findAll({
        where: { AmazonSellerID: amazonSellerID, ASIN: asins },
        attributes: ['ID', 'AmazonSellerID', 'ASIN', col],
        raw: true
    });
    console.log(`updateSellerAsinLatestRanges: Found existing records`, { 
        amazonSellerID, 
        existingRecordsCount: existingRecords.length,
        existingRecords: existingRecords.slice(0, 3)
    });
    
    const result = await SellerAsinList.update(
        { [col]: rangeStr, dtUpdatedOn: new Date() }, 
        { where: { AmazonSellerID: amazonSellerID, ASIN: asins } }
    );
    console.log(`updateSellerAsinLatestRanges: Update completed`, { 
        amazonSellerID, 
        column: col, 
        rangeStr, 
        asinsCount: asins.length,
        updatedRows: result[0],
        existingRecordsCount: existingRecords.length
    });
}
async function __importJson(row, processed = 0, errors = 0){
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
			
			// Use the unified completion handler for no-data scenario
			await handleReportCompletion(row.CronJobID, row.ReportType, row.AmazonSellerID, null, false);
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

		const stats = await importJsonWithRetry({
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
		// Use the unified completion handler for data scenario
		await handleReportCompletion(row.CronJobID, row.ReportType, row.AmazonSellerID, json, true);
		processed++;
	} catch (e) {
		console.error('Error processing saved file:', e.message);
		await downloadUrls.updateProcessStatusById(row.ID, 'FAILED', { lastError: e.message });
		// Mark cron detail import failed (2) or retry failed (3) if attempts already happened
		if (row.CronJobID && row.ReportType) {
			const status = (row.ProcessAttempts && Number(row.ProcessAttempts) > 0) ? 3 : 2;
			await model.updateSQPReportStatus(row.CronJobID, row.ReportType, status, row.ReportID, e.message, null, null, null, new Date());
		}
		errors++;
    }
    return { processed, errors };
}
async function processSavedJsonFiles(filter = {}) {
	const rows = await downloadUrls.getCompletedDownloadsWithFiles(filter);
	if (!rows || rows.length === 0) {
		console.log('No saved JSON files to process');
		return { processed: 0, errors: 0 };
	}

	let processed = 0;
	let errors = 0;

    for (const row of rows) {
        ({ processed, errors } = await __importJson(row, processed, errors));
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
    importJsonWithRetry,
    getReportDateForPeriod,
    handleReportCompletion,
    getDownloadUrlStats
};
