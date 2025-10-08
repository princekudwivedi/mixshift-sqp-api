const { DataTypes } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');

const { TBL_SQP_DOWNLOAD_URLS } = require('../../config/env.config');

const table = TBL_SQP_DOWNLOAD_URLS;

// Cache for the model to prevent recreating it
let cachedModel = null;
let cachedUserId = null;

let BaseModel = getCurrentSequelize().define(table, {
    ID: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    CronJobID: { type: DataTypes.BIGINT },
    ReportType: { type: DataTypes.STRING(32) },
    Status: { type: DataTypes.STRING(32) },
    DownloadAttempts: { type: DataTypes.INTEGER, defaultValue: 0 },
    MaxDownloadAttempts: { type: DataTypes.INTEGER, defaultValue: 3 },
    ErrorMessage: { type: DataTypes.TEXT },
    FilePath: { type: DataTypes.STRING(500) },
    FileSize: { type: DataTypes.BIGINT, defaultValue: 0 },
    DownloadStartTime: { type: DataTypes.DATE },
    DownloadEndTime: { type: DataTypes.DATE },
    ProcessStatus: { type: DataTypes.STRING(32) },
    ProcessAttempts: { type: DataTypes.INTEGER, defaultValue: 0 },
    MaxProcessAttempts: { type: DataTypes.INTEGER, defaultValue: 3 },
    SuccessCount: { type: DataTypes.INTEGER, defaultValue: 0 },
    FailCount: { type: DataTypes.INTEGER, defaultValue: 0 },
    TotalRecords: { type: DataTypes.INTEGER, defaultValue: 0 },
    FullyImported: { type: DataTypes.TINYINT, defaultValue: 0 },
    LastProcessAt: { type: DataTypes.DATE },
    LastProcessError: { type: DataTypes.TEXT },
    dtCreatedOn: { type: DataTypes.DATE },
    dtUpdatedOn: { type: DataTypes.DATE }
}, {
    tableName: table,
    timestamps: false
});

function getModel() {
    
    const currentUserId = getCurrentUserId();
    
    // Clear cache if database has changed
    if (cachedModel && cachedUserId !== currentUserId) {
        cachedModel = null;
        cachedUserId = null;
    }
    
    if (!cachedModel) {
        const sequelize = getCurrentSequelize();
        cachedModel = sequelize.define(TBL_SQP_DOWNLOAD_URLS, {
            ID: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
            CronJobID: { type: DataTypes.BIGINT },            
            ReportType: { type: DataTypes.STRING(32) },
            Status: { type: DataTypes.STRING(32) },
            DownloadAttempts: { type: DataTypes.INTEGER, defaultValue: 0 },
            MaxDownloadAttempts: { type: DataTypes.INTEGER, defaultValue: 3 },
            ErrorMessage: { type: DataTypes.TEXT },
            FilePath: { type: DataTypes.STRING(500) },
            FileSize: { type: DataTypes.BIGINT, defaultValue: 0 },
            DownloadStartTime: { type: DataTypes.DATE },
            DownloadEndTime: { type: DataTypes.DATE },
            ProcessStatus: { type: DataTypes.STRING(32) },
            ProcessAttempts: { type: DataTypes.INTEGER, defaultValue: 0 },
            MaxProcessAttempts: { type: DataTypes.INTEGER, defaultValue: 3 },
            SuccessCount: { type: DataTypes.INTEGER, defaultValue: 0 },
            FailCount: { type: DataTypes.INTEGER, defaultValue: 0 },
            TotalRecords: { type: DataTypes.INTEGER, defaultValue: 0 },
            FullyImported: { type: DataTypes.TINYINT, defaultValue: 0 },
            LastProcessAt: { type: DataTypes.DATE },
            LastProcessError: { type: DataTypes.TEXT },
            dtCreatedOn: { type: DataTypes.DATE },
            dtUpdatedOn: { type: DataTypes.DATE }
        }, {
            tableName: TBL_SQP_DOWNLOAD_URLS,
            timestamps: false
        });
        cachedUserId = currentUserId;
    }
    return cachedModel;
}

module.exports = { getModel };

