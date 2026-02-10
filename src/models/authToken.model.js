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
                attributes: ['id', 'AmazonSellerID', 'access_token', 'refresh_token', 'expires_in','iLostAccess','dtLostAccessOn'],
                order: [['id', 'DESC']]
            });
            
            if (token && token.iLostAccess === 0) {
                logger.info({ 
                    amazonSellerID, 
                    tokenId: token.id,
                    hasAccessToken: !!token.access_token,
                    hasRefreshToken: !!token.refresh_token,
                    expiresIn: token.expires_in
                }, 'Token found for seller');
            } else {
                if (token?.iLostAccess === 1) {
                    logger.warn({ amazonSellerID, iLostAccess: token?.iLostAccess }, 'Token lost access for seller');
                } else {
                    logger.warn({ amazonSellerID, iLostAccess: token?.iLostAccess }, 'No token found in database for seller');
                }
            }
            
            return token;
        } catch (error) {
            logger.error({ error: error.message, stack: error.stack, amazonSellerID }, 'Error in AuthToken.getSavedToken');
            throw error;
        }
    }

    /**
     * Update token after refresh (ALLOWED for token refresh operations)
     * @param {string} amazonSellerID - Amazon Seller ID
     * @param {Object} tokenData - Token data to update
     * @returns {boolean} - Success status
     */
    async updateRefreshedToken(amazonSellerID, tokenData) {
        try {
            const SpApiAuthorization = getSpApiAuthorization();
            
            const updateData = {
                access_token: tokenData.access_token,
                expires_in: tokenData.expires_in
            };
            
            // Update refresh token if provided
            if (tokenData.refresh_token) {
                updateData.refresh_token = tokenData.refresh_token;
            }
            
            const [updated] = await SpApiAuthorization.update(updateData, {
                where: { AmazonSellerID: amazonSellerID }
            });
            
            if (updated > 0) {
                logger.info({ 
                    amazonSellerID, 
                    expiresAt: tokenData.expires_in
                }, 'Token updated after refresh');
                return true;
            } else {
                logger.warn({ amazonSellerID }, 'No token record found to update');
                return false;
            }
            
        } catch (error) {
            logger.error({ 
                amazonSellerID,
                error: error.message,
                stack: error.stack
            }, 'Failed to update refreshed token');
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
