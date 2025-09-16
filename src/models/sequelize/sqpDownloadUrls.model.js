const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { env } = require('../../config/env.config');

const table = env('TBL_SQP_DOWNLOAD_URLS', 'sqp_download_urls');

const SqpDownloadUrls = sequelize.define(table, {
    ID: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    CronJobID: { type: DataTypes.BIGINT },
    ReportID: { type: DataTypes.STRING(128) },
    AmazonSellerID: { type: DataTypes.BIGINT },
    ReportType: { type: DataTypes.STRING(32) },
    DownloadURL: { type: DataTypes.TEXT },
    ReportDocumentID: { type: DataTypes.STRING(128) },
    CompressionAlgorithm: { type: DataTypes.STRING(32) },
    Status: { type: DataTypes.STRING(32) },
    DownloadAttempts: { type: DataTypes.INTEGER },
    MaxDownloadAttempts: { type: DataTypes.INTEGER },
    ErrorMessage: { type: DataTypes.TEXT },
    FilePath: { type: DataTypes.TEXT },
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
    CreatedDate: { type: DataTypes.DATE },
    UpdatedDate: { type: DataTypes.DATE }
}, {
    tableName: table,
    timestamps: false
});

module.exports = SqpDownloadUrls;


