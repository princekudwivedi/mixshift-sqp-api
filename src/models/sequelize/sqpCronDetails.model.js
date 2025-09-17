const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { getTenantSequelizeForCurrentDb } = require('../../db/tenant.db');
const { TBL_SQP_CRON_DETAILS } = require('../../config/env.config');

const table = TBL_SQP_CRON_DETAILS;

let BaseModel = sequelize.define(table, {
    ID: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    AmazonSellerID: { type: DataTypes.STRING(100) },
    ASIN_List: { type: DataTypes.TEXT },
    WeeklySQPDataPullStatus: { type: DataTypes.TINYINT },
    WeeklySQPDataPullStartDate: { type: DataTypes.DATE },
    WeeklySQPDataPullEndDate: { type: DataTypes.DATE },
    MonthlySQPDataPullStatus: { type: DataTypes.TINYINT },
    MonthlySQPDataPullStartDate: { type: DataTypes.DATE },
    MonthlySQPDataPullEndDate: { type: DataTypes.DATE },
    QuarterlySQPDataPullStatus: { type: DataTypes.TINYINT },
    QuarterlySQPDataPullStartDate: { type: DataTypes.DATE },
    QuarterlySQPDataPullEndDate: { type: DataTypes.DATE },
    ReportID_Weekly: { type: DataTypes.STRING(255) },
    ReportID_Monthly: { type: DataTypes.STRING(255) },
    ReportID_Quarterly: { type: DataTypes.STRING(255) },
    RetryCount_Weekly: { type: DataTypes.INTEGER },
    RetryCount_Monthly: { type: DataTypes.INTEGER },
    RetryCount_Quarterly: { type: DataTypes.INTEGER },
    LastError_Weekly: { type: DataTypes.TEXT },
    LastError_Monthly: { type: DataTypes.TEXT },
    LastError_Quarterly: { type: DataTypes.TEXT },
    CreatedDate: { type: DataTypes.DATE },
    UpdatedDate: { type: DataTypes.DATE },
    ReportDocumentID_Weekly: { type: DataTypes.STRING(255) },
    ReportDocumentID_Monthly: { type: DataTypes.STRING(255) },
    ReportDocumentID_Quarterly: { type: DataTypes.STRING(255) },
    DownloadCompleted_Weekly: { type: DataTypes.TINYINT },
    DownloadCompleted_Monthly: { type: DataTypes.TINYINT },
    DownloadCompleted_Quarterly: { type: DataTypes.TINYINT }
}, {
    tableName: table,
    timestamps: false
});

function getModel() {
    const tenantSequelize = getTenantSequelizeForCurrentDb();
    return tenantSequelize.models[table] || tenantSequelize.define(table, BaseModel.getAttributes(), { tableName: table, timestamps: false, freezeTableName: true });
}

module.exports = { getModel };


