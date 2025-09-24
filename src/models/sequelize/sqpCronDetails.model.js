const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { getTenantSequelizeForCurrentDb } = require('../../db/tenant.db');
const { TBL_SQP_CRON_DETAILS } = require('../../config/env.config');

const table = TBL_SQP_CRON_DETAILS;

let BaseModel = sequelize.define(table, {
    ID: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    AmazonSellerID: { type: DataTypes.STRING(100) },
    ASIN_List: { type: DataTypes.TEXT },
    WeeklyProcessRunningStatus: { type: DataTypes.TINYINT },
    WeeklySQPDataPullStatus: { type: DataTypes.TINYINT },
    WeeklySQPDataPullStartDate: { type: DataTypes.DATE },
    WeeklySQPDataPullEndDate: { type: DataTypes.DATE },
    MonthlyProcessRunningStatus: { type: DataTypes.TINYINT },
    MonthlySQPDataPullStatus: { type: DataTypes.TINYINT },
    MonthlySQPDataPullStartDate: { type: DataTypes.DATE },
    MonthlySQPDataPullEndDate: { type: DataTypes.DATE },
    QuarterlyProcessRunningStatus: { type: DataTypes.TINYINT },
    QuarterlySQPDataPullStatus: { type: DataTypes.TINYINT },
    QuarterlySQPDataPullStartDate: { type: DataTypes.DATE },
    QuarterlySQPDataPullEndDate: { type: DataTypes.DATE },
    CreatedDate: { type: DataTypes.DATE },
    UpdatedDate: { type: DataTypes.DATE }
}, {
    tableName: table,
    timestamps: false
});

function getModel() {
    const tenantSequelize = getTenantSequelizeForCurrentDb();
    return tenantSequelize.models[table] || tenantSequelize.define(table, BaseModel.getAttributes(), { tableName: table, timestamps: false, freezeTableName: true });
}

module.exports = { getModel };


