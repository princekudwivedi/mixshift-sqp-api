const logger = require('../utils/logger.utils');
const apiLogger = require('../utils/api.logger.utils');
const { sendFailureNotification, shouldSendNotification, getErrorType } = require('../utils/notification.utils');
const dates = require('../utils/dates.utils');
const model = require('../models/sqp.cron.model');
const sellerModel = require('../models/sequelize/seller.model');
const AuthToken = require('../models/authToken.model');
const sp = require('../spapi/client.spapi');
const jsonSvc = require('../services/sqp.json.processing.service');
const downloadUrls = require('../models/sqp.download.urls.model');
const { NotificationHelpers, RetryHelpers, DelayHelpers, Helpers } = require('../helpers/sqp.helpers');
const env = require('../config/env.config');
const authService = require('../services/auth.service');

async function checkAllowedReportTypes(reportTypes, user, seller, chunk) {
	const nowInTimezone = dates.getNowDateTimeInUserTimezone().log;
	const nowDateOnly = new Date(nowInTimezone.replace(' ', 'T'));
	nowDateOnly.setHours(0, 0, 0, 0); // normalize to date only

	// Evaluate all delays
	const delayEvaluations = reportTypes.map(type => ({
		type,
		...dates.evaluateReportDelay(type, nowDateOnly)
	}));

	const allowedReportTypes = delayEvaluations
								.filter(info => !info.delay)
								.map(info => info.type);
	
	
	const delayedReportTypes = delayEvaluations.filter(info => info.delay);

	// -----------------------------
	// IF ANY REPORT TYPES ARE DELAYED
	// -----------------------------
	if (delayedReportTypes.length > 0) {
		const ranges = delayedReportTypes.map(info => {
			const range = dates.getDateRangeForPeriod(info.type);
			return {
				type: info.type,
				range: `${range.start} to ${range.end}`,
				reason: info.reason,
			};
		});

		// Log each delayed type separately
		for (const item of ranges) {
			apiLogger.logDelayReportRequestsByTypeAndRange({
				userId: user.ID,
				sellerId: seller.AmazonSellerID,
				sellerAccountId: seller.idSellerAccount,
				endpoint: 'Delaying report requests until allowed window',
				asins: chunk.asin_string || '',
				asinCount: chunk.asins.length,
				status: 'delayed',
				reportType: item.type,
				range: item.range,
				error: item.reason,
				nowInTimezone: nowInTimezone
			});
		}
	}

	return allowedReportTypes;
}

async function requestForSeller(seller, authOverrides = {}, spReportType = env.GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT, user = null) {
	logger.info({ seller: seller.idSellerAccount }, 'Requesting SQP reports for seller');	
	
	try {
		const { asins, reportTypes } = await model.getActiveASINsBySeller(seller.idSellerAccount);
		if (!asins.length) {
			logger.warn({ sellerId: seller.idSellerAccount }, 'No eligible ASINs for seller (pending or ${env.MAX_DAYS_AGO}+ day old completed)');
			return [];
		}
		const chunks = model.splitASINsIntoChunks(asins, 200);
		logger.info({ chunkCount: chunks.length }, 'Split ASINs into chunks');
		let cronDetailIDs = [];
		let cronDetailData = [];		
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];			
			// Check if any report types are allowed to be requested 
			let allowedReportTypes = await checkAllowedReportTypes(reportTypes, user, seller, chunk);

			// -----------------------------
			// IF *NO* REPORT TYPES ARE ALLOWED SKIP REQUESTS
			// -----------------------------
			if (allowedReportTypes.length === 0) {
				break;
			}
			
			logger.info({ chunkIndex: i, asinCount: chunk.asins.length }, 'Processing chunk');
			const timezone = await model.getUserTimezone(user);
			const weekRange = dates.getDateRangeForPeriod('WEEK', timezone);
			const monthRange = dates.getDateRangeForPeriod('MONTH', timezone);
			const quarterRange = dates.getDateRangeForPeriod('QUARTER', timezone);
			const FullWeekRange = `${weekRange.start} to ${weekRange.end}`;
			const FullMonthRange = `${monthRange.start} to ${monthRange.end}`;
			const FullQuarterRange = `${quarterRange.start} to ${quarterRange.end}`;
			const cronDetailRow = await model.createSQPCronDetail(seller.AmazonSellerID, chunk.asin_string, seller.idSellerAccount, { SellerName: seller.SellerName, FullWeekRange: FullWeekRange, FullMonthRange: FullMonthRange, FullQuarterRange: FullQuarterRange });
			const cronDetailID = cronDetailRow.ID;
			// Convert Sequelize instance to plain object
			const cronDetailObject = cronDetailRow.toJSON ? cronDetailRow.toJSON() : cronDetailRow.dataValues;
			logger.info({ cronDetailID: cronDetailID }, 'Created cron detail');
			cronDetailIDs.push(cronDetailID);
			cronDetailData.push(cronDetailObject);
			for (const type of allowedReportTypes) {
				// Prepare to mark ASINs as In Progress and set start time
				const startTime = dates.getNowDateTimeInUserTimezone();
				logger.info({ 
					userId: user.ID,
					sellerAccountId: seller.idSellerAccount,
					amazonSellerID: seller.AmazonSellerID,
					asinCount: asins.length, 
					asins: asins.slice(0, 5),
					startTime: startTime.log
				}, 'Found ASINs for seller - will mark as InProgress per chunk');
				logger.info({ type }, 'Requesting report for type');
				await model.ASINsBySellerUpdated(seller.idSellerAccount, seller.AmazonSellerID, chunk.asins, 1, type, startTime.db); // 1 = InProgress
                // ProcessRunningStatus = 1 (Request Report)
                await model.setProcessRunningStatus(cronDetailID, type, 1);
                await model.logCronActivity({ cronJobID: cronDetailID, reportType: type, action: 'Request Report', status: 1, message: 'Requesting report', Range: chunk.range });
                await requestSingleReport(chunk, seller, cronDetailID, type, authOverrides, spReportType, user);
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

async function requestSingleReport(chunk, seller, cronDetailID, reportType, authOverrides = {}, spReportType = env.GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT, user = null) {
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
		context: { chunk, seller, authOverrides, user },
		model,
		sendFailureNotification: (cronDetailID, amazonSellerID, reportType, errorMessage, retryCount, reportId, isFatalError, range) => {
			return sendFailureNotification({
				cronDetailID,
				amazonSellerID,
				reportType,
				errorMessage,
				retryCount,
				reportId,
				isFatalError,
				range,
				model,
				NotificationHelpers,
				env,
				context: 'Cron'
			});
		},
		operation: async ({ attempt, currentRetry, context, startTime }) => {
			const { chunk, seller, user } = context;
			
			// Set start date when beginning the report request
			const startDate =  dates.getNowDateTimeInUserTimezone();
			logger.info({ cronDetailID, reportType, startDate: startDate.log, attempt }, 'Setting start date for report request');
			await model.updateSQPReportStatus(cronDetailID, reportType, 0, startDate.db);

			const period = reportType;
			const timezone = await model.getUserTimezone(user);
			const range = dates.getDateRangeForPeriod(period, timezone);
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
                asinString = String(chunk.asin_string).replaceAll(/\s+/g, ' ').trim().slice(0, 200);
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
			const requestStartTime =  dates.getNowDateTimeInUserTimezone();

			// Ensure access token is present for this seller
			let currentAuthOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID);
			if (!currentAuthOverrides.accessToken) {				
				logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for request');
				
				// API Logger - Failed Request (No Token)
				const userId = user ? user.ID : null;
				apiLogger.logRequestReport({
					userId,
					sellerId: seller.AmazonSellerID,
					sellerAccountId: seller.idSellerAccount,
					endpoint: 'SP-API Create Report',
					requestPayload: payload,
					response: null,
					startTime: requestStartTime.log,
					endTime:  dates.getNowDateTimeInUserTimezone().log,
					executionTime: (Date.now() - startTime) / 1000,
					status: 'failure',
					reportId: null,
					reportType,
					range: `${range.start} to ${range.end}`,
					error: { message: 'No access token available for report request' },
					retryCount: currentRetry,
					attempt
				});
				
				throw new Error('No access token available for report request');
			}
            // 1️⃣ Create report
			const { reportId } = await sp.createReport(seller, payload, currentAuthOverrides);
			if(!reportId){
				logger.error({ reportId, payload, range: range.range, attempt }, 'Report creation failed');
				throw new Error('Report creation failed - no reportId returned');
			}
			const requestEndTime =  dates.getNowDateTimeInUserTimezone();
			
			// API Logger - Successful Request Report
			const userId = user ? user.ID : null;
			apiLogger.logRequestReport({
				userId,
				sellerId: seller.AmazonSellerID,
				sellerAccountId: seller.idSellerAccount,
				endpoint: 'SP-API Create Report',
				requestPayload: payload,
				response: reportId,
				startTime: requestStartTime.log,
				endTime: requestEndTime.log,
				executionTime: (Date.now() - startTime) / 1000,
				status: reportId ? 'success' : 'failure',
				reportId,
				reportType,
				range: `${range.start} to ${range.end}`,
				error: null,
				retryCount: currentRetry,
				attempt
			});
			
			logger.info({ reportId, attempt }, 'Report created successfully');
			
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
				Range: `${range.start} to ${range.end}`,
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
				data: { reportId, startDate: startDate.log, initialDelay: initialDelaySeconds }
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
    const { cronDetailID, cronDetailData, user } = filter;
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

                const result = await checkReportStatusByType(row, type, authOverrides, reportID, retry, user);

                if (result.success) {
                    res.push(result);
                }
            }
        }
    }

    // Finalize cronRunningStatus after status checks
    try { if (cronDetailID) await finalizeCronRunningStatus(cronDetailID, user); } catch (_) {}
    return retry ? res : undefined;
}


async function checkReportStatusByType(row, reportType, authOverrides = {}, reportID = null, retry = false, user = null) {
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

	// Calculate date range for the report type
	const timezone = await model.getUserTimezone(user);
	const range = dates.getDateRangeForPeriod(reportType, timezone);

	// Use the universal retry function
	const statusMaxRetries = Number(process.env.MAX_RETRY_ATTEMPTS) || 3;
	const result = await RetryHelpers.executeWithRetry({
		cronDetailID: row.ID,
		amazonSellerID: row.AmazonSellerID,
		reportType,
		action: 'Check Status',
		maxRetries: statusMaxRetries,
		context: { row, reportId, seller, authOverrides, isRetry: retry, user, range, maxRetries: statusMaxRetries },
		model,
		sendFailureNotification: (cronDetailID, amazonSellerID, reportType, errorMessage, retryCount, reportId, isFatalError, range) => {
			return sendFailureNotification({
				cronDetailID,
				amazonSellerID,
				reportType,
				errorMessage,
				retryCount,
				reportId,
				isFatalError,
				range,
				model,
				NotificationHelpers,
				env,
				context: 'Cron'
			});
		},
		operation: async ({ attempt, currentRetry, context, startTime }) => {
			const { row, reportId, seller, user, range } = context;
			const statusStartTime =  dates.getNowDateTimeInUserTimezone();
			
			// Ensure access token for this seller during status checks
			
			const currentAuthOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID);
			if (!currentAuthOverrides.accessToken) {
				logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for request');
				
				// API Logger - Failed Status Check (No Token)
				const userId = user ? user.ID : null;
				apiLogger.logRequestStatus({
					userId,
					sellerId: seller.AmazonSellerID,
					sellerAccountId: seller.idSellerAccount,
					reportId,
					reportType,
					range: `${range.start} to ${range.end}`,
					currentStatus: 'UNKNOWN',
					response: null,
					retryCount: currentRetry,
					attempt,
					startTime: statusStartTime.log,
					endTime:  dates.getNowDateTimeInUserTimezone().log,
					executionTime: (Date.now() - startTime) / 1000,
					status: 'failure',
					error: { message: 'No access token available for report request' }
				});
				
				throw new Error('No access token available for report request');
			}
			
			const { processingStatus, reportDocumentId } = await sp.getReportStatus(seller, reportId, currentAuthOverrides);
			if(!processingStatus || !reportDocumentId){
				logger.error({ reportId, processingStatus, reportDocumentId, range: range.range, attempt }, 'Report status check failed');
				throw new Error('Report status check failed - no processingStatus or reportDocumentId returned');
			}

			const status = processingStatus;
			const statusEndTime =  dates.getNowDateTimeInUserTimezone();
			
			// API Logger - Status Check
			const userId = user ? user.ID : null;
			apiLogger.logRequestStatus({
				userId,
				sellerId: seller.AmazonSellerID,
				sellerAccountId: seller.idSellerAccount,
				reportId,
				reportType,
				range: `${range.start} to ${range.end}`,
				currentStatus: status,
				response: status,
				retryCount: currentRetry,
				attempt,
				startTime: statusStartTime.log,
				endTime: statusEndTime.log,
				executionTime: (Date.now() - startTime) / 1000,
				status: status ? 'success' : 'failure',
				error: null,
				reportDocumentId: reportDocumentId || null
			});
			
            if (status === 'DONE') {
				// Keep ReportID_* as the original reportId; store documentId separately
				const documentId = reportDocumentId || null;

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
                await model.logCronActivity({ cronJobID: row.ID, reportType, action: 'Download Report', status: 1, message: 'Report ready', reportID: reportId, reportDocumentID: documentId });
				
				const requestDelaySeconds = Number(process.env.REQUEST_DELAY_SECONDS) || 30;
				await DelayHelpers.wait(requestDelaySeconds, 'Between report status checks and downloads (rate limiting)');

				// ProcessRunningStatus = 3 (Download)
                await model.setProcessRunningStatus(row.ID, reportType, 3);
                
				const downloadResult = await downloadReportByType(row, reportType, authOverrides, reportId, user, range, reportDocumentId);
				return {
					message: downloadResult?.message ? downloadResult?.message : `Report ready on attempt ${attempt}. Report ID: ${reportId}${documentId ? ' | Document ID: ' + documentId : ''}`,
					action: downloadResult?.action ? downloadResult?.action : 'Check Status and Download Report',
					reportID: reportId,
					reportDocumentID: documentId,
					data: { status, documentId },
					skipped: true
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
					message: `Report ${status.toLowerCase().replaceAll('_',' ')} on attempt ${attempt}, waiting ${delaySeconds}s before retry`, 
					reportID: reportId, 
					retryCount: currentRetry,
					executionTime: (Date.now() - startTime) / 1000 
				});

				const maxRetries = context?.maxRetries ?? 3;

				if(attempt >= maxRetries) {
					// Parse ASINs from the row's ASIN_List
					const asins = row.ASIN_List ? row.ASIN_List.split(/\s+/).filter(Boolean).map(a => a.trim()) : [];
        
					if (asins.length > 0 && row.AmazonSellerID) {
						await model.ASINsBySellerUpdated(
							row.SellerID,
							row.AmazonSellerID,
							asins,
							3,           // Status 3 = Failed
							reportType,  // WEEK/MONTH/QUARTER
							null,        // startTime already set
							 dates.getNowDateTimeInUserTimezone().db      // endTime when failed
						);
						
						logger.info({
							cronDetailID: row.ID,
							reportType,
							asinCount: asins.length,
							status: 3
						}, `After 3 attempts Updated ${asins.length} ASINs to failed status (3) for ${reportType}`);
					}

					// Max retries reached - return failure instead of retrying
					return {
						message: `Report still ${status.toLowerCase().replaceAll('_',' ')} after ${maxRetries} attempts`,
						action: 'Check Status',
						reportID: reportId,
						data: { status, attempt, maxRetries },
						success: false
					};
				}
				
				// Wait before retrying
				await DelayHelpers.wait(delaySeconds, 'Before retry IN_QUEUE or IN_PROGRESS');

				// Throw error to trigger retry mechanism
				const pendingError = new Error(`Report still ${status.toLowerCase().replaceAll('_',' ')} after ${delaySeconds}s wait - retrying`);
				pendingError.code = 'REPORT_PENDING';
				pendingError.isRetryable = true;
				pendingError.suppressErrorLog = true; // Don't log as error, just retry
				throw pendingError;

				
			} else if (status === 'FATAL' || status === 'CANCELLED') {                
				// Fatal or cancelled status - treat as error
				const res = await handleFatalOrUnknownStatus(row, reportType, status, reportId);

				const requestDelaySeconds = Number(process.env.REQUEST_DELAY_SECONDS) || 30;
				await DelayHelpers.wait(requestDelaySeconds, 'Between report status checks and fatal/cancelled (rate limiting)');

				return res;
			} else {
				// Unknown status - treat as error
				const finalStatus = status || 'UNKNOWN';
				const res = await handleFatalOrUnknownStatus(row, reportType, finalStatus, reportId);
				const requestDelaySeconds = Number(process.env.REQUEST_DELAY_SECONDS) || 30;
				await DelayHelpers.wait(requestDelaySeconds, 'Between report status checks and unknown status (rate limiting)');
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

async function downloadReportByType(row, reportType, authOverrides = {}, reportId = null, user = null, range = null, downloadDocumentId = null) {
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
		context: { row, reportId, seller, authOverrides, user, range, downloadDocumentId },
		model,
		sendFailureNotification: (cronDetailID, amazonSellerID, reportType, errorMessage, retryCount, reportId, isFatalError, range) => {
			return sendFailureNotification({
				cronDetailID,
				amazonSellerID,
				reportType,
				errorMessage,
				retryCount,
				reportId,
				isFatalError,
				range,
				model,
				NotificationHelpers,
				env,
				context: 'Cron'
			});
		},
		operation: async ({ attempt, currentRetry, context, startTime }) => {
			const { row, reportId, seller, user, range, downloadDocumentId } = context;
			const downloadStartTime =  dates.getNowDateTimeInUserTimezone();
			const timezone = await model.getUserTimezone(user);
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
			
			// Use the reportDocumentId from status response
			const documentId = downloadDocumentId || reportId;
			logger.info({ documentId, attempt }, 'Using document ID for download');
			
			// Ensure access token for download as well
			const currentAuthOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID);
			if (!currentAuthOverrides.accessToken) {
				logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for request');
				
				// API Logger - Failed Download (No Token)
				const userId = user ? user.ID : null;
				apiLogger.logDownload({
					userId,
					sellerId: seller.AmazonSellerID,
					sellerAccountId: seller.idSellerAccount,
					reportId,
					reportDocumentId: null,
					reportType,
					range: `${range.start} to ${range.end}`,
					fileUrl: null,
					filePath: null,
					fileSize: 0,
					rowCount: 0,
					downloadPayload: { documentId: reportId },
					startTime: downloadStartTime.log,
					endTime:  dates.getNowDateTimeInUserTimezone().log,
					executionTime: (Date.now() - startTime) / 1000,
					status: 'failure',
					error: { message: 'No access token available for report request' },
					retryCount: currentRetry,
					attempt
				});
				
				throw new Error('No access token available for report request');
			}
			// Download the report document
			const downloadResponse = await sp.downloadReport(seller, documentId, currentAuthOverrides);
			let res = downloadResponse?.data || downloadResponse;
			if(!res){
				logger.error({ downloadResponse, documentId, range: range.range, attempt }, 'Download report failed');
				throw new Error('Download report failed - no data returned');
			}
			
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
				const downloadMeta = { AmazonSellerID: row.AmazonSellerID, ReportType: reportType, ReportID: documentId, SellerID: seller.idSellerAccount, UserID: user ? user.ID : null };
				let filePath = null; let fileSize = 0;
				const downloadEndTime =  dates.getNowDateTimeInUserTimezone();
				
				try {
					const saveResult = await jsonSvc.saveReportJsonFile(downloadMeta, data);
					filePath = saveResult?.path || saveResult?.url || null;
					if (filePath) {
						const fs = require('node:fs');
						const stat = await fs.promises.stat(filePath).catch(() => null);
						fileSize = stat ? stat.size : 0;
						logger.info({ filePath, fileSize, attempt }, 'Report JSON saved to disk');
					}
					
					// API Logger - Successful Download with Data
					const userId = user ? user.ID : null;
					apiLogger.logDownload({
						userId,
						sellerId: seller.AmazonSellerID,
						sellerAccountId: seller.idSellerAccount,
						reportId,
						reportDocumentId: documentId,
						reportType,
						range: `${range.start} to ${range.end}`,
						fileUrl: res?.url || null,
						filePath,
						fileSize,
						rowCount: data.length,
						downloadPayload: { documentId },
						startTime: downloadStartTime.log,
						endTime: downloadEndTime.log,
						executionTime: (Date.now() - startTime) / 1000,
						status: 'success',
						error: downloadError,
						retryCount: currentRetry,
						attempt
					});
					
				} catch (error_) {
					logger.warn({ error: error_ ? (error_.message || String(error_)) : 'Unknown error', attempt }, 'Failed to save JSON file');
					
					// API Logger - Download Success but File Save Failed
					const userId = user ? user.ID : null;
					apiLogger.logDownload({
						userId,
						sellerId: seller.AmazonSellerID,
						sellerAccountId: seller.idSellerAccount,
						reportId,
						reportDocumentId: documentId,
						reportType,
						range: `${range.start} to ${range.end}`,
						fileUrl: res?.url || null,
						filePath: null,
						fileSize: 0,
						rowCount: data.length,
						downloadPayload: { documentId },
						startTime: downloadStartTime.log,
						endTime:  dates.getNowDateTimeInUserTimezone().log,
						executionTime: (Date.now() - startTime) / 1000,
						status: 'partial_success',
						error: error_,
						retryCount: currentRetry,
						attempt
					});
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

				
				const filter = { cronDetailID: row.ID, ReportType: reportType };
				const newRow = await downloadUrls.getCompletedDownloadsWithFiles(filter);
				
				if (newRow.length > 0) {					
					// Process saved JSON files immediately after download
					try {
						// Convert Sequelize instance to plain object
						const plainRow = newRow[0].toJSON ? newRow[0].toJSON() : newRow[0];
						const enrichedRow = { ...plainRow, AmazonSellerID: row.AmazonSellerID, ReportID: reportId, SellerID: row.SellerID };					
						const importResult = await jsonSvc.__importJson(enrichedRow, 0, 0, 0, timezone);
						logger.info({ 
								action: 'Download Completed - Import Done',
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
						action: 'Download Completed & Import Done',
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
					await jsonSvc.handleReportCompletion(row.ID, reportType, row.AmazonSellerID, null, false, timezone);

					return {
						action: 'Download Completed & Import Done - No Data to import',
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

async function handleFatalOrUnknownStatus(row, reportType, status, reportId = null) {	
	// Use provided reportId or fetch from DB as fallback
	if (!reportId) {
		reportId = await model.getLatestReportId(row.ID, reportType);
	}

    const statusToSet = 3; // Failed status
    const endDate =  dates.getNowDateTimeInUserTimezone().db;
    
    // Fatal should mark cron as completed (2) with failed SQP status (3); no retry
    await model.updateSQPReportStatus(row.ID, reportType, statusToSet, null, endDate, 2);
    
    logger.fatal({ 
        cronDetailID: row.ID, 
        reportType, 
        status,
        reportId,
        sqpDataPullStatus: statusToSet 
    }, `Report ${status} - Permanent failure`);
    
    await model.logCronActivity({
        cronJobID: row.ID,
        reportType,
        action: 'Fatal Error',  // Explicit action name for fatal errors
        status: 3,              // Status 3 = error/failed
        message: `Report ${status} - Permanent failure`,
        reportID: reportId,     // Use the provided reportId
        retryCount: 0,
        executionTime: 0
    });    
    
    try {
        // Parse ASINs from the row's ASIN_List
        const asins = row.ASIN_List ? row.ASIN_List.split(/\s+/).filter(Boolean).map(a => a.trim()) : [];
        
        if (asins.length > 0 && row.AmazonSellerID) {
            await model.ASINsBySellerUpdated(
				row.SellerID,
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
    await sendFailureNotification({
        cronDetailID: row.ID, 
        amazonSellerID: row.AmazonSellerID, 
        reportType, 
        errorMessage: `Amazon returned ${status} status - report cannot be recovered`, 
        retryCount: 0,  // 0 attempts for FATAL - sent immediately
        reportId,
        isFatalError: true,  // isFatalError flag
        range: null,
        model,
        NotificationHelpers,
        env,
        context: 'Cron'
    });
    
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

// Finalize cronRunningStatus for a cron detail based on type statuses
async function finalizeCronRunningStatus(cronDetailID, user = null) {
    try {
        const { getModel: getSqpCronDetails } = require('../models/sequelize/sqpCronDetails.model');
        const SqpCronDetails = getSqpCronDetails();
        const row = await SqpCronDetails.findOne({ where: { ID: cronDetailID }, raw: true });
        if (!row) return;

        const weekly = row.WeeklySQPDataPullStatus;
        const monthly = row.MonthlySQPDataPullStatus;
        const quarterly = row.QuarterlySQPDataPullStatus;
        
        const weeklyProcess = row.WeeklyProcessRunningStatus;
        const monthlyProcess = row.MonthlyProcessRunningStatus;
        const quarterlyProcess = row.QuarterlyProcessRunningStatus;

        // Build list of actively processed report types (ProcessRunningStatus > 0)
        const activeReports = [];
        if (weeklyProcess > 0) activeReports.push({ type: 'WEEK', status: weekly, process: weeklyProcess });
        if (monthlyProcess > 0) activeReports.push({ type: 'MONTH', status: monthly, process: monthlyProcess });
        if (quarterlyProcess > 0) activeReports.push({ type: 'QUARTER', status: quarterly, process: quarterlyProcess });
        
        // If no active reports, keep cronRunningStatus as is
        if (activeReports.length === 0) {
            logger.info({ cronDetailID }, 'No active report types being processed, keeping cronRunningStatus unchanged');
            return;
        }

        // Get only statuses for active reports
        const statuses = activeReports.map(r => r.status);
        
        const anyInProgress = statuses.includes(0);
        const anyRetryNeeded = statuses.includes(2);
        const allCompleted = statuses.every(s => s === 1);
        const allFinalizedOrFatal = statuses.every(s => s === 1 || s === 3);

        let newStatus = row.cronRunningStatus;
        let reason = '';

        /**
         * Priority logic for cronRunningStatus:
         * 1. If ANY report needs retry (status 2) → cronRunningStatus = 3 (needs retry)
         * 2. If ANY report is in progress (status 0) → cronRunningStatus = 1 (running)
         * 3. If ALL reports are completed successfully (status 1) → cronRunningStatus = 2 (completed)
         * 4. If ALL reports are finalized (mix of status 1 and 3, no 0 or 2) → cronRunningStatus = 2 (completed with some fatal)
         * 5. Otherwise → keep current status
         */

        if (anyRetryNeeded) {
            // Priority 1: Any report needs retry
            newStatus = 3;
            reason = 'Some reports need retry (status 2)';
        } else if (anyInProgress) {
            // Priority 2: Any report still in progress
            newStatus = 1;
            reason = 'Some reports still in progress (status 0)';
        } else if (allCompleted) {
            // Priority 3: All reports completed successfully
            newStatus = 2;
            reason = 'All reports completed successfully (status 1)';
        } else if (allFinalizedOrFatal) {
            // Priority 4: All reports are either completed or fatal (no in-progress or retry)
            newStatus = 2;
            reason = 'All reports finalized (mix of completed and fatal)';
        } else {
            // Keep current status
            reason = 'No status change needed';
        }

        if (newStatus !== row.cronRunningStatus) {
            logger.info({ 
                cronDetailID, 
                oldStatus: row.cronRunningStatus, 
                newStatus, 
                reason,
                activeReports: activeReports.map(r => `${r.type}(status:${r.status})`).join(', '),
                weekly, 
                monthly, 
                quarterly 
            }, 'Updating cronRunningStatus');
            
            await SqpCronDetails.update({ 
                cronRunningStatus: newStatus, 
                dtUpdatedOn:  dates.getNowDateTimeInUserTimezone().db 
            }, { 
                where: { ID: cronDetailID } 
            });
        } else {
            logger.info({ 
                cronDetailID, 
                cronRunningStatus: row.cronRunningStatus, 
                reason,
                activeReports: activeReports.map(r => `${r.type}(status:${r.status})`).join(', '),
                weekly, 
                monthly, 
                quarterly 
            }, 'cronRunningStatus unchanged');
        }
    } catch (e) {
        logger.error({ cronDetailID, error: e.message }, 'Failed to finalize cronRunningStatus');
    }
}

module.exports = {
	requestForSeller,
	checkReportStatuses,
	finalizeCronRunningStatus,
};


