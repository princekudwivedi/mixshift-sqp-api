const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { env } = require('../../config/env.config');

const table = env('TBL_SQP_CRON_DETAILS', 'sqp_cron_details');

const SqpCronDetails = sequelize.define(table, {
    ID: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    AmazonSellerID: { type: DataTypes.BIGINT },
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
    ReportID_Weekly: { type: DataTypes.STRING(128) },
    ReportID_Monthly: { type: DataTypes.STRING(128) },
    ReportID_Quarterly: { type: DataTypes.STRING(128) },
    RetryCount_Weekly: { type: DataTypes.INTEGER },
    RetryCount_Monthly: { type: DataTypes.INTEGER },
    RetryCount_Quarterly: { type: DataTypes.INTEGER },
    LastError_Weekly: { type: DataTypes.TEXT },
    LastError_Monthly: { type: DataTypes.TEXT },
    LastError_Quarterly: { type: DataTypes.TEXT },
    CreatedDate: { type: DataTypes.DATE },
    UpdatedDate: { type: DataTypes.DATE },
    ReportDocumentID_Weekly: { type: DataTypes.STRING(128) },
    ReportDocumentID_Monthly: { type: DataTypes.STRING(128) },
    ReportDocumentID_Quarterly: { type: DataTypes.STRING(128) },
    DownloadCompleted_Weekly: { type: DataTypes.TINYINT },
    DownloadCompleted_Monthly: { type: DataTypes.TINYINT },
    DownloadCompleted_Quarterly: { type: DataTypes.TINYINT }
}, {
    tableName: table,
    timestamps: false
});

module.exports = SqpCronDetails;


