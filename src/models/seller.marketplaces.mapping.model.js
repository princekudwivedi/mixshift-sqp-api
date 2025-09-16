const BaseModel = require('./base.model');
const { env } = require('../config/env.config');

class SellerMarketplacesMappingModel extends BaseModel {
    constructor() {
        super(env('TBL_SELLER_MARKET_PLACES_MAPPING', 'seller_marketplaces_mapping'), 'ID');
    }

    async getBySellerId(sellerId, options = {}) {
        return this.getAll({ where: { SellerID: sellerId }, ...options });
    }

    async getByMarketplaceId(marketplaceId, options = {}) {
        return this.getAll({ where: { MarketplaceID: marketplaceId }, ...options });
    }

    async list(options = {}) {
        return this.getAll(options);
    }
}

module.exports = new SellerMarketplacesMappingModel();


