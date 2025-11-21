const { getCurrentSequelize } = require('../db/tenant.db');
const logger = require('../utils/logger.utils');
const { Op } = require('sequelize');

/**
 * Base ORM Model Class
 * Provides common database operations for all models using Sequelize
 */
class BaseModel {
    constructor(tableName, primaryKey = 'id') {
        this.tableName = tableName;
        this.primaryKey = primaryKey;
        this.sequelize = null;
    }

    /**
     * Get Sequelize instance
     */
    getSequelize() {
        if (!this.sequelize) {
            this.sequelize = getCurrentSequelize();
        }
        return this.sequelize;
    }

    /**
     * Get all records
     */
    async getAll(options = {}) {
        try {
            const { 
                where = {}, 
                orderBy = null, 
                limit = null, 
                offset = 0,
                attributes = null 
            } = options;

            const sequelize = this.getSequelize();
            const queryOptions = {
                where,
                attributes: attributes || undefined,
                order: orderBy ? [[orderBy]] : undefined,
                limit: limit || undefined,
                offset: offset || undefined
            };

            // Remove undefined values
            for (const key of Object.keys(queryOptions)) {
                if (queryOptions[key] === undefined) {
                    delete queryOptions[key];
                }
            }

            const results = await sequelize.query(
                `SELECT * FROM ${this.tableName}`,
                {
                    replacements: {},
                    type: sequelize.QueryTypes.SELECT,
                    ...queryOptions
                }
            );

            logger.debug({ table: this.tableName, count: results.length }, 'BaseModel.getAll');
            return results;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in BaseModel.getAll');
            throw error;
        }
    }

    /**
     * Get a single record by ID
     */
    async get(id) {
        try {
            const sequelize = this.getSequelize();
            const results = await sequelize.query(
                `SELECT * FROM ${this.tableName} WHERE ${this.primaryKey} = :id LIMIT 1`,
                {
                    replacements: { id },
                    type: sequelize.QueryTypes.SELECT
                }
            );
            const record = results[0] || null;
            
            logger.debug({ table: this.tableName, id, found: !!record }, 'BaseModel.get');
            return record;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, id }, 'Error in BaseModel.get');
            throw error;
        }
    }

    /**
     * Get a single record by conditions
     */
    async getBy(conditions) {
        try {
            const sequelize = this.getSequelize();
            const whereClause = Object.keys(conditions).map(key => `${key} = :${key}`).join(' AND ');
            const results = await sequelize.query(
                `SELECT * FROM ${this.tableName} WHERE ${whereClause} LIMIT 1`,
                {
                    replacements: conditions,
                    type: sequelize.QueryTypes.SELECT
                }
            );
            const record = results[0] || null;
            
            logger.debug({ table: this.tableName, conditions, found: !!record }, 'BaseModel.getBy');
            return record;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, conditions }, 'Error in BaseModel.getBy');
            throw error;
        }
    }

    /**
     * Create a new record
     */
    async create(data) {
        try {
            const sequelize = this.getSequelize();
            const fields = Object.keys(data);
            
            const columns = fields.join(', ');
            const placeholders = fields.map(f => `:${f}`).join(', ');

            const result = await sequelize.query(
                `INSERT INTO ${this.tableName} (${columns}) VALUES (${placeholders})`,
                {
                    replacements: data,
                    type: sequelize.QueryTypes.INSERT
                }
            );
            
            logger.debug({ table: this.tableName, id: result[0], fields }, 'BaseModel.create');
            return result[0];
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, data }, 'Error in BaseModel.create');
            throw error;
        }
    }

    /**
     * Update a record by ID
     */
    async update(id, data) {
        try {
            const sequelize = this.getSequelize();
            const fields = Object.keys(data);
            const setClause = fields.map(field => `${field} = :${field}`).join(', ');
            
            const result = await sequelize.query(
                `UPDATE ${this.tableName} SET ${setClause} WHERE ${this.primaryKey} = :id`,
                {
                    replacements: { ...data, id },
                    type: sequelize.QueryTypes.UPDATE
                }
            );
            
            logger.debug({ table: this.tableName, id, fields, affectedRows: result[1] }, 'BaseModel.update');
            return result[1] > 0;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, id, data }, 'Error in BaseModel.update');
            throw error;
        }
    }

    /**
     * Update records by conditions
     */
    async updateBy(conditions, data) {
        try {
            const sequelize = this.getSequelize();
            const fields = Object.keys(data);
            const setClause = fields.map(field => `${field} = :${field}`).join(', ');
            const whereClause = Object.keys(conditions).map(key => `${key} = :${key}`).join(' AND ');
            
            const result = await sequelize.query(
                `UPDATE ${this.tableName} SET ${setClause} WHERE ${whereClause}`,
                {
                    replacements: { ...data, ...conditions },
                    type: sequelize.QueryTypes.UPDATE
                }
            );
            
            logger.debug({ table: this.tableName, conditions, fields, affectedRows: result[1] }, 'BaseModel.updateBy');
            return result[1];
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, conditions, data }, 'Error in BaseModel.updateBy');
            throw error;
        }
    }

    /**
     * Delete a record by ID
     */
    async delete(id) {
        try {
            const sequelize = this.getSequelize();
            const result = await sequelize.query(
                `DELETE FROM ${this.tableName} WHERE ${this.primaryKey} = :id`,
                {
                    replacements: { id },
                    type: sequelize.QueryTypes.DELETE
                }
            );
            
            logger.debug({ table: this.tableName, id, affectedRows: result[1] }, 'BaseModel.delete');
            return result[1] > 0;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, id }, 'Error in BaseModel.delete');
            throw error;
        }
    }

    /**
     * Delete records by conditions
     */
    async deleteBy(conditions) {
        try {
            const sequelize = this.getSequelize();
            const whereClause = Object.keys(conditions).map(key => `${key} = :${key}`).join(' AND ');
            
            const result = await sequelize.query(
                `DELETE FROM ${this.tableName} WHERE ${whereClause}`,
                {
                    replacements: conditions,
                    type: sequelize.QueryTypes.DELETE
                }
            );
            
            logger.debug({ table: this.tableName, conditions, affectedRows: result[1] }, 'BaseModel.deleteBy');
            return result[1];
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, conditions }, 'Error in BaseModel.deleteBy');
            throw error;
        }
    }

    /**
     * Count records
     */
    async count(conditions = {}) {
        try {
            const sequelize = this.getSequelize();
            let sql = `SELECT COUNT(*) as count FROM ${this.tableName}`;
            const replacements = {};

            if (Object.keys(conditions).length > 0) {
                const whereClause = Object.keys(conditions).map(key => `${key} = :${key}`).join(' AND ');
                sql += ` WHERE ${whereClause}`;
                Object.assign(replacements, conditions);
            }

            const results = await sequelize.query(sql, {
                replacements,
                type: sequelize.QueryTypes.SELECT
            });
            const count = results[0].count;
            
            logger.debug({ table: this.tableName, conditions, count }, 'BaseModel.count');
            return count;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, conditions }, 'Error in BaseModel.count');
            throw error;
        }
    }

    /**
     * Check if record exists
     */
    async exists(conditions) {
        try {
            const count = await this.count(conditions);
            return count > 0;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, conditions }, 'Error in BaseModel.exists');
            throw error;
        }
    }

    /**
     * Find records with custom SQL
     */
    async find(sql, params = {}) {
        try {
            const sequelize = this.getSequelize();
            const results = await sequelize.query(sql, {
                replacements: params,
                type: sequelize.QueryTypes.SELECT
            });
            logger.debug({ table: this.tableName, sql, params, count: results.length }, 'BaseModel.find');
            return results;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, sql, params }, 'Error in BaseModel.find');
            throw error;
        }
    }

    /**
     * Execute raw SQL query
     */
    async query(sql, params = {}) {
        try {
            const sequelize = this.getSequelize();
            const results = await sequelize.query(sql, {
                replacements: params,
                type: sequelize.QueryTypes.SELECT
            });
            logger.debug({ table: this.tableName, sql, params, count: results.length }, 'BaseModel.query');
            return results;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, sql, params }, 'Error in BaseModel.query');
            throw error;
        }
    }

    /**
     * Begin transaction
     */
    async beginTransaction() {
        try {
            const sequelize = this.getSequelize();
            const transaction = await sequelize.transaction();
            logger.debug({ table: this.tableName }, 'BaseModel.beginTransaction');
            return transaction;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in BaseModel.beginTransaction');
            throw error;
        }
    }

    /**
     * Commit transaction
     */
    async commit(transaction) {
        try {
            await transaction.commit();
            logger.debug({ table: this.tableName }, 'BaseModel.commit');
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in BaseModel.commit');
            throw error;
        }
    }

    /**
     * Rollback transaction
     */
    async rollback(transaction) {
        try {
            await transaction.rollback();
            logger.debug({ table: this.tableName }, 'BaseModel.rollback');
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in BaseModel.rollback');
            throw error;
        }
    }
}

module.exports = BaseModel;
