const dbConfig = require('../config/db.config');
const logger = require('../src/utils/logger');

/**
 * AuthToken Model
 * ORM model for SP API authorization tokens
 */
class AuthToken {
    constructor() {
        this.tableName = 'tbl_sp_api_authorization';
        this.primaryKey = 'id';
    }

    /**
     * Find all tokens with options
     */
    async findAll(options = {}) {
        try {
            const {
                where = {},
                attributes = '*',
                order = [['id', 'DESC']],
                limit = null,
                offset = 0
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
            logger.debug({ table: this.tableName, count: results.length }, 'AuthToken.findAll');
            return results;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in AuthToken.findAll');
            throw error;
        }
    }

    /**
     * Find one token by conditions
     */
    async findOne(options = {}) {
        try {
            const {
                where = {},
                attributes = '*',
                order = [['id', 'DESC']]
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

            sql += ' LIMIT 1';

            const results = await dbConfig.query(sql, params);
            const token = results[0] || null;
            
            logger.debug({ table: this.tableName, found: !!token }, 'AuthToken.findOne');
            return token;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in AuthToken.findOne');
            throw error;
        }
    }

    /**
     * Get saved token by Amazon Seller ID
     */
    async getSavedToken(amazonSellerID) {
        try {
            const token = await this.findOne({
                where: { AmazonSellerID: amazonSellerID },
                attributes: ['id', 'AmazonSellerID', 'access_token', 'refresh_token', 'expires_in'],
                order: [['id', 'DESC']]
            });

            logger.debug({ amazonSellerID, found: !!token }, 'AuthToken.getSavedToken');
            return token;
        } catch (error) {
            logger.error({ error: error.message, amazonSellerID }, 'Error in AuthToken.getSavedToken');
            throw error;
        }
    }

    /**
     * Create new token
     */
    async create(tokenData) {
        try {
            const data = {
                AmazonSellerID: tokenData.amazonSellerID,
                access_token: tokenData.accessToken,
                refresh_token: tokenData.refreshToken,
                expires_in: tokenData.expiresIn,
                created_at: new Date(),
                updated_at: new Date(),
                ...tokenData
            };

            const fields = Object.keys(data);
            const values = Object.values(data);
            const placeholders = fields.map(() => '?').join(', ');
            
            const sql = `INSERT INTO ${this.tableName} (${fields.join(', ')}) VALUES (${placeholders})`;
            const result = await dbConfig.query(sql, values);
            
            logger.debug({ table: this.tableName, id: result.insertId, amazonSellerID: tokenData.amazonSellerID }, 'AuthToken.create');
            return { ...data, [this.primaryKey]: result.insertId };
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, tokenData }, 'Error in AuthToken.create');
            throw error;
        }
    }

    /**
     * Update token by ID
     */
    async update(id, updateData) {
        try {
            const data = {
                ...updateData,
                updated_at: new Date()
            };

            const fields = Object.keys(data);
            const values = Object.values(data);
            const setClause = fields.map(field => `${field} = ?`).join(', ');
            
            const sql = `UPDATE ${this.tableName} SET ${setClause} WHERE ${this.primaryKey} = ?`;
            const result = await dbConfig.query(sql, [...values, id]);
            
            logger.debug({ table: this.tableName, id, fields, affectedRows: result.affectedRows }, 'AuthToken.update');
            return result.affectedRows > 0;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, id, updateData }, 'Error in AuthToken.update');
            throw error;
        }
    }

    /**
     * Update token by Amazon Seller ID
     */
    async updateBySellerId(amazonSellerID, updateData) {
        try {
            const data = {
                ...updateData,
                updated_at: new Date()
            };

            const fields = Object.keys(data);
            const values = Object.values(data);
            const setClause = fields.map(field => `${field} = ?`).join(', ');
            
            const sql = `UPDATE ${this.tableName} SET ${setClause} WHERE AmazonSellerID = ?`;
            const result = await dbConfig.query(sql, [...values, amazonSellerID]);
            
            logger.debug({ table: this.tableName, amazonSellerID, fields, affectedRows: result.affectedRows }, 'AuthToken.updateBySellerId');
            return result.affectedRows > 0;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, amazonSellerID, updateData }, 'Error in AuthToken.updateBySellerId');
            throw error;
        }
    }

    /**
     * Delete token by ID
     */
    async destroy(id) {
        try {
            const sql = `DELETE FROM ${this.tableName} WHERE ${this.primaryKey} = ?`;
            const result = await dbConfig.query(sql, [id]);
            
            logger.debug({ table: this.tableName, id, affectedRows: result.affectedRows }, 'AuthToken.destroy');
            return result.affectedRows > 0;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, id }, 'Error in AuthToken.destroy');
            throw error;
        }
    }

    /**
     * Count tokens
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
            
            logger.debug({ table: this.tableName, where, count }, 'AuthToken.count');
            return count;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, where }, 'Error in AuthToken.count');
            throw error;
        }
    }

    /**
     * Get tokens by Amazon Seller ID
     */
    async getBySellerId(amazonSellerID, options = {}) {
        return await this.findAll({
            where: { AmazonSellerID: amazonSellerID },
            ...options
        });
    }

    /**
     * Check if token exists for seller
     */
    async existsForSeller(amazonSellerID) {
        const count = await this.count({ AmazonSellerID: amazonSellerID });
        return count > 0;
    }
}

module.exports = new AuthToken();
