const logger = require('../utils/logger.utils');
const dates = require('../utils/dates.utils');
const model = require('../models/sqpCronModel');
const sellerModel = require('../models/seller.model');
const masterModel = require('../models/master.model');
const sp = require('../spapi/client.spapi');
const jsonSvc = require('../services/sqpJsonProcessingService');
const downloadUrls = require('../models/sqp.download.urls.model');
const { sellerDefaults } = require('../config/env.config');

const MAX_RETRIES = 3;

function shouldRequestReport(row, reportType) {
	const prefix = model.mapPrefix(reportType);
	const status = row[`${prefix}SQPDataPullStatus`];
	const retry = row[`RetryCount_${prefix}`] || 0;
	return (status === 0 || status === 2) && retry < MAX_RETRIES;
}

function sellerProfileFromEnv() {
	return {
		AmazonSellerID: sellerDefaults.amazonSellerId,
		idSellerAccount: sellerDefaults.idSellerAccount,
		AmazonMarketplaceId: sellerDefaults.marketplaceId,
		MerchantRegion: sellerDefaults.merchantRegion,
		AccessToken: process.env.LWA_ACCESS_TOKEN || '',
	};
}

async function requestForSeller(seller, authOverrides = {}) {
	logger.info({ seller: seller.idSellerAccount }, 'Requesting SQP reports for seller');
	
	try {
		const asins = await model.getActiveASINsBySeller(seller.idSellerAccount);
		if (!asins.length) {
			logger.warn('No active ASINs for seller');
			return;
		}
		
		logger.info({ asinCount: asins.length }, 'Found ASINs for seller');
		const chunks = model.splitASINsIntoChunks(asins, 200);
		logger.info({ chunkCount: chunks.length }, 'Split ASINs into chunks');
		
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			logger.info({ chunkIndex: i, asinCount: chunk.asins.length }, 'Processing chunk');
			
			const cronDetailID = await model.createSQPCronDetail(seller.AmazonSellerID, chunk.asin_string);
			logger.info({ cronDetailID }, 'Created cron detail');
			
			for (const type of ['WEEK', 'MONTH', 'QUARTER']) {
				logger.info({ type }, 'Requesting report for type');
				await requestSingleReport(chunk, seller, cronDetailID, type, authOverrides);
			}
		}
	} catch (error) {
		logger.error({ 
			error: error.message, 
			stack: error.stack,
			seller: seller.idSellerAccount 
		}, 'Error in requestForSeller');
		throw error;
	}
}

async function requestSingleReport(chunk, seller, cronDetailID, reportType, authOverrides = {}) {
	logger.info({ 
		cronDetailID, 
		reportType, 
		sellerId: seller.AmazonSellerID,
		hasAuthOverrides: !!authOverrides.accessToken 
	}, 'Starting requestSingleReport');
	
	// Fetch minimal row for decision; here we simulate decision by retry count
	const retryCount = await model.getRetryCount(cronDetailID, reportType);
	if (retryCount >= MAX_RETRIES) {
		logger.info({ cronDetailID, reportType }, 'Max retries reached, skipping');
		return;
	}
	
	try {
		
		logger.info({ cronDetailID, reportType }, 'Updating report status to 0');
		await model.updateSQPReportStatus(cronDetailID, reportType, 0);
		
		logger.info({ cronDetailID, reportType }, 'Logging cron activity start');
		await model.logCronActivity({
			cronJobID: cronDetailID,
			amazonSellerID: seller.AmazonSellerID,
			reportType,
			action: 'Request Report',
			status: 0,
			message: `Starting report request for ${chunk.asins.length} ASINs`,
		});

		const period = reportType;
		const range = dates.getDateRangeForPeriod(period);
		logger.info({ period, range }, 'Date range calculated');
		
		const payload = {
			reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
			dataStartTime: `${range.start}T00:00:00Z`,
			dataEndTime: `${range.end}T23:59:59Z`,
			marketplaceIds: [ seller.AmazonMarketplaceId ],
			reportOptions: { asin: chunk.asin_string, reportPeriod: reportType },
		};
		
		logger.info({ payload }, 'Payload created, calling SP-API');

		// Ensure access token is present for this seller
		if (!authOverrides.accessToken) {
			const tokenRow = await masterModel.getSavedToken(seller.AmazonSellerID);
			if (tokenRow && tokenRow.access_token) {
				authOverrides = { ...authOverrides, accessToken: tokenRow.access_token };
				logger.info({ amazonSellerID: seller.AmazonSellerID }, 'Access token loaded for request');
			} else {
				logger.warn({ amazonSellerID: seller.AmazonSellerID }, 'No access token available for request');
			}
		}

		const resp = await sp.createReport(seller, payload, authOverrides);
		const reportId = resp.reportId;
		
		logger.info({ reportId }, 'Report created successfully');
		
		await model.updateSQPReportStatus(cronDetailID, reportType, 0, reportId);
		await model.logCronActivity({
			cronJobID: cronDetailID,
			amazonSellerID: seller.AmazonSellerID,
			reportType,
			action: 'Request Report',
			status: 1,
			message: `Report requested successfully. Report ID: ${reportId}`,
			reportID: reportId,
		});
	} catch (e) {
		logger.error({ 
			error: e.message, 
			stack: e.stack,
			cronDetailID, 
			reportType 
		}, 'Error in requestSingleReport');
		
		await model.incrementRetryCount(cronDetailID, reportType);
		await model.updateSQPReportStatus(cronDetailID, reportType, 2, null, e.message);
		await model.logCronActivity({
			cronJobID: cronDetailID,
			amazonSellerID: seller.AmazonSellerID,
			reportType,
			action: 'Request Report',
			status: 2,
			message: `Report request failed: ${e.message}`,
			retryCount: retryCount + 1,
		});
	}
}

async function checkReportStatuses(authOverrides = {}) {
	logger.info('Starting checkReportStatuses');
	const rows = await model.getReportsForStatusCheck();
	logger.info({ reportCount: rows.length }, 'Found reports for status check');
	
	if (rows.length === 0) {
		logger.info('No reports found for status check');
		return;
	}
	
	for (const row of rows) {
		logger.info({ rowId: row.ID }, 'Processing report row');
		for (const [type, field] of [['WEEK', 'ReportID_Weekly'], ['MONTH', 'ReportID_Monthly'], ['QUARTER', 'ReportID_Quarterly']]) {
			if (row[field] && row[`${model.mapPrefix(type)}SQPDataPullStatus`] === 0) {
				logger.info({ type, reportId: row[field] }, 'Checking status for report');
				await checkReportStatusByType(row, type, field, authOverrides);
			}
		}
	}
}

async function checkReportStatusByType(row, reportType, field, authOverrides = {}) {
	const reportId = row[field];
	// Get seller profile from database using AmazonSellerID from the row
	const seller = await sellerModel.getProfileDetailsByAmazonSellerID(row.AmazonSellerID);
	if (!seller) {
		logger.error({ amazonSellerID: row.AmazonSellerID }, 'Seller profile not found');
		return;
	}

	// Ensure access token for this seller during status checks
	if (!authOverrides.accessToken) {
		const tokenRow = await masterModel.getSavedToken(seller.AmazonSellerID);
		if (tokenRow && tokenRow.access_token) {
			authOverrides = { ...authOverrides, accessToken: tokenRow.access_token };
			logger.info({ amazonSellerID: seller.AmazonSellerID }, 'Access token loaded for status');
		} else {
			logger.warn({ amazonSellerID: seller.AmazonSellerID }, 'No access token available for status');
		}
	}
	
	try {
		const res = await sp.getReportStatus(seller, reportId, authOverrides);
		const status = res.processingStatus;
		if (status === 'DONE') {
			// Keep ReportID_* as the original reportId; store documentId separately
			const documentId = res.reportDocumentId || null;
			await model.updateSQPReportStatus(row.ID, reportType, 1, reportId, null, documentId, false);
			// Enqueue for download processing (store in sqp_download_urls as PENDING)
			await downloadUrls.storeDownloadUrl({
				CronJobID: row.ID,
				ReportID: reportId,
				AmazonSellerID: row.AmazonSellerID,
				ReportType: reportType,
				DownloadURL: '',
				ReportDocumentID: documentId,
				CompressionAlgorithm: null,
				Status: 'PENDING',
				DownloadAttempts: 0,
				MaxDownloadAttempts: 3,
			});
			await model.logCronActivity({ cronJobID: row.ID, amazonSellerID: row.AmazonSellerID, reportType, action: 'Check Status', status: 1, message: `Report ready. Report ID: ${reportId}${documentId ? ' | Document ID: ' + documentId : ''}`, reportID: reportId, reportDocumentID: documentId });
		} else if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') {
			await model.logCronActivity({ cronJobID: row.ID, amazonSellerID: row.AmazonSellerID, reportType, action: 'Check Status', status: 0, message: `Report ${status.toLowerCase().replace('_',' ')}`, reportID: reportId });
		} else if (status === 'FATAL' || status === 'CANCELLED') {
			await model.incrementRetryCount(row.ID, reportType);
			await model.updateSQPReportStatus(row.ID, reportType, 2, null, status);
			await model.logCronActivity({ cronJobID: row.ID, amazonSellerID: row.AmazonSellerID, reportType, action: 'Check Status', status: 2, message: `Report ${status}`, reportID: reportId });
		} else {
			await model.logCronActivity({ cronJobID: row.ID, amazonSellerID: row.AmazonSellerID, reportType, action: 'Check Status', status: 2, message: `Unknown status: ${status}`, reportID: reportId });
		}
	} catch (e) {
		await model.logCronActivity({ cronJobID: row.ID, amazonSellerID: row.AmazonSellerID, reportType, action: 'Check Status', status: 2, message: `Error: ${e.message}`, reportID: reportId });
	}
}

async function downloadCompletedReports(authOverrides = {}) {
	const rows = await model.getReportsForDownload();
	for (const row of rows) {
		for (const [type, field] of [['WEEK', 'ReportID_Weekly'], ['MONTH', 'ReportID_Monthly'], ['QUARTER', 'ReportID_Quarterly']]) {
			if (row[field] && row[`${model.mapPrefix(type)}SQPDataPullStatus`] === 1) {
				await downloadReportByType(row, type, field, authOverrides);
			}
		}
	}
}

async function downloadReportByType(row, reportType, field, authOverrides = {}) {
	const reportId = row[field];
	// Load seller profile by AmazonSellerID (avoid env defaults)
	const seller = await sellerModel.getProfileDetailsByAmazonSellerID(row.AmazonSellerID);
	if (!seller) {
		logger.error({ amazonSellerID: row.AmazonSellerID }, 'Seller profile not found for download');
		return;
	}

	// Ensure access token for download as well
	if (!authOverrides.accessToken) {
		const tokenRow = await masterModel.getSavedToken(row.AmazonSellerID);
		if (tokenRow && tokenRow.access_token) {
			authOverrides = { ...authOverrides, accessToken: tokenRow.access_token };
			logger.info({ amazonSellerID: row.AmazonSellerID }, 'Access token loaded for download');
		} else {
			logger.warn({ amazonSellerID: row.AmazonSellerID }, 'No access token available for download');
		}
	}
	try {
		logger.info({ reportId, reportType }, 'Starting download for report');
		
		// First get report status to ensure we have the latest reportDocumentId
		const statusRes = await sp.getReportStatus(seller, reportId, authOverrides);
		
		logger.info({ status: statusRes.processingStatus, reportDocumentId: statusRes.reportDocumentId }, 'Report status check');
		
		if (statusRes.processingStatus !== 'DONE') {
			throw new Error(`Report not ready, status: ${statusRes.processingStatus}`);
		}
		
		// Use the reportDocumentId from status response
		const documentId = statusRes.reportDocumentId || reportId;
		logger.info({ documentId }, 'Using document ID for download');
		// Download the report document
		const res = await sp.downloadReport(seller, documentId, authOverrides);
		// Get JSON data directly (no Excel needed)
		//const data = Array.isArray(res?.data) ? res.data : [];
		let data = [];

		if (Array.isArray(res?.data)) {
				data = res.data;
			} else if (Array.isArray(res?.data?.records)) {
				data = res.data.records;
			} else if (Array.isArray(res?.data?.dataByAsin)) {
				data = res.data.dataByAsin;  // <-- handle SQP reports
		}	
		logger.info({ rows: data.length, reportType }, 'Report data received');
		
		if (data.length > 0) {
			// Save JSON file to disk and record only path into sqp_download_urls
			const downloadMeta = { AmazonSellerID: row.AmazonSellerID, ReportType: reportType, ReportID: documentId };
			let filePath = null; let fileSize = 0;
			try {
				filePath = await jsonSvc.saveReportJsonFile(downloadMeta, data);
				const fs = require('fs');
				const stat = await fs.promises.stat(filePath).catch(() => null);
				fileSize = stat ? stat.size : 0;
				logger.info({ filePath, fileSize }, 'Report JSON saved to disk');
			} catch (fileErr) {
				logger.warn({ error: fileErr.message }, 'Failed to save JSON file');
			}

			// Upsert into sqp_download_urls for later JSON processing
			await downloadUrls.storeDownloadUrl({
				CronJobID: row.ID,
				ReportID: reportId,
				AmazonSellerID: row.AmazonSellerID,
				ReportType: reportType,
				DownloadURL: '',
				ReportDocumentID: documentId,
				CompressionAlgorithm: null,
				Status: 'COMPLETED',
				// FilePath and FileSize are tracked on sqp_download_urls, not in sqp_cron_logs
			});

			// Mark download as completed
			await model.updateSQPReportStatus(row.ID, reportType, 1, null, null, null, true);
			
			await model.logCronActivity({ 
				cronJobID: row.ID, 
				amazonSellerID: row.AmazonSellerID, 
				reportType, 
				action: 'Download Report', 
				status: 1, 
				message: `Report downloaded and file saved for later processing`, 
				reportID: reportId,
				reportDocumentID: documentId,
				downloadCompleted: true,
				fileSize: fileSize,
				filePath: filePath
			});
		} else {
			// No data received - log this and update status
			logger.warn({ reportId: documentId, reportType }, 'No data received from report download');
			
			// Mark download as completed even with no data
			await model.updateSQPReportStatus(row.ID, reportType, 1, null, 'No data in report', null, true);
			await model.logCronActivity({ 
				cronJobID: row.ID, 
				amazonSellerID: row.AmazonSellerID, 
				reportType, 
				action: 'Download Report', 
				status: 1, 
				message: 'Report downloaded but contains no data', 
				reportID: reportId,
				reportDocumentID: documentId,
				downloadCompleted: true,
				recordsProcessed: 0
			});
		}
	} catch (e) {
		logger.error({ error: e.message, reportId, reportType }, 'Download failed');
		await model.logCronActivity({ cronJobID: row.ID, amazonSellerID: row.AmazonSellerID, reportType, action: 'Download Report', status: 2, message: `Report download failed: ${e.message}`, reportID: reportId });
	}
}

async function storeSQPMetrics3Mo(row, reportType, data) {
	try {
		logger.info({ amazonSellerID: row.AmazonSellerID, reportType, recordCount: data.length }, 'Storing data in sqp_metrics_3mo');
		
		// Process each record and store in sqp_metrics_3mo table
		for (const record of data) {
			// Map SQP report fields to sqp_metrics_3mo table structure
			const metricsData = {
				amazon_seller_id: row.AmazonSellerID,
				report_type: reportType,
				asin: record.asin || record.ASIN,
				query: record.query || record.searchTerm,
				impressions: record.impressions || 0,
				clicks: record.clicks || 0,
				click_through_rate: record.clickThroughRate || 0,
				cart_adds: record.cartAdds || 0,
				cart_add_rate: record.cartAddRate || 0,
				purchases: record.purchases || 0,
				purchase_rate: record.purchaseRate || 0,
				revenue: record.revenue || 0,
				report_date: new Date(),
				created_at: new Date()
			};
			
			// Insert into sqp_metrics_3mo table
			await model.insertSQPMetrics3Mo(metricsData);
		}
		
		logger.info({ amazonSellerID: row.AmazonSellerID, reportType, stored: data.length }, 'Successfully stored in sqp_metrics_3mo');
	} catch (error) {
		logger.error({ error: error.message, amazonSellerID: row.AmazonSellerID, reportType }, 'Failed to store in sqp_metrics_3mo');
		throw error;
	}
}

// Removed legacy processAndStoreReportData; using sqp_metrics_3mo only

module.exports = {
	requestForSeller,
	checkReportStatuses,
	downloadCompletedReports,
};


