const { getCurrentSequelize } = require('../../db/tenant.db');

// Writable models
// Note: SqpCronDetails and SqpCronLogs are tenant-aware via getModel(); do not import here
const SqpDownloadUrls = require('./sqpDownloadUrls.model');
const SellerAsinList = require('./sellerAsinList.model');

// Read-only models
const Seller = require('./seller.model');
const Marketplace = require('./marketplace.model');
const SellerMarketplacesMapping = require('./sellerMarketplacesMapping.model');
const AsinSkuList = require('./asinSkuList.model');
const MwsOauthToken = require('./mwsOauthToken.model');
const MwsAccessKeys = require('./mwsAccessKeys.model');
const SpApiSts = require('./spApiSts.model');

async function init() {
    await sequelize.authenticate();
    return {
        sequelize,
        // tenant-aware: import directly where needed
        SqpDownloadUrls,
        SellerAsinList,
        // read-only
        Seller,
        Marketplace,
        SellerMarketplacesMapping,
        AsinSkuList,
        MwsOauthToken,
        MwsAccessKeys,
        SpApiSts
    };
}

module.exports = {
    init,
    sequelize,    
    // tenant-aware: not exported here
    SqpDownloadUrls,
    SellerAsinList,
    // read-only
    Seller,
    Marketplace,
    SellerMarketplacesMapping,
    AsinSkuList,
    MwsOauthToken,
    MwsAccessKeys,
    SpApiSts
};


