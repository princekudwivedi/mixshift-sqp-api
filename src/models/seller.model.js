const dbConfig = require('../config/db.config');
const { TBL_SELLER } = require('../config/env.config');
const logger = require('../src/utils/logger');

/**
 * Seller Model
 * Sequelize-like ORM model for sellers
 */
class Seller {
    constructor() {
        this.tableName = TBL_SELLER;
        this.primaryKey = 'ID';
    }

    /**
     * Find all sellers with options
     */
    async findAll(options = {}) {
        try {
            const {
                where = {},
                attributes = '*',
                order = [['CreatedDate', 'DESC']],
                limit = null,
                offset = 0,
                include = []
            } = options;

            let sql = `SELECT ${attributes} FROM ${this.tableName}`;
            const params = [];

            // Add WHERE clause
            if (Object.keys(where).length > 0) {
                const whereClause = Object.keys(where).map(key => `${key} = ?`).join(' AND ');
                sql += ` WHERE ${whereClause}`;
                params.push(...Object.values(where));
            }

            // Add ORDER BY clause
            if (order && order.length > 0) {
                const orderClause = order.map(([field, direction]) => `${field} ${direction}`).join(', ');
                sql += ` ORDER BY ${orderClause}`;
            }

            // Add LIMIT clause
            if (limit) {
                sql += ` LIMIT ${limit}`;
                if (offset > 0) {
                    sql += ` OFFSET ${offset}`;
                }
            }

            const results = await dbConfig.query(sql, params);
            logger.debug({ table: this.tableName, count: results.length }, 'Seller.findAll');
            return results;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in Seller.findAll');
            throw error;
        }
    }

    /**
     * Find one seller by conditions
     */
    async findOne(options = {}) {
        try {
            const {
                where = {},
                attributes = '*',
                include = []
            } = options;

            let sql = `SELECT ${attributes} FROM ${this.tableName}`;
            const params = [];

            // Add WHERE clause
            if (Object.keys(where).length > 0) {
                const whereClause = Object.keys(where).map(key => `${key} = ?`).join(' AND ');
                sql += ` WHERE ${whereClause}`;
                params.push(...Object.values(where));
            }

            sql += ' LIMIT 1';

            const results = await dbConfig.query(sql, params);
            const record = results[0] || null;
            
            logger.debug({ table: this.tableName, found: !!record }, 'Seller.findOne');
            return record;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in Seller.findOne');
            throw error;
        }
    }

    /**
     * Find seller by primary key
     */
    async findByPk(id, options = {}) {
        return await this.findOne({
            where: { [this.primaryKey]: id },
            ...options
        });
    }

    /**
     * Find seller by Amazon Seller ID
     */
    async findByAmazonSellerId(amazonSellerId, options = {}) {
        return await this.findOne({
            where: { AmazonSellerID: amazonSellerId },
            ...options
        });
    }

    /**
     * Create new seller record
     */
    async create(sellerData) {
        try {
            const data = {
                AmazonSellerID: sellerData.amazonSellerId,
                SellerName: sellerData.sellerName,
                Marketplace: sellerData.marketplace,
                Status: sellerData.status || 'active',
                CreatedDate: new Date(),
                UpdatedDate: new Date(),
                ...sellerData
            };

            const fields = Object.keys(data);
            const values = Object.values(data);
            const placeholders = fields.map(() => '?').join(', ');
            
            const sql = `INSERT INTO ${this.tableName} (${fields.join(', ')}) VALUES (${placeholders})`;
            const result = await dbConfig.query(sql, values);
            
            logger.debug({ table: this.tableName, id: result.insertId, fields }, 'Seller.create');
            return { ...data, [this.primaryKey]: result.insertId };
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, sellerData }, 'Error in Seller.create');
            throw error;
        }
    }

    /**
     * Update seller by ID
     */
    async update(id, updateData) {
        try {
            const data = {
                ...updateData,
                UpdatedDate: new Date()
            };

            const fields = Object.keys(data);
            const values = Object.values(data);
            const setClause = fields.map(field => `${field} = ?`).join(', ');
            
            const sql = `UPDATE ${this.tableName} SET ${setClause} WHERE ${this.primaryKey} = ?`;
            const result = await dbConfig.query(sql, [...values, id]);
            
            logger.debug({ table: this.tableName, id, fields, affectedRows: result.affectedRows }, 'Seller.update');
            return result.affectedRows > 0;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, id, updateData }, 'Error in Seller.update');
            throw error;
        }
    }

    /**
     * Delete seller by ID
     */
    async destroy(id) {
        try {
            const sql = `DELETE FROM ${this.tableName} WHERE ${this.primaryKey} = ?`;
            const result = await dbConfig.query(sql, [id]);
            
            logger.debug({ table: this.tableName, id, affectedRows: result.affectedRows }, 'Seller.destroy');
            return result.affectedRows > 0;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, id }, 'Error in Seller.destroy');
            throw error;
        }
    }

    /**
     * Count sellers
     */
    async count(where = {}) {
        try {
            let sql = `SELECT COUNT(*) as count FROM ${this.tableName}`;
            const params = [];

            if (Object.keys(where).length > 0) {
                const whereClause = Object.keys(where).map(key => `${key} = ?`).join(' AND ');
                sql += ` WHERE ${whereClause}`;
                params.push(...Object.values(where));
            }

            const results = await dbConfig.query(sql, params);
            const count = results[0].count;
            
            logger.debug({ table: this.tableName, where, count }, 'Seller.count');
            return count;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, where }, 'Error in Seller.count');
            throw error;
        }
    }

    /**
     * Get sellers for cron processing
     */
    async getSellersForCron(options = {}) {
        try {
            const {
                idSellerAccount = null,
                pullAll = false,
                limit = null,
                offset = 0
            } = options;

            let sql = `SELECT * FROM ${this.tableName} WHERE Status = 'active'`;
            const params = [];

            if (idSellerAccount && !pullAll) {
                sql += ` AND ${this.primaryKey} = ?`;
                params.push(idSellerAccount);
            }

            sql += ` ORDER BY CreatedDate ASC`;

            if (limit) {
                sql += ` LIMIT ${limit}`;
                if (offset > 0) {
                    sql += ` OFFSET ${offset}`;
                }
            }

            const results = await dbConfig.query(sql, params);
            logger.debug({ table: this.tableName, count: results.length, options }, 'Seller.getSellersForCron');
            return results;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, options }, 'Error in Seller.getSellersForCron');
            throw error;
        }
    }

    /**
     * Get seller profile details by ID
     */
    async getProfileDetailsById(id) {
        try {
            const sql = `SELECT * FROM ${this.tableName} WHERE ${this.primaryKey} = ? AND Status = 'active'`;
            const results = await dbConfig.query(sql, [id]);
            
            const seller = results[0] || null;
            logger.debug({ table: this.tableName, id, found: !!seller }, 'Seller.getProfileDetailsById');
            return seller;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, id }, 'Error in Seller.getProfileDetailsById');
            throw error;
        }
    }

    /**
     * Find by status
     */
    async findByStatus(status, options = {}) {
        return await this.findAll({
            where: { Status: status },
            ...options
        });
    }

    /**
     * Find by marketplace
     */
    async findByMarketplace(marketplace, options = {}) {
        return await this.findAll({
            where: { Marketplace: marketplace },
            ...options
        });
    }

    /**
     * Find active sellers
     */
    async findActive(options = {}) {
        return await this.findByStatus('active', options);
    }

    /**
     * Find inactive sellers
     */
    async findInactive(options = {}) {
        return await this.findByStatus('inactive', options);
    }

    /**
     * Find by date range
     */
    async findByDateRange(startDate, endDate, options = {}) {
        try {
            const { limit = null, offset = 0, order = [['CreatedDate', 'DESC']] } = options;
            
            let sql = `SELECT * FROM ${this.tableName} WHERE CreatedDate BETWEEN ? AND ?`;
            const params = [startDate, endDate];

            // Add ORDER BY clause
            if (order && order.length > 0) {
                const orderClause = order.map(([field, direction]) => `${field} ${direction}`).join(', ');
                sql += ` ORDER BY ${orderClause}`;
            }

            // Add LIMIT clause
            if (limit) {
                sql += ` LIMIT ${limit}`;
                if (offset > 0) {
                    sql += ` OFFSET ${offset}`;
                }
            }
            
            const results = await dbConfig.query(sql, params);
            logger.debug({ table: this.tableName, startDate, endDate, count: results.length }, 'Seller.findByDateRange');
            return results;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, startDate, endDate }, 'Error in Seller.findByDateRange');
            throw error;
        }
    }

    /**
     * Get seller statistics
     */
    async getStats() {
        try {
            const sql = `
                SELECT 
                    COUNT(*) as total_sellers,
                    SUM(CASE WHEN Status = 'active' THEN 1 ELSE 0 END) as active_sellers,
                    SUM(CASE WHEN Status = 'inactive' THEN 1 ELSE 0 END) as inactive_sellers,
                    COUNT(DISTINCT Marketplace) as unique_marketplaces
                FROM ${this.tableName}
            `;
            
            const results = await dbConfig.query(sql);
            logger.debug({ table: this.tableName }, 'Seller.getStats');
            return results[0];
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in Seller.getStats');
            throw error;
        }
    }

    /**
     * Search sellers
     */
    async search(searchTerm, options = {}) {
        try {
            const { limit = 10, offset = 0 } = options;
            
            const sql = `
                SELECT * FROM ${this.tableName} 
                WHERE (SellerName LIKE ? OR AmazonSellerID LIKE ? OR Marketplace LIKE ?)
                AND Status = 'active'
                ORDER BY CreatedDate DESC
                LIMIT ? OFFSET ?
            `;
            
            const searchPattern = `%${searchTerm}%`;
            const params = [searchPattern, searchPattern, searchPattern, limit, offset];
            
            const results = await dbConfig.query(sql, params);
            logger.debug({ table: this.tableName, searchTerm, count: results.length }, 'Seller.search');
            return results;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, searchTerm }, 'Error in Seller.search');
            throw error;
        }
    }
}

module.exports = new Seller();
