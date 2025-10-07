const { DataTypes } = require('sequelize');
const { getCurrentSequelize } = require('../../db/tenant.db');

const { TBL_SQP_CRON_LOGS } = require('../../config/env.config');

const table = TBL_SQP_CRON_LOGS;

// Cache for the model to prevent recreating it
let cachedModel = null;

let BaseModel = getCurrentSequelize().define(table, {
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
    if (!cachedModel) {
        const sequelize = getCurrentSequelize();
        cachedModel = sequelize.define(TBL_SQP_CRON_LOGS, {
            ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
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
            tableName: TBL_SQP_CRON_LOGS,
            timestamps: false
        });
    }
    return cachedModel;
}

module.exports = { getModel };

