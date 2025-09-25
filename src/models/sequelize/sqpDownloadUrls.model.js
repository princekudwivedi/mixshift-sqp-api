const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { getTenantSequelizeForCurrentDb } = require('../../db/tenant.db');
const { TBL_SQP_DOWNLOAD_URLS } = require('../../config/env.config');

const table = TBL_SQP_DOWNLOAD_URLS;

let BaseModel = sequelize.define(table, {
    ID: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    CronJobID: { type: DataTypes.BIGINT },
    ReportType: { type: DataTypes.STRING(32) },
    Status: { type: DataTypes.STRING(32) },
    DownloadAttempts: { type: DataTypes.INTEGER },
    MaxDownloadAttempts: { type: DataTypes.INTEGER },
    ErrorMessage: { type: DataTypes.TEXT },
    FilePath: { type: DataTypes.STRING(500) },
    FileSize: { type: DataTypes.BIGINT },
    DownloadStartTime: { type: DataTypes.DATE },
    DownloadEndTime: { type: DataTypes.DATE },
    ProcessStatus: { type: DataTypes.STRING(32) },
    ProcessAttempts: { type: DataTypes.INTEGER },
    MaxProcessAttempts: { type: DataTypes.INTEGER },
    SuccessCount: { type: DataTypes.INTEGER },
    FailCount: { type: DataTypes.INTEGER },
    TotalRecords: { type: DataTypes.INTEGER },
    FullyImported: { type: DataTypes.TINYINT },
    LastProcessAt: { type: DataTypes.DATE },
    LastProcessError: { type: DataTypes.TEXT },
    dtCreatedOn: { type: DataTypes.DATE },
    dtUpdatedOn: { type: DataTypes.DATE }
}, {
    tableName: table,
    timestamps: false
});

function getModel() {
    const tenantSequelize = getTenantSequelizeForCurrentDb();
    return tenantSequelize.models[table] || tenantSequelize.define(table, BaseModel.getAttributes(), { tableName: table, timestamps: false, freezeTableName: true });
}

module.exports = { getModel };


