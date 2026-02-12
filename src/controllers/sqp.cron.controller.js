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

		delayedReportTypes.reduce((acc, curr) => {
			acc[curr.type] = curr.reason;
			return acc;
		}, {});

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
			return { cronDetailIDs: [], cronDetailData: [] };
		}
		const chunks = model.splitASINsIntoChunks(asins, 200);
		logger.info({ chunkCount: chunks.length }, 'Split ASINs into chunks');
		let cronDetailIDs = [];
		let cronDetailData = [];
		const timezone = await model.getUserTimezone(user);
		const today = dates.getNowDateTimeInUserTimezoneDate(new Date(), timezone);
		const fromDate = seller.dtLatestSQPPullDate ? new Date(seller.dtLatestSQPPullDate) : null;
		const pending = fromDate ? dates.getPendingRangesFromDate(fromDate, today, timezone) : { weekRanges: [], monthRanges: [], quarterRanges: [] };
		const hasAnyPending = pending.weekRanges.length > 0 || pending.monthRanges.length > 0 || pending.quarterRanges.length > 0;

		if (hasAnyPending) {
			// New behaviour: when we have a dtLatestSQPPullDate and pending ranges, create one cron detail per (type, range)
			logger.info({
				fromDate: fromDate ? fromDate.toISOString().slice(0, 10) : null,
				weekCount: pending.weekRanges.length,
				monthCount: pending.monthRanges.length,
				quarterCount: pending.quarterRanges.length
			}, 'Using pending ranges from dtLatestSQPPullDate');

			const rangesByType = {
				WEEK: pending.weekRanges,
				MONTH: pending.monthRanges,
				QUARTER: pending.quarterRanges
			};

			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i];
				let allowedReportTypes = await checkAllowedReportTypes(reportTypes, user, seller, chunk);
				if (allowedReportTypes.length === 0) {
					break;
				}
				logger.info({ chunkIndex: i, asinCount: chunk.asins.length }, 'Processing chunk (pending ranges)');

				for (const type of allowedReportTypes) {
					const typeRanges = rangesByType[type] || [];
					if (typeRanges.length === 0) continue;

					for (const rangeObj of typeRanges) {
						const rangeStr = rangeObj.range || (rangeObj.start && rangeObj.end ? `${rangeObj.start} to ${rangeObj.end}` : null);
						const fullRangeOpt = type === 'WEEK'
							? { FullWeekRange: rangeStr, FullMonthRange: null, FullQuarterRange: null }
							: type === 'MONTH'
								? { FullWeekRange: null, FullMonthRange: rangeStr, FullQuarterRange: null }
								: { FullWeekRange: null, FullMonthRange: null, FullQuarterRange: rangeStr };

						const cronDetailRow = await model.createSQPCronDetail(
							seller.AmazonSellerID,
							chunk.asin_string,
							seller.idSellerAccount,
							{ SellerName: seller.SellerName, ...fullRangeOpt }
						);
						const cronDetailID = cronDetailRow.ID;
						const cronDetailObject = cronDetailRow.toJSON ? cronDetailRow.toJSON() : cronDetailRow.dataValues;
						cronDetailIDs.push(cronDetailID);
						cronDetailData.push(cronDetailObject);

						logger.info({ cronDetailID, type, range: rangeStr }, 'Created cron detail for pending range');

						const startTime = dates.getNowDateTimeInUserTimezone();
						await model.ASINsBySellerUpdated(seller.idSellerAccount, seller.AmazonSellerID, chunk.asins, 1, type, startTime.db);
						await model.setProcessRunningStatus(cronDetailID, type, 1);
						await model.logCronActivity({
							cronJobID: cronDetailID,
							reportType: type,
							action: 'Request Report',
							status: 1,
							message: 'Requesting report',
							Range: rangeStr,
							iInitialPull: 0
						});
						await requestSingleReport(chunk, seller, cronDetailID, type, authOverrides, spReportType, user, rangeObj);
					}
				}
				logger.info({
					sellerId: seller.idSellerAccount,
					amazonSellerID: seller.AmazonSellerID,
					chunkIndex: i,
					asinCount: chunk.asins.length,
					cronDetailIDs: cronDetailIDs.length
				}, 'Marked ASINs as InProgress after request (pending ranges)');
			}
		} else {
			// Original behaviour: when starting from the beginning (no dtLatestSQPPullDate),
			// create a single cron detail per chunk with WEEK, MONTH and QUARTER ranges together.
			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i];
				let allowedReportTypes = await checkAllowedReportTypes(reportTypes, user, seller, chunk);
				if (allowedReportTypes.length === 0) {
					break;
				}

				logger.info({ chunkIndex: i, asinCount: chunk.asins.length }, 'Processing chunk (initial ranges)');

				const weekRange = dates.getDateRangeForPeriod('WEEK', timezone);
				const monthRange = dates.getDateRangeForPeriod('MONTH', timezone);
				const quarterRange = dates.getDateRangeForPeriod('QUARTER', timezone);
				const FullWeekRange = `${weekRange.start} to ${weekRange.end}`;
				const FullMonthRange = `${monthRange.start} to ${monthRange.end}`;
				const FullQuarterRange = `${quarterRange.start} to ${quarterRange.end}`;

				const cronDetailRow = await model.createSQPCronDetail(
					seller.AmazonSellerID,
					chunk.asin_string,
					seller.idSellerAccount,
					{
						SellerName: seller.SellerName,
						FullWeekRange,
						FullMonthRange,
						FullQuarterRange
					}
				);
				const cronDetailID = cronDetailRow.ID;
				const cronDetailObject = cronDetailRow.toJSON ? cronDetailRow.toJSON() : cronDetailRow.dataValues;
				cronDetailIDs.push(cronDetailID);
				cronDetailData.push(cronDetailObject);
				logger.info({ cronDetailID }, 'Created cron detail (initial ranges)');

				for (const type of allowedReportTypes) {
					const startTime = dates.getNowDateTimeInUserTimezone();
					logger.info({
						userId: user.ID,
						sellerAccountId: seller.idSellerAccount,
						amazonSellerID: seller.AmazonSellerID,
						asinCount: asins.length,
						asins: asins.slice(0, 5),
						startTime: startTime.log
					}, 'Found ASINs for seller - will mark as InProgress per chunk');

					logger.info({ type }, 'Requesting report for type (initial ranges)');
					await model.ASINsBySellerUpdated(seller.idSellerAccount, seller.AmazonSellerID, chunk.asins, 1, type, startTime.db);
					await model.setProcessRunningStatus(cronDetailID, type, 1);
					await requestSingleReport(chunk, seller, cronDetailID, type, authOverrides, spReportType, user);
				}

				logger.info({
					sellerId: seller.idSellerAccount,
					amazonSellerID: seller.AmazonSellerID,
					chunkIndex: i,
					asinCount: chunk.asins.length,
					cronDetailIDs: cronDetailIDs.length
				}, 'Marked ASINs as InProgress after request (initial ranges)');
			}
		}

		return { cronDetailIDs, cronDetailData };
	} catch (error) {
		logger.error({ error: error ? (error.message || String(error)) : 'Unknown error', stack: error?.stack, seller: seller.idSellerAccount }, 'Error in requestForSeller');
		throw error;
	}
}

async function requestSingleReport(chunk, seller, cronDetailID, reportType, authOverrides = {}, spReportType = env.GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT, user = null, rangeOverride = null) {
	logger.info({ 
		cronDetailID, 
		reportType, 
		sellerId: seller.AmazonSellerID,
		hasAuthOverrides: !!authOverrides.accessToken,
		rangeOverride: rangeOverride ? (rangeOverride.range || `${rangeOverride.start} to ${rangeOverride.end}`) : null
	}, 'Starting requestSingleReport with retry logic');

	const timezone = await model.getUserTimezone(user);
	const rangeForLog = rangeOverride != null
		? (rangeOverride.range || (rangeOverride.start != null && rangeOverride.end != null ? `${rangeOverride.start} to ${rangeOverride.end}` : null))
		: (() => { const r = dates.getDateRangeForPeriod(reportType, timezone); return `${r.start} to ${r.end}`; })();
	// Always include Range in log so the column is populated (one row per type for single-entry, one per range for pending).
	const extraLogFields = { Range: rangeForLog, iInitialPull: 0 };

	const result = await RetryHelpers.executeWithRetry({
		cronDetailID,
		amazonSellerID: seller.AmazonSellerID,
		reportType,
		action: 'Request Report',
		context: { chunk, seller, authOverrides, user, rangeOverride },
		model,
		extraLogFields,
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
			const { chunk, seller, authOverrides, user, rangeOverride } = context;
			
			// Set start date when beginning the report request
			const startDate =  dates.getNowDateTimeInUserTimezone();
			logger.info({ cronDetailID, reportType, startDate: startDate.log, attempt }, 'Setting start date for report request');
			await model.updateSQPReportStatus(cronDetailID, reportType, 0, startDate.db);

			const timezone = await model.getUserTimezone(user);
			let range;
			if (rangeOverride != null && rangeOverride.start != null && rangeOverride.end != null) {
				range = { start: rangeOverride.start, end: rangeOverride.end };
			} else {
				range = dates.getDateRangeForPeriod(reportType, timezone);
			}
			logger.info({ reportType, range, attempt }, 'Date range calculated');
			
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

            let resp;
			let requestError = null;
            try {
                resp = await sp.createReport(seller, payload, currentAuthOverrides);
            } catch (err) {
                const status = err.status || err.statusCode || err.response?.status;
                // If unauthorized/forbidden, force refresh token once and retry
                if (status === 401 || status === 403) {
					currentAuthOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID, true);
					if (!currentAuthOverrides.accessToken) {				
						logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for request');
						requestError = new Error('No access token available for report request after forced refresh');
						
						// API Logger - Failed Request (No Token After Refresh)
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
							error: requestError,
							retryCount: currentRetry,
							attempt
						});
						
						throw requestError;
					}
					resp = await sp.createReport(seller, payload, currentAuthOverrides);
                } else {
					logger.error({
						status,
						body: err.response && (err.response.body || err.response.text),
						message: err.message,
						payload
					}, 'SP-API createReport failed');
					throw err;
				}
            }
			const reportId = resp.reportId;
			const requestEndTime =  dates.getNowDateTimeInUserTimezone();
			
			// API Logger - Successful Request Report
			const userId = user ? user.ID : null;
			apiLogger.logRequestReport({
				userId,
				sellerId: seller.AmazonSellerID,
				sellerAccountId: seller.idSellerAccount,
				endpoint: 'SP-API Create Report',
				requestPayload: payload,
				response: resp,
				startTime: requestStartTime.log,
				endTime: requestEndTime.log,
				executionTime: (Date.now() - startTime) / 1000,
				status: reportId ? 'success' : 'failure',
				reportId,
				reportType,
				range: `${range.start} to ${range.end}`,
				error: requestError,
				retryCount: currentRetry,
				attempt
			});
			
			logger.info({ reportId, attempt }, 'Report created successfully');
			
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
    const { cronDetailID, cronDetailData, user, seller } = filter;
	const rows = cronDetailData;
    logger.info({ reportCount: rows.length }, 'Found reports for status check');
    
    if (rows.length === 0) {
        logger.info('No reports found for status check');
        return [];
    }
    const isSingleEntryRow = (r) => r.FullWeekRange && r.FullMonthRange && r.FullQuarterRange;
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

                // Use type-specific range so we find the same log row as request (Range is always stored now).
                const typeSpecificRange = type === 'WEEK' ? row.FullWeekRange : type === 'MONTH' ? row.FullMonthRange : row.FullQuarterRange;
                const rowRangeStrForLog = typeSpecificRange || null;
                const reportID = await model.getLatestReportId(row.ID, type, null, rowRangeStrForLog);

                await model.logCronActivity({
                    cronJobID: row.ID,
                    reportType: type,
                    action: 'Check Status',
                    status: 1,
                    message: 'Checking report status',
                    reportID,
                    Range: rowRangeStrForLog
                });

                logger.info({ type, range: rowRangeStrForLog }, 'Checking status for report');

                const result = await checkReportStatusByType(row, type, authOverrides, reportID, retry, user, seller, rowRangeStrForLog, typeSpecificRange);
                if (result.success) {
                    res.push(result);
                }
            }
        }
    }

    if (rows.length > 0 && !isSingleEntryRow(rows[0])) {
        for (const row of rows) {
            try { await finalizeCronRunningStatus(row.ID, user); } catch (_) {}
        }
    } else {
        try { if (cronDetailID && Array.isArray(cronDetailID) ? cronDetailID[0] : cronDetailID) await finalizeCronRunningStatus(Array.isArray(cronDetailID) ? cronDetailID[0] : cronDetailID, user); } catch (_) {}
    }
    
    return retry ? res : undefined;
}


async function checkReportStatusByType(row, reportType, authOverrides = {}, reportID = null, retry = false, user = null, seller = null, rangeStrOverride = null, rangeStrForDate = null) {
    const rangeStrForLog = rangeStrOverride ?? row.FullWeekRange ?? row.FullMonthRange ?? row.FullQuarterRange ?? null;
    const reportId = reportID || await model.getLatestReportId(row.ID, reportType, null, rangeStrForLog);
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
            executionTime: 0,
            Range: rangeStrForLog
        });
        return { success: true, skipped: true, reason: 'No ReportID in logs yet' };
    }
	if (!seller) {
		logger.error({ amazonSellerID: row.AmazonSellerID }, 'Seller profile not found');
		return;
	}

	const timezone = await model.getUserTimezone(user);
	const rangeStrToParse = rangeStrForDate ?? rangeStrOverride ?? row.FullWeekRange ?? row.FullMonthRange ?? row.FullQuarterRange ?? null;
	let range;
	if (rangeStrToParse && rangeStrToParse.includes(' to ')) {
		const p = rangeStrToParse.split(' to ');
		range = { start: p[0].trim(), end: p[1].trim() };
	} else {
		range = dates.getDateRangeForPeriod(reportType, timezone);
	}
	const rangeStr = range && range.start != null && range.end != null ? `${range.start} to ${range.end}` : null;

	// Use the universal retry function
	const statusMaxRetries = Number(process.env.MAX_RETRY_ATTEMPTS) || 3;
	const result = await RetryHelpers.executeWithRetry({
		cronDetailID: row.ID,
		amazonSellerID: row.AmazonSellerID,
		reportType,
		action: 'Check Status',
		maxRetries: statusMaxRetries,
		context: { row, reportId, seller, authOverrides, isRetry: retry, user, range, rangeStr, maxRetries: statusMaxRetries },
		model,
		extraLogFields: rangeStr != null ? { Range: rangeStr } : {},
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
			const { row, reportId, seller, authOverrides, isRetry, user, range } = context;
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
			
            let res;
			let statusError = null;
            try {
                res = await sp.getReportStatus(seller, reportId, currentAuthOverrides);
            } catch (err) {
                const status = err.status || err.statusCode || err.response?.status;
                if (status === 401 || status === 403) {
                    // Force refresh and retry once
                    const refreshed = await authService.buildAuthOverrides(seller.AmazonSellerID, true);
                    if (!refreshed.accessToken) {				
                        logger.error({ amazonSellerID: seller.AmazonSellerID, attempt, user: user ? user.ID : null }, 'No access token available for request');
						statusError = new Error('No access token available for report request after forced refresh');
						
						// API Logger - Failed Status Check (No Token After Refresh)
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
							error: statusError
						});
						
                        throw statusError;
                    }
                    res = await sp.getReportStatus(seller, reportId, refreshed);
                } else {
					logger.error({
						status,
						body: err.response && (err.response.body || err.response.text),
						message: err.message,
						payload
					}, 'SP-API getReportStatus failed');
					throw err;
				}
            }
			const status = res.processingStatus;
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
				response: res,
				retryCount: currentRetry,
				attempt,
				startTime: statusStartTime.log,
				endTime: statusEndTime.log,
				executionTime: (Date.now() - startTime) / 1000,
				status: status ? 'success' : 'failure',
				error: statusError,
				reportDocumentId: res.reportDocumentId || null
			});
			
            if (status === 'DONE') {
				// Keep ReportID_* as the original reportId; store documentId separately
				const documentId = res.reportDocumentId || null;

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
                // Log report ID and document ID in cron logs (use same Range as request so we update the same row)
                const rangeStrForLog = range && range.start != null && range.end != null ? `${range.start} to ${range.end}` : null;
                await model.logCronActivity({ cronJobID: row.ID, reportType, action: 'Download Report', status: 1, message: 'Report ready', reportID: reportId, reportDocumentID: documentId, Range: rangeStrForLog });
				
				const requestDelaySeconds = Number(process.env.REQUEST_DELAY_SECONDS) || 30;
				await DelayHelpers.wait(requestDelaySeconds, 'Between report status checks and downloads (rate limiting)');

				// ProcessRunningStatus = 3 (Download)
                await model.setProcessRunningStatus(row.ID, reportType, 3);
                
				const downloadResult = await downloadReportByType(row, reportType, authOverrides, reportId, user, range, documentId, seller);
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
				// Log the status (use same Range as request so we update the same row)
				const rangeStrForLog = range && range.start != null && range.end != null ? `${range.start} to ${range.end}` : null;
				await model.logCronActivity({ 
					cronJobID: row.ID, 
					reportType, 
					action: 'Check Status', 
					status: 0, 
					message: `Report ${status.toLowerCase().replace('_',' ')} on attempt ${attempt}, waiting ${delaySeconds}s before retry`, 
					reportID: reportId, 
					retryCount: currentRetry,
					executionTime: (Date.now() - startTime) / 1000,
					Range: rangeStrForLog
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
				}
				
				// Wait before retrying
				await DelayHelpers.wait(delaySeconds, 'Before retry IN_QUEUE or IN_PROGRESS');

				// Throw error to trigger retry mechanism
				throw new Error(`Report still ${status.toLowerCase().replace('_',' ')} after ${delaySeconds}s wait - retrying`);
				
			} else if (status === 'FATAL' || status === 'CANCELLED') {
				const rangeStrForFatal = range && range.start != null && range.end != null ? `${range.start} to ${range.end}` : null;
				const res = await handleFatalOrUnknownStatus(row, reportType, status, reportId, rangeStrForFatal);

				const requestDelaySeconds = Number(process.env.REQUEST_DELAY_SECONDS) || 30;
				await DelayHelpers.wait(requestDelaySeconds, 'Between report status checks and fatal/cancelled (rate limiting)');

				return res;
			} else {
				// Unknown status - treat as error
				if(!status) {
					status = 'UNKNOWN';
				}
				const rangeStrForFatal = range && range.start != null && range.end != null ? `${range.start} to ${range.end}` : null;
				const res = await handleFatalOrUnknownStatus(row, reportType, status, reportId, rangeStrForFatal);
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

async function downloadReportByType(row, reportType, authOverrides = {}, reportId = null, user = null, range = null, reportDocumentId = '', seller = null) {
    const rangeStr = range && range.start && range.end ? `${range.start} to ${range.end}` : (row.FullWeekRange || row.FullMonthRange || row.FullQuarterRange || null);
    if (!reportId) {
        reportId = await model.getLatestReportId(row.ID, reportType, null, rangeStr);
        if (!reportId) {
            await model.logCronActivity({ cronJobID: row.ID, reportType, action: 'Download Report', status: 3, message: 'Skipping download: ReportID not found in logs', reportID: null, retryCount: 0, executionTime: 0, Range: rangeStr });
            return { success: true, skipped: true, reason: 'No ReportID in logs' };
        }
    }

	// Check if seller profile is provided
	if (!seller) {
		logger.error({ amazonSellerID: row.AmazonSellerID }, 'Seller profile not found for download');
		return;
	}

	// Use the universal retry function (include Range so we update the same log row)
	const result = await RetryHelpers.executeWithRetry({
		cronDetailID: row.ID,
		amazonSellerID: row.AmazonSellerID,
		reportType,
		action: 'Download Report',
		context: { row, reportId, seller, authOverrides, user, range, reportDocumentId },
		model,
		extraLogFields: rangeStr ? { Range: rangeStr } : {},
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
			const { row, reportId, seller, authOverrides, user, range, reportDocumentId } = context;
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
					error: { message: 'No access token available for report request but retry again on catch block' },
					retryCount: currentRetry,
					attempt
				});
				
				throw new Error('No access token available for report request but retry again on catch block');
			}
			
			// Use the reportDocumentId from status response
			const documentId = reportDocumentId || reportId;
			logger.info({ documentId, attempt }, 'Using document ID for download');
			
			// Download the report document
			let res;
			let downloadError = null;
			try {
				res = await sp.downloadReport(seller, documentId, currentAuthOverrides);
			} catch (err) {
				const status = err.status || err.statusCode || err.response?.status;
				if (status === 401 || status === 403) {
					const refreshed = await authService.buildAuthOverrides(seller.AmazonSellerID, true);
					if (!refreshed.accessToken) {				
						logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available for request');
						downloadError = new Error('No access token available for report request after forced refresh');
						
						// API Logger - Failed Download (No Token After Refresh)
						const userId = user ? user.ID : null;
						apiLogger.logDownload({
							userId,
							sellerId: seller.AmazonSellerID,
							sellerAccountId: seller.idSellerAccount,
							reportId,
							reportDocumentId: documentId,
							reportType,
							range: `${range.start} to ${range.end}`,
							fileUrl: null,
							filePath: null,
							fileSize: 0,
							rowCount: 0,
							downloadPayload: { documentId },
							startTime: downloadStartTime.log,
							endTime:  dates.getNowDateTimeInUserTimezone().log,
							executionTime: (Date.now() - startTime) / 1000,
							status: 'failure',
							error: downloadError,
							retryCount: currentRetry,
							attempt
						});
						
						throw downloadError;
					}
					res = await sp.downloadReport(seller, documentId, refreshed);
				} else {
					throw err;
				}
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
					
				} catch (fileErr) {
					logger.warn({ error: fileErr ? (fileErr.message || String(fileErr)) : 'Unknown error', attempt }, 'Failed to save JSON file');
					
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
						error: fileErr,
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

				
				const newRow = await downloadUrls.getCompletedDownloadsWithFiles(filter = { cronDetailID: row.ID, ReportType: reportType });
				
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

async function handleFatalOrUnknownStatus(row, reportType, status, reportId = null, rangeStrOverride = null) {
	const rowRangeStr = rangeStrOverride ?? row.FullWeekRange ?? row.FullMonthRange ?? row.FullQuarterRange ?? null;
	if (!reportId) {
		reportId = await model.getLatestReportId(row.ID, reportType, null, rowRangeStr);
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
        action: 'Fatal Error',
        status: 3,
        message: `Report ${status} - Permanent failure`,
        reportID: reportId,
        retryCount: 0,
        executionTime: 0,
        Range: rowRangeStr
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
        
        const anyInProgress = statuses.some(s => s === 0);
        const anyRetryNeeded = statuses.some(s => s === 2);
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

        // When cron run fully completed (no pending/retry), update seller's latest SQP pull date
        if (newStatus === 2 && row.SellerID) {
            try {
                const timezone = await model.getUserTimezone(user);
                await sellerModel.updateLastestSQPPullDateBySellerId(row.SellerID, timezone);
            } catch (err) {
                logger.error({ cronDetailID, SellerID: row.SellerID, error: err.message }, 'Failed to update dtLatestSQPPullDate after cron completion');
            }
        }
    } catch (e) {
        logger.error({ cronDetailID, error: e.message }, 'Failed to finalize cronRunningStatus');
    }
}

module.exports = {
	requestForSeller,
	checkReportStatuses,
	finalizeCronRunningStatus,
	requestSingleReport
};


