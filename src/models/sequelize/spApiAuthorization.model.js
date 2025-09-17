const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { getTenantSequelizeForCurrentDb } = require('../../db/tenant.db');

// Using default table name; if you add a constant later, switch to it
const table = 'tbl_sp_api_authorization';

let BaseModel = sequelize.define(table, {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    AmazonSellerID: { type: DataTypes.STRING(255), allowNull: false },
    access_token: { type: DataTypes.TEXT, allowNull: true },
    refresh_token: { type: DataTypes.TEXT, allowNull: true },
    expires_in: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true }
}, {
    tableName: table,
    timestamps: false
});

function getModel() {
    const tenantSequelize = getTenantSequelizeForCurrentDb();
    return tenantSequelize.models[table] || tenantSequelize.define(table, BaseModel.getAttributes(), { tableName: table, timestamps: false, freezeTableName: true });
}

module.exports = { getModel };


