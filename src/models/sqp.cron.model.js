const { getModel: getSqpCronDetails } = require('./sequelize/sqpCronDetails.model');
const { getModel: getSqpCronLogs } = require('./sequelize/sqpCronLogs.model');
const { getModel: getSellerAsinList } = require('./sequelize/sellerAsinList.model');
const { Op, literal } = require('sequelize');
const logger = require('../utils/logger.utils');
const env = require('../config/env.config');

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

async function getActiveASINsBySeller(sellerId = null, limit = true) {
    const SellerAsinList = getSellerAsinList();
    const sellerFilter = sellerId ? { SellerID: sellerId } : {};
    const baseWhere = { IsActive: 1, LastSQPDataPullStatus: { [Op.or]: [null] }, ...sellerFilter };
    // Pending ASINs
    const pendingAsins = await SellerAsinList.findAll({
        where: baseWhere,
        attributes: ['ASIN'],
        ...(limit ? { limit: env.MAX_ASINS_PER_REQUEST } : {}),
        order: [['dtCreatedOn', 'ASC']]
    });
    if (!limit) logger.info({ batchSize: pendingAsins.length }, 'Selected all pending ASINs for processing');

    // Return early if enough pending ASINs
    if (pendingAsins.length >= env.MAX_ASINS_PER_REQUEST) {
        logger.info({ sellerId, batchSize: pendingAsins.length }, `Selected ${env.MAX_ASINS_PER_REQUEST} pending ASINs for processing`);
        return pendingAsins.map(r => r.ASIN).filter(Boolean);
    }

    // Completed ASINs (older than MAX_DAYS_AGO)
    const maxDaysAgo = new Date();
    maxDaysAgo.setDate(maxDaysAgo.getDate() - env.MAX_DAYS_AGO);

    const completedWhere = {
        IsActive: 1,
        LastSQPDataPullStatus: { [Op.or]: ['Completed', 'Failed', 'InProgress', 'Pending'] },
        LastSQPDataPullEndTime: { [Op.lte]: maxDaysAgo },
        ...sellerFilter
    };

    const completedAsins = await SellerAsinList.findAll({
        where: completedWhere,
        attributes: ['ASIN'],
        ...(limit ? { limit: env.MAX_ASINS_PER_REQUEST - pendingAsins.length } : {}),
        order: [['LastSQPDataPullEndTime', 'ASC']]
    });

    const allAsins = [...pendingAsins, ...completedAsins];

    logger.info({
        sellerId,
        pendingCount: pendingAsins.length,
        completedCount: completedAsins.length,
        totalBatchSize: allAsins.length,
        pendingAsins: pendingAsins.map(r => r.ASIN).slice(0, 5),
        completedAsins: completedAsins.map(r => r.ASIN).slice(0, 5),
        maxDaysAgo: maxDaysAgo.toISOString()
    }, 'Selected ASINs for processing (pending + eligible completed)');

    return allAsins.map(r => r.ASIN).filter(Boolean);
}

async function ASINsBySellerUpdated(amazonSellerID, asinList, status, startTime = null, endTime = null) {
    try {
        const SellerAsinList = getSellerAsinList();
        const data = { LastSQPDataPullStatus: status, dtUpdatedOn: new Date() };
        if (startTime) {
            data.LastSQPDataPullStartTime = new Date(startTime);
        }
        if (endTime) {
            data.LastSQPDataPullEndTime = new Date(endTime);
        }
        
        logger.info({ 
            amazonSellerID, 
            asinCount: asinList.length, 
            status, 
            startTime, 
            endTime 
        }, 'Updating ASIN status in seller_ASIN_list');
        
        // Perform the update and get the number of affected rows
        const [affectedRows] = await SellerAsinList.update(data, { 
            where: { 
                AmazonSellerID: amazonSellerID, 
                ASIN: { [Op.in]: asinList } 
            } 
        });
        
        if (affectedRows === 0) {
            logger.warn({ 
                amazonSellerID, 
                asinCount: asinList.length, 
                asins: asinList.slice(0, 5),
                status 
            }, 'WARNING: No ASINs were updated - records may not exist in database');
        } else {
            logger.info({ 
                amazonSellerID, 
                affectedRows,
                requestedCount: asinList.length,
                status 
            }, `Successfully updated ${affectedRows} ASIN(s) to status: ${status}`);
        }
        
        return affectedRows;
    } catch (error) {
        logger.error({ 
            error: error.message, 
            stack: error.stack,
            amazonSellerID, 
            asinCount: asinList.length,
            status 
        }, 'Error updating ASIN status');
        throw error;
    }
}

async function hasEligibleASINs(sellerId, limit = true) {
    const eligibleAsins = await getActiveASINsBySeller(sellerId, limit);
    const hasEligible = eligibleAsins.length > 0;

    logger.info({ sellerId, eligibleCount: eligibleAsins.length, hasEligible }, 'Seller ASIN eligibility check');
    return hasEligible;
}

async function createSQPCronDetail(amazonSellerID, asinString) {
    const SqpCronDetails = getSqpCronDetails();
    const row = await SqpCronDetails.create({ AmazonSellerID: amazonSellerID, ASIN_List: asinString, dtCreatedOn: new Date(), dtUpdatedOn: new Date() });
    return row.ID;
}

async function updateSQPReportStatus(cronDetailID, reportType, status, _reportId = null, _lastError = null, _documentId = null, _downloadCompleted = null, startDate = undefined, endDate = undefined) {
    const prefix = mapPrefix(reportType);
    const data = {
        [`${prefix}SQPDataPullStatus`]: status,
        dtUpdatedOn: new Date()
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
        dtUpdatedOn: new Date()
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
            dtCreatedOn: new Date()
        });
    }
}

async function getLatestReportId(cronJobID, reportType) {
    const SqpCronLogs = getSqpCronLogs();
    const row = await SqpCronLogs.findOne({
        where: { CronJobID: cronJobID, ReportType: reportType, ReportID: { [Op.ne]: null } },
        order: [['dtUpdatedOn', 'DESC']],
        attributes: ['ReportID']
    });
    return row ? row.ReportID : null;
}

async function setProcessRunningStatus(cronDetailID, reportType, status) {
    try {
        const prefix = mapPrefix(reportType);
        const SqpCronDetails = getSqpCronDetails();
        await SqpCronDetails.update({ [`${prefix}ProcessRunningStatus`]: Number(status), dtUpdatedOn: new Date() }, { where: { ID: cronDetailID } });
    } catch (error) {
        console.error('Failed to update ProcessRunningStatus:', error.message);
    }
}

async function getReportsForStatusCheck(filter = {}, retry = false) {
    const SqpCronDetails = getSqpCronDetails();
    const where = {};
    if (retry) {
        where[Op.or] = [
            { WeeklySQPDataPullStatus: { [Op.in]: [2,3] }},
            { MonthlySQPDataPullStatus: { [Op.in]: [2,3] }},
            { QuarterlySQPDataPullStatus: { [Op.in]: [2,3] }},
        ];
        if (filter.reportType) {
            const prefix = mapPrefix(filter.reportType);
            where[`${prefix}SQPDataPullStatus`] = { [Op.in]: [2,3] };
        }
    } else {
        where[Op.or] = [
            { WeeklySQPDataPullStatus: 0},
            { MonthlySQPDataPullStatus: 0},
            { QuarterlySQPDataPullStatus: 0}
        ];
    }
    if (filter.cronDetailID && Array.isArray(filter.cronDetailID)) where.ID = { [Op.in]: filter.cronDetailID };
    else if (filter.cronDetailID) where.ID = filter.cronDetailID;    
    return SqpCronDetails.findAll({ where });
}

async function getReportsForDownload(filter = {}, retry = false) {
    const SqpCronDetails = getSqpCronDetails();
    const where = {};
    if (retry) {
        where[Op.or] = [
            { WeeklySQPDataPullStatus: { [Op.in]: [2,3] }},
            { MonthlySQPDataPullStatus: { [Op.in]: [2,3] }},
            { QuarterlySQPDataPullStatus: { [Op.in]: [2,3] }},
        ];
        if (filter.reportType) {
            const prefix = mapPrefix(filter.reportType);
            where[`${prefix}SQPDataPullStatus`] = { [Op.in]: [2,3] };
        }
    } else {
        where[Op.or] = [
            { WeeklySQPDataPullStatus: 0},
            { MonthlySQPDataPullStatus: 0},
            { QuarterlySQPDataPullStatus: 0}
        ];
    }
    if (filter.cronDetailID && Array.isArray(filter.cronDetailID)) where.ID = { [Op.in]: filter.cronDetailID };
    else if (filter.cronDetailID) where.ID = filter.cronDetailID;
    return SqpCronDetails.findAll({ where });
}

/**
 * Check cron details of sellers by date - checkCronDetailsOfSellersByDate
 * @param {number} idUserAccount - User account ID (0 for all)
 * @param {number} AmazonSellerID - Amazon Seller ID (0 for all)
 * @param {boolean} iActiveCRON - Filter by active cron status
 * @param {string} date - Date filter (empty for today)
 * @param {boolean} iActiveRetryFlag - Filter by retry status
 * @returns {Promise<Array>} Array of cron detail records
 */
async function checkCronDetailsOfSellersByDate(idUserAccount = 0, AmazonSellerID = '', iActiveCRON = false, date = '', iActiveRetryFlag = false) {
    const SqpCronDetails = getSqpCronDetails();
    
    // Build date filter
    let dateFilter = {};
    if (date !== '') {
        const targetDate = new Date(date);
        const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0);
        const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59);
        dateFilter = {
            [Op.or]: [
                { WeeklySQPDataPullStartDate: { [Op.between]: [startOfDay, endOfDay] } },
                { MonthlySQPDataPullStartDate: { [Op.between]: [startOfDay, endOfDay] } },
                { QuarterlySQPDataPullStartDate: { [Op.between]: [startOfDay, endOfDay] } }
            ]
        };
    } else {
        const today = new Date();
        const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
        const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
        dateFilter = {
            [Op.or]: [
                { WeeklySQPDataPullStartDate: { [Op.between]: [startOfDay, endOfDay] } },
                { MonthlySQPDataPullStartDate: { [Op.between]: [startOfDay, endOfDay] } },
                { QuarterlySQPDataPullStartDate: { [Op.between]: [startOfDay, endOfDay] } }
            ]
        };
    }
    
    const where = { ...dateFilter };
    
    // Filter by active cron status
    if (iActiveCRON) {
        where[Op.or] = [
            { WeeklyProcessRunningStatus: { [Op.in]: [1, 2, 3] } },
            { MonthlyProcessRunningStatus: { [Op.in]: [1, 2, 3] } },
            { QuarterlyProcessRunningStatus: { [Op.in]: [1, 2, 3] } }
        ];
    }
    
    // Filter by retry status
    if (iActiveRetryFlag != '') {
        where[Op.or] = [
            { WeeklySQPDataPullStatus: 3 },
            { MonthlySQPDataPullStatus: 3 },
            { QuarterlySQPDataPullStatus: 3 }
        ];
    }
    
    // Filter by AmazonSellerID
    if (AmazonSellerID) {
        where.AmazonSellerID = AmazonSellerID;
    }    
    
    const results = await SqpCronDetails.findAll({
        where,
        order: [['ID', 'DESC']]
    });
    
    // Return single object if sellerId specified, otherwise array
    if (AmazonSellerID != '') {
        return results.length > 0 ? results[0] : null;
    } else {
        return results;
    }
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

/**
 * Lightweight in-table retry counters using sqp_cron_logs.RetryCount
 * We record the latest retry count per CronJobID+ReportType by finding the most recent log row.
 */
async function getRetryCount(cronJobID, reportType) {
    const SqpCronLogs = getSqpCronLogs();
    const row = await SqpCronLogs.findOne({
        where: { CronJobID: cronJobID, ReportType: reportType },
        order: [['dtUpdatedOn', 'DESC']],
        attributes: ['RetryCount']
    });
    return row && typeof row.RetryCount === 'number' ? row.RetryCount : 0;
}

async function incrementRetryCount(cronJobID, reportType) {
    const SqpCronLogs = getSqpCronLogs();
    // Create or update a lightweight row to persist the increment
    const where = { CronJobID: cronJobID, ReportType: reportType };
    const existing = await SqpCronLogs.findOne({ where });
    if (existing) {
        const next = (typeof existing.RetryCount === 'number' ? existing.RetryCount : 0) + 1;
        await existing.update({ RetryCount: next, dtUpdatedOn: new Date() });
        return next;
    } else {
        await SqpCronLogs.create({ ...where, RetryCount: 1, Action: 'Retry', Status: 3, Message: 'Increment retry', dtCreatedOn: new Date(), dtUpdatedOn: new Date() });
        return 1;
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
    checkCronDetailsOfSellersByDate,
    handleCronError,
    getRetryCount,
    incrementRetryCount,
    ASINsBySellerUpdated,
    hasEligibleASINs
};


