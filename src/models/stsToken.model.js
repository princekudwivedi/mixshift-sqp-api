const { getModel: getSpApiSts } = require('./sequelize/spApiSts.model');
const logger = require('../utils/logger.utils');
const dates = require('../utils/dates.utils');

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
            logger.warn({ error: error.message }, 'STS token table not found or accessible');
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
            const SpApiSts = getSpApiSts();
            const count = await SpApiSts.count({ where });
            logger.debug({ where, count }, 'StsToken.count');
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
            const now = dates.getDateTime();
            const SpApiSts = getSpApiSts();
            const { Op } = require('sequelize');
            const tokens = await SpApiSts.findAll({ where: { expire_at: { [Op.gt]: now } }, order: [['id','DESC']] });
            logger.debug({ count: tokens.length }, 'StsToken.getActiveTokens');
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

            const now = dates.getDateTime();
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
