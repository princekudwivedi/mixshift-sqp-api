const dbConfig = require('../config/db.config');
const { TBL_USERS } = require('../config/env.config');
const logger = require('../src/utils/logger');

/**
 * User Model
 * ORM model for users table (for cron operations)
 */
class User {
    constructor() {
        this.tableName = TBL_USERS;
        this.primaryKey = 'ID';
    }

    /**
     * Find all users with options
     */
    async findAll(options = {}) {
        try {
            const {
                where = {},
                attributes = '*',
                order = [['ID', 'ASC']],
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
            logger.debug({ table: this.tableName, count: results.length }, 'User.findAll');
            return results;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in User.findAll');
            throw error;
        }
    }

    /**
     * Count users with conditions
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
            
            logger.debug({ table: this.tableName, where, count }, 'User.count');
            return count;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, where }, 'Error in User.count');
            throw error;
        }
    }

    /**
     * Check if cron priority flag is active for any agency user
     */
    async checkCronPriorityFlagActive() {
        try {
            const count = await this.count({
                iActive: '1',
                iParentID: '0',
                iUserType: '2',
                isDeleted: '0',
                isDemoUser: '0',
                iCronPriorityFlag: '1'
            });
            
            const isActive = count > 0;
            logger.debug({ count, isActive }, 'User.checkCronPriorityFlagActive');
            return isActive;
        } catch (error) {
            logger.error({ error: error.message }, 'Error in User.checkCronPriorityFlagActive');
            throw error;
        }
    }

    /**
     * Get all agency user list with proper ordering
     */
    async getAllAgencyUserList() {
        try {
            const priorityActive = await this.checkCronPriorityFlagActive();
            
            // Build the complex query with joins
            let sql = `
                SELECT 
                    user.ID,
                    user.Email,
                    user.AgencyName,
                    user.iCronPriorityFlag,
                    user.dtUpdatedOn,
                    DB.DB_Name,
                    DB.DomainName,
                    time.Timezone,
                    time.GMT_Value
                FROM ${this.tableName} AS user
                LEFT JOIN ${process.env.TBL_USER_DB_MAP || 'user_db_mapping'} AS map ON map.UserID = user.ID
                LEFT JOIN ${process.env.TBL_USER_DBS || 'user_databases'} AS DB ON map.MappedDB_ID = DB.DB_ID
                LEFT JOIN ${process.env.TBL_TIMEZONES || 'timezones'} AS time ON user.iTimezoneID = time.ID
                WHERE user.iActive = '1'
                  AND user.iParentID = '0'
                  AND user.iUserType != '4'
                  AND user.isDeleted = '0'
                  AND user.isDemoUser = '0'
                  AND DB.DB_Name <> ''
                  AND DB.DomainName <> ''
            `;

            // Add ordering based on priority flag
            if (priorityActive) {
                sql += ` ORDER BY user.iCronPriorityFlag DESC, user.dtUpdatedOn ASC, user.ID ASC`;
            } else {
                sql += ` ORDER BY time.GMT_Value DESC, user.ID ASC`;
            }

            const results = await dbConfig.query(sql);
            logger.debug({ table: this.tableName, count: results.length, priorityActive }, 'User.getAllAgencyUserList');
            return results;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in User.getAllAgencyUserList');
            throw error;
        }
    }

    /**
     * Find user by ID
     */
    async findById(id) {
        try {
            const sql = `SELECT * FROM ${this.tableName} WHERE ${this.primaryKey} = ? LIMIT 1`;
            const results = await dbConfig.query(sql, [id]);
            const user = results[0] || null;
            
            logger.debug({ table: this.tableName, id, found: !!user }, 'User.findById');
            return user;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, id }, 'Error in User.findById');
            throw error;
        }
    }

    /**
     * Find users by conditions
     */
    async findBy(conditions) {
        try {
            const whereClause = Object.keys(conditions).map(key => `${key} = ?`).join(' AND ');
            const sql = `SELECT * FROM ${this.tableName} WHERE ${whereClause}`;
            const params = Object.values(conditions);
            
            const results = await dbConfig.query(sql, params);
            logger.debug({ table: this.tableName, conditions, count: results.length }, 'User.findBy');
            return results;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, conditions }, 'Error in User.findBy');
            throw error;
        }
    }

    /**
     * Get active agency users
     */
    async getActiveAgencyUsers() {
        return await this.findBy({
            iActive: '1',
            iParentID: '0',
            iUserType: '2',
            isDeleted: '0',
            isDemoUser: '0'
        });
    }

    /**
     * Get users with cron priority flag
     */
    async getUsersWithCronPriority() {
        return await this.findBy({
            iActive: '1',
            iParentID: '0',
            iUserType: '2',
            isDeleted: '0',
            isDemoUser: '0',
            iCronPriorityFlag: '1'
        });
    }
}

module.exports = new User();
