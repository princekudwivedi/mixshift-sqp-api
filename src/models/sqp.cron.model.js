const { getModel: getSqpCronDetails } = require('./sequelize/sqpCronDetails.model');
const { getModel: getSqpCronLogs } = require('./sequelize/sqpCronLogs.model');
const { getModel: getSellerAsinList } = require('./sequelize/sellerAsinList.model');
const { Op, literal } = require('sequelize');

function splitASINsIntoChunks(asins, size) {
    const chunks = [];
    for (let i = 0; i < asins.length; i += size) {
        const part = asins.slice(i, i + size);
        chunks.push({ asins: part, asin_string: part.join(' ') });
    }
    return chunks;
}

function mapPrefix(reportType) {
    if (reportType === 'WEEK') return 'Weekly';
    if (reportType === 'MONTH') return 'Monthly';
    if (reportType === 'QUARTER') return 'Quarterly';
    return '';
}

async function getActiveASINsBySeller(sellerId) {
    const SellerAsinList = getSellerAsinList();
    const rows = await SellerAsinList.findAll({ where: { SellerID: sellerId, IsActive: 1 }, attributes: ['ASIN'] });
    return rows.map(r => r.ASIN).filter(Boolean);
}

async function createSQPCronDetail(amazonSellerID, asinString) {
    const SqpCronDetails = getSqpCronDetails();
    const row = await SqpCronDetails.create({ AmazonSellerID: amazonSellerID, ASIN_List: asinString, CreatedDate: new Date(), UpdatedDate: new Date() });
    return row.ID;
}

async function getRetryCount(cronDetailID, reportType) {
    const SqpCronDetails = getSqpCronDetails();
    const row = await SqpCronDetails.findOne({ where: { ID: cronDetailID }, attributes: ['RetryCount_Weekly', 'RetryCount_Monthly', 'RetryCount_Quarterly'] });
    if (!row) return 0;
    const prefix = mapPrefix(reportType);
    return row[`RetryCount_${prefix}`] || 0;
}

async function incrementRetryCount(cronDetailID, reportType) {
    const prefix = mapPrefix(reportType);
    const SqpCronDetails = getSqpCronDetails();
    
    try {
        const result = await SqpCronDetails.update({ 
            [`RetryCount_${prefix}`]: literal(`COALESCE(${`RetryCount_${prefix}`},0)+1`),
            UpdatedDate: new Date()
        }, { 
            where: { ID: cronDetailID } 
        });
        
        console.log(`Incremented retry count for ID ${cronDetailID}, type ${reportType}, result:`, result);
        return result;
    } catch (error) {
        console.error(`Error incrementing retry count for ID ${cronDetailID}, type ${reportType}:`, error);
        throw error;
    }
}

async function updateSQPReportStatus(cronDetailID, reportType, status, reportId = null, lastError = null, documentId = null, downloadCompleted = null, startDate = undefined, endDate = undefined) {
    const prefix = mapPrefix(reportType);
    console.log(`updateSQPReportStatus called with:`, {
        cronDetailID, reportType, status, reportId, lastError, documentId, downloadCompleted, startDate, endDate
    });
    
    const data = {
        [`${prefix}SQPDataPullStatus`]: status,
        [`ReportID_${prefix}`]: reportId,
        [`LastError_${prefix}`]: lastError,
        [`ReportDocumentID_${prefix}`]: documentId,
        [`DownloadCompleted_${prefix}`]: downloadCompleted,
        UpdatedDate: new Date()
    };
    if (startDate) { 
        data[`${prefix}SQPDataPullStartDate`] = new Date(startDate); 
        console.log(`Setting ${prefix}SQPDataPullStartDate to:`, new Date(startDate));
    }
    if (endDate) { 
        data[`${prefix}SQPDataPullEndDate`] = new Date(endDate); 
        console.log(`Setting ${prefix}SQPDataPullEndDate to:`, new Date(endDate));
    }
    console.log(`Updating SQP report status for ID ${cronDetailID}, type ${reportType}:`, data);
    const SqpCronDetails = getSqpCronDetails();
    const result = await SqpCronDetails.update(data, { where: { ID: cronDetailID } });
    console.log(`Update result for ID ${cronDetailID}:`, result);
}

async function logCronActivity({ cronJobID, amazonSellerID, reportType, action, status, message, reportID = null, reportDocumentID = null, retryCount = null, downloadCompleted = null, fileSize = null, filePath = null, recordsProcessed = null, executionTime = null }) {
    const SqpCronLogs = getSqpCronLogs();
    const where = { CronJobID: cronJobID, AmazonSellerID: amazonSellerID, ReportType: reportType };
    const payload = {
        Action: action,
        Status: status,
        Message: message,
        ReportID: reportID,
        ReportDocumentID: reportDocumentID,
        RetryCount: retryCount,
        DownloadCompleted: downloadCompleted ? 1 : 0,
        RecordsProcessed: recordsProcessed,
        ExecutionTime: executionTime !== null && executionTime !== undefined ? Number(executionTime) : undefined,
        UpdatedDate: new Date()
    };
    
    // Add file metadata to message if available
    if (filePath || fileSize) {
        const fileInfo = [];
        if (filePath) fileInfo.push(`File: ${filePath}`);
        if (fileSize) fileInfo.push(`Size: ${fileSize} bytes`);
        payload.Message = `${message}${fileInfo.length > 0 ? ' | ' + fileInfo.join(' | ') : ''}`;
    }
    
    const existing = await SqpCronLogs.findOne({ where });
    if (existing) {
        await existing.update(payload);
    } else {
        await SqpCronLogs.create({
            ...where,
            ...payload,
            CreatedDate: new Date()
        });
    }
}

async function getReportsForStatusCheck() {
    // Any detail with ReportID_* present and corresponding *_Status = 0 (pending)
    const SqpCronDetails = getSqpCronDetails();
    const rows = await SqpCronDetails.findAll({
        where: {
            [Op.or]: [
                { [Op.and]: [{ ReportID_Weekly: { [Op.ne]: null } }, { WeeklySQPDataPullStatus: 0 }] },
                { [Op.and]: [{ ReportID_Monthly: { [Op.ne]: null } }, { MonthlySQPDataPullStatus: 0 }] },
                { [Op.and]: [{ ReportID_Quarterly: { [Op.ne]: null } }, { QuarterlySQPDataPullStatus: 0 }] }
            ]
        }
    });
    return rows;
}

async function getReportsForDownload() {
    // Any detail with ReportID_* present and corresponding *_Status = 1 (success) but not yet DownloadCompleted
    const SqpCronDetails = getSqpCronDetails();
    const rows = await SqpCronDetails.findAll({
        where: {
            [Op.or]: [
                { [Op.and]: [{ ReportID_Weekly: { [Op.ne]: null } }, { WeeklySQPDataPullStatus: 1 }, { DownloadCompleted_Weekly: { [Op.ne]: 1 } }] },
                { [Op.and]: [{ ReportID_Monthly: { [Op.ne]: null } }, { MonthlySQPDataPullStatus: 1 }, { DownloadCompleted_Monthly: { [Op.ne]: 1 } }] },
                { [Op.and]: [{ ReportID_Quarterly: { [Op.ne]: null } }, { QuarterlySQPDataPullStatus: 1 }, { DownloadCompleted_Quarterly: { [Op.ne]: 1 } }] }
            ]
        }
    });
    return rows;
}

/**
 * Comprehensive error handling that updates both cron details and logs
 */
async function handleCronError(cronDetailID, amazonSellerID, reportType, action, error, reportId = null) {
    const prefix = mapPrefix(reportType);
    
    try {
        // Increment retry count
        await incrementRetryCount(cronDetailID, reportType);
        
        // Update status to error (2)
        await updateSQPReportStatus(cronDetailID, reportType, 2, reportId, error.message, null, null, null, new Date());
        
        // Get current retry count for logging
        const retryCount = await getRetryCount(cronDetailID, reportType);
        
        // Log to cron logs
        await logCronActivity({
            cronJobID: cronDetailID,
            amazonSellerID: amazonSellerID,
            reportType: reportType,
            action: action,
            status: retryCount < 3 ? 3 : 2, // 3 = will retry, 2 = failed
            message: retryCount < 3 ? `${action} failed (will retry): ${error.message}` : `${action} failed: ${error.message}`,
            reportID: reportId,
            retryCount: retryCount,
            executionTime: 0
        });
        
        console.log(`Error handled for ID ${cronDetailID}, type ${reportType}, retry count: ${retryCount}`);
        
    } catch (logError) {
        console.error(`Failed to handle cron error for ID ${cronDetailID}:`, logError);
        throw logError;
    }
}

module.exports = {
    splitASINsIntoChunks,
    mapPrefix,
    getActiveASINsBySeller,
    createSQPCronDetail,
    getRetryCount,
    incrementRetryCount,
    updateSQPReportStatus,
    logCronActivity,
    getReportsForStatusCheck,
    getReportsForDownload,
    handleCronError
};


