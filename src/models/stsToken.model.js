const { getModel: getSpApiSts } = require('./sequelize/spApiSts.model');
const logger = require('../utils/logger.utils');

/**
 * StsToken Model
 * ORM model for STS tokens
 */
class StsToken {
    constructor() {}

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

            const SpApiSts = getSpApiSts();
            const results = await SpApiSts.findAll({ where, attributes: Array.isArray(attributes) ? attributes : undefined, order, limit, offset });
            logger.debug({ count: results.length }, 'StsToken.findAll');
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

            const SpApiSts = getSpApiSts();
            const token = await SpApiSts.findOne({ where, attributes: Array.isArray(attributes) ? attributes : undefined, order });
            logger.debug({ found: !!token }, 'StsToken.findOne');
            return token;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName }, 'Error in StsToken.findOne');
            throw error;
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
            const SpApiSts = getSpApiSts();
            const count = await SpApiSts.count({ where });
            logger.debug({ where, count }, 'StsToken.count');
            return count;
        } catch (error) {
            logger.error({ error: error.message, table: this.tableName, where }, 'Error in StsToken.count');
            throw error;
        }
    }
}

module.exports = new StsToken();
