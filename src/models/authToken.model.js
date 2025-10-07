const { getModel: getSpApiAuthorization } = require('./sequelize/spApiAuthorization.model');
const logger = require('../utils/logger.utils');

/**
 * AuthToken Model
 * ORM model for SP API authorization tokens
 */
class AuthToken {
    constructor() {
        this.readOnly = true;
    }

    async findAll(options = {}) {
        try {
            const { where = {}, attributes, order = [['id', 'DESC']], limit, offset } = options;
            const SpApiAuthorization = getSpApiAuthorization();
            const results = await SpApiAuthorization.findAll({ where, attributes, order, limit, offset });
            logger.debug({ count: results.length }, 'AuthToken.findAll');
            return results;
        } catch (error) {
            logger.error({ error: error.message }, 'Error in AuthToken.findAll');
            throw error;
        }
    }

    async findOne(options = {}) {
        try {
            const { where = {}, attributes, order = [['id', 'DESC']] } = options;
            const SpApiAuthorization = getSpApiAuthorization();
            const token = await SpApiAuthorization.findOne({ where, attributes, order });
            logger.debug({ found: !!token }, 'AuthToken.findOne');
            return token;
        } catch (error) {
            logger.error({ error: error.message }, 'Error in AuthToken.findOne');
            throw error;
        }
    }

    /**
     * Get saved token by Amazon Seller ID
     */
    async getSavedToken(amazonSellerID) {
        try {
            const SpApiAuthorization = getSpApiAuthorization();
            const token = await SpApiAuthorization.findOne({
                where: { AmazonSellerID: amazonSellerID },
                attributes: ['id', 'AmazonSellerID', 'access_token', 'refresh_token', 'expires_in'],
                order: [['id', 'DESC']]
            });
            
            if (token) {
                logger.info({ 
                    amazonSellerID, 
                    tokenId: token.id,
                    hasAccessToken: !!token.access_token,
                    hasRefreshToken: !!token.refresh_token,
                    expiresIn: token.expires_in
                }, 'Token found for seller');
            } else {
                logger.warn({ amazonSellerID }, 'No token found in database for seller');
            }
            
            return token;
        } catch (error) {
            logger.error({ error: error.message, stack: error.stack, amazonSellerID }, 'Error in AuthToken.getSavedToken');
            throw error;
        }
    }

    /**
     * Create new token
     */
    async create() { throw new Error('Write operation not allowed on read-only auth token model'); }

    /**
     * Update token by ID
     */
    async update() { throw new Error('Write operation not allowed on read-only auth token model'); }

    /**
     * Update token by Amazon Seller ID
     */
    async updateBySellerId() { throw new Error('Write operation not allowed on read-only auth token model'); }

    /**
     * Delete token by ID
     */
    async destroy() { throw new Error('Write operation not allowed on read-only auth token model'); }

    /**
     * Count tokens
     */
    async count(where = {}) {
        try {
            const SpApiAuthorization = getSpApiAuthorization();
            const count = await SpApiAuthorization.count({ where });
            logger.debug({ where, count }, 'AuthToken.count');
            return count;
        } catch (error) {
            logger.error({ error: error.message, where }, 'Error in AuthToken.count');
            throw error;
        }
    }

    /**
     * Get tokens by Amazon Seller ID
     */
    async getBySellerId(amazonSellerID, options = {}) {
        const SpApiAuthorization = getSpApiAuthorization();
        return await SpApiAuthorization.findAll({ where: { AmazonSellerID: amazonSellerID }, ...options });
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
