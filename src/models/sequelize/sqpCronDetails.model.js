const { DataTypes } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');
const { TBL_SQP_CRON_DETAILS } = require('../../config/env.config');

const table = TBL_SQP_CRON_DETAILS;

// Cache for the model to prevent recreating it
let cachedModel = null;
let cachedUserId = null;

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
            ID: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
            AmazonSellerID: { type: DataTypes.STRING(100) },
            SellerID: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
            ASIN_List: { type: DataTypes.TEXT },
            SellerName: { type: DataTypes.STRING(255) },
            iInitialPull: { type: DataTypes.TINYINT, defaultValue: 0 },
            FullWeekRange: { type: DataTypes.STRING(255) },
            FullMonthRange: { type: DataTypes.STRING(255) },
            FullQuarterRange: { type: DataTypes.STRING(255) },
            WeeklyProcessRunningStatus: { type: DataTypes.TINYINT },
            WeeklySQPDataPullStatus: { type: DataTypes.TINYINT },
            WeeklySQPDataPullStartDate: { type: DataTypes.DATE },
            WeeklySQPDataPullEndDate: { type: DataTypes.DATE },
            MonthlyProcessRunningStatus: { type: DataTypes.TINYINT },
            MonthlySQPDataPullStatus: { type: DataTypes.TINYINT },
            MonthlySQPDataPullStartDate: { type: DataTypes.DATE },
            MonthlySQPDataPullEndDate: { type: DataTypes.DATE },
            QuarterlyProcessRunningStatus: { type: DataTypes.TINYINT },
            QuarterlySQPDataPullStatus: { type: DataTypes.TINYINT },
            QuarterlySQPDataPullStartDate: { type: DataTypes.DATE },
            QuarterlySQPDataPullEndDate: { type: DataTypes.DATE },
            dtCronStartDate: { type: DataTypes.DATE },
            cronRunningStatus: { type: DataTypes.TINYINT },
            dtCreatedOn: { type: DataTypes.DATE },
            dtUpdatedOn: { type: DataTypes.DATE }
        }, {
            tableName: table,
            timestamps: false
        });
        cachedUserId = currentUserId;
    }
    return cachedModel;
}

module.exports = { getModel };


