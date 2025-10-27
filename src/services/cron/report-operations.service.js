/**
 * Report Operations Service
 * Centralized service for Amazon SP-API report operations
 * Eliminates duplicate code across controllers
 */

const sp = require('../../spapi/client.spapi');
const logger = require('../../utils/logger.utils');
const env = require('../../config/env.config');
const { RetryHelpers, DelayHelpers } = require('../../helpers/sqp.helpers');

class ReportOperationsService {
    /**
     * Request a report from Amazon SP-API
     * @param {Object} params - Request parameters
     * @returns {Promise<Object>} Report ID and metadata
     */
    async requestReport({ seller, asinList, range, reportType, authOverrides, cronDetailID, model, isInitialPull = false }) {
        const result = await RetryHelpers.executeWithRetry({
            cronDetailID,
            amazonSellerID: seller.AmazonSellerID,
            reportType,
            action: isInitialPull ? 'Initial Pull - Request Report' : 'Request Report',
            context: { seller, asinList, range, reportType, reportId: null },
            model,
            maxRetries: 3,
            skipIfMaxRetriesReached: true,
            extraLogFields: isInitialPull ? { Range: range.range, iInitialPull: 1 } : {},
            operation: async ({ attempt, currentRetry, context, startTime }) => {
                // Set ProcessRunningStatus
                await model.setProcessRunningStatus(cronDetailID, reportType, 1);
                
                // Prepare ASIN string (max 20 ASINs, 200 chars)
                const asinString = asinList.slice(0, 20).join(' ').substring(0, 200);
                
                // Build payload
                const payload = {
                    reportType: env.GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT,
                    dataStartTime: `${range.startDate}T00:00:00Z`,
                    dataEndTime: `${range.endDate}T23:59:59Z`,
                    marketplaceIds: [seller.AmazonMarketplaceId],
                    reportOptions: { asin: asinString, reportPeriod: range.type }
                };

                // Verify access token
                if (!authOverrides.accessToken) {
                    logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available');
                    throw new Error('No access token available for report request');
                }

                // Create report via SP-API
                const resp = await sp.createReport(seller, payload, authOverrides);
                const reportId = resp.reportId;
                
                logger.info({ reportId, range: range.range, attempt }, 'Report created successfully');
                
                // Update status
                if (range.range) {
                    await model.updateSQPReportStatus(cronDetailID, reportType, 0, new Date());
                    
                    // Log activity
                    await model.logCronActivity({
                        cronJobID: cronDetailID,
                        reportType,
                        action: isInitialPull ? 'Initial Pull - Request Report' : 'Request Report',
                        status: 1,
                        message: `Report requested: ${range.range}`,
                        reportID: reportId,
                        Range: range.range,
                        iInitialPull: isInitialPull ? 1 : 0,
                        retryCount: 0,
                        executionTime: (Date.now() - startTime) / 1000
                    });
                }
                
                // Rate limiting delay
                const requestDelaySeconds = Number(process.env.REQUEST_DELAY_SECONDS) || 30;
                await DelayHelpers.wait(requestDelaySeconds, 'Between report requests (rate limiting)');
                
                return {
                    message: `Report requested successfully. Report ID: ${reportId}. Range: ${range.range}`,
                    reportID: reportId,
                    data: { reportId, range: range.range },
                    logData: isInitialPull ? { Range: range.range, iInitialPull: 1 } : {}
                };
            }
        });
        
        return result;
    }

    /**
     * Check report status from Amazon SP-API
     * @param {Object} params - Status check parameters
     * @returns {Promise<Object>} Status and document ID if ready
     */
    async checkReportStatus({ seller, reportId, range, reportType, authOverrides, cronDetailID, model, downloadUrls, isInitialPull = false, retry = false }) {
        const result = await RetryHelpers.executeWithRetry({
            cronDetailID,
            amazonSellerID: seller.AmazonSellerID,
            reportType,
            action: isInitialPull ? 'Initial Pull - Check Status' : 'Check Status',
            context: { seller, reportId, range, reportType, retry },
            model,
            maxRetries: 3,
            skipIfMaxRetriesReached: true,
            extraLogFields: isInitialPull ? { Range: range.range, iInitialPull: 1 } : {},
            operation: async ({ attempt, currentRetry, context, startTime }) => {
                // Set ProcessRunningStatus = 2 (Status Check)
                await model.setProcessRunningStatus(cronDetailID, reportType, 2);
                
                // Verify access token
                if (!authOverrides.accessToken) {
                    logger.error({ amazonSellerID: seller.AmazonSellerID, attempt }, 'No access token available');
                    throw new Error('No access token available for status check');
                }
                
                // Check report status
                const res = await sp.getReportStatus(seller, reportId, authOverrides);
                const status = res.processingStatus;
                
                if (status === 'DONE') {
                    const documentId = res.reportDocumentId || null;
                    
                    // Update status to indicate report is ready
                    await model.updateSQPReportStatus(cronDetailID, reportType, 1);
                    
                    // Store for download queue
                    await downloadUrls.storeDownloadUrl({
                        CronJobID: cronDetailID,
                        ReportID: reportId,
                        ReportType: reportType,
                        DownloadURL: '',
                        Status: 'PENDING',
                        DownloadAttempts: 0,
                        MaxDownloadAttempts: 3
                    });
                    
                    logger.info({ reportId, documentId, range: range.range }, 'Report ready for download');
                    
                    return {
                        status: 'DONE',
                        documentId,
                        message: `Report ${reportId} is ready for download`,
                        data: { reportId, documentId, status: 'DONE' }
                    };
                }
                
                // Still processing
                logger.info({ reportId, status, range: range.range }, 'Report still processing');
                
                return {
                    status,
                    message: `Report ${reportId} status: ${status}`,
                    data: { reportId, status }
                };
            }
        });
        
        return result;
    }

    /**
     * Download and process report from Amazon SP-API
     * @param {Object} params - Download parameters
     * @returns {Promise<Object>} Downloaded data
     */
    async downloadReport({ seller, reportId, documentId, range, reportType, authOverrides, cronDetailID, model, downloadUrls, jsonSvc, isInitialPull = false, retry = false }) {
        const result = await RetryHelpers.executeWithRetry({
            cronDetailID,
            amazonSellerID: seller.AmazonSellerID,
            reportType,
            action: isInitialPull ? 'Initial Pull - Download Report' : 'Download Report',
            context: { seller, reportId, documentId, range, reportType, retry },
            model,
            maxRetries: 3,
            skipIfMaxRetriesReached: true,
            extraLogFields: isInitialPull ? { Range: range.range, iInitialPull: 1 } : {},
            operation: async ({ attempt, currentRetry, context, startTime }) => {
                logger.info({ reportId, documentId, range: range.range, attempt }, 'Starting report download');
                
                // Set ProcessRunningStatus = 3 (Download)
                await model.setProcessRunningStatus(cronDetailID, reportType, 3);
                
                // Verify access token
                if (!authOverrides.accessToken) {
                    logger.error({ amazonSellerID: seller.AmazonSellerID }, 'No access token available');
                    throw new Error('No access token available for download');
                }
                
                // Download report data
                const res = await sp.downloadReport(seller, documentId, reportType, authOverrides);
                
                // Extract data
                let data = [];
                if (Array.isArray(res)) {
                    data = res;
                } else if (Array.isArray(res?.data)) {
                    data = res.data;
                } else if (Array.isArray(res?.data?.records)) {
                    data = res.data.records;
                } else if (Array.isArray(res?.data?.dataByAsin)) {
                    data = res.data.dataByAsin;
                }
                
                logger.info({ rows: data.length, range: range.range, attempt }, 'Report data received');
                
                if (data.length > 0) {
                    // Save JSON file
                    const downloadMeta = { 
                        AmazonSellerID: seller.AmazonSellerID, 
                        ReportType: reportType, 
                        ReportID: documentId || reportId
                    };
                    
                    let filePath = null;
                    let fileSize = 0;
                    
                    try {
                        const saveResult = await jsonSvc.saveReportJsonFile(downloadMeta, data);
                        filePath = saveResult?.path || saveResult?.url || null;
                        
                        if (filePath) {
                            const fs = require('fs');
                            const stat = await fs.promises.stat(filePath).catch(() => null);
                            fileSize = stat ? stat.size : 0;
                            logger.info({ filePath, fileSize, range: range.range }, 'JSON saved successfully');
                        }
                    } catch (fileErr) {
                        logger.warn({ error: fileErr.message, range: range.range }, 'Failed to save JSON file');
                    }
                    
                    // Update download URL record
                    await downloadUrls.updateDownloadUrlStatusByCriteria(
                        cronDetailID,
                        reportType,
                        'COMPLETED',
                        null,
                        filePath,
                        fileSize,
                        false,
                        reportId
                    );
                    
                    // Log download
                    await model.logCronActivity({
                        cronJobID: cronDetailID,
                        reportType,
                        action: isInitialPull ? 'Initial Pull - Download Report' : 'Download Report',
                        status: 1,
                        message: `Downloaded report for ${range.range}`,
                        reportID: reportId,
                        reportDocumentID: documentId,
                        Range: range.range,
                        iInitialPull: isInitialPull ? 1 : 0,
                        executionTime: (Date.now() - startTime) / 1000
                    });
                    
                    // Import data immediately
                    const newRow = await downloadUrls.getCompletedDownloadsWithFiles({ 
                        cronDetailID, 
                        ReportType: reportType, 
                        ReportID: reportId 
                    });
                    
                    if (newRow.length > 0) {
                        const plainRow = newRow[0].toJSON ? newRow[0].toJSON() : newRow[0];
                        const enrichedRow = { 
                            ...plainRow, 
                            AmazonSellerID: seller.AmazonSellerID, 
                            ReportID: reportId, 
                            SellerID: seller.idSellerAccount 
                        };
                        
                        logger.info({ cronDetailID, reportType, range: range.range }, 'Starting data import');
                        
                        // Import JSON data
                        const importResult = await jsonSvc.__importJson(enrichedRow, 0, 0, isInitialPull ? 1 : 0);
                        
                        logger.info({ cronDetailID, reportType, range: range.range, importResult }, 'Import completed successfully');
                        
                        // Log import success
                        await model.logCronActivity({
                            cronJobID: cronDetailID,
                            reportType,
                            action: isInitialPull ? 'Initial Pull - Import Done' : 'Import Done',
                            status: 1,
                            message: `Imported data for ${range.range}`,
                            reportID: reportId,
                            reportDocumentID: documentId,
                            Range: range.range,
                            iInitialPull: isInitialPull ? 1 : 0,
                            executionTime: (Date.now() - startTime) / 1000
                        });
                        
                        return {
                            message: `Report downloaded and imported successfully`,
                            data: { reportId, documentId, recordCount: data.length, importResult },
                            reportDocumentID: documentId
                        };
                    }
                }
                
                // No data scenario
                logger.warn({ reportId, range: range.range }, 'Report contains no data');
                
                return {
                    message: `Report downloaded but contains no data`,
                    data: { reportId, documentId, recordCount: 0 }
                };
            }
        });
        
        return result;
    }

    /**
     * Complete workflow: Request → Check → Download
     * @param {Object} params - Complete workflow parameters
     * @returns {Promise<Object>} Final result
     */
    async completeReportWorkflow(params) {
        const { seller, asinList, range, reportType, authOverrides, cronDetailID, model, downloadUrls, jsonSvc, isInitialPull = false } = params;
        
        try {
            // Step 1: Request report
            const requestResult = await this.requestReport({
                seller, asinList, range, reportType, authOverrides, cronDetailID, model, isInitialPull
            });
            
            const reportId = requestResult.reportID || requestResult.data?.reportId;
            
            if (!reportId) {
                throw new Error('Failed to get report ID from request');
            }
            
            // Step 2: Wait for report to be ready
            const initialDelay = Number(process.env.INITIAL_DELAY_SECONDS) || 30;
            await DelayHelpers.wait(initialDelay, 'Before status check');
            
            // Step 3: Check status
            const statusResult = await this.checkReportStatus({
                seller, reportId, range, reportType, authOverrides, cronDetailID, model, downloadUrls, isInitialPull
            });
            
            if (statusResult.status !== 'DONE') {
                return {
                    success: false,
                    message: `Report not ready yet. Status: ${statusResult.status}`,
                    data: { reportId, status: statusResult.status }
                };
            }
            
            const documentId = statusResult.documentId;
            
            // Step 4: Download and import
            const downloadResult = await this.downloadReport({
                seller, reportId, documentId, range, reportType, authOverrides, cronDetailID, model, downloadUrls, jsonSvc, isInitialPull
            });
            
            return {
                success: true,
                message: 'Complete workflow finished successfully',
                data: { reportId, documentId, ...downloadResult.data }
            };
            
        } catch (error) {
            logger.error({ 
                error: error.message, 
                seller: seller.AmazonSellerID, 
                reportType, 
                range: range.range 
            }, 'Complete workflow failed');
            
            throw error;
        }
    }
}

// Export singleton instance
module.exports = new ReportOperationsService();

