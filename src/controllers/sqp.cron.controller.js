const logger = require('../utils/logger.utils');
const dates = require('../utils/dates.utils');
const model = require('../models/sqp.cron.model');
const sellerModel = require('../models/sequelize/seller.model');
const AuthToken = require('../models/authToken.model');
const sp = require('../spapi/client.spapi');
const jsonSvc = require('../services/sqp.json.processing.service');
const downloadUrls = require('../models/sqp.download.urls.model');
const { NotificationHelpers, RetryHelpers, DelayHelpers } = require('../helpers/sqp.helpers');
const env = require('../config/env.config');
const authService = require('../services/auth.service');

/**
 * Send failure notification when max retries are reached
 */
async function sendFailureNotification(cronDetailID, amazonSellerID, reportType, errorMessage, retryCount, reportId = null, isFatalError = false) {
	try {
		// Determine notification type and message
		const notificationType = isFatalError ? 'FATAL ERROR' : 'MAX RETRIES REACHED';
		const notificationReason = isFatalError 
			? 'Amazon returned FATAL/CANCELLED status - no retries attempted'
			: `Max retries (${retryCount}) exhausted`;
		
		logger.error({
			cronDetailID,
			amazonSellerID,
			reportType,
			errorMessage,
			retryCount,
			isFatalError,
			notificationType
		}, `SENDING FAILURE NOTIFICATION - ${notificationType}`);
		
		// Log the notification
        await model.logCronActivity({
			cronJobID: cronDetailID,
			reportType: reportType,
			action: 'Failure Notification',
			status: 2,
			message: `NOTIFICATION: Report failed after ${retryCount} attempts. ${notificationReason}. Error: ${errorMessage}`,
            reportID: reportId,
			retryCount: retryCount,
			executionTime: 0
		});
        
        // Send actual email notification if SMTP and recipients are configured
        const to = NotificationHelpers.parseList(process.env.NOTIFY_TO || require('../config/env.config').env.NOTIFY_TO);
        const cc = NotificationHelpers.parseList(process.env.NOTIFY_CC || require('../config/env.config').env.NOTIFY_CC);
        const bcc = NotificationHelpers.parseList(process.env.NOTIFY_BCC || require('../config/env.config').env.NOTIFY_BCC);
        if ((to.length + cc.length + bcc.length) > 0) {
            // Different subject lines for FATAL vs retry exhaustion
            const subject = isFatalError 
                ? `SQP Cron FATAL Error [${reportType}] - No retries`
                : `SQP Cron Failed after ${retryCount} attempts [${reportType}]`;
            
            const html = `
                <h3>SQP Cron Failure${isFatalError ? ' - FATAL Error' : ''}</h3>
                <p><strong>Cron Detail ID:</strong> ${cronDetailID}</p>
                <p><strong>Seller:</strong> ${amazonSellerID}</p>
                <p><strong>Report Type:</strong> ${reportType}</p>
                <p><strong>Report ID:</strong> ${reportId || 'N/A'}</p>
                <p><strong>Retry Count:</strong> ${retryCount}</p>
                <p><strong>Failure Type:</strong> ${isFatalError ? 'Amazon FATAL/CANCELLED (immediate)' : 'Max retry attempts exhausted'}</p>
                <p><strong>Error:</strong> ${errorMessage}</p>
                <p><strong>Time:</strong> ${new Date().toISOString()}</p>
                ${isFatalError ? '<p><em>Note: This report returned a FATAL/CANCELLED status from Amazon and cannot be recovered. No retry attempts were made.</em></p>' : ''}
            `;
            await NotificationHelpers.sendEmail({ subject, html, to, cc, bcc });
        } else {
            logger.warn('Notification recipients not configured (NOTIFY_TO/CC/BCC)');
        }
		
	} catch (notificationError) {
		logger.error({ 
			notificationError: notificationError ? (notificationError.message || String(notificationError)) : 'Unknown error',
			errorStack: notificationError?.stack,
			cronDetailID,
			amazonSellerID,
			reportType
		}, 'Failed to send failure notification');
	}
}

async function requestForSeller(seller, authOverrides = {}, spReportType = config.GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT) {
	logger.info({ seller: seller.idSellerAccount }, 'Requesting SQP reports for seller');
	
	try {
		const { asins, reportTypes } = await model.getActiveASINsBySeller(seller.idSellerAccount);
		if (!asins.length) {
			logger.warn({ sellerId: seller.idSellerAccount }, 'No eligible ASINs for seller (pending or ${env.MAX_DAYS_AGO}+ day old completed)');
			return [];
		}
		// Prepare to mark ASINs as In Progress and set start time
		const startTime = new Date();				
		logger.info({ 
			sellerId: seller.idSellerAccount,
			amazonSellerID: seller.AmazonSellerID,
			asinCount: asins.length, 
			asins: asins.slice(0, 5),
			startTime: startTime.toISOString()
		}, 'Found ASINs for seller - will mark as InProgress per chunk');
		
		const chunks = model.splitASINsIntoChunks(asins, 200);
		logger.info({ chunkCount: chunks.length }, 'Split ASINs into chunks');
		let cronDetailIDs = [];
		let cronDetailData = [];
		
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			logger.info({ chunkIndex: i, asinCount: chunk.asins.length }, 'Processing chunk');
			
			const cronDetailRow = await model.createSQPCronDetail(seller.AmazonSellerID, chunk.asin_string, { SellerName: seller.SellerName });
			const cronDetailID = cronDetailRow.ID;
			// Convert Sequelize instance to plain object
			const cronDetailObject = cronDetailRow.toJSON ? cronDetailRow.toJSON() : cronDetailRow.dataValues;
			logger.info({ cronDetailID: cronDetailID }, 'Created cron detail');
			cronDetailIDs.push(cronDetailID);
			cronDetailData.push(cronDetailObject);
			for (const type of reportTypes) {
				logger.info({ type }, 'Requesting report for type');
				await model.ASINsBySellerUpdated(seller.AmazonSellerID, chunk.asins, 1, type, startTime); // 1 = InProgress
                // ProcessRunningStatus = 1 (Request Report)
                await model.setProcessRunningStatus(cronDetailID, type, 1);
                await model.logCronActivity({ cronJobID: cronDetailID, reportType: type, action: 'Request Report', status: 1, message: 'Requesting report', Range: chunk.range });
                await requestSingleReport(chunk, seller, cronDetailID, type, authOverrides, spReportType);
			}
			logger.info({ 
				sellerId: seller.idSellerAccount,
				amazonSellerID: seller.AmazonSellerID,
				chunkIndex: i,
				asinCount: chunk.asins.length,
				asins: chunk.asins.slice(0, 5),
				cronDetailID
			}, 'Marked ASINs as InProgress after request');
		}
		return { cronDetailIDs, cronDetailData };
	} catch (error) {
		logger.error({ 
			error: error ? (error.message || String(error)) : 'Unknown error', 
			stack: error?.stack,
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
			let currentAuthOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID);
			if (!currentAuthOverrides.accessToken) {				
				logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for request');
				throw new Error('No access token available for report request');
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
				executionTime: 0,
				Range: chunk.range,
				iInitialPull: 0
			});
			
				// Add initial delay after report creation to give Amazon time to start processing
			const initialDelaySeconds = await DelayHelpers.waitWithLogging({
				cronDetailID,
				reportType,
				reportId,
				context: 'After Report Request',
				logger
			});
			
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
    const { cronDetailID, cronDetailData } = filter;
	const rows = cronDetailData;
    logger.info({ reportCount: rows.length }, 'Found reports for status check');
    
    if (rows.length === 0) {
        logger.info('No reports found for status check');
        return [];
    }
	const res = [];
    for (const row of rows) {
        logger.info({ rowId: row.ID }, 'Processing report row');		
		let loop = [];
		if (retry && filter.reportType) {
			loop = [filter.reportType];
		} else {
			loop = await model.getReportsForStatusType(row, retry);
		}
		logger.info({ loop }, `Loop status check ${cronDetailID}`);
        for (const type of loop) {
            const statusField = `${model.mapPrefix(type)}SQPDataPullStatus`;
            const processStatusField = row[statusField];

            if (processStatusField === 0 || (retry && processStatusField === 2)) {
                // Set running status
                await model.setProcessRunningStatus(row.ID, type, 2);

                const reportID = await model.getLatestReportId(row.ID, type);

                await model.logCronActivity({
                    cronJobID: row.ID,
                    reportType: type,
                    action: 'Check Status',
                    status: 1,
                    message: 'Checking report status',
                    reportID
                });

                logger.info({ type }, 'Checking status for report');

                const result = await checkReportStatusByType(row, type, authOverrides, reportID, retry);

                if (result.success) {
                    res.push(result);
                }
            }
        }
    }

    return retry ? res : undefined;
}


async function checkReportStatusByType(row, reportType, authOverrides = {}, reportID = null, retry = false) {
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
		context: { row, reportId, seller, authOverrides, isRetry: retry },
		model,
		sendFailureNotification,
		operation: async ({ attempt, currentRetry, context, startTime }) => {
			const { row, reportId, seller, authOverrides, isRetry } = context;
			
			// Ensure access token for this seller during status checks
			
			const currentAuthOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID);
			if (!currentAuthOverrides.accessToken) {
				logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for request');
				throw new Error('No access token available for report request');
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
				const delaySeconds = await DelayHelpers.calculateBackoffDelay(attempt, 'Delay in IN_QUEUE or IN_PROGRESS');
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
				await DelayHelpers.wait(delaySeconds, 'Before retry IN_QUEUE or IN_PROGRESS');

				// Throw error to trigger retry mechanism
				throw new Error(`Report still ${status.toLowerCase().replace('_',' ')} after ${delaySeconds}s wait - retrying`);
				
            } else if (status === 'FATAL' || status === 'CANCELLED') {                
				// Fatal or cancelled status - treat as error
				const res = await handleFatalOrUnknownStatus(row, reportType, status);
				return res;
			} else {
				// Unknown status - treat as error
				if(!status) {
					status = 'UNKNOWN';
				}
				const res = await handleFatalOrUnknownStatus(row, reportType, status);
				return res;
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

async function downloadCompletedReports(authOverrides = {}, filter = {}, retry = false) {    
	const { cronDetailID, cronDetailData } = filter;
	const rows = cronDetailData;	
    for (const row of rows) {
		let loop = [];
		if (retry && filter.reportType) {
			loop = [filter.reportType];
		} else {
			loop = await model.getReportsForStatusType(row, retry);
		}
		logger.info({ loop }, `Loop download ${cronDetailID}`);
        for (const type of loop) {
			const statusField = `${model.mapPrefix(type)}SQPDataPullStatus`;
            const processStatusField = row[statusField];
            
            // Skip download if:
            // - Status is 3 (failed/FATAL)
            // - Status is not 0 or 2 when in retry mode
            if (processStatusField === 3) {
                logger.info({ 
                    cronDetailID: row.ID, 
                    reportType: type,
                    status: processStatusField 
                }, 'Skipping download - report status is FAILED (3)');
                continue;
            }
            
            if (processStatusField === 0 || (retry && processStatusField === 2 && processStatusField !== 3)) {
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
			const currentAuthOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID);
			if (!currentAuthOverrides.accessToken) {
				logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for request');
				throw new Error('No access token available for report request');
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
					logger.warn({ error: fileErr ? (fileErr.message || String(fileErr)) : 'Unknown error', attempt }, 'Failed to save JSON file');
				}

				// Update the existing record in sqp_download_urls with file metadata and set status to COMPLETED
                await downloadUrls.updateDownloadUrlStatusByCriteria(
                    row.ID,
                    reportType,
                    'COMPLETED',
                    null,
                    filePath,
                    fileSize,
                    false,
					reportId
                );

				
			const newRow = await downloadUrls.getCompletedDownloadsWithFiles(filter = { cronDetailID: row.ID, ReportType: reportType });
			
			if (newRow.length > 0) {					
				// Process saved JSON files immediately after download
				try {
					// Convert Sequelize instance to plain object
					const plainRow = newRow[0].toJSON ? newRow[0].toJSON() : newRow[0];
					const enrichedRow = { ...plainRow, AmazonSellerID: row.AmazonSellerID, ReportID: reportId };
					console.log('enrichedRow', enrichedRow);
					const importResult = await jsonSvc.__importJson(enrichedRow, 0, 0);
						logger.info({ 
							cronDetailID: row.ID, 
							reportType, 
							importResult 
						}, 'Import process completed after download');
					} catch (importError) {
						logger.error({ 
							error: importError ? (importError.message || String(importError)) : 'Unknown error', 
							stack: importError?.stack,
							cronDetailID: row.ID, 
							reportType 
						}, 'Error during import process - file saved but import failed');
						// Don't throw - file is saved, import can be retried later
					}
				}
				return {
					message: `Report downloaded successfully on attempt ${attempt} and import process completed`,
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

async function handleFatalOrUnknownStatus(row, reportType, status) {	
	const reportId = await model.getLatestReportId(row.ID, reportType);
    const statusToSet = 3; // Failed status
    const endDate = new Date();
    
    await model.updateSQPReportStatus(row.ID, reportType, statusToSet, reportId, status, null, null, null, endDate);
    
    logger.fatal({ 
        cronDetailID: row.ID, 
        reportType, 
        status, 
        sqpDataPullStatus: statusToSet 
    }, `Report ${status} - Permanent failure`);
    
    await model.logCronActivity({
        cronJobID: row.ID,
        reportType,
        action: 'Fatal Error',  // Changed from 'Check Status' to 'Fatal Error'
        status: 2,              // Keep status 2 (error/failed)
        message: `Report ${status} - Permanent failure`,
        reportID: reportId,
        retryCount: 0,
        executionTime: 0
    });    
    
    try {
        // Parse ASINs from the row's ASIN_List
        const asins = row.ASIN_List ? row.ASIN_List.split(/\s+/).filter(Boolean).map(a => a.trim()) : [];
        
        if (asins.length > 0 && row.AmazonSellerID) {
            await model.ASINsBySellerUpdated(
                row.AmazonSellerID,
                asins,
                3,           // Status 3 = Failed
                reportType,  // WEEK/MONTH/QUARTER
                null,        // startTime already set
                endDate      // endTime when failed
            );
            
            logger.info({
                cronDetailID: row.ID,
                reportType,
                asinCount: asins.length,
                status: 3
            }, `Updated ${asins.length} ASINs to failed status (3) for ${reportType}`);
        }
    } catch (asinUpdateError) {
        logger.error({
            error: asinUpdateError.message,
            cronDetailID: row.ID,
            reportType
        }, 'Failed to update ASIN statuses to failed');
    }
    
    // FATAL/CANCELLED = Send notification immediately with 0 attempts
    // This is different from regular failures which notify after 3 retry attempts
    await sendFailureNotification(
        row.ID, 
        row.AmazonSellerID, 
        reportType, 
        `Amazon returned ${status} status - report cannot be recovered`, 
        0,  // 0 attempts for FATAL - sent immediately
        reportId,
        true  // isFatalError flag
    );
    
    logger.info({ 
        cronDetailID: row.ID, 
        reportType 
    }, 'FATAL notification sent immediately (not after retry attempts)');
    
    // Return success (don't throw - notification already sent, status already set)
    // Throwing here would trigger another notification
    return { 
        message: `Report ${status} - permanent failure handled, notification sent`,
		skipped: true,
        reportID: reportId,
        data: { status, handled: true }
    };
}

module.exports = {
	requestForSeller,
	checkReportStatuses,
	downloadCompletedReports,
	sendFailureNotification,
};


