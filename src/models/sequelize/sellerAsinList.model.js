const { DataTypes } = require('sequelize');
const { getCurrentSequelize } = require('../../db/tenant.db');

const { TBL_SELLER_ASIN_LIST } = require('../../config/env.config');

const table = TBL_SELLER_ASIN_LIST;

// Cache for the model to prevent recreating it
let cachedModel = null;

// Write-allowed model (insert/update/delete/truncate permitted)
let BaseModel = getCurrentSequelize().define(table, {
    ID: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    SellerID: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    AmazonSellerID: { type: DataTypes.STRING(100), allowNull: false },
    ASIN: { type: DataTypes.STRING(20), allowNull: false },
    IsActive: { type: DataTypes.TINYINT, allowNull: true, defaultValue: 0 },
    LastSQPDataPullStatus: { type: DataTypes.ENUM('Pending','InProgress','Completed','Failed'), allowNull: true },
    LastSQPDataPullStartTime: { type: DataTypes.DATE, allowNull: true },
    LastSQPDataPullEndTime: { type: DataTypes.DATE, allowNull: true },
    LatestRecordDateRangeWeekly: { type: DataTypes.STRING(255), allowNull: true },
    LatestRecordDateRangeMonthly: { type: DataTypes.STRING(255), allowNull: true },
    LatestRecordDateRangeQuarterly: { type: DataTypes.STRING(255), allowNull: true },
    dtCreatedOn: { type: DataTypes.DATE, allowNull: false },
    dtUpdatedOn: { type: DataTypes.DATE, allowNull: true }
}, {
    tableName: table,
    timestamps: false
});

function getModel() {
    if (!cachedModel) {
        const sequelize = getCurrentSequelize();
        cachedModel = sequelize.define(table, {
            ID: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
            SellerID: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
            AmazonSellerID: { type: DataTypes.STRING(100), allowNull: false },
            ASIN: { type: DataTypes.STRING(20), allowNull: false },
            IsActive: { type: DataTypes.TINYINT, allowNull: true, defaultValue: 0 },
            LastSQPDataPullStatus: { type: DataTypes.ENUM('Pending','InProgress','Completed','Failed'), allowNull: true },
            LastSQPDataPullStartTime: { type: DataTypes.DATE, allowNull: true },
            LastSQPDataPullEndTime: { type: DataTypes.DATE, allowNull: true },
            LatestRecordDateRangeWeekly: { type: DataTypes.STRING(255), allowNull: true },
            LatestRecordDateRangeMonthly: { type: DataTypes.STRING(255), allowNull: true },
            LatestRecordDateRangeQuarterly: { type: DataTypes.STRING(255), allowNull: true },
            dtCreatedOn: { type: DataTypes.DATE, allowNull: false },
            dtUpdatedOn: { type: DataTypes.DATE, allowNull: true }
        }, {
            tableName: table,
            timestamps: false
        });
    }
    return cachedModel;
}

module.exports = { getModel };

