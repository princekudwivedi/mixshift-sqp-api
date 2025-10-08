const { DataTypes } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');

const { TBL_SELLER_ASIN_LIST } = require('../../config/env.config');

const table = TBL_SELLER_ASIN_LIST;

// Cache for the model to prevent recreating it
let cachedModel = null;
let cachedUserId = null;

// Write-allowed model (insert/update/delete/truncate permitted)
let BaseModel = getCurrentSequelize().define(table, {
    ID: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    SellerID: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    AmazonSellerID: { type: DataTypes.STRING(100), allowNull: false },
    ASIN: { type: DataTypes.STRING(20), allowNull: false },
    IsActive: { type: DataTypes.TINYINT, allowNull: true, defaultValue: 0 },
    
    LatestRecordDateRangeWeekly: { type: DataTypes.STRING(255), allowNull: true },
    LatestRecordDateRangeMonthly: { type: DataTypes.STRING(255), allowNull: true },
    LatestRecordDateRangeQuarterly: { type: DataTypes.STRING(255), allowNull: true },

    // Weekly fields
    WeeklyLastSQPDataPullStatus: { type: DataTypes.TINYINT, allowNull: true },
    WeeklyLastSQPDataPullStartTime: { type: DataTypes.DATE, allowNull: true },
    WeeklyLastSQPDataPullEndTime: { type: DataTypes.DATE, allowNull: true },
    
    // Monthly fields
    MonthlyLastSQPDataPullStatus: { type: DataTypes.TINYINT, allowNull: true },
    MonthlyLastSQPDataPullStartTime: { type: DataTypes.DATE, allowNull: true },
    MonthlyLastSQPDataPullEndTime: { type: DataTypes.DATE, allowNull: true },
    
    // Quarterly fields
    QuarterlyLastSQPDataPullStatus: { type: DataTypes.TINYINT, allowNull: true },
    QuarterlyLastSQPDataPullStartTime: { type: DataTypes.DATE, allowNull: true },
    QuarterlyLastSQPDataPullEndTime: { type: DataTypes.DATE, allowNull: true },    
    
    dtCreatedOn: { type: DataTypes.DATE, allowNull: false },
    dtUpdatedOn: { type: DataTypes.DATE, allowNull: true }
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
        cachedModel = sequelize.define(table, {
            ID: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
            SellerID: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
            AmazonSellerID: { type: DataTypes.STRING(100), allowNull: false },
            ASIN: { type: DataTypes.STRING(20), allowNull: false },
            IsActive: { type: DataTypes.TINYINT, allowNull: true, defaultValue: 0 },
            
            LatestRecordDateRangeWeekly: { type: DataTypes.STRING(255), allowNull: true },
            LatestRecordDateRangeMonthly: { type: DataTypes.STRING(255), allowNull: true },
            LatestRecordDateRangeQuarterly: { type: DataTypes.STRING(255), allowNull: true },

            // Weekly fields
            WeeklyLastSQPDataPullStatus: { type: DataTypes.TINYINT, allowNull: true },
            WeeklyLastSQPDataPullStartTime: { type: DataTypes.DATE, allowNull: true },
            WeeklyLastSQPDataPullEndTime: { type: DataTypes.DATE, allowNull: true },
            
            // Monthly fields
            MonthlyLastSQPDataPullStatus: { type: DataTypes.TINYINT, allowNull: true },
            MonthlyLastSQPDataPullStartTime: { type: DataTypes.DATE, allowNull: true },
            MonthlyLastSQPDataPullEndTime: { type: DataTypes.DATE, allowNull: true },
            
            // Quarterly fields
            QuarterlyLastSQPDataPullStatus: { type: DataTypes.TINYINT, allowNull: true },
            QuarterlyLastSQPDataPullStartTime: { type: DataTypes.DATE, allowNull: true },
            QuarterlyLastSQPDataPullEndTime: { type: DataTypes.DATE, allowNull: true },               
            
            
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

