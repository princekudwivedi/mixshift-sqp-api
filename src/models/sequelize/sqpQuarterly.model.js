const { DataTypes } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');

const table = 'sqp_quarterly';

// Cache for the model to prevent recreating it
let cachedModel = null;
let cachedUserId = null;

let BaseModel = getCurrentSequelize().define(table, {
    ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    CronJobID: { type: DataTypes.BIGINT },
    ReportDate: { type: DataTypes.DATEONLY },
    StartDate: { type: DataTypes.DATEONLY },
    EndDate: { type: DataTypes.DATEONLY },
    CurrencyCode: { type: DataTypes.STRING(8) },
    SearchQuery: { type: DataTypes.TEXT },
    SearchQueryScore: { type: DataTypes.DECIMAL(10,4) },
    SearchQueryVolume: { type: DataTypes.BIGINT },
    TotalQueryImpressionCount: { type: DataTypes.BIGINT },
    AsinImpressionCount: { type: DataTypes.BIGINT },
    AsinImpressionShare: { type: DataTypes.DECIMAL(10,4) },
    TotalClickCount: { type: DataTypes.BIGINT },
    TotalClickRate: { type: DataTypes.DECIMAL(10,4) },
    AsinClickCount: { type: DataTypes.BIGINT },
    AsinClickShare: { type: DataTypes.DECIMAL(10,4) },
    TotalMedianClickPrice: { type: DataTypes.DECIMAL(12,4) },
    AsinMedianClickPrice: { type: DataTypes.DECIMAL(12,4) },
    TotalSameDayShippingClickCount: { type: DataTypes.BIGINT },
    TotalOneDayShippingClickCount: { type: DataTypes.BIGINT },
    TotalTwoDayShippingClickCount: { type: DataTypes.BIGINT },
    TotalCartAddCount: { type: DataTypes.BIGINT },
    TotalCartAddRate: { type: DataTypes.DECIMAL(10,4) },
    AsinCartAddCount: { type: DataTypes.BIGINT },
    AsinCartAddShare: { type: DataTypes.DECIMAL(10,4) },
    TotalMedianCartAddPrice: { type: DataTypes.DECIMAL(12,4) },
    AsinMedianCartAddPrice: { type: DataTypes.DECIMAL(12,4) },
    TotalSameDayShippingCartAddCount: { type: DataTypes.BIGINT },
    TotalOneDayShippingCartAddCount: { type: DataTypes.BIGINT },
    TotalTwoDayShippingCartAddCount: { type: DataTypes.BIGINT },
    TotalPurchaseCount: { type: DataTypes.BIGINT },
    TotalPurchaseRate: { type: DataTypes.DECIMAL(10,4) },
    AsinPurchaseCount: { type: DataTypes.BIGINT },
    AsinPurchaseShare: { type: DataTypes.DECIMAL(10,4) },
    TotalMedianPurchasePrice: { type: DataTypes.DECIMAL(12,4) },
    AsinMedianPurchasePrice: { type: DataTypes.DECIMAL(12,4) },
    AsinPurchaseRate: { type: DataTypes.DECIMAL(10,4) },
    TotalSameDayShippingPurchaseCount: { type: DataTypes.BIGINT },
    TotalOneDayShippingPurchaseCount: { type: DataTypes.BIGINT },
    TotalTwoDayShippingPurchaseCount: { type: DataTypes.BIGINT },
    ASIN: { type: DataTypes.STRING(32) },
    dtCreatedOn: { type: DataTypes.DATE },
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
        cachedModel = sequelize.define('sqp_quarterly', {
            ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            // Add other fields as needed - this is a basic structure
            dtCreatedOn: DataTypes.DATE,
            dtUpdatedOn: DataTypes.DATE
        }, {
            tableName: 'sqp_quarterly',
            timestamps: false
        });
    }
    return cachedModel;
}

module.exports = { getModel };

