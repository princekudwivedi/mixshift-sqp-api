const { Op, literal } = require('sequelize');
const { getModel: getSqpDownloadUrls } = require('./sequelize/sqpDownloadUrls.model');
const logger = require('../utils/logger.utils');

async function getCompletedDownloadsWithFiles(filter = {}) {
	const SqpDownloadUrls = getSqpDownloadUrls();
	const where = {
		Status: 'COMPLETED',
		FullyImported: { [Op.ne]: 1 },
		FilePath: { [Op.ne]: null },
	};
	// Support both cronDetailID and CronJobID for backward compatibility
	if (filter.cronDetailID) where.CronJobID = filter.cronDetailID;
	if (filter.ReportType) where.ReportType = filter.ReportType;
	return SqpDownloadUrls.findAll({
		where: {
			...where,
			[Op.and]: [
				{
					[Op.or]: [
						{ ProcessStatus: null },
						{ ProcessStatus: 'PENDING' },
						{ ProcessStatus: 'FAILED' },
						{ ProcessStatus: 'FAILED_PARTIAL' }
					]
				},
				{
					[Op.or]: [
						{ MaxProcessAttempts: null },
						literal('(COALESCE(ProcessAttempts,0) < COALESCE(MaxProcessAttempts, 3))')
					]
				}
			]
		},
		order: [['dtUpdatedOn', 'ASC']]
	});
}

// Unified updater: pass either { id } or { criteria: {...} }
async function updateDownloadStatus(selector, { status, errorMessage = null, filePath = null, fileSize = null, incrementAttempts = false }) {
	const data = { Status: status };
	if (errorMessage !== null) data.ErrorMessage = errorMessage;
	if (filePath !== null) data.FilePath = filePath;
	if (fileSize !== null) data.FileSize = fileSize;
	if (status === 'DOWNLOADING') data.DownloadStartTime = new Date();
	if (status === 'COMPLETED' || status === 'FAILED') data.DownloadEndTime = new Date();
	if (incrementAttempts) data.DownloadAttempts = literal('COALESCE(DownloadAttempts, 0) + 1');
	data.dtUpdatedOn = new Date();

	const where = selector?.id ? { ID: selector.id } : selector?.criteria || null;
	if (!where) throw new Error('updateDownloadStatus requires either id or criteria');
	const SqpDownloadUrls = getSqpDownloadUrls();
	const [affected] = await SqpDownloadUrls.update(data, { where });
	if (!affected) {
		logger.warn({ where, data }, 'updateDownloadStatus: No rows updated. Creating a new row as fallback');
		// Build minimal row from selector.criteria when ID is not provided
		if (!selector.id && selector.criteria && selector.criteria.CronJobID && selector.criteria.ReportType) {
			await SqpDownloadUrls.create({
				CronJobID: selector.criteria.CronJobID,
				ReportType: selector.criteria.ReportType,
				Status: status || 'PENDING',
				ProcessStatus: 'PENDING',
				ErrorMessage: errorMessage || null,
				FilePath: filePath || null,
				FileSize: fileSize || null,
				DownloadStartTime: status === 'DOWNLOADING' ? new Date() : undefined,
				DownloadEndTime: (status === 'COMPLETED' || status === 'FAILED') ? new Date() : undefined,
				dtCreatedOn: new Date(),
				dtUpdatedOn: new Date()
			});
		}
	}
}

// Backwards-compatible helpers
async function updateDownloadUrlStatus(id, status, errorMessage = null, filePath = null, fileSize = null, incrementAttempts = false) {
	return updateDownloadStatus({ id }, { status, errorMessage, filePath, fileSize, incrementAttempts });
}

async function updateDownloadUrlStatusByCriteria(cronJobID, reportType, status, errorMessage = null, filePath = null, fileSize = null, incrementAttempts = false) {
    const SqpDownloadUrls = getSqpDownloadUrls();
    // Find latest row for this CronJobID+ReportType
    const latest = await SqpDownloadUrls.findOne({
        where: { CronJobID: cronJobID, ReportType: reportType },
        order: [['dtUpdatedOn', 'DESC']]
    });
    if (!latest) {
        logger.warn({ cronJobID, reportType }, 'updateDownloadUrlStatusByCriteria: No existing row found. Creating new');
        await SqpDownloadUrls.create({
            CronJobID: cronJobID,
            ReportType: reportType,
            Status: status || 'PENDING',
            ProcessStatus: 'PENDING',
            DownloadAttempts: 0,
            MaxDownloadAttempts: 3,
            ErrorMessage: errorMessage || null,
            FilePath: filePath || null,
            FileSize: fileSize || null,
            dtCreatedOn: new Date(),
            dtUpdatedOn: new Date()
        });
        return;
    }
    
    // Update ReportDocumentID if provided and not null
    const updateData = { status, errorMessage, filePath, fileSize, incrementAttempts };
    // Also ensure ProcessStatus is PENDING when download completes and file is present
    if (status === 'COMPLETED' && (filePath || fileSize)) {
        await SqpDownloadUrls.update({ ProcessStatus: 'PENDING', dtUpdatedOn: new Date() }, { where: { ID: latest.ID, ProcessStatus: null } });
    }
    return updateDownloadStatus({ id: latest.ID }, updateData);
}

async function storeDownloadUrl(row) {
    const SqpDownloadUrls = getSqpDownloadUrls();
	const where = { CronJobID: row.CronJobID, ReportType: row.ReportType };
	const latest = await SqpDownloadUrls.findOne({
        where: where,
        order: [['dtUpdatedOn', 'DESC']]
    });
    if (!latest) {
		const payload = {
			// DownloadURL intentionally omitted; we rely on FilePath (local or S3 URL)
			Status: row.Status || 'PENDING',
			DownloadAttempts: row.DownloadAttempts || 0,
			MaxDownloadAttempts: row.MaxDownloadAttempts || 3,
			FilePath: row.FilePath || null,
			FileSize: row.FileSize || null,
			ProcessStatus: 'PENDING',
			DownloadStartTime: row.DownloadStartTime || undefined,
			DownloadEndTime: row.Status === 'COMPLETED' ? new Date() : undefined,
			LastProcessError: row.LastProcessError || null,
			dtUpdatedOn: new Date()
		};
		try {
			return await SqpDownloadUrls.create({ CronJobID: row.CronJobID, ReportType: row.ReportType, ...payload, dtCreatedOn: new Date() });
		} catch (err) {
			logger.error({
				error: err.message,
				stack: err.stack,
				cronJobID: row.CronJobID,
				reportType: row.ReportType,
				payload
			}, 'Failed to create sqp_download_urls row');
			throw err;
		}
	} else {
		const payload = {
			Status: row.Status || 'PENDING',
			DownloadAttempts: row.DownloadAttempts || 0,
			MaxDownloadAttempts: row.MaxDownloadAttempts || 3,
			FilePath: row.FilePath || null,
			FileSize: row.FileSize || null,
			DownloadStartTime: row.DownloadStartTime || undefined,
			dtUpdatedOn: new Date()
		};
		try {
			return await SqpDownloadUrls.update(payload, { where: { ID: latest.ID } });
		} catch (err) {
			logger.error({
				error: err.message,
				cronJobID: row.CronJobID,
				reportType: row.ReportType,
				payload
			}, 'Failed to update sqp_download_urls row');
			throw err;
		}
	}
}

async function updateProcessStatusById(id, processStatus, extra = {}) {
	const SqpDownloadUrls = getSqpDownloadUrls();
	const data = {
		ProcessStatus: processStatus,
		dtUpdatedOn: new Date(),
		LastProcessAt: new Date()
	};
	if (extra.incrementAttempts) data.ProcessAttempts = literal('COALESCE(ProcessAttempts,0)+1');
	if (typeof extra.successCount === 'number') data.SuccessCount = extra.successCount;
	if (typeof extra.failCount === 'number') data.FailCount = extra.failCount;
	if (typeof extra.totalRecords === 'number') data.TotalRecords = extra.totalRecords;
	if (typeof extra.fullyImported === 'number') data.FullyImported = extra.fullyImported;
	if (typeof extra.lastError === 'string') data.LastProcessError = extra.lastError;
	await SqpDownloadUrls.update(data, { where: { ID: id } });
}

async function getDownloadUrlStats() {
	const SqpDownloadUrls = getSqpDownloadUrls();
	const total = await SqpDownloadUrls.count();
	const pending = await SqpDownloadUrls.count({ where: { Status: 'PENDING' } });
	const completed = await SqpDownloadUrls.count({ where: { Status: 'COMPLETED' } });
	const failed = await SqpDownloadUrls.count({ where: { Status: 'FAILED' } });
	return { total, pending, completed, failed };
}

module.exports = {
	getCompletedDownloadsWithFiles,
	updateDownloadStatus,
	updateDownloadUrlStatus, 
	updateDownloadUrlStatusByCriteria,
	storeDownloadUrl,
	updateProcessStatusById,
	getDownloadUrlStats
};


