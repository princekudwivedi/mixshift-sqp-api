const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { getTenantSequelizeForCurrentDb } = require('../../db/tenant.db');
const { TBL_SELLER_ASIN_LIST } = require('../../config/env.config');

const table = TBL_SELLER_ASIN_LIST;

// Write-allowed model (insert/update/delete/truncate permitted)
let BaseModel = sequelize.define(table, {
    ID: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    SellerID: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    AmazonSellerID: { type: DataTypes.STRING(100), allowNull: false },
    ASIN: { type: DataTypes.STRING(20), allowNull: false },
    IsActive: { type: DataTypes.TINYINT, allowNull: true, defaultValue: 0 },
    LastSQPDataPullStatus: { type: DataTypes.ENUM('Pending','InProgress','Completed','Failed'), allowNull: true },
    LastSQPDataPullStartTime: { type: DataTypes.DATE, allowNull: true },
    LastSQPDataPullEndTime: { type: DataTypes.DATE, allowNull: true },
    dtCreatedOn: { type: DataTypes.DATE, allowNull: false },
    dtUpdatedOn: { type: DataTypes.DATE, allowNull: true }
}, {
    tableName: table,
    timestamps: false
});

function getModel() {
    const tenantSequelize = getTenantSequelizeForCurrentDb();
    return tenantSequelize.models[table] || tenantSequelize.define(table, BaseModel.getAttributes(), { tableName: table, timestamps: false, freezeTableName: true });
}

module.exports = { getModel };


