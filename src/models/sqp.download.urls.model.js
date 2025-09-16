const BaseModel = require('./BaseModel');
const { Op, fn, col, literal } = require('sequelize');
const { SqpDownloadUrls } = require('../models/sequelize');
const logger = require('../utils/logger');

class SqpDownloadUrlsModel extends BaseModel {
    constructor() {
        super('sqp_download_urls', 'ID');
    }
    /**
     * Get all completed downloads with files ready for processing
     */
    async getCompletedDownloadsWithFiles() {
        try {
            return await SqpDownloadUrls.findAll({
                where: {
                    Status: 'COMPLETED',
                    [Op.and]: [
                        { [Op.or]: [{ ProcessStatus: null }, { ProcessStatus: { [Op.in]: ['PENDING', 'FAILED', 'FAILED_PARTIAL'] } }] },
                        { [Op.or]: [
                            { ProcessAttempts: null },
                            literal('COALESCE(ProcessAttempts,0) < COALESCE(MaxProcessAttempts,3)')
                        ] },
                        { FilePath: { [Op.ne]: null } },
                        { FilePath: { [Op.ne]: '' } }
                    ]
                },
                order: [['CreatedDate', 'ASC']]
            });
        } catch (error) {
            logger.error({ error: error.message }, 'Error getting completed downloads with files');
            throw error;
        }
    }

    /**
     * Get download by ID
     */
    async getById(id) {
        return await SqpDownloadUrls.findOne({ where: { ID: id } });
    }

    /**
     * Mark processing start
     */
    async markProcessingStart(id) {
        try {
            await SqpDownloadUrls.update({
                ProcessStatus: 'PROCESSING',
                ProcessAttempts: literal('COALESCE(ProcessAttempts,0) + 1'),
                DownloadAttempts: literal('COALESCE(DownloadAttempts,0) + 1'),
                DownloadStartTime: literal('COALESCE(DownloadStartTime, NOW())'),
                LastProcessAt: literal('NOW()')
            }, { where: { ID: id } });
            return true;
        } catch (error) {
            logger.error({ error: error.message, id }, 'Error marking processing start');
            throw error;
        }
    }

    /**
     * Update processing result
     */
    async updateProcessingResult(id, total, success, failed, lastError) {
        try {
            const fullyImported = total > 0 && failed === 0 ? 1 : 0;
            const status = fullyImported ? 'SUCCESS' : (success > 0 ? 'FAILED_PARTIAL' : 'FAILED');
            await SqpDownloadUrls.update({
                ProcessStatus: status,
                SuccessCount: success,
                FailCount: failed,
                TotalRecords: total,
                FullyImported: fullyImported,
                LastProcessError: lastError,
                DownloadEndTime: new Date()
            }, { where: { ID: id } });
            return true;
        } catch (error) {
            logger.error({ error: error.message, id }, 'Error updating processing result');
            throw error;
        }
    }

    /**
     * Mark processing failure
     */
    async markProcessingFailure(id, message) {
        try {
            await SqpDownloadUrls.update({
                ProcessStatus: 'FAILED',
                LastProcessError: message,
                DownloadEndTime: new Date()
            }, { where: { ID: id } });
            return true;
        } catch (error) {
            logger.error({ error: error.message, id }, 'Error marking processing failure');
            throw error;
        }
    }

    /**
     * Get processing statistics
     */
    async getProcessingStats() {
        try {
            const total_downloads = await SqpDownloadUrls.count();
            const files_ready = await SqpDownloadUrls.count({ where: { Status: 'COMPLETED', FilePath: { [Op.ne]: null } } });
            const pending = await SqpDownloadUrls.count({ where: { Status: 'PENDING' } });
            const failed = await SqpDownloadUrls.count({ where: { Status: 'FAILED' } });
            return { total_downloads, files_ready, pending, failed };
        } catch (error) {
            logger.error({ error: error.message }, 'Error getting processing stats');
            throw error;
        }
    }

    /**
     * Get downloads by status
     */
    async getByStatus(status, options = {}) {
        return await this.getAll({
            where: { Status: status },
            ...options
        });
    }

    /**
     * Get downloads by seller ID
     */
    async getBySellerId(sellerId, options = {}) {
        return await this.getAll({
            where: { AmazonSellerID: sellerId },
            ...options
        });
    }

    /**
     * Get downloads by report type
     */
    async getByReportType(reportType, options = {}) {
        return await this.getAll({
            where: { ReportType: reportType },
            ...options
        });
    }

    /**
     * Get pending downloads
     */
    async getPending(options = {}) {
        return await this.getByStatus('PENDING', options);
    }

    /**
     * Get completed downloads
     */
    async getCompleted(options = {}) {
        return await this.getByStatus('COMPLETED', options);
    }

    /**
     * Get failed downloads
     */
    async getFailed(options = {}) {
        return await this.getByStatus('FAILED', options);
    }

    /**
     * Get downloads by date range
     */
    async getByDateRange(startDate, endDate, options = {}) {
        const sql = `
            SELECT * FROM ${this.tableName} 
            WHERE CreatedDate BETWEEN ? AND ?
            ${options.orderBy ? `ORDER BY ${options.orderBy}` : ''}
            ${options.limit ? `LIMIT ${options.limit}` : ''}
            ${options.offset ? `OFFSET ${options.offset}` : ''}
        `;
        
        return await this.find(sql, [startDate, endDate]);
    }

    /**
     * Get download count by status
     */
    async getCountByStatus(status) {
        return await this.count({ Status: status });
    }

    /**
     * Get download count by seller
     */
    async getCountBySeller(sellerId) {
        return await this.count({ AmazonSellerID: sellerId });
    }
}

module.exports = new SqpDownloadUrlsModel();
