const { query } = require('../db/mysql');
const { tables } = require('../config/env');

/**
 * Store download URL for later processing
 */
async function storeDownloadUrl(downloadUrlData) {
    try {
        // Check if download URL already exists for this report
        const checkSql = `SELECT ID FROM ${tables.sqpDownloadUrls} 
                         WHERE ReportID = ? AND AmazonSellerID = ? AND ReportType = ?`;
        const existing = await query(checkSql, [
            downloadUrlData.ReportID,
            downloadUrlData.AmazonSellerID,
            downloadUrlData.ReportType
        ]);

        if (existing.length > 0) {
            // Update existing record
            const updateSql = `UPDATE ${tables.sqpDownloadUrls} 
                              SET DownloadURL = ?, ReportDocumentID = ?, CompressionAlgorithm = ?,
                                  Status = ?, FilePath = ?, FileSize = ?, UpdatedDate = NOW()
                              WHERE ID = ?`;
            return await query(updateSql, [
                downloadUrlData.DownloadURL,
                downloadUrlData.ReportDocumentID,
                downloadUrlData.CompressionAlgorithm,
                downloadUrlData.Status,
                downloadUrlData.FilePath || null,
                Number(downloadUrlData.FileSize || 0),
                existing[0].ID
            ]);
        } else {
            // Insert new record
            const insertSql = `INSERT INTO ${tables.sqpDownloadUrls} 
                              (CronJobID, ReportID, AmazonSellerID, ReportType, DownloadURL, 
                               ReportDocumentID, CompressionAlgorithm, Status, DownloadAttempts, 
                               MaxDownloadAttempts, FilePath, FileSize, CreatedDate)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
            return await query(insertSql, [
                downloadUrlData.CronJobID,
                downloadUrlData.ReportID,
                downloadUrlData.AmazonSellerID,
                downloadUrlData.ReportType,
                downloadUrlData.DownloadURL,
                downloadUrlData.ReportDocumentID,
                downloadUrlData.CompressionAlgorithm,
                downloadUrlData.Status,
                downloadUrlData.DownloadAttempts || 0,
                downloadUrlData.MaxDownloadAttempts || 3,
                downloadUrlData.FilePath || null,
                Number(downloadUrlData.FileSize || 0)
            ]);
        }
    } catch (error) {
        console.error('Error storing download URL:', error);
        throw error;
    }
}

/**
 * Get pending download URLs for processing
 */
async function getPendingDownloadUrls(limit = 10) {
    try {
        const sql = `SELECT * FROM ${tables.sqpDownloadUrls} 
                     WHERE Status = 'PENDING' AND DownloadAttempts < MaxDownloadAttempts
                     ORDER BY CreatedDate ASC
                     LIMIT ?`;
        return await query(sql, [limit]);
    } catch (error) {
        console.error('Error getting pending download URLs:', error);
        throw error;
    }
}

/**
 * Update download URL status
 */
async function updateDownloadUrlStatus(id, status, errorMessage = null, filePath = null, fileSize = 0) {
    try {
        const updateData = {
            Status: status,
            UpdatedDate: new Date()
        };

        if (errorMessage) {
            updateData.ErrorMessage = errorMessage;
        }

        if (filePath) {
            updateData.FilePath = filePath;
            updateData.FileSize = fileSize;
        }

        if (status === 'DOWNLOADING') {
            updateData.DownloadStartTime = new Date();
        } else if (['COMPLETED', 'FAILED'].includes(status)) {
            updateData.DownloadEndTime = new Date();
        }

        if (status === 'FAILED') {
            updateData.DownloadAttempts = 'DownloadAttempts + 1';
        }

        // Build dynamic SQL
        const setClause = Object.keys(updateData)
            .map(key => {
                if (key === 'DownloadAttempts') {
                    return `${key} = ${updateData[key]}`;
                }
                return `${key} = ?`;
            })
            .join(', ');

        const values = Object.values(updateData).filter(val => val !== 'DownloadAttempts + 1');

        const sql = `UPDATE ${tables.sqpDownloadUrls} SET ${setClause} WHERE ID = ?`;
        return await query(sql, [...values, id]);
    } catch (error) {
        console.error('Error updating download URL status:', error);
        throw error;
    }
}

/**
 * Store report data in sqp_metrics_3mo table
 */
async function storeReportData(reportData) {
    try {
        // Remove duplicates before insertion (by ReportID/Seller/Type)
        await removeDuplicateReportData(reportData.ReportID, reportData.AmazonSellerID, reportData.ReportType);

        const sql = `INSERT INTO ${tables.sqpMetrics3mo}
                     (ReportID, AmazonSellerID, ReportType, ReportDate, ASIN, Query,
                      Impressions, Clicks, ClickThroughRate, CostPerClick, Spend,
                      Orders, Sales, ACoS, ConversionRate, CreatedDate)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;

        return await query(sql, [
            reportData.ReportID,
            reportData.AmazonSellerID,
            reportData.ReportType,
            reportData.ReportDate,
            reportData.ASIN,
            reportData.Query,
            reportData.Impressions,
            reportData.Clicks,
            reportData.ClickThroughRate,
            reportData.CostPerClick,
            reportData.Spend,
            reportData.Orders,
            reportData.Sales,
            reportData.ACoS,
            reportData.ConversionRate
        ]);
    } catch (error) {
        console.error('Error storing report data into sqp_metrics_3mo:', error);
        throw error;
    }
}

/**
 * Remove duplicate report data from sqp_metrics_3mo
 */
async function removeDuplicateReportData(reportID, amazonSellerID, reportType) {
    try {
        const sql = `DELETE FROM ${tables.sqpMetrics3mo} 
                     WHERE ReportID = ? AND AmazonSellerID = ? AND ReportType = ?`;
        return await query(sql, [reportID, amazonSellerID, reportType]);
    } catch (error) {
        console.error('Error removing duplicate report data from sqp_metrics_3mo:', error);
        throw error;
    }
}

/**
 * Get download URL statistics
 */
async function getDownloadUrlStats() {
    try {
        const sql = `SELECT 
                        Status,
                        COUNT(*) as count,
                        AVG(DownloadAttempts) as avg_attempts
                     FROM ${tables.sqpDownloadUrls}
                     GROUP BY Status`;
        return await query(sql);
    } catch (error) {
        console.error('Error getting download URL stats:', error);
        throw error;
    }
}

module.exports = {
    storeDownloadUrl,
    getPendingDownloadUrls,
    updateDownloadUrlStatus,
    storeReportData,
    removeDuplicateReportData,
    getDownloadUrlStats
};
