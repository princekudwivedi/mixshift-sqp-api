const BaseModel = require('./base.model');
const { env } = require('../config/env.config');

class MarketplaceModel extends BaseModel {
    constructor() {
        super(env('TBL_MARKET_PLACE', 'marketplace'), 'ID');
    }

    async getById(id) {
        return this.get(id);
    }

    async getBy(field, value, options = {}) {
        return this.getAll({ where: { [field]: value }, ...options });
    }

    async list(options = {}) {
        return this.getAll(options);
    }

    async countAll(where = {}) {
        return this.count(where);
    }
}

module.exports = new MarketplaceModel();


