const BaseModel = require('./BaseModel');
const { Op, fn, col, literal } = require('sequelize');
const { SqpMetrics } = require('../models/sequelize');
const logger = require('../utils/logger');

class SqpMetricsModel extends BaseModel {
    constructor() {
        super('sqp_metrics', 'ID');
    }
    /**
     * Store metrics data in sqp_metrics_3mo table
     */
    async storeMetrics3Mo(metricsData) {
        return await this.create(metricsData);
    }

    /**
     * Remove existing report data to avoid duplicates
     */
    async removeExistingReportData(reportID) {
        return await this.deleteBy({ ReportID: reportID });
    }

    /**
     * Get metrics by report ID
     */
    async getByReportId(reportID) {
        return await this.getAll({
            where: { ReportID: reportID },
            orderBy: 'CreatedDate DESC'
        });
    }

    /**
     * Get metrics by seller ID and date range
     */
    async getBySellerAndDateRange(amazonSellerID, startDate, endDate) {
        return await SqpMetrics.findAll({
            where: {
                AmazonSellerID: amazonSellerID,
                ReportDate: { [Op.between]: [startDate, endDate] }
            },
            order: [['ReportDate', 'DESC'], ['CreatedDate', 'DESC']]
        });
    }

    /**
     * Get metrics statistics
     */
    async getMetricsStats() {
        const total = await SqpMetrics.count();
        return { total_records: total };
    }

    /**
     * Upsert totals record in sqp_metrics table
     */
    async upsertTotalsRecord(totalsData) {
        try {
            const fields = Object.keys(totalsData);
            const values = Object.values(totalsData);
            const placeholders = fields.map(() => '?').join(', ');
            const updateClause = fields.map(field => `${field} = VALUES(${field})`).join(', ');
            
            const sql = `INSERT INTO ${tables.sqpMetrics3moTotals} (${fields.join(', ')}) 
                         VALUES (${placeholders})
                         ON DUPLICATE KEY UPDATE ${updateClause}`;
            return await this.find(sql, values);
        } catch (error) {
            logger.error({ error: error.message, totalsData }, 'Error upserting totals record');
            throw error;
        }
    }

    /**
     * Bulk insert metrics into sqp_metrics_3mo in chunks
     */
    async bulkInsert3Mo(rows, chunkSize = 500) {
        if (!Array.isArray(rows) || rows.length === 0) return 0;
        const columns = Object.keys(rows[0]);
        const placeholdersPerRow = `(${columns.map(() => '?').join(',')})`;
        let inserted = 0;
        for (let i = 0; i < rows.length; i += chunkSize) {
            const chunk = rows.slice(i, i + chunkSize);
            const values = [];
            for (const row of chunk) {
                values.push(...columns.map(c => row[c]));
            }
            const sql = `INSERT INTO ${this.tableName} (${columns.join(',')}) VALUES ${new Array(chunk.length).fill(placeholdersPerRow).join(',')}`;
            await this.find(sql, values);
            inserted += chunk.length;
        }
        return inserted;
    }

    /**
     * Get aggregated metrics by search query
     */
    async getAggregatedMetricsByQuery(amazonSellerID, searchQuery, startDate, endDate) {
        return await SqpMetrics.findAll({
            attributes: [
                'SearchQuery',
                [fn('SUM', col('AsinImpressionCount')), 'total_impressions'],
                [fn('SUM', col('AsinClickCount')), 'total_clicks'],
                [fn('SUM', col('AsinCartAddCount')), 'total_cart_adds'],
                [fn('SUM', col('AsinPurchaseCount')), 'total_purchases'],
                [fn('AVG', col('AsinMedianClickPrice')), 'avg_click_price'],
                [fn('AVG', col('AsinMedianPurchasePrice')), 'avg_purchase_price']
            ],
            where: {
                AmazonSellerID: amazonSellerID,
                SearchQuery: searchQuery,
                ReportDate: { [Op.between]: [startDate, endDate] }
            },
            group: ['SearchQuery']
        });
    }

    /**
     * Get top performing ASINs
     */
    async getTopPerformingAsins(amazonSellerID, limit = 10, startDate, endDate) {
        return await SqpMetrics.findAll({
            attributes: [
                'ASIN',
                [fn('SUM', col('AsinImpressionCount')), 'total_impressions'],
                [fn('SUM', col('AsinClickCount')), 'total_clicks'],
                [fn('SUM', col('AsinPurchaseCount')), 'total_purchases'],
                [fn('AVG', col('AsinMedianClickPrice')), 'avg_click_price'],
                [fn('AVG', col('AsinMedianPurchasePrice')), 'avg_purchase_price']
            ],
            where: {
                AmazonSellerID: amazonSellerID,
                ReportDate: { [Op.between]: [startDate, endDate] }
            },
            group: ['ASIN'],
            order: [[literal('total_purchases'), 'DESC'], [literal('total_clicks'), 'DESC']],
            limit
        });
    }

    /**
     * Get metrics by seller ID
     */
    async getBySellerId(sellerId, options = {}) {
        return await SqpMetrics.findAll({ where: { AmazonSellerID: sellerId }, ...options });
    }

    /**
     * Get metrics by ASIN
     */
    async getByAsin(asin, options = {}) {
        return await SqpMetrics.findAll({ where: { ASIN: asin }, ...options });
    }

    /**
     * Get metrics by search query
     */
    async getBySearchQuery(searchQuery, options = {}) {
        return await SqpMetrics.findAll({ where: { SearchQuery: searchQuery }, ...options });
    }

    /**
     * Get metrics by report type
     */
    async getByReportType(reportType, options = {}) {
        return await SqpMetrics.findAll({ where: { ReportType: reportType }, ...options });
    }

    /**
     * Get metrics by date range
     */
    async getByDateRange(startDate, endDate, options = {}) {
        return await SqpMetrics.findAll({
            where: { ReportDate: { [Op.between]: [startDate, endDate] } },
            order: options.orderBy ? [options.orderBy.split(' ')] : undefined,
            limit: options.limit,
            offset: options.offset
        });
    }

    /**
     * Get metrics count by seller
     */
    async getCountBySeller(sellerId) {
        return await SqpMetrics.count({ where: { AmazonSellerID: sellerId } });
    }

    /**
     * Get metrics count by ASIN
     */
    async getCountByAsin(asin) {
        return await SqpMetrics.count({ where: { ASIN: asin } });
    }

    /**
     * Get metrics count by search query
     */
    async getCountBySearchQuery(searchQuery) {
        return await SqpMetrics.count({ where: { SearchQuery: searchQuery } });
    }

    /**
     * Get aggregated metrics by seller
     */
    async getAggregatedBySeller(sellerId, startDate, endDate) {
        return await SqpMetrics.findAll({
            attributes: [
                'AmazonSellerID',
                [fn('COUNT', literal('*')), 'total_records'],
                [fn('SUM', col('AsinImpressionCount')), 'total_impressions'],
                [fn('SUM', col('AsinClickCount')), 'total_clicks'],
                [fn('SUM', col('AsinCartAddCount')), 'total_cart_adds'],
                [fn('SUM', col('AsinPurchaseCount')), 'total_purchases'],
                [fn('AVG', col('AsinMedianClickPrice')), 'avg_click_price'],
                [fn('AVG', col('AsinMedianPurchasePrice')), 'avg_purchase_price']
            ],
            where: {
                AmazonSellerID: sellerId,
                ReportDate: { [Op.between]: [startDate, endDate] }
            },
            group: ['AmazonSellerID']
        });
    }
}

module.exports = new SqpMetricsModel();
