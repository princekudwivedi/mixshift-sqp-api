const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { TBL_SQP_METRICS_3MO } = require('../../config/env.config');

const SqpMetrics3mo = sequelize.define(TBL_SQP_METRICS_3MO, {
    ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    ReportID: { type: DataTypes.BIGINT },
    AmazonSellerID: { type: DataTypes.BIGINT },
    ReportType: { type: DataTypes.STRING(32) },
    ReportDate: { type: DataTypes.DATEONLY },
    ASIN: { type: DataTypes.STRING(32) },
    SearchQuery: { type: DataTypes.TEXT },
    AsinImpressionCount: { type: DataTypes.BIGINT },
    AsinClickCount: { type: DataTypes.BIGINT },
    TotalClickRate: { type: DataTypes.DECIMAL(10,4) },
    AsinMedianClickPrice: { type: DataTypes.DECIMAL(10,4) },
    Spend: { type: DataTypes.DECIMAL(12,4) },
    AsinPurchaseCount: { type: DataTypes.BIGINT },
    Sales: { type: DataTypes.DECIMAL(12,4) },
    ACoS: { type: DataTypes.DECIMAL(10,4) },
    AsinPurchaseRate: { type: DataTypes.DECIMAL(10,4) },
    SourceFile: { type: DataTypes.STRING(255) },
    CreatedDate: { type: DataTypes.DATE },
}, {
    tableName: TBL_SQP_METRICS_3MO,
    timestamps: false
});

module.exports = SqpMetrics3mo;


