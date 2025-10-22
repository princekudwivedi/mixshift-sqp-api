const { DataTypes } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');

const { TBL_SELLER_ASIN_LIST } = require('../../config/env.config');

const table = TBL_SELLER_ASIN_LIST;

// Cache for the model to prevent recreating it
let cachedModel = null;
let cachedUserId = null;

// Write-allowed model (insert/update/delete/truncate permitted)
const modelDefinition = {
    ID: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    SellerID: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    AmazonSellerID: { type: DataTypes.STRING(100), allowNull: false },

    SellerName: { type: DataTypes.STRING(255), allowNull: true },
    MarketPlaceName: { type: DataTypes.STRING(255), allowNull: true },
    ASIN: { type: DataTypes.STRING(20), allowNull: false },
    ItemName: { type: DataTypes.STRING(500), allowNull: true },
    SKU: { type: DataTypes.STRING(255), allowNull: true },
    IsActive: { type: DataTypes.TINYINT, allowNull: true, defaultValue: 0 },
    
    LatestRecordDateRangeWeekly: { type: DataTypes.STRING(255), allowNull: true },
    LatestRecordDateRangeMonthly: { type: DataTypes.STRING(255), allowNull: true },
    LatestRecordDateRangeQuarterly: { type: DataTypes.STRING(255), allowNull: true },

    // Overall Initial Pull Status (for all types combined)
    InitialPullStatus: { type: DataTypes.TINYINT, allowNull: true },
    InitialPullStartTime: { type: DataTypes.DATE, allowNull: true },
    InitialPullEndTime: { type: DataTypes.DATE, allowNull: true },    

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
};

const modelOptions = {    
    tableName: table,
    timestamps: false,
    indexes: [
        {
            unique: true,
            fields: ['ASIN', 'SellerID']
        }
    ]
};

function getModel() {
    
    const currentUserId = getCurrentUserId();
    
    // Clear cache if database has changed
    if (cachedModel && cachedUserId !== currentUserId) {
        cachedModel = null;
        cachedUserId = null;
    }
    
    if (!cachedModel) {
        const sequelize = getCurrentSequelize();
        cachedModel = sequelize.define(table, modelDefinition, modelOptions);
    }
    return cachedModel;
}

module.exports = { getModel };

