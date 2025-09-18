const fs = require('fs').promises;
const path = require('path');
const sqpDownloadUrlsModel = require('../models/sqp.download.urls.model');
const sqpMetricsModel = require('../models/sqp.metrics.model');
const { ValidationHelpers, DateHelpers, FileHelpers, DataProcessingHelpers, NotificationHelpers } = require('../helpers/sqp.helpers');
const logger = require('../utils/logger.utils');

/**
 * Copy data from sqp_metrics_3mo to sqp_metrics with bulk insert for better performance
 */
async function copyDataWithBulkInsert(options = {}) {
    try {
        const { 
            batchSize = 1000, 
            force = false, 
            dryRun = false 
        } = options;
        
        logger.info({ batchSize, force, dryRun }, 'Starting bulk copy process');
        
        // Get reportIDs from sqp_download_urls that have data in sqp_metrics_3mo
        const reportIdsWithData = await sqpMetricsModel.getReportIdsWithDataIn3mo();        
        if (reportIdsWithData.length === 0) {
            logger.info('No reports with data found in 3mo table');
            return { processed: 0, copied: 0, errors: 0 };
        }
        
        logger.info({ reportCount: reportIdsWithData.length }, 'Found reports with data in 3mo table');
        
        if (dryRun) {
            return await performDryRun(reportIdsWithData);
        }
        
        const { getModel: getSqpMetrics3mo } = require('../models/sequelize/sqpMetrics3mo.model');
        const { getModel: getSqpMetrics } = require('../models/sequelize/sqpMetrics.model');
        const SqpMetrics3mo = getSqpMetrics3mo();
        const SqpMetrics = getSqpMetrics();
        
        let totalCopied = 0;
        let totalErrors = 0;
        let processedReports = 0;
        let successfullyCopiedReportIds = [];
        
        // Process reports in batches
        for (let i = 0; i < reportIdsWithData.length; i += batchSize) {
            const batch = reportIdsWithData.slice(i, i + batchSize);
            
            for (const reportID of batch) {
                try {
                    // Get all records from 3mo table for this report
                    const records3mo = await SqpMetrics3mo.findAll({ 
                        where: { ReportID: reportID },
                        raw: true 
                    });
                    
                    if (records3mo.length === 0) {
                        logger.debug({ reportID }, 'No records found in 3mo table for this report');
                        continue;
                    }
                    
                    // Check if data already exists in main table (unless force is enabled)
                    if (!force) {
                        const existingCount = await SqpMetrics.count({ where: { ReportID: reportID } });
                        if (existingCount > 0) {
                            logger.debug({ 
                                reportID, 
                                existingCount 
                            }, 'Records already exist in main table, skipping');
                            continue;
                        }
                    }
                    
                    // Dedupe records on logical key (ASIN + SearchQuery + ReportDate)
                    const makeKey = (r) => `${r.ASIN || ''}|${r.SearchQuery || ''}|${r.ReportDate || ''}`;
                    const uniqueMap = new Map();
                    for (const r of records3mo) {
                        uniqueMap.set(makeKey(r), r);
                    }

                    // Prepare records for bulk insert (remove ID fields)
                    const recordsToInsert = Array.from(uniqueMap.values()).map(record => {
                        const { ID, ...recordData } = record;
                        return recordData;
                    });
                    
                    // Bulk insert into main table
                    await SqpMetrics.bulkCreate(recordsToInsert);
                    
                    totalCopied += recordsToInsert.length;
                    processedReports++;
                    successfullyCopiedReportIds.push(reportID);
                    
                    logger.info({ 
                        reportID, 
                        recordsCopied: recordsToInsert.length 
                    }, 'Successfully copied report data');
                    
                } catch (error) {
                    logger.error({ 
                        error: error.message,
                        stack: error.stack,
                        reportID
                    }, 'Error copying report data');
                    totalErrors++;
                }
            }
        }
        
        // Update download URLs to mark data as copied to main table
        if (successfullyCopiedReportIds.length > 0) {
            try {
                await sqpDownloadUrlsModel.markDataCopiedToMain(successfullyCopiedReportIds);
                logger.info({ 
                    reportCount: successfullyCopiedReportIds.length 
                }, 'Updated download URLs to mark data as copied to main table');
            } catch (error) {
                logger.error({ 
                    error: error.message,
                    reportIds: successfullyCopiedReportIds 
                }, 'Error updating download URLs copy flag');
                // Don't fail the entire process if flag update fails
            }
        }
        
        logger.info({ 
            processedReports,
            totalCopied, 
            totalErrors 
        }, 'Bulk copy process completed');
        
        return { processed: processedReports, copied: totalCopied, errors: totalErrors };
        
    } catch (error) {
        logger.error({ error: error.message }, 'Error in bulk copy process');
        throw error;
    }
}

/**
 * Perform a dry run to show what would be copied
 */
async function performDryRun(reportIdsWithData) {
    try {
        logger.info({ reportCount: reportIdsWithData.length }, 'Performing dry run');
        
        const { getModel: getSqpMetrics3mo } = require('../models/sequelize/sqpMetrics3mo.model');
        const SqpMetrics3mo = getSqpMetrics3mo();
        
        let totalRecords = 0;
        
        for (const reportID of reportIdsWithData) {
            // Count distinct logical rows (ASIN + SearchQuery). Adjust if needed.
            const rows = await SqpMetrics3mo.findAll({
                where: { ReportID: reportID },
                attributes: ['ASIN', 'SearchQuery'],
                group: ['ASIN', 'SearchQuery'],
                raw: true
            });
            totalRecords += rows.length;
        }
        
        logger.info({ 
            totalReports: reportIdsWithData.length,
            totalRecords 
        }, 'Dry run completed');
        
        return { processed: reportIdsWithData.length, copied: totalRecords, errors: 0 };
        
    } catch (error) {
        logger.error({ error: error.message }, 'Error in dry run');
        throw error;
    }
}

module.exports = {
    copyDataWithBulkInsert,
    performDryRun
};
