const { query } = require('../db/mysql.db');
const logger = require('../utils/logger.utils');

/**
 * Base ORM Model Class
 * Provides common database operations for all models
 */
class BaseModel {
    constructor(tableName, primaryKey = 'id') {
        this.tableName = tableName;
        this.primaryKey = primaryKey;
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
                select = '*' 
            } = options;

            let sql = `SELECT ${select} FROM ${this.tableName}`;
            const params = [];

            // Add WHERE clause
            if (Object.keys(where).length > 0) {
                const whereClause = Object.keys(where).map(key => `${key} = ?`).join(' AND ');
                sql += ` WHERE ${whereClause}`;
                params.push(...Object.values(where));
            }

            // Add ORDER BY clause
            if (orderBy) {
                sql += ` ORDER BY ${orderBy}`;
            }

            // Add LIMIT clause
            if (limit) {
                sql += ` LIMIT ${limit}`;
                if (offset > 0) {
                    sql += ` OFFSET ${offset}`;
                }
            }

            const results = await query(sql, params);
            logger.debug({ table: this.tableName, sql, params, count: results.length }, 'BaseModel.getAll');
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
            const sql = `SELECT * FROM ${this.tableName} WHERE ${this.primaryKey} = ?`;
            const results = await query(sql, [id]);
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
            const whereClause = Object.keys(conditions).map(key => `${key} = ?`).join(' AND ');
            const sql = `SELECT * FROM ${this.tableName} WHERE ${whereClause} LIMIT 1`;
            const params = Object.values(conditions);
            
            const results = await query(sql, params);
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
            const fields = Object.keys(data);
            const values = Object.values(data);
            const placeholders = fields.map(() => '?').join(', ');
            
            const sql = `INSERT INTO ${this.tableName} (${fields.join(', ')}) VALUES (${placeholders})`;
            const result = await query(sql, values);
            
            logger.debug({ table: this.tableName, id: result.insertId, fields }, 'BaseModel.create');
            return result.insertId;
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
            const fields = Object.keys(data);
            const values = Object.values(data);
            const setClause = fields.map(field => `${field} = ?`).join(', ');
            
            const sql = `UPDATE ${this.tableName} SET ${setClause} WHERE ${this.primaryKey} = ?`;
            const result = await query(sql, [...values, id]);
            
            logger.debug({ table: this.tableName, id, fields, affectedRows: result.affectedRows }, 'BaseModel.update');
            return result.affectedRows > 0;
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
            const fields = Object.keys(data);
            const values = Object.values(data);
            const setClause = fields.map(field => `${field} = ?`).join(', ');
            const whereClause = Object.keys(conditions).map(key => `${key} = ?`).join(' AND ');
            
            const sql = `UPDATE ${this.tableName} SET ${setClause} WHERE ${whereClause}`;
            const result = await query(sql, [...values, ...Object.values(conditions)]);
            
            logger.debug({ table: this.tableName, conditions, fields, affectedRows: result.affectedRows }, 'BaseModel.updateBy');
            return result.affectedRows;
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
            const sql = `DELETE FROM ${this.tableName} WHERE ${this.primaryKey} = ?`;
            const result = await query(sql, [id]);
            
            logger.debug({ table: this.tableName, id, affectedRows: result.affectedRows }, 'BaseModel.delete');
            return result.affectedRows > 0;
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
            const whereClause = Object.keys(conditions).map(key => `${key} = ?`).join(' AND ');
            const sql = `DELETE FROM ${this.tableName} WHERE ${whereClause}`;
            const params = Object.values(conditions);
            
            const result = await query(sql, params);
            logger.debug({ table: this.tableName, conditions, affectedRows: result.affectedRows }, 'BaseModel.deleteBy');
            return result.affectedRows;
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
            let sql = `SELECT COUNT(*) as count FROM ${this.tableName}`;
            const params = [];

            if (Object.keys(conditions).length > 0) {
                const whereClause = Object.keys(conditions).map(key => `${key} = ?`).join(' AND ');
                sql += ` WHERE ${whereClause}`;
                params.push(...Object.values(conditions));
            }

            const results = await query(sql, params);
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
    async find(sql, params = []) {
        try {
            const results = await query(sql, params);
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
    async query(sql, params = []) {
        try {
            const results = await query(sql, params);
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
            await query('START TRANSACTION');
            logger.debug({ table: this.tableName }, 'BaseModel.beginTransaction');
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in BaseModel.beginTransaction');
            throw error;
        }
    }

    /**
     * Commit transaction
     */
    async commit() {
        try {
            await query('COMMIT');
            logger.debug({ table: this.tableName }, 'BaseModel.commit');
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in BaseModel.commit');
            throw error;
        }
    }

    /**
     * Rollback transaction
     */
    async rollback() {
        try {
            await query('ROLLBACK');
            logger.debug({ table: this.tableName }, 'BaseModel.rollback');
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in BaseModel.rollback');
            throw error;
        }
    }
}

module.exports = BaseModel;
