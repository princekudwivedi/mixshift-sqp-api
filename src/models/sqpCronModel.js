const { query } = require('../db/mysql');
const { tables } = require('../config/env');

function mapPrefix(period) {
    const p = String(period || '').toUpperCase();
    if (p === 'WEEK') return 'Weekly';
    if (p === 'MONTH') return 'Monthly';
    if (p === 'QUARTER') return 'Quarterly';
    return p[0] ? p[0] + p.slice(1).toLowerCase() : '';
}

async function getActiveASINsBySeller(sellerId) {
    const sql = `SELECT ASIN, IsActive, AmazonSellerID, SellerID, LastSQPDataPullStatus, LastSQPDataPullStartTime, LastSQPDataPullEndTime
                 FROM ${tables.sellerAsinList}
                 WHERE SellerID = ? AND IsActive = 1 AND ASIN <> ''
                 ORDER BY ASIN`;
    return query(sql, [sellerId]);
}

function splitASINsIntoChunks(asins, maxChars = 200) {
    const chunks = [];
    let current = '';
    let list = [];
    for (const row of asins) {
        const asin = row.ASIN || String(row).trim();
        const test = current ? `${current} ${asin}` : asin;
        if (test.length <= maxChars) {
            current = test; list.push(asin);
        } else {
            if (current) chunks.push({ asins: list.slice(), asin_string: current, char_count: current.length });
            current = asin; list = [asin];
        }
    }
    if (current) chunks.push({ asins: list.slice(), asin_string: current, char_count: current.length });
    return chunks;
}

async function createSQPCronDetail(amazonSellerID, asinList) {
    const sql = `INSERT INTO ${tables.sqpCronDetails} (AmazonSellerID, ASIN_List, CreatedDate, UpdatedDate)
                 VALUES (?, ?, NOW(), NOW())`;
    const rows = await query(sql, [amazonSellerID, asinList]);
    return rows.insertId;
}

async function updateSQPReportStatus(cronDetailID, reportType, status, reportID = null, errorMessage = null, reportDocumentID = null, downloadCompleted = false) {
    const prefix = mapPrefix(reportType);
    const startField = `${prefix}SQPDataPullStartDate`;
    const endField = `${prefix}SQPDataPullEndDate`;
    const statusField = `${prefix}SQPDataPullStatus`;
    const reportField = `ReportID_${prefix}`;
    const documentField = `ReportDocumentID_${prefix}`;
    const downloadField = `DownloadCompleted_${prefix}`;
    const errorField = `LastError_${prefix}`;

    console.log('updateSQPReportStatus called with:', {
        cronDetailID,
        reportType,
        status,
        reportID,
        errorMessage,
        prefix,
        reportField
    });

    let sets = [`${statusField} = ?`];
    const params = [status];
    
    if (status === 1) {
        sets.push(`${endField} = NOW()`);
        if (reportID) {
            sets.push(`${reportField} = ?`);
            params.push(reportID);
        }
        if (reportDocumentID) {
            sets.push(`${documentField} = ?`);
            params.push(reportDocumentID);
        }
        if (downloadCompleted) {
            sets.push(`${downloadField} = 1`);
        }
    } else if (status === 2) {
        sets.push(`${endField} = NOW()`);
        if (errorMessage) {
            sets.push(`${errorField} = ?`);
            params.push(errorMessage);
        }
    } else if (status === 0) {
        sets.push(`${startField} = NOW()`, `${endField} = NULL`);
        if (reportID) {
            sets.push(`${reportField} = ?`);
            params.push(reportID);
        }
        // Reset download completion flag when starting new request
        sets.push(`${downloadField} = 0`);
    }
    
    params.push(cronDetailID); // Add cronDetailID as the last parameter for WHERE clause

    const sql = `UPDATE ${tables.sqpCronDetails} SET ${sets.join(', ')} WHERE ID = ?`;
    console.log('SQL to execute:', sql);
    console.log('Parameters:', params);
    
    const result = await query(sql, params);
    console.log('Update result:', result);
    return result;
}

async function incrementRetryCount(cronDetailID, reportType) {
    const prefix = mapPrefix(reportType);
    const field = `RetryCount_${prefix}`;
    const sql = `UPDATE ${tables.sqpCronDetails} SET ${field} = ${field} + 1 WHERE ID = ?`;
    return query(sql, [cronDetailID]);
}

async function getRetryCount(cronDetailID, reportType) {
    const prefix = mapPrefix(reportType);
    const field = `RetryCount_${prefix}`;
    const sql = `SELECT ${field} AS cnt FROM ${tables.sqpCronDetails} WHERE ID = ?`;
    const rows = await query(sql, [cronDetailID]);
    return rows[0] ? rows[0].cnt : 0;
}

async function logCronActivity({ cronJobID, amazonSellerID, reportType, action, status, message = null, reportID = null, reportDocumentID = null, downloadCompleted = false, recordsProcessed = 0, fileSize = 0, filePath = null, retryCount = 0, executionTime = 0 }) {
    try {
        // First, check if a row already exists for this reportType
        const checkSql = `SELECT ID FROM ${tables.cronLogs} 
            WHERE CronJobID = ? AND AmazonSellerID = ? AND ReportType = ? 
            LIMIT 1`;
        
        const existingRows = await query(checkSql, [cronJobID, amazonSellerID, reportType]);
        
        if (existingRows && existingRows.length > 0) {
            // Row exists - UPDATE it
            const updateSql = `UPDATE ${tables.cronLogs} 
                SET Action = ?, Status = ?, Message = ?, ReportID = ?, ReportDocumentID = ?, DownloadCompleted = ?, 
                    RecordsProcessed = ?, FileSize = ?, FilePath = ?, RetryCount = ?, ExecutionTime = ?, CreatedDate = NOW()
                WHERE CronJobID = ? AND AmazonSellerID = ? AND ReportType = ?`;
            
            return await query(updateSql, [action, status, message, reportID, reportDocumentID, downloadCompleted, recordsProcessed, fileSize, filePath, retryCount, executionTime, cronJobID, amazonSellerID, reportType]);
        } else {
            // Row doesn't exist - INSERT new one
            const insertSql = `INSERT INTO ${tables.cronLogs}
                (CronJobID, AmazonSellerID, ReportType, Action, Status, Message, ReportID, ReportDocumentID, DownloadCompleted, 
                 RecordsProcessed, FileSize, FilePath, RetryCount, ExecutionTime, CreatedDate)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
            
            return await query(insertSql, [cronJobID, amazonSellerID, reportType, action, status, message, reportID, reportDocumentID, downloadCompleted, recordsProcessed, fileSize, filePath, retryCount, executionTime]);
        }
    } catch (error) {
        console.error('Failed to log cron activity:', error.message);
        return null;
    }
}

async function getReportsForStatusCheck() {
    const t = tables.sqpCronDetails;
    // Check for pending reports across all rows and periods
    const sql = `SELECT * FROM ${t} WHERE (WeeklySQPDataPullStatus = 0 AND ReportID_Weekly IS NOT NULL)
        OR (MonthlySQPDataPullStatus = 0 AND ReportID_Monthly IS NOT NULL)
        OR (QuarterlySQPDataPullStatus = 0 AND ReportID_Quarterly IS NOT NULL)`;
    return query(sql);
}

async function getReportsForDownload() {
    const t = tables.sqpCronDetails;
    const sql = `SELECT * FROM ${t} WHERE (WeeklySQPDataPullStatus = 1 AND ReportID_Weekly IS NOT NULL)
        OR (MonthlySQPDataPullStatus = 1 AND ReportID_Monthly IS NOT NULL)
        OR (QuarterlySQPDataPullStatus = 1 AND ReportID_Quarterly IS NOT NULL)`;
    return query(sql);
}

// Removed legacy sqp_report_data storing; using sqp_metrics_3mo only

async function insertSQPMetrics3Mo(metricsData) {
    try {
        const sql = `INSERT INTO sqp_metrics_3mo 
            (amazon_seller_id, report_type, asin, query, impressions, clicks, click_through_rate, 
             cart_adds, cart_add_rate, purchases, purchase_rate, revenue, report_date, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        
        const values = [
            metricsData.amazon_seller_id,
            metricsData.report_type,
            metricsData.asin,
            metricsData.query,
            metricsData.impressions,
            metricsData.clicks,
            metricsData.click_through_rate,
            metricsData.cart_adds,
            metricsData.cart_add_rate,
            metricsData.purchases,
            metricsData.purchase_rate,
            metricsData.revenue,
            metricsData.report_date,
            metricsData.created_at
        ];
        
        return await query(sql, values);
    } catch (error) {
        console.error('Failed to insert SQP metrics 3mo:', error.message);
        throw error;
    }
}

module.exports = {
    getActiveASINsBySeller,
    splitASINsIntoChunks,
    createSQPCronDetail,
    updateSQPReportStatus,
    incrementRetryCount,
    getRetryCount,
    logCronActivity,
    getReportsForStatusCheck,
    getReportsForDownload,
    mapPrefix,
    insertSQPMetrics3Mo,
};


