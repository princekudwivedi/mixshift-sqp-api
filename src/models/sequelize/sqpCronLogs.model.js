const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { env } = require('../../config/env.config');

const table = env('TBL_SQP_CRON_LOGS', 'sqp_cron_logs');

const SqpCronLogs = sequelize.define(table, {
    ID: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    CronJobID: { type: DataTypes.BIGINT },
    AmazonSellerID: { type: DataTypes.BIGINT },
    ReportType: { type: DataTypes.STRING(32) },
    Action: { type: DataTypes.STRING(64) },
    Status: { type: DataTypes.TINYINT },
    Message: { type: DataTypes.TEXT },
    ReportID: { type: DataTypes.STRING(128) },
    RetryCount: { type: DataTypes.INTEGER },
    ExecutionTime: { type: DataTypes.DECIMAL(10,3) },
    CreatedDate: { type: DataTypes.DATE },
    UpdatedDate: { type: DataTypes.DATE },
    ReportDocumentID: { type: DataTypes.STRING(128) },
    DownloadCompleted: { type: DataTypes.TINYINT },
    RecordsProcessed: { type: DataTypes.INTEGER }
}, {
    tableName: table,
    timestamps: false
});

module.exports = SqpCronLogs;


