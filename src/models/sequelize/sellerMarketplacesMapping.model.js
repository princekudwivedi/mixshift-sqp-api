const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { TBL_SELLER_MARKET_PLACES_MAPPING } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_SELLER_MARKET_PLACES_MAPPING;

const SellerMarketplacesMapping = sequelize.define(table, {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    SellerId: { type: DataTypes.INTEGER, allowNull: false },
    AmazonSellerID: { type: DataTypes.STRING(100), allowNull: false },
    MarketId: { type: DataTypes.INTEGER, allowNull: false }
}, {
    tableName: table,
    timestamps: false
});

module.exports = makeReadOnly(SellerMarketplacesMapping);


