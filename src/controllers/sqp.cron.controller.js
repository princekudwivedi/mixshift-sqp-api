const logger = require('../utils/logger.utils');
const dates = require('../utils/dates.utils');
const model = require('../models/sqp.cron.model');
const sellerModel = require('../models/sequelize/seller.model');
const AuthToken = require('../models/authToken.model');
const StsToken = require('../models/stsToken.model');
const sp = require('../spapi/client.spapi');
const jsonSvc = require('../services/sqp.json.processing.service');
const downloadUrls = require('../models/sqp.download.urls.model');
const { sellerDefaults } = require('../config/env.config');
const { NotificationHelpers } = require('../helpers/sqp.helpers');
const { RetryHelpers } = require('../helpers/sqp.helpers');

const MAX_RETRIES = 3;

/**
 * Send failure notification when max retries are reached
 */
async function sendFailureNotification(cronDetailID, amazonSellerID, reportType, errorMessage, retryCount, reportId = null) {
	try {
		logger.error({
			cronDetailID,
			amazonSellerID,
			reportType,
			errorMessage,
			retryCount
		}, 'SENDING FAILURE NOTIFICATION - Max retries reached');
		
		// Log the notification
        await model.logCronActivity({
			cronJobID: cronDetailID,
			amazonSellerID: amazonSellerID,
			reportType: reportType,
			action: 'Failure Notification',
			status: 2,
			message: `NOTIFICATION: Report failed after ${retryCount} attempts. Error: ${errorMessage}`,
            reportID: reportId,
			retryCount: retryCount,
			executionTime: 0
		});
        
        // Send actual email notification if SMTP and recipients are configured
        const to = NotificationHelpers.parseList(process.env.NOTIFY_TO || require('../config/env.config').env.NOTIFY_TO);
        const cc = NotificationHelpers.parseList(process.env.NOTIFY_CC || require('../config/env.config').env.NOTIFY_CC);
        const bcc = NotificationHelpers.parseList(process.env.NOTIFY_BCC || require('../config/env.config').env.NOTIFY_BCC);
        if ((to.length + cc.length + bcc.length) > 0) {
            const subject = `SQP Cron Failed after ${retryCount} attempts [${reportType}]`;
            const html = `
                <h3>SQP Cron Failure</h3>
                <p><strong>Cron Detail ID:</strong> ${cronDetailID}</p>
                <p><strong>Seller:</strong> ${amazonSellerID}</p>
                <p><strong>Report Type:</strong> ${reportType}</p>
                <p><strong>Report ID:</strong> ${reportId || ''}</p>
                <p><strong>Retry Count:</strong> ${retryCount}</p>
                <p><strong>Last Error:</strong> ${errorMessage}</p>
                <p>Time: ${new Date().toISOString()}</p>
            `;
            await NotificationHelpers.sendEmail({ subject, html, to, cc, bcc });
        } else {
            logger.warn('Notification recipients not configured (NOTIFY_TO/CC/BCC)');
        }
		
	} catch (notificationError) {
		logger.error({ 
			notificationError: notificationError.message,
			cronDetailID,
			amazonSellerID,
			reportType
		}, 'Failed to send failure notification');
	}
}


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

async function requestForSeller(seller, authOverrides = {}, spReportType = config.GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT) {
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
				await requestSingleReport(chunk, seller, cronDetailID, type, authOverrides, spReportType);
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

async function requestSingleReport(chunk, seller, cronDetailID, reportType, authOverrides = {}, spReportType = config.GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT) {
	logger.info({ 
		cronDetailID, 
		reportType, 
		sellerId: seller.AmazonSellerID,
		hasAuthOverrides: !!authOverrides.accessToken 
	}, 'Starting requestSingleReport with retry logic');
	
	// Use the universal retry function
	const result = await RetryHelpers.executeWithRetry({
		cronDetailID,
		amazonSellerID: seller.AmazonSellerID,
		reportType,
		action: 'Request Report',
		context: { chunk, seller, authOverrides },
		model,
		sendFailureNotification,
		operation: async ({ attempt, currentRetry, context, startTime }) => {
			const { chunk, seller, authOverrides } = context;
			
			// Set start date when beginning the report request
			const startDate = new Date();
			logger.info({ cronDetailID, reportType, startDate, attempt }, 'Setting start date for report request');
			await model.updateSQPReportStatus(cronDetailID, reportType, 0, null, null, null, null, startDate);

			const period = reportType;
			const range = dates.getDateRangeForPeriod(period);
			logger.info({ period, range, attempt }, 'Date range calculated');
			
			// Resolve marketplace id (required by SP-API). If unavailable, skip this request gracefully.
			const marketplaceId = seller.AmazonMarketplaceId || null;
			if (!marketplaceId) {
				logger.warn({ sellerId: seller.AmazonSellerID, attempt }, 'Missing AmazonMarketplaceId; skipping report request');
				throw new Error('Missing AmazonMarketplaceId; skipping report request');
			}

            // Build asin string within 200 chars (space-separated)
            let asinString = '';
            if (Array.isArray(chunk.asins) && chunk.asins.length > 0) {
                const limit = 200;
                const normalized = chunk.asins.map(a => String(a).trim()).filter(Boolean);
                const parts = [];
                let currentLen = 0;
                for (const a of normalized) {
                    const addLen = (parts.length === 0 ? a.length : a.length + 1);
                    if (currentLen + addLen > limit) break;
                    parts.push(a);
                    currentLen += addLen;
                }
                asinString = parts.join(' ');
            } else if (chunk.asin_string) {
                asinString = String(chunk.asin_string).replace(/\s+/g, ' ').trim().slice(0, 200);
            }

            if (!asinString) {
                throw new Error('No ASINs available for report request');
            }

            const payload = {
                reportType: spReportType,
				dataStartTime: `${range.start}T00:00:00Z`,
				dataEndTime: `${range.end}T23:59:59Z`,
				marketplaceIds: [ marketplaceId ],
                reportOptions: { asin: asinString, reportPeriod: reportType },
			};
			
			logger.info({ payload, attempt }, 'Payload created, calling SP-API');

			// Ensure access token is present for this seller
			let currentAuthOverrides = { ...authOverrides };
			if (!currentAuthOverrides.accessToken) {
				const tokenRow = await AuthToken.getSavedToken(seller.AmazonSellerID);
				if (tokenRow && tokenRow.access_token) {
					currentAuthOverrides = { ...currentAuthOverrides, accessToken: tokenRow.access_token };
					logger.info({ amazonSellerID: seller.AmazonSellerID, attempt }, 'Access token loaded for request');
				} else {
					logger.warn({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for request');
				}
			}

            let resp;
            try {
                resp = await sp.createReport(seller, payload, currentAuthOverrides);
            } catch (err) {
                logger.error({
                    status: err.status || err.statusCode,
                    body: err.response && (err.response.body || err.response.text),
                    message: err.message,
                    payload
                }, 'SP-API createReport failed');
                throw err;
            }
			const reportId = resp.reportId;
			
			logger.info({ reportId, attempt }, 'Report created successfully');
			
			// Update with reportId but preserve the start date
			await model.updateSQPReportStatus(cronDetailID, reportType, 0, reportId, null, null, null, startDate);
			
			return {
				message: `Report requested successfully on attempt ${attempt}. Report ID: ${reportId}`,
				reportID: reportId,
				data: { reportId, startDate }
			};
		}
	});
	
	if (result.success) {
		logger.info({ cronDetailID, reportType, attempt: result.attempt }, 'Report request completed successfully');
	} else if (result.skipped) {
		logger.info({ cronDetailID, reportType, reason: result.reason }, 'Report request skipped');
	} else {
		logger.error({ cronDetailID, reportType, error: result.error }, 'Report request failed');
	}
	
	return result;
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

	// Use the universal retry function
	const result = await RetryHelpers.executeWithRetry({
		cronDetailID: row.ID,
		amazonSellerID: row.AmazonSellerID,
		reportType,
		action: 'Check Status',
		context: { row, reportId, seller, authOverrides },
		model,
		sendFailureNotification,
		operation: async ({ attempt, currentRetry, context, startTime }) => {
			const { row, reportId, seller, authOverrides } = context;
			
			// Ensure access token for this seller during status checks
			let currentAuthOverrides = { ...authOverrides };
			if (!currentAuthOverrides.accessToken) {
				const tokenRow = await AuthToken.getSavedToken(seller.AmazonSellerID);
				if (tokenRow && tokenRow.access_token) {
					currentAuthOverrides = { ...currentAuthOverrides, accessToken: tokenRow.access_token };
					logger.info({ amazonSellerID: seller.AmazonSellerID, attempt }, 'Access token loaded for status check');
				} else {
					logger.warn({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for status check');
				}
			}
			
			const res = await sp.getReportStatus(seller, reportId, currentAuthOverrides);
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
				
				return {
					message: `Report ready on attempt ${attempt}. Report ID: ${reportId}${documentId ? ' | Document ID: ' + documentId : ''}`,
					reportID: reportId,
					reportDocumentID: documentId,
					data: { status, documentId }
				};
				
			} else if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') {
				// Report is still processing, no need to retry immediately
				logger.info({ cronDetailID: row.ID, reportType, status, attempt }, 'Report still processing, no retry needed');
				
				// Log the status but don't throw error (this is not a failure)
				await model.logCronActivity({ 
					cronJobID: row.ID, 
					amazonSellerID: row.AmazonSellerID, 
					reportType, 
					action: 'Check Status', 
					status: 0, 
					message: `Report ${status.toLowerCase().replace('_',' ')} on attempt ${attempt}`, 
					reportID: reportId, 
					retryCount: currentRetry,
					executionTime: (Date.now() - startTime) / 1000 
				});
				
				// Return success but with special flag to indicate no retry needed
				return {
					message: `Report ${status.toLowerCase().replace('_',' ')} on attempt ${attempt}`,
					reportID: reportId,
					data: { status },
					noRetryNeeded: true
				};
				
			} else if (status === 'FATAL' || status === 'CANCELLED') {
				// These are permanent failures, don't retry
				await model.incrementRetryCount(row.ID, reportType);
				await model.updateSQPReportStatus(row.ID, reportType, 2, null, status, null, null, null, new Date());
				const retry = await model.getRetryCount(row.ID, reportType);
				
				// Log the permanent failure
				await model.logCronActivity({ 
					cronJobID: row.ID, 
					amazonSellerID: row.AmazonSellerID, 
					reportType, 
					action: 'Check Status', 
					status: 2, 
					message: `Report ${status} on attempt ${attempt}`, 
					reportID: reportId, 
					retryCount: retry, 
					executionTime: (Date.now() - startTime) / 1000 
				});
				
				// Send notification for permanent failure
				await sendFailureNotification(row.ID, row.AmazonSellerID, reportType, `Report ${status}`, retry, reportId);
				
				// Throw error to trigger retry mechanism, but this will be caught and handled
				throw new Error(`Report ${status} - permanent failure`);
				
			} else {
				// Unknown status - treat as error and retry
				throw new Error(`Unknown report status: ${status}`);
			}
		}
	});
	
	if (result.success) {
		if (result.data?.noRetryNeeded) {
			logger.info({ cronDetailID: row.ID, reportType, status: result.data.status }, 'Status check completed - report still processing');
		} else {
			logger.info({ cronDetailID: row.ID, reportType, attempt: result.attempt }, 'Status check completed successfully');
		}
	} else if (result.skipped) {
		logger.info({ cronDetailID: row.ID, reportType, reason: result.reason }, 'Status check skipped');
	} else {
		logger.error({ cronDetailID: row.ID, reportType, error: result.error }, 'Status check failed');
	}
	
	return result;
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

	// Use the universal retry function
	const result = await RetryHelpers.executeWithRetry({
		cronDetailID: row.ID,
		amazonSellerID: row.AmazonSellerID,
		reportType,
		action: 'Download Report',
		context: { row, reportId, seller, authOverrides },
		model,
		sendFailureNotification,
		operation: async ({ attempt, currentRetry, context, startTime }) => {
			const { row, reportId, seller, authOverrides } = context;
			
			logger.info({ reportId, reportType, attempt }, 'Starting download for report');
			
			// Update download status to DOWNLOADING and increment attempts
			await downloadUrls.updateDownloadUrlStatusByCriteria(
				row.ID, 
				reportId, 
				row.AmazonSellerID, 
				reportType, 
				'DOWNLOADING',
				null,
				null,
				null,
				true // Increment attempts
			);
			
			// Ensure access token for download as well
			let currentAuthOverrides = { ...authOverrides };
			if (!currentAuthOverrides.accessToken) {
				const tokenRow = await AuthToken.getSavedToken(row.AmazonSellerID);
				if (tokenRow && tokenRow.access_token) {
					currentAuthOverrides = { ...currentAuthOverrides, accessToken: tokenRow.access_token };
					logger.info({ amazonSellerID: row.AmazonSellerID, attempt }, 'Access token loaded for download');
				} else {
					logger.warn({ amazonSellerID: row.AmazonSellerID, attempt }, 'No access token available for download');
				}
			}
			
			// First get report status to ensure we have the latest reportDocumentId
			const statusRes = await sp.getReportStatus(seller, reportId, currentAuthOverrides);
			
			logger.info({ status: statusRes.processingStatus, reportDocumentId: statusRes.reportDocumentId, attempt }, 'Report status check');
			
			if (statusRes.processingStatus !== 'DONE') {
				throw new Error(`Report not ready, status: ${statusRes.processingStatus}`);
			}
			
			// Use the reportDocumentId from status response
			const documentId = statusRes.reportDocumentId || reportId;
			logger.info({ documentId, attempt }, 'Using document ID for download');
			
			// Download the report document
			const res = await sp.downloadReport(seller, documentId, currentAuthOverrides);
			
			// Get JSON data directly (no Excel needed)
			let data = [];
			if (Array.isArray(res?.data)) {
				data = res.data;
			} else if (Array.isArray(res?.data?.records)) {
				data = res.data.records;
			} else if (Array.isArray(res?.data?.dataByAsin)) {
				data = res.data.dataByAsin;  // <-- handle SQP reports
			}	
			logger.info({ rows: data.length, reportType, attempt }, 'Report data received');
			
			if (data.length > 0) {
				// Save JSON file to disk and record only path into sqp_download_urls
				const downloadMeta = { AmazonSellerID: row.AmazonSellerID, ReportType: reportType, ReportID: documentId };
				let filePath = null; let fileSize = 0;
				try {
					const saveResult = await jsonSvc.saveReportJsonFile(downloadMeta, data);
					filePath = saveResult?.path || saveResult?.url || null;
					if (filePath) {
						const fs = require('fs');
						const stat = await fs.promises.stat(filePath).catch(() => null);
						fileSize = stat ? stat.size : 0;
						logger.info({ filePath, fileSize, attempt }, 'Report JSON saved to disk');
					}
				} catch (fileErr) {
					logger.warn({ error: fileErr.message, attempt }, 'Failed to save JSON file');
				}

				// Update the existing record in sqp_download_urls with file metadata and set status to COMPLETED
				await downloadUrls.updateDownloadUrlStatusByCriteria(
					row.ID, 
					reportId, 
					row.AmazonSellerID, 
					reportType, 
					'COMPLETED',
					null,
					filePath,
					fileSize,
					false // Don't increment attempts
				);

				// Mark download as completed - preserve existing ReportID and ReportDocumentID and set end date
				await model.updateSQPReportStatus(row.ID, reportType, 1, reportId, null, documentId, true, null, new Date());
				
				return {
					message: `Report downloaded successfully on attempt ${attempt} and file saved for later processing`,
					reportID: reportId,
					reportDocumentID: documentId,
					logData: {
						downloadCompleted: true,
						filePath: filePath,
						fileSize: fileSize,
						recordsProcessed: Array.isArray(data) ? data.length : 0
					},
					data: { documentId, filePath, fileSize, recordCount: data.length }
				};
				
			} else {
				// No data received - log this and update status
				logger.warn({ reportId: documentId, reportType, attempt }, 'No data received from report download');
				
				// Update download status to COMPLETED even with no data
				await downloadUrls.updateDownloadUrlStatusByCriteria(
					row.ID, 
					reportId, 
					row.AmazonSellerID, 
					reportType, 
					'COMPLETED',
					'No data in report',
					null,
					null,
					false // Don't increment attempts
				);
				
				// Mark download as completed even with no data - preserve existing ReportID and ReportDocumentID and set end date
				await model.updateSQPReportStatus(row.ID, reportType, 1, reportId, 'No data in report', documentId, true, null, new Date());
				
				return {
					message: `Report downloaded on attempt ${attempt} but contains no data`,
					reportID: reportId,
					reportDocumentID: documentId,
					logData: {
						downloadCompleted: true,
						recordsProcessed: 0
					},
					data: { documentId, recordCount: 0 }
				};
			}
		}
	});
	
	if (result.success) {
		logger.info({ cronDetailID: row.ID, reportType, attempt: result.attempt }, 'Download completed successfully');
	} else if (result.skipped) {
		logger.info({ cronDetailID: row.ID, reportType, reason: result.reason }, 'Download skipped');
	} else {
		logger.error({ cronDetailID: row.ID, reportType, error: result.error }, 'Download failed');
	}
	
	return result;
}

module.exports = {
	requestForSeller,
	checkReportStatuses,
	downloadCompletedReports,
};


