const logger = require('../utils/logger.utils');
const dates = require('../utils/dates.utils');
const model = require('../models/sqp.cron.model');
const sellerModel = require('../models/sequelize/seller.model');
const AuthToken = require('../models/authToken.model');
const StsToken = require('../models/stsToken.model');
const sp = require('../spapi/client.spapi');
const jsonSvc = require('../services/sqp.json.processing.service');
const downloadUrls = require('../models/sqp.download.urls.model');
const { getModel: getSqpCronDetails } = require('../models/sequelize/sqpCronDetails.model');
const { sellerDefaults } = require('../config/env.config');
const { NotificationHelpers } = require('../helpers/sqp.helpers');
const { RetryHelpers } = require('../helpers/sqp.helpers');
const env = require('../config/env.config');
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
    return (status === 0 || status === 2);
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
			logger.warn({ sellerId: seller.idSellerAccount }, 'No eligible ASINs for seller (pending or ${env.MAX_DAYS_AGO}+ day old completed)');
			return [];
		}
		// Mark ASINs as Pending and set start time
		const startTime = new Date();
		await model.ASINsBySellerUpdated(seller.AmazonSellerID, asins, 'Pending', startTime);		
		logger.info({ 
			sellerId: seller.idSellerAccount,
			amazonSellerID: seller.AmazonSellerID,
			asinCount: asins.length, 
			asins: asins.slice(0, 5),
			startTime: startTime.toISOString()
		}, 'Found ASINs for seller and marked as Pending');
		
		const chunks = model.splitASINsIntoChunks(asins, 200);
		logger.info({ chunkCount: chunks.length }, 'Split ASINs into chunks');
		let cronDetailIDs = [];
		
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			logger.info({ chunkIndex: i, asinCount: chunk.asins.length }, 'Processing chunk');
			
			const cronDetailID = await model.createSQPCronDetail(seller.AmazonSellerID, chunk.asin_string);
			logger.info({ cronDetailID }, 'Created cron detail');
			cronDetailIDs.push(cronDetailID);

			for (const type of ['WEEK', 'MONTH', 'QUARTER']) {
				logger.info({ type }, 'Requesting report for type');
                // ProcessRunningStatus = 1 (Request Report)
                await model.setProcessRunningStatus(cronDetailID, type, 1);
                await model.logCronActivity({ cronJobID: cronDetailID, reportType: type, action: 'Request Report', status: 1, message: 'Requesting report' });
                await requestSingleReport(chunk, seller, cronDetailID, type, authOverrides, spReportType);
			}

			// Mark ASINs as InProgress
			await model.ASINsBySellerUpdated(seller.AmazonSellerID, chunk.asins, 'InProgress');
			logger.info({ 
				sellerId: seller.idSellerAccount,
				amazonSellerID: seller.AmazonSellerID,
				chunkIndex: i,
				asinCount: chunk.asins.length,
				asins: chunk.asins.slice(0, 5),
				cronDetailID
			}, 'Marked ASINs as InProgress after request');
		}
		return cronDetailIDs;
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
			// Log report creation so status checker can fetch ReportID from logs
			await model.logCronActivity({
				cronJobID: cronDetailID,
				reportType,
				action: 'Request Report',
				status: 1,
				message: 'Report requested',
				reportID: reportId,
				retryCount: 0,
				executionTime: 0
			});
			
			logger.info({ initialDelaySeconds: process.env.INITIAL_DELAY_SECONDS }, 'Initial delay seconds');
			// Add initial delay after report creation to give Amazon time to start processing
			const initialDelaySeconds = Number(process.env.INITIAL_DELAY_SECONDS) || 30; // 30 seconds initial delay
			logger.info({ cronDetailID, reportType, reportId, delaySeconds: initialDelaySeconds }, 'Report created, waiting before first status check');
			
			// Wait before allowing status checks
			await new Promise(resolve => setTimeout(resolve, initialDelaySeconds * 1000));
			
			logger.info({ cronDetailID, reportType, reportId }, 'Initial delay completed, ready for status checks');
			
			return {
				message: `Report requested successfully on attempt ${attempt}. Report ID: ${reportId}. Waited ${initialDelaySeconds}s before status checks.`,
				reportID: reportId,
				data: { reportId, startDate, initialDelay: initialDelaySeconds }
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

async function checkReportStatuses(authOverrides = {}, filter = {}, retry = false) {
	logger.info('Starting checkReportStatuses');
	const rows = await model.getReportsForStatusCheck(filter);
	logger.info({ reportCount: rows.length }, 'Found reports for status check');
	
	if (rows.length === 0) {
		logger.info('No reports found for status check');
		return;
	}
	let reportID = null;	
    for (const row of rows) {
        logger.info({ rowId: row.ID }, 'Processing report row');
        for (const type of ['WEEK', 'MONTH', 'QUARTER']) {
            if (row[`${model.mapPrefix(type)}SQPDataPullStatus`] === 0 || (retry && row[`${model.mapPrefix(type)}SQPDataPullStatus`] === 2)) {
                // ProcessRunningStatus = 2 (Check Status)
                await model.setProcessRunningStatus(row.ID, type, 2);
				reportID = await model.getLatestReportId(row.ID, type);
                await model.logCronActivity({ cronJobID: row.ID, reportType: type, action: 'Check Status', status: 1, message: 'Checking report status', reportID: reportID });
                logger.info({ type }, 'Checking status for report');
                await checkReportStatusByType(row, type, authOverrides, reportID);
			}
		}
	}
}

async function checkReportStatusByType(row, reportType, authOverrides = {}, reportID = null) {
    // Find latest ReportID from logs for this CronJobID + ReportType
    const reportId = reportID || await model.getLatestReportId(row.ID, reportType);
    if (!reportId) {
        logger.warn({ cronDetailID: row.ID, reportType }, 'No ReportID found in logs yet; skipping status check for this type');
        await model.logCronActivity({
            cronJobID: row.ID,
            reportType,
            action: 'Check Status',
            status: 3,
            message: 'Skipping status check: ReportID not found in logs yet',
            reportID: null,
            retryCount: 0,
            executionTime: 0
        });
        return { success: true, skipped: true, reason: 'No ReportID in logs yet' };
    }
	
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
                //await model.updateSQPReportStatus(row.ID, reportType, 1);
				// Enqueue for download processing (store in sqp_download_urls as PENDING)
                await downloadUrls.storeDownloadUrl({
					CronJobID: row.ID,
					ReportID: reportId,
					ReportType: reportType,
					DownloadURL: '',
					Status: 'PENDING',
					DownloadAttempts: 0,
					MaxDownloadAttempts: 3,
				});
                // Log report ID and document ID in cron logs
                await model.logCronActivity({ cronJobID: row.ID, reportType, action: 'Check Status', status: 1, message: 'Report ready', reportID: reportId, reportDocumentID: documentId });
				
				return {
					message: `Report ready on attempt ${attempt}. Report ID: ${reportId}${documentId ? ' | Document ID: ' + documentId : ''}`,
					reportID: reportId,
					reportDocumentID: documentId,
					data: { status, documentId }
				};
				
			} else if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') {
				logger.info({ baseDelay: process.env.RETRY_BASE_DELAY_SECONDS, maxDelay: process.env.RETRY_MAX_DELAY_SECONDS }, 'Base delay and max delay');
				// Report is still processing, add delay before retry
				const baseDelay = Number(process.env.RETRY_BASE_DELAY_SECONDS || process.env.INITIAL_DELAY_SECONDS) || 30;
				const maxDelay = Number(process.env.RETRY_MAX_DELAY_SECONDS) || 120;
				const delaySeconds = Math.min(baseDelay + (attempt * 15), maxDelay); // 60s, 75s, 90s, capped 
				logger.info({ cronDetailID: row.ID, reportType, status, attempt, delaySeconds }, 'Report still processing, waiting before retry');
				logger.info({ delaySeconds }, 'Delay seconds');
				// Log the status
				await model.logCronActivity({ 
					cronJobID: row.ID, 
					amazonSellerID: row.AmazonSellerID, 
					reportType, 
					action: 'Check Status', 
					status: 0, 
					message: `Report ${status.toLowerCase().replace('_',' ')} on attempt ${attempt}, waiting ${delaySeconds}s before retry`, 
					reportID: reportId, 
					retryCount: currentRetry,
					executionTime: (Date.now() - startTime) / 1000 
				});
				
				// Wait before retrying
				await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
				
				// Throw error to trigger retry mechanism
				throw new Error(`Report still ${status.toLowerCase().replace('_',' ')} after ${delaySeconds}s wait - retrying`);
				
            } else if (status === 'FATAL' || status === 'CANCELLED') {
                // Permanent failure
                const latestReportId = await model.getLatestReportId(row.ID, reportType);
                await model.updateSQPReportStatus(row.ID, reportType, 2, latestReportId, status, null, null, null, new Date());
                await model.logCronActivity({ 
                    cronJobID: row.ID, 
                    reportType, 
                    action: 'Check Status', 
                    status: 2, 
                    message: `Report ${status} on attempt ${attempt}`, 
                    reportID: latestReportId || reportId, 
                    retryCount: 0, 
                    executionTime: (Date.now() - startTime) / 1000 
                });
                await sendFailureNotification(row.ID, row.AmazonSellerID, reportType, `Report ${status}`, 0, reportId);
				
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

async function downloadCompletedReports(authOverrides = {}, filter = {}) {
    const rows = await model.getReportsForDownload(filter);
    for (const row of rows) {
        for (const type of ['WEEK', 'MONTH', 'QUARTER']) {
            if (row[`${model.mapPrefix(type)}SQPDataPullStatus`] === 0) {
                const reportId = await model.getLatestReportId(row.ID, type);
                if (!reportId) {
                    await model.logCronActivity({ cronJobID: row.ID, reportType: type, action: 'Download Report', status: 3, message: 'Skipping download: ReportID not found in logs', reportID: null, retryCount: 0, executionTime: 0 });
                    continue;
                }
                // ProcessRunningStatus = 3 (Download)
                await model.setProcessRunningStatus(row.ID, type, 3);
                await model.logCronActivity({ cronJobID: row.ID, reportType: type, action: 'Download Report', status: 1, message: 'Downloading report', reportID: reportId });
                await downloadReportByType(row, type, authOverrides, reportId);
            }
        }
    }
}

async function downloadReportByType(row, reportType, authOverrides = {}, reportId = null) {
    if (!reportId) {
        reportId = await model.getLatestReportId(row.ID, reportType);
        if (!reportId) {
            await model.logCronActivity({ cronJobID: row.ID, reportType, action: 'Download Report', status: 3, message: 'Skipping download: ReportID not found in logs', reportID: null, retryCount: 0, executionTime: 0 });
            return { success: true, skipped: true, reason: 'No ReportID in logs' };
        }
    }
	
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
                reportType,
                'DOWNLOADING',
                null,
                null,
                null,
                true
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
                    reportType,
                    'COMPLETED',
                    null,
                    filePath,
                    fileSize,
                    false
                );
				
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
                    reportType,
                    'COMPLETED',
                    'No data in report',
                    null,
                    null,
                    false
                );

				// Use the unified completion handler for no-data scenario
				await jsonSvc.handleReportCompletion(row.ID, reportType, row.AmazonSellerID, null, false);
				
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


