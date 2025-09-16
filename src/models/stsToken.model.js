const dbConfig = require('../config/db.config');
const { TBL_STS_TOKENS } = require('../config/env.config');
const logger = require('../src/utils/logger');

/**
 * StsToken Model
 * ORM model for STS tokens
 */
class StsToken {
    constructor() {
        this.tableName = TBL_STS_TOKENS;
        this.primaryKey = 'id';
    }

    /**
     * Find all STS tokens with options
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
            logger.debug({ table: this.tableName, count: results.length }, 'StsToken.findAll');
            return results;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in StsToken.findAll');
            throw error;
        }
    }

    /**
     * Find one STS token by conditions
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
            
            logger.debug({ table: this.tableName, found: !!token }, 'StsToken.findOne');
            return token;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in StsToken.findOne');
            throw error;
        }
    }

    /**
     * Get latest STS token details
     */
    async getLatestTokenDetails() {
        try {
            const token = await this.findOne({
                attributes: ['id', 'accessKeyId', 'secretAccessKey', 'SessionToken', 'expire_at'],
                order: [['id', 'DESC']]
            });

            logger.debug({ found: !!token }, 'StsToken.getLatestTokenDetails');
            return token;
        } catch (error) {
            logger.warn({ error: error.message, table: this.tableName }, 'STS token table not found or accessible');
            return null;
        }
    }

    // Write operations are not allowed for read-only model
    async create() {
        throw new Error('Write operation not allowed on read-only STS token model');
    }

    async update() {
        throw new Error('Write operation not allowed on read-only STS token model');
    }

    async destroy() {
        throw new Error('Write operation not allowed on read-only STS token model');
    }

    /**
     * Count STS tokens
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
            
            logger.debug({ table: this.tableName, where, count }, 'StsToken.count');
            return count;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, where }, 'Error in StsToken.count');
            throw error;
        }
    }

    /**
     * Get active STS tokens (not expired)
     */
    async getActiveTokens() {
        try {
            const now = new Date();
            const tokens = await this.findAll({
                where: { expire_at: { operator: '>', value: now } },
                order: [['id', 'DESC']]
            });

            logger.debug({ table: this.tableName, count: tokens.length }, 'StsToken.getActiveTokens');
            return tokens;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in StsToken.getActiveTokens');
            throw error;
        }
    }

    /**
     * Check if token is expired
     */
    async isTokenExpired(tokenId) {
        try {
            const token = await this.findOne({
                where: { id: tokenId },
                attributes: ['expire_at']
            });

            if (!token) {
                return true; // Token not found, consider expired
            }

            const now = new Date();
            const expireAt = new Date(token.expire_at);
            const isExpired = now >= expireAt;

            logger.debug({ tokenId, isExpired, expireAt, now }, 'StsToken.isTokenExpired');
            return isExpired;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, tokenId }, 'Error in StsToken.isTokenExpired');
            return true; // On error, consider expired
        }
    }
}

module.exports = new StsToken();
