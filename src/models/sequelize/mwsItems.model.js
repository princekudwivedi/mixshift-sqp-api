const { DataTypes } = require('sequelize');
const { getCurrentSequelize } = require('../../db/tenant.db');
const { TBL_MWS_ITEMS } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_MWS_ITEMS || 'mws_items';

// Cache for the model to prevent recreating it
let cachedModel = null;

function getModel() {
    if (!cachedModel) {
        const sequelize = getCurrentSequelize();
        cachedModel = sequelize.define(table, {
            ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            SellerID: DataTypes.STRING,
            SellerName: DataTypes.STRING,
            ProfileID: DataTypes.STRING,
            MerchantType: DataTypes.STRING,
            MarketPlaceName: DataTypes.STRING,
            MarketPlaceID: DataTypes.STRING,
            AmazonSellerID: DataTypes.STRING,
            AmazonMarketplaceId: DataTypes.STRING,
            AmazonMarketplaceName: DataTypes.STRING,
            ItemName: DataTypes.STRING,
            ItemDescription: DataTypes.TEXT,
            AmazonListingId: DataTypes.STRING,
            SKU: DataTypes.STRING,
            ItemPrice: DataTypes.FLOAT,
            ItemQuantityAvailable: DataTypes.INTEGER,
            OpenDate: DataTypes.DATE,
            ImageUrl: DataTypes.STRING,
            ItemIsMarketplace: DataTypes.STRING,
            ProductIdType: DataTypes.STRING,
            ZshopShippingFee: DataTypes.STRING,
            ItemNote: DataTypes.TEXT,
            ItemCondition: DataTypes.STRING,
            ZshopCategory: DataTypes.STRING,
            ZshopBrowsePath: DataTypes.STRING,
            ZshopStorefrontFeature: DataTypes.STRING,
            ASIN: DataTypes.STRING,
            ASIN_2: DataTypes.STRING,
            ASIN_3: DataTypes.STRING,
            WillShipInternationally: DataTypes.STRING,
            ExpeditedShipping: DataTypes.STRING,
            ZShopBoldface: DataTypes.STRING,
            AmazonProductId: DataTypes.STRING,
            BidForFeaturedPlacement: DataTypes.STRING,
            AddDelete: DataTypes.STRING,
            PendingQuantity: DataTypes.INTEGER,
            FulfillmentChannel: DataTypes.STRING,
            MerchantShippingGroup: DataTypes.STRING,
            ItemCost: DataTypes.FLOAT,
            LeadTime: DataTypes.INTEGER,
            IsActive: DataTypes.BOOLEAN,
            ItemNickname: DataTypes.STRING,
            ParentASIN: DataTypes.STRING,
            ItemGroup: DataTypes.STRING,
            ItemLabel1: DataTypes.STRING,
            ItemLabel2: DataTypes.STRING,
            ItemCostGlobal: DataTypes.FLOAT,
            ShippingCost: DataTypes.FLOAT,
            Brand: DataTypes.STRING,
            TargetACOS: DataTypes.FLOAT,
            TargetTACOS: DataTypes.FLOAT,
            Tag1: DataTypes.STRING,
            Tag2: DataTypes.STRING,
            Tag3: DataTypes.STRING,
            Tag4: DataTypes.STRING,
            MainImage1: DataTypes.STRING,
            MainImage2: DataTypes.STRING,
            MainImage3: DataTypes.STRING,
            Images: DataTypes.TEXT,
            InCatalog: DataTypes.BOOLEAN,
            dtUpdatedOn: DataTypes.DATE,
            HadMFInventory: DataTypes.BOOLEAN,
            FBAInventoryReportOccurrence: DataTypes.STRING,
            dtMainImageUpdatedDate: DataTypes.DATE,
        }, {
            tableName: table,
            timestamps: false
        });
    }
    return makeReadOnly(cachedModel);
}

module.exports = { getModel };
