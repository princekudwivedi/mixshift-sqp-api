const { Op, literal } = require('sequelize');
const { getModel: getSqpDownloadUrls } = require('./sequelize/sqpDownloadUrls.model');

async function getPendingDownloadUrls(limit = 50) {
	const SqpDownloadUrls = getSqpDownloadUrls();
	return SqpDownloadUrls.findAll({
		where: { Status: 'PENDING' },
		order: [['CreatedDate', 'ASC']],
		limit
	});
}

async function getCompletedDownloadsWithFiles(limit = 50) {
	const SqpDownloadUrls = getSqpDownloadUrls();
	return SqpDownloadUrls.findAll({
		where: {
			Status: 'COMPLETED',
			FilePath: { [Op.ne]: null },
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
		order: [['UpdatedDate', 'ASC']],
		limit
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
	data.UpdatedDate = new Date();

	const where = selector?.id ? { ID: selector.id } : selector?.criteria || null;
	if (!where) throw new Error('updateDownloadStatus requires either id or criteria');
	const SqpDownloadUrls = getSqpDownloadUrls();
	await SqpDownloadUrls.update(data, { where });
}

// Backwards-compatible helpers
async function updateDownloadUrlStatus(id, status, errorMessage = null, filePath = null, fileSize = null, incrementAttempts = false) {
	return updateDownloadStatus({ id }, { status, errorMessage, filePath, fileSize, incrementAttempts });
}

async function updateDownloadUrlStatusByCriteria(cronJobID, reportID, amazonSellerID, reportType, status, errorMessage = null, filePath = null, fileSize = null, incrementAttempts = false) {
	const criteria = { CronJobID: cronJobID, ReportID: reportID, AmazonSellerID: amazonSellerID, ReportType: reportType };
	return updateDownloadStatus({ criteria }, { status, errorMessage, filePath, fileSize, incrementAttempts });
}

async function storeDownloadUrl(row) {
	const SqpDownloadUrls = getSqpDownloadUrls();
	const where = {
		CronJobID: row.CronJobID,
		ReportID: row.ReportID,
		AmazonSellerID: row.AmazonSellerID,
		ReportType: row.ReportType,
	};
	const payload = {
		// DownloadURL intentionally omitted; we rely on FilePath (local or S3 URL)
		ReportDocumentID: row.ReportDocumentID || null,
		CompressionAlgorithm: row.CompressionAlgorithm || null,
		Status: row.Status || 'PENDING',
		DownloadAttempts: row.DownloadAttempts || 0,
		MaxDownloadAttempts: row.MaxDownloadAttempts || 3,
		FilePath: row.FilePath || null,
		FileSize: row.FileSize || null,
		DownloadStartTime: row.DownloadStartTime || undefined,
		DownloadEndTime: row.Status === 'COMPLETED' ? new Date() : undefined,
		LastProcessError: row.LastProcessError || null,
		UpdatedDate: new Date()
	};
	const existing = await SqpDownloadUrls.findOne({ where });
	if (existing) {
		return existing.update(payload);
	}
	return SqpDownloadUrls.create({ ...where, ...payload, CreatedDate: new Date() });
}

async function updateProcessStatusById(id, processStatus, extra = {}) {
	const SqpDownloadUrls = getSqpDownloadUrls();
	const data = {
		ProcessStatus: processStatus,
		UpdatedDate: new Date(),
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
	getPendingDownloadUrls,
	getCompletedDownloadsWithFiles,
	updateDownloadStatus,
	updateDownloadUrlStatus, 
	updateDownloadUrlStatusByCriteria,
	storeDownloadUrl,
	updateProcessStatusById,
	getDownloadUrlStats,
};


