const sequelize = require('../../config/sequelize.config');

// Writable models
const SqpMetrics3mo = require('./sqpMetrics3mo.model');
const SqpMetrics = require('./sqpMetrics.model');
const SqpCronDetails = require('./sqpCronDetails.model');
const SqpCronLogs = require('./sqpCronLogs.model');
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
        // writable
        SqpMetrics3mo,
        SqpMetrics,
        SqpCronDetails,
        SqpCronLogs,
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
    // writable
    SqpMetrics3mo,
    SqpMetrics,
    SqpCronDetails,
    SqpCronLogs,
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


