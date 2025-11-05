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
async function getReportsForStatusType(row, retry = false) {
    const SqpCronLogs = getSqpCronLogs(); 
    const reportTypes = [];
    let where = {};
    if (retry) {
        where = { CronJobID: row.ID, ReportType: row.ReportType, Status: { [Op.in]: [0, 2] }, iInitialPull: row.iInitialPull};
    } else {
        where = { CronJobID: row.ID, Status: { [Op.in]: [1] }, iInitialPull: row.iInitialPull };
    }
    const logs = await SqpCronLogs.findAll({ where });
    reportTypes.push(...logs.map(l => l.ReportType));
    return reportTypes;
}
async function getActiveASINsBySeller(sellerId = null, limit = true, reportType = null) {
    const SellerAsinList = getSellerAsinList();
    const sellerFilter = sellerId ? { SellerID: sellerId } : {};
    const currentDay = new Date();
    const retryCutoffTime = new Date();
    retryCutoffTime.setDate(currentDay.getDate() - env.MAX_DAYS_AGO);
    const isActive = 1;

    const asins = await SellerAsinList.findAll({
        where: {
            IsActive: isActive,
            ...sellerFilter
        },
        attributes: [
            'ASIN', 
            'WeeklyLastSQPDataPullStatus', 'WeeklyLastSQPDataPullStartTime',
            'MonthlyLastSQPDataPullStatus', 'MonthlyLastSQPDataPullStartTime',
            'QuarterlyLastSQPDataPullStatus', 'QuarterlyLastSQPDataPullStartTime'
        ],
        order: [['dtCreatedOn', 'ASC']]
    });
    
    const resultAsins = [];
    for (const a of asins) {
        const weeklyDate = a.WeeklyLastSQPDataPullStartTime ? new Date(a.WeeklyLastSQPDataPullStartTime) : null;
        const monthlyDate = a.MonthlyLastSQPDataPullStartTime ? new Date(a.MonthlyLastSQPDataPullStartTime) : null;
        const quarterlyDate = a.QuarterlyLastSQPDataPullStartTime ? new Date(a.QuarterlyLastSQPDataPullStartTime) : null;
    
        // Weekly logic: pending or failed and older than cutoff
        const includeWeek = (!a.WeeklyLastSQPDataPullStatus || [1,3].includes(a.WeeklyLastSQPDataPullStatus)) &&
                            (!weeklyDate || weeklyDate <= retryCutoffTime);
        
        // Monthly logic: pending or failed and older than cutoff
        const includeMonth = (!a.MonthlyLastSQPDataPullStatus || [1,3].includes(a.MonthlyLastSQPDataPullStatus)) &&
                            (!monthlyDate || monthlyDate <= retryCutoffTime);
    
        // Quarter logic: pending or failed and older than cutoff
        const includeQuarter = (!a.QuarterlyLastSQPDataPullStatus || [1,3].includes(a.QuarterlyLastSQPDataPullStatus)) &&
                               (!quarterlyDate || quarterlyDate <= retryCutoffTime);
    
        if (includeWeek) resultAsins.push({ ASIN: a.ASIN, reportType: 'WEEK' });
        if (includeMonth) resultAsins.push({ ASIN: a.ASIN, reportType: 'MONTH' });
        if (includeQuarter) resultAsins.push({ ASIN: a.ASIN, reportType: 'QUARTER' });
    
    }
    
    if (resultAsins.length > 0) {
        // Remove duplicate ASINs
        const uniqueAsins = [...new Set(resultAsins.map(r => r.ASIN))];
        const reportTypes = [...new Set(resultAsins.map(r => r.reportType))];

        // 🔥 Apply limit AFTER filtering
        const limitedAsins = limit ? uniqueAsins.slice(0, env.MAX_ASINS_PER_REQUEST) : uniqueAsins;

        logger.info({ sellerId, count: limitedAsins.length }, 'Scenario matched with week/month/quarter logic');
        return {
            reportTypes,
            asins: limitedAsins
        };
    }
    
    return { reportTypes: [], asins: [] };    
}
async function getActiveASINsBySellerInitialPull(sellerId = null, limit = true) {
    const SellerAsinList = getSellerAsinList();
    const sellerFilter = sellerId ? { SellerID: sellerId } : {};

    const where = {
        IsActive: 1,
        ...sellerFilter,
        InitialPullStatus: null
    };

    const asins = await SellerAsinList.findAll({
        where,
        attributes: ['ASIN'],
        ...(limit ? { limit: env.MAX_ASINS_PER_REQUEST } : {}),
        order: [['dtCreatedOn', 'ASC']]
    });

    if (asins.length > 0) {
        logger.info({ sellerId, count: asins.length }, `Scenario matched: Initial Pull`);
        return { asins: asins.map(a => a.ASIN) };
    }

    logger.info({ sellerId }, 'No eligible ASINs found for Initial Pull');
    return { asins: [] };
}

async function ASINsBySellerUpdated(SellerID, amazonSellerID, asinList, status, reportType, startTime = null, endTime = null) {
    try {
        const SellerAsinList = getSellerAsinList();
        const prefix = mapPrefix(reportType); // 'Weekly', 'Monthly', or 'Quarterly'
        
        const data = { 
            [`${prefix}LastSQPDataPullStatus`]: status,
            dtUpdatedOn: new Date() 
        };
        
        if (startTime) {
            data[`${prefix}LastSQPDataPullStartTime`] = new Date(startTime);
        }
        if (endTime) {
            data[`${prefix}LastSQPDataPullEndTime`] = new Date(endTime);
        }
        let where = {
            AmazonSellerID: amazonSellerID, 
            ASIN: { [Op.in]: asinList } 
        }
        if(SellerID){
            where.SellerID = SellerID;
        }
        
        logger.info({ 
            SellerID,
            amazonSellerID,
            reportType,
            prefix,
            asinCount: asinList.length, 
            status, 
            startTime, 
            endTime 
        }, 'Updating ASIN status in seller_ASIN_list');
        
        // Perform the update and get the number of affected rows
        const [affectedRows] = await SellerAsinList.update(data, { 
            where: where
        });
        
        if (affectedRows === 0) {
            logger.warn({ 
                amazonSellerID,
                reportType,
                asinCount: asinList.length, 
                asins: asinList.slice(0, 5),
                status 
            }, 'WARNING: No ASINs were updated - records may not exist in database');
        } else {
            logger.info({ 
                amazonSellerID,
                reportType,
                affectedRows,
                requestedCount: asinList.length,
                status 
            }, `Successfully updated ${affectedRows} ASIN(s) to status: ${status} for ${reportType}`);
        }
        
        return affectedRows;
    } catch (error) {
        logger.error({ 
            error: error.message, 
            stack: error.stack,
            amazonSellerID,
            reportType,
            asinCount: asinList.length,
            status 
        }, 'Error updating ASIN status');
        throw error;
    }
}

async function hasEligibleASINs(sellerId, reportType = null, limit = true) {
    const { asins, reportTypes } = await getActiveASINsBySeller(sellerId, limit, reportType);
    const hasEligible = asins.length > 0;

    logger.info({ sellerId, reportType, eligibleCount: asins.length, hasEligible, reportTypes }, 'Seller ASIN eligibility check');
    return hasEligible;
}
async function hasEligibleASINsInitialPull(sellerId, limit = true) {
    const { asins } = await getActiveASINsBySellerInitialPull(sellerId, limit);
    const hasEligible = asins.length > 0;

    logger.info({ sellerId, eligibleCount: asins.length, hasEligible }, 'Seller ASIN eligibility check');
    return hasEligible;
}

async function createSQPCronDetail(amazonSellerID, asinString, sellerID, options = {}) {
    const SqpCronDetails = getSqpCronDetails();
    
    // Base data for creating cron detail
    const createData = { 
        AmazonSellerID: amazonSellerID, 
        SellerID: sellerID,
        ASIN_List: asinString,         
        dtCreatedOn: new Date(), 
        dtCronStartDate: new Date(), 
        dtUpdatedOn: new Date() 
    };
    
    // Add optional fields for initial pull
    if (options.iInitialPull !== undefined) {
        createData.iInitialPull = options.iInitialPull;
    }
    if (options.FullWeekRange) {
        createData.FullWeekRange = options.FullWeekRange;
    }
    if (options.FullMonthRange) {
        createData.FullMonthRange = options.FullMonthRange;
    }
    if (options.FullQuarterRange) {
        createData.FullQuarterRange = options.FullQuarterRange;
    }
    if (options.SellerName) {
        createData.SellerName = options.SellerName;
    }    
    createData.cronRunningStatus = 1;
    const row = await SqpCronDetails.create(createData);
    
    // Fetch the complete record with all columns to ensure all fields are populated
    const completeRow = await SqpCronDetails.findByPk(row.ID);
    return completeRow;
}

async function updateSQPReportStatus(cronDetailID, reportType, status, startDate = undefined, endDate = undefined, cronRunningStatus = null, cronStartDate = false) {
    const prefix = mapPrefix(reportType);
    const data = {
        dtUpdatedOn: new Date()
    };
    if(cronStartDate){
        data.dtCronStartDate = new Date();
    }
    if(status){
        data[`${prefix}SQPDataPullStatus`] =  status;
    } else if(status == 0){
        data[`${prefix}SQPDataPullStatus`] =  status;
    }
    if (startDate) {
        data[`${prefix}SQPDataPullStartDate`] = new Date(startDate);
    }
    if (endDate) {
        data[`${prefix}SQPDataPullEndDate`] = new Date(endDate);
    }
    if(cronRunningStatus != null){
        data.cronRunningStatus = Number(cronRunningStatus);
    }
    const SqpCronDetails = getSqpCronDetails();
    await SqpCronDetails.update(data, { where: { ID: cronDetailID } });
}

async function logCronActivity({ cronJobID, reportType, action, status, message, reportID = null, reportDocumentID = null, retryCount = null, executionTime = null, Range = null, iInitialPull = 0 }) {
    const SqpCronLogs = getSqpCronLogs();
    
    // For initial pull with Range and Action, create unique log per range + action
    // ReportID is NOT part of the key - it's just a field that gets updated as the report progresses
    // This prevents duplicate entries for the same range as reportID changes from NULL to actual ID
    // For regular pull, match by CronJobID + ReportType
    const where = (iInitialPull === 1 && Range) 
        ? { 
            CronJobID: cronJobID, 
            ReportType: reportType, 
            Range: Range,
            iInitialPull: iInitialPull
        }
        : { CronJobID: cronJobID, ReportType: reportType};
    
    const payload = {
        Status: status,
        Action: action,
        Message: message,
        ReportID: reportID,
        RetryCount: retryCount,
        ExecutionTime: executionTime != null ? Number(executionTime) : undefined,
        dtUpdatedOn: new Date()
    };      
    
    if (reportDocumentID != null) {
        payload.ReportDocumentID = reportDocumentID;
    }
    if(Range != null) {
        payload.Range = Range;
    }
    if(iInitialPull != null) {
        payload.iInitialPull = iInitialPull;
    }
    
    const existing = await SqpCronLogs.findOne({ where });
    if (existing) {
        // Update existing log entry (for retries of the same action)
        await existing.update(payload);
    } else {
        // Create new log entry
        await SqpCronLogs.create({
            ...where,
            ...payload,
            dtCreatedOn: new Date()
        });
    }
}

async function getLatestReportId(cronJobID, reportType, reportID = null, range = null) {
    const SqpCronLogs = getSqpCronLogs();
    let where = { CronJobID: cronJobID, ReportType: reportType };
    
    // For initial pull, filter by Range to get the correct reportId for this specific date range
    if (range != null) {
        where.Range = range;
    }
    
    if (reportID != null) {
        where.ReportID = reportID;
    } else {
        where.ReportID = { [Op.ne]: null };
    }
    const row = await SqpCronLogs.findOne({
        where: where,
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
        logger.error({ error: error.message, cronDetailID, reportType }, 'Failed to update ProcessRunningStatus');
    }
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
async function checkCronDetailsOfSellersByDate(
    idUserAccount = 0,
    AmazonSellerID = '',
    iActiveCRON = false,
    date = '',
    iActiveRetryFlag = false,
    iInitialPull = 0
) {
    const SqpCronDetails = getSqpCronDetails();
    let HoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    if(iInitialPull === 1){
        HoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000);
    }

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

    // ✅ Active Cron Filter (status in [1,2,3], not older than 2h, and SQPDataPullStatus != 3)
    if (iActiveCRON) {
        where[Op.and] = [
            {
                [Op.or]: [
                    { WeeklyProcessRunningStatus: { [Op.in]: [1, 2, 3] } },
                    { MonthlyProcessRunningStatus: { [Op.in]: [1, 2, 3] } },
                    { QuarterlyProcessRunningStatus: { [Op.in]: [1, 2, 3] } },
                ]
            },
            {
                [Op.or]: [
                    { WeeklySQPDataPullStatus: { [Op.ne]: 3 } },
                    { MonthlySQPDataPullStatus: { [Op.ne]: 3 } },
                    { QuarterlySQPDataPullStatus: { [Op.ne]: 3 } },
                ]
            },
            {
                dtUpdatedOn: { [Op.gt]: HoursAgo }
            }
        ];
    }

    // Retry flag filter (unchanged)
    if (iActiveRetryFlag) {
        where[Op.or] = [
            { WeeklySQPDataPullStatus: 2 },
            { MonthlySQPDataPullStatus: 2 },
            { QuarterlySQPDataPullStatus: 2 }
        ];
    }

    if (iInitialPull) {
        where.iInitialPull = iInitialPull;
    }

    if (AmazonSellerID) {
        where.AmazonSellerID = AmazonSellerID;
    }

    const results = await SqpCronDetails.findAll({
        where,
        order: [['ID', 'DESC']]
    });

    // Return single record if AmazonSellerID given
    if (AmazonSellerID != '') {
        return results.length > 0 ? results[0] : null;
    } else {
        return results;
    }
}

/**
 * Lightweight in-table retry counters using sqp_cron_logs.RetryCount
 * We record the latest retry count per CronJobID+ReportType by finding the most recent log row.
 */
async function getRetryCount(cronJobID, reportType, reportId) {
    const SqpCronLogs = getSqpCronLogs();
    let where = { CronJobID: cronJobID, ReportType: reportType };
    if (reportId != null) {
        where.ReportID = reportId;
    }
    const row = await SqpCronLogs.findOne({
        where: where,
        order: [['dtUpdatedOn', 'DESC']],
        attributes: ['RetryCount']
    });
    return row && typeof row.RetryCount === 'number' ? row.RetryCount : 0;
}

async function incrementRetryCount(cronJobID, reportType, reportId) {
    const SqpCronLogs = getSqpCronLogs();
    let where = { CronJobID: cronJobID, ReportType: reportType };
    if (reportId != null) {
        where.ReportID = reportId;
    }
    // Create or update a lightweight row to persist the increment    
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
    getActiveASINsBySellerInitialPull,
    createSQPCronDetail,
    getLatestReportId,
    updateSQPReportStatus,
    logCronActivity,
    setProcessRunningStatus,    
    checkCronDetailsOfSellersByDate,
    getRetryCount,
    incrementRetryCount,
    ASINsBySellerUpdated,
    hasEligibleASINs,
    hasEligibleASINsInitialPull,
    getReportsForStatusType
};


