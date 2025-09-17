const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { TBL_ASIN_SKU_LIST } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_ASIN_SKU_LIST;

const AsinSkuList = sequelize.define(table, {
    ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    ASIN: { type: DataTypes.STRING(100), allowNull: false },
    SKU: { type: DataTypes.STRING(100), allowNull: false },
    SellerID: { type: DataTypes.INTEGER, allowNull: false }
}, {
    tableName: table,
    timestamps: false
});

module.exports = makeReadOnly(AsinSkuList);


