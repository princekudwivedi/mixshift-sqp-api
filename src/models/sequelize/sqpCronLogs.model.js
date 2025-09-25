const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { getTenantSequelizeForCurrentDb } = require('../../db/tenant.db');
const { TBL_SQP_CRON_LOGS } = require('../../config/env.config');

const table = TBL_SQP_CRON_LOGS;

let BaseModel = sequelize.define(table, {
    ID: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    CronJobID: { type: DataTypes.BIGINT },
    ReportType: { type: DataTypes.STRING(32) },
    Action: { type: DataTypes.STRING(64) },
    Status: { type: DataTypes.TINYINT },
    Message: { type: DataTypes.TEXT },
    ReportID: { type: DataTypes.STRING(128) },
    RetryCount: { type: DataTypes.INTEGER },
    ExecutionTime: { type: DataTypes.INTEGER },
    dtCreatedOn: { type: DataTypes.DATE },
    dtUpdatedOn: { type: DataTypes.DATE },
    ReportDocumentID: { type: DataTypes.STRING(128) },
}, {
    tableName: table,
    timestamps: false
});

function getModel() {
    const tenantSequelize = getTenantSequelizeForCurrentDb();
    return tenantSequelize.models[table] || tenantSequelize.define(table, BaseModel.getAttributes(), { tableName: table, timestamps: false, freezeTableName: true });
}

module.exports = { getModel };


