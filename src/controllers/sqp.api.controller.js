const { SuccessHandler, ErrorHandler } = require('../middleware/response.handlers');
const { ValidationHelpers } = require('../helpers/sqp.helpers');
const { loadDatabase } = require('../db/tenant.db');
const { getModel: getSellerAsinList } = require('../models/sequelize/sellerAsinList.model');
const sellerModel = require('../models/sequelize/seller.model');
const logger = require('../utils/logger.utils');

/**
 * Handles SQP-related API endpoints
 */
class SqpApiController {

    /**
     * Get ASIN SKU List for a seller
     * GET: /sqp/getAsinSkuList/{userId}/{sellerID}
     */
    async getAsinSkuList(req, res) {
        try {
            const { userId, sellerID } = req.params;
            
            // Validate parameters
            const validatedUserId = ValidationHelpers.sanitizeNumber(userId);
            const validatedSellerID = ValidationHelpers.sanitizeNumber(sellerID);

            if (!validatedUserId || !validatedSellerID || validatedUserId <= 0 || validatedSellerID <= 0) {
                return ErrorHandler.sendError(res, new Error('Invalid userId/sellerID'), 'Invalid userId/sellerID', 400);
            }

            // Load tenant database
            await loadDatabase(validatedUserId);

            // Get models
            const SellerAsinList = getSellerAsinList();

            // Validate seller (active) under this tenant
            const seller = await sellerModel.getProfileDetailsByID(validatedSellerID);

            if (!seller) {
                return ErrorHandler.sendError(res, new Error('Seller not found or inactive'), 'Seller not found or inactive', 404);
            }

            // Fetch ASIN list for seller from seller_ASIN_list table only
            const asinList = await SellerAsinList.findAll({
                where: { SellerID: validatedSellerID },
                attributes: [
                    'ASIN', 'IsActive', 
                    'LastSQPDataPullStatus', 'LastSQPDataPullStartTime', 'LastSQPDataPullEndTime'
                ],
                order: [['ASIN', 'ASC']]
            });

            const response = {
                success: true,
                seller: {
                    id: seller.idSellerAccount,
                    amazon_seller_id: seller.AmazonSellerID,
                    name: seller.SellerName,
                    marketplace_id: seller.MarketPlaceID,
                    marketplace_name: seller.MarketPlaceName
                },
                count: asinList.length,
                asin_sku_list: asinList
            };

            logger.info({
                userId: validatedUserId,
                sellerID: validatedSellerID,
                asinCount: asinList.length
            }, 'getAsinSkuList completed successfully');

            return SuccessHandler.sendSuccess(res, response);

        } catch (error) {
            logger.error({ error: error.message, userId: req.params.userId, sellerID: req.params.sellerID }, 'getAsinSkuList failed');
            return ErrorHandler.sendError(res, error, 'Internal server error', 500);
        }
    }

    /**
     * Update ASIN IsActive status
     * PUT: /sqp/updateAsinStatus/{userId}/{sellerID}/{asin}
     * Body (JSON): { "status": 1 } or { "status": 0 }
     * Body (form-data): status = 1 or status = 0
     * Angular: Supports both JSON and form-data requests
     */
    async updateAsinStatus(req, res) {
        try {
            const { userId, sellerID, asin } = req.params;
            // Handle JSON body, form-data, and Angular requests
            const body = req.body || {};
            const status = body.status || body['status'] || body.Status;
            
            // Log request details for debugging Angular requests
            logger.info({
                userId: userId,
                sellerID: sellerID,
                asin: asin,
                contentType: req.headers['content-type'],
                bodyKeys: body ? Object.keys(body) : [],
                status: status,
                userAgent: req.headers['user-agent']
            }, 'updateAsinStatus request received');
            
            // Validate parameters
            const validatedUserId = ValidationHelpers.sanitizeNumber(userId);
            const validatedSellerID = ValidationHelpers.sanitizeNumber(sellerID);
            const validatedAsin = ValidationHelpers.sanitizeString(asin, 20);
            const validatedStatus = ValidationHelpers.sanitizeNumber(status);

            if (!validatedUserId || !validatedSellerID || !validatedAsin || 
                validatedUserId <= 0 || validatedSellerID <= 0) {
                return ErrorHandler.sendError(res, new Error('Invalid userId/sellerID/asin'), 'Invalid userId/sellerID/asin', 400);
            }

            // Validate status (must be 0 or 1)
            if (status === undefined || status === null || status === '') {
                return ErrorHandler.sendError(res, new Error('Missing status'), 'Status parameter is required in request body', 400);
            }
            
            if (validatedStatus !== 0 && validatedStatus !== 1) {
                return ErrorHandler.sendError(res, new Error('Invalid status'), 'Status must be 0 (inactive) or 1 (active)', 400);
            }

            // Load tenant database
            await loadDatabase(validatedUserId);

            // Get models
            const SellerAsinList = getSellerAsinList();

            // Update IsActive status for the specified ASIN
            const [updatedRows] = await SellerAsinList.update(
                { IsActive: validatedStatus, dtUpdatedOn: new Date() },
                { 
                    where: { 
                        SellerID: validatedSellerID,
                        ASIN: validatedAsin.toUpperCase()
                    }
                }
            );

            if (updatedRows === 0) {
                return ErrorHandler.sendError(res, new Error('ASIN not found for this seller'), 'ASIN not found for this seller', 404);
            }

            // Get the updated record
            const updatedRecord = await SellerAsinList.findOne({
                where: { 
                    SellerID: validatedSellerID,
                    ASIN: validatedAsin.toUpperCase()
                },
                attributes: ['ID', 'SellerID', 'ASIN', 'IsActive', 'dtUpdatedOn']
            });

            const statusText = validatedStatus === 1 ? 'active' : 'inactive';
            const response = {
                success: true,
                message: `ASIN status updated to ${statusText} successfully`,
                asin: updatedRecord
            };

            logger.info({
                userId: validatedUserId,
                sellerID: validatedSellerID,
                asin: validatedAsin,
                status: validatedStatus,
                statusText: statusText,
                updatedRows
            }, 'updateAsinStatus completed successfully');

            return SuccessHandler.sendSuccess(res, response);

        } catch (error) {
            logger.error({ error: error.message, userId: req.params.userId, sellerID: req.params.sellerID, asin: req.params.asin }, 'updateAsinStatus failed');
            return ErrorHandler.sendError(res, error, 'Internal server error', 500);
        }
    }
}

module.exports = new SqpApiController();
