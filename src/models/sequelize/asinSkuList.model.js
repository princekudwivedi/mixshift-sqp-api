const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { getTenantSequelizeForCurrentDb } = require('../../db/tenant.db');
const { TBL_ASIN_SKU_LIST } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_ASIN_SKU_LIST;

let BaseModel = sequelize.define(table, {
    ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    ASIN: { type: DataTypes.STRING(100), allowNull: false },
    SKU: { type: DataTypes.STRING(100), allowNull: false },
    SellerID: { type: DataTypes.INTEGER, allowNull: false }
}, {
    tableName: table,
    timestamps: false
});

function getModel() {
    const tenantSequelize = getTenantSequelizeForCurrentDb();
    const model = tenantSequelize.models[table] || tenantSequelize.define(table, BaseModel.getAttributes(), { 
        tableName: table, 
        timestamps: false, 
        freezeTableName: true 
    });
    return makeReadOnly(model);
}

module.exports = { getModel };


