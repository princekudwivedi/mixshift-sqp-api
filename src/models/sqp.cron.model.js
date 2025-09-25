const { getModel: getSqpCronDetails } = require('./sequelize/sqpCronDetails.model');
const { getModel: getSqpCronLogs } = require('./sequelize/sqpCronLogs.model');
const { getModel: getSellerAsinList } = require('./sequelize/sellerAsinList.model');
const { Op, literal } = require('sequelize');

function splitASINsIntoChunks(asins, maxChars = 200) {
    // Split ASINs into space-separated chunks where each concatenated string <= maxChars
    const chunks = [];
    const normalized = (asins || []).map(a => String(a).trim()).filter(Boolean);
    let current = [];
    let currentLen = 0;

    for (const asin of normalized) {
        const addLen = current.length === 0 ? asin.length : asin.length + 1; // +1 space when not first
        if (currentLen + addLen > maxChars) {
            if (current.length > 0) {
                chunks.push({ asins: current.slice(), asin_string: current.join(' ') });
            }
            current = [asin];
            currentLen = asin.length;
        } else {
            current.push(asin);
            currentLen += addLen;
        }
    }
    if (current.length > 0) {
        chunks.push({ asins: current.slice(), asin_string: current.join(' ') });
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

async function updateSQPReportStatus(cronDetailID, reportType, status, _reportId = null, _lastError = null, _documentId = null, _downloadCompleted = null, startDate = undefined, endDate = undefined) {
    const prefix = mapPrefix(reportType);
    const data = {
        [`${prefix}SQPDataPullStatus`]: status,
        UpdatedDate: new Date()
    };
    if (startDate) {
        data[`${prefix}SQPDataPullStartDate`] = new Date(startDate);
    }
    if (endDate) {
        data[`${prefix}SQPDataPullEndDate`] = new Date(endDate);
    }
    const SqpCronDetails = getSqpCronDetails();
    await SqpCronDetails.update(data, { where: { ID: cronDetailID } });
}

async function logCronActivity({ cronJobID, reportType, action, status, message, reportID = null, reportDocumentID = null, retryCount = null, executionTime = null }) {
    const SqpCronLogs = getSqpCronLogs();
    const where = { CronJobID: cronJobID, ReportType: reportType };
    const payload = {
        Action: action,
        Status: status,
        Message: message,
        ReportID: reportID,
        RetryCount: retryCount,
        ExecutionTime: executionTime != null ? Number(executionTime) : undefined,
        UpdatedDate: new Date()
    };
      
    if (reportDocumentID != null && reportDocumentID != undefined) {
        payload.ReportDocumentID = reportDocumentID;
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

async function getLatestReportId(cronJobID, reportType) {
    const SqpCronLogs = getSqpCronLogs();
    const row = await SqpCronLogs.findOne({
        where: { CronJobID: cronJobID, ReportType: reportType, ReportID: { [Op.ne]: null } },
        order: [['UpdatedDate', 'DESC']],
        attributes: ['ReportID']
    });
    return row ? row.ReportID : null;
}

async function setProcessRunningStatus(cronDetailID, reportType, status) {
    try {
        const prefix = mapPrefix(reportType);
        const SqpCronDetails = getSqpCronDetails();
        await SqpCronDetails.update({ [`${prefix}ProcessRunningStatus`]: Number(status), UpdatedDate: new Date() }, { where: { ID: cronDetailID } });
    } catch (error) {
        console.error('Failed to update ProcessRunningStatus:', error.message);
    }
}

async function getReportsForStatusCheck() {
    const SqpCronDetails = getSqpCronDetails();
    return SqpCronDetails.findAll({
        where: {
            [Op.or]: [
                { WeeklySQPDataPullStatus: 0},
                { MonthlySQPDataPullStatus: 0},
                { QuarterlySQPDataPullStatus: 0}
            ]
        }
    });
}

async function getReportsForDownload() {
    const SqpCronDetails = getSqpCronDetails();
    return SqpCronDetails.findAll({
        where: {
            [Op.or]: [
                { WeeklySQPDataPullStatus: 0},
                { MonthlySQPDataPullStatus: 0},
                { QuarterlySQPDataPullStatus: 0}
            ]
        }
    });
}

/**
 * Comprehensive error handling that updates both cron details and logs
 */
async function handleCronError(cronDetailID, amazonSellerID, reportType, action, error, reportId = null) {
    const prefix = mapPrefix(reportType);
    
    try {
        // Update status to error (2)
        await updateSQPReportStatus(cronDetailID, reportType, 2, reportId, error.message, null, null, null, new Date());

        // Log to cron logs
        await logCronActivity({
            cronJobID: cronDetailID,
            reportType: reportType,
            action: action,
            status: 2,
            message: `${action} failed: ${error.message}`,
            reportID: reportId,
            retryCount: 0,
            executionTime: 0
        });
        
        console.log(`Error handled for ID ${cronDetailID}, type ${reportType}`);
        
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
    getLatestReportId,
    updateSQPReportStatus,
    logCronActivity,
    setProcessRunningStatus,
    getReportsForStatusCheck,
    getReportsForDownload,
    handleCronError
};


