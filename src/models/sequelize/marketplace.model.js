const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { TBL_MARKET_PLACE } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_MARKET_PLACE;

const Marketplace = sequelize.define(table, {
    ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    Name: { type: DataTypes.STRING(150), allowNull: false },
    AmazonMarketplaceId: { type: DataTypes.STRING(30), allowNull: false },
    CountryCode: { type: DataTypes.STRING(30), allowNull: false },
    CurrencyCode: { type: DataTypes.STRING(30), allowNull: false },
    SalesChannel: { type: DataTypes.STRING(255), allowNull: false }
}, {
    tableName: table,
    timestamps: false
});

module.exports = makeReadOnly(Marketplace);


