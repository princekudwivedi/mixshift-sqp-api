const BaseModel = require('./base.model');
const { env } = require('../config/env.config');
const { getModel: getSqpMetrics } = require('./sequelize/sqpMetrics.model');
const { getModel: getSqpMetrics3mo } = require('./sequelize/sqpMetrics3mo.model');
const { getModel: getSqpDownloadUrls } = require('./sequelize/sqpDownloadUrls.model');
const logger = require('../utils/logger.utils');

class SqpMetricsModel extends BaseModel {
    constructor() {
        super(env('TBL_SQP_METRICS', 'sqp_metrics'), 'ID');
        this.metrics3moTable = env('TBL_SQP_METRICS_3MO', 'sqp_metrics_3mo');
    }

    /**
     * Get reportIDs from sqp_download_urls table that have corresponding data in sqp_metrics_3mo
     */
    async getReportIdsWithDataIn3mo() {
        try {
            const SqpDownloadUrls = getSqpDownloadUrls();
            const SqpMetrics3mo = getSqpMetrics3mo();
            
            // Get all reportIDs from download_urls table
            const downloadReports = await SqpDownloadUrls.findAll({
                where: {
                    Status: 'COMPLETED',
                    ProcessStatus: 'SUCCESS',
                    FullyImported: 1,
                    FilePath: { [require('sequelize').Op.ne]: null }
                },
                attributes: ['ReportID'],
                raw: true
            });
            
            if (downloadReports.length === 0) {
                logger.info('No completed download reports found');
                return [];
            }

            const reportIds = downloadReports.map(report => report.ReportID);
            
            // Check which reportIDs have data in sqp_metrics_3mo table
            const reportsWithData = await SqpMetrics3mo.findAll({
                where: {
                    ReportID: { [require('sequelize').Op.in]: reportIds }
                },
                attributes: ['ReportID'],
                group: ['ReportID'],
                raw: true
            });
            
            const reportIdsWithData = reportsWithData.map(report => report.ReportID);
            
            logger.info({ 
                totalDownloadReports: reportIds.length,
                reportsWithDataIn3mo: reportIdsWithData.length 
            }, 'Retrieved reportIDs with data in 3mo table');
            
            return reportIdsWithData;
        } catch (error) {
            logger.error({ error: error.message }, 'Error getting reportIDs with data in 3mo table');
            throw error;
        }
    }

}

module.exports = new SqpMetricsModel();
