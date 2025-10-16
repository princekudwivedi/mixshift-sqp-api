const { DataTypes } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');
const { TBL_USERS } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_USERS; // 'users'

// Cache for lazy-loaded model
let cachedModel = null;
let cachedUserId = null;

// Model definition structure
const modelDefinition = {
    ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    AgencyName: { type: DataTypes.STRING(255), allowNull: false },
    FirstName: { type: DataTypes.STRING(255), allowNull: false },
    LastName: { type: DataTypes.STRING(255), allowNull: false },
    Email: { type: DataTypes.STRING(255), allowNull: false },
    Password: { type: DataTypes.STRING(255), allowNull: false },
    MasterPassword: { type: DataTypes.STRING(255), allowNull: false },
    Verification_code: { type: DataTypes.STRING(255), allowNull: false },
    isLWA_User: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    iUserType: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    iParentID: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    isDemoUser: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    iActive: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    isDeleted: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    iCronPriorityFlag: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    iMwsCronPriorityFlag: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    iStatus60DaysPull: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    dt60DaysPullStatusUpdate: { type: DataTypes.DATE, allowNull: true },
    iMWS_CurrentMonthArchiveStatus: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    dtMWS_LastArchiveDate: { type: DataTypes.DATE, allowNull: true },
    iCurrentMonthArchiveStatus: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    dtLastArchiveDate: { type: DataTypes.DATE, allowNull: true },
    iAdvertisingDataOverwriteFlag: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    AdvertisingDataOverwriteReports: { type: DataTypes.TEXT, allowNull: false },
    iPriorityAdvertisingStatusMailFlag: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    dtPriorityAdvertisingMailDate: { type: DataTypes.DATE, allowNull: true },
    dtLastStatusSendDate: { type: DataTypes.DATE, allowNull: true },
    dtMwsLastStatusSendDate: { type: DataTypes.DATE, allowNull: true },
    iTimezoneID: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    ForgotPasswordKey: { type: DataTypes.STRING(255), allowNull: false },
    iSendMissingDataAlert: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    dtCreatedOn: { type: DataTypes.DATE, allowNull: false },
    dtUpdatedOn: { type: DataTypes.DATE, allowNull: true },
    dtEmailVerifiedOn: { type: DataTypes.DATE, allowNull: true },
    dtMwsUpdatedOn: { type: DataTypes.DATE, allowNull: true },
    dtBlankRecordUpdateDate: { type: DataTypes.DATE, allowNull: true },
    iBlankBuyerEmailStatus: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    unknownBuyerSqCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    user_logo: { type: DataTypes.STRING(250), allowNull: true }
};

const modelOptions = {
    tableName: table,
    timestamps: false
};

// Lazy load model
function getModel() {
    const currentUserId = getCurrentUserId();
    
    if (cachedUserId !== currentUserId) {
        cachedModel = null;
        cachedUserId = currentUserId;
    }
    
    if (!cachedModel) {
        const sequelize = getCurrentSequelize();
        cachedModel = sequelize.define(table, modelDefinition, modelOptions);
    }
    
    return makeReadOnly(cachedModel);
}

// Export functions similar to sqp.cron.model.js pattern
async function getAllAgencyUserList() {
    try {
        const { QueryTypes } = require('sequelize');
        const sequelize = getCurrentSequelize();
        
        // First check if any agency user has active cron priority flag
        const hasActiveCronPriorityFlag = await checkCronPriorityFlagActiveOrNotForAnyAgencyUser();
        
        let query;
        if (hasActiveCronPriorityFlag) {
            // Order by priority flag DESC, then by MWS updated date ASC, then by ID ASC
            query = `
                SELECT 
                    user.ID,
                    user.AgencyName,
                    user.FirstName,
                    user.LastName,
                    user.Email,
                    user.iTimezoneID,
                    user.iMwsCronPriorityFlag,
                    user.dtMwsUpdatedOn,
                    time.Timezone,
                    time.GMT_Value
                FROM ${require('../../config/env.config').TBL_USERS} as user
                LEFT JOIN ${require('../../config/env.config').TBL_TIMEZONES} as time ON user.iTimezoneID = time.ID
                WHERE user.iActive = 1 
                    AND user.iParentID = 0 
                    AND user.iUserType != 4 
                    AND user.isDeleted = 0 
                    AND user.isDemoUser = 0
                ORDER BY user.iMwsCronPriorityFlag DESC, user.dtMwsUpdatedOn ASC, user.ID ASC
            `;
        } else {
            // Order by timezone GMT value DESC, then by ID ASC
            query = `
                SELECT 
                    user.ID,
                    user.AgencyName,
                    user.FirstName,
                    user.LastName,
                    user.Email,
                    user.iTimezoneID,
                    user.iMwsCronPriorityFlag,
                    user.dtMwsUpdatedOn,
                    time.Timezone,
                    time.GMT_Value
                FROM ${require('../../config/env.config').TBL_USERS} as user
                LEFT JOIN ${require('../../config/env.config').TBL_TIMEZONES} as time ON user.iTimezoneID = time.ID
                WHERE user.iActive = 1 
                    AND user.iParentID = 0 
                    AND user.iUserType != 4 
                    AND user.isDeleted = 0 
                    AND user.isDemoUser = 0
                ORDER BY time.GMT_Value DESC, user.ID ASC
            `;
        }
        
        const users = await sequelize.query(query, {
            type: QueryTypes.SELECT
        });
        
        return users;
    } catch (error) {
        console.error('Error getting agency user list:', error);
        throw error;
    }
}

async function checkCronPriorityFlagActiveOrNotForAnyAgencyUser() {
    try {
        const { QueryTypes } = require('sequelize');
        const sequelize = getCurrentSequelize();
        
        const query = `
            SELECT user.ID
            FROM ${require('../../config/env.config').TBL_USERS} as user
            WHERE user.iMwsCronPriorityFlag = 1
                AND user.iParentID = 0
                AND user.iUserType != 4
                AND user.iActive = 1
                AND user.isDeleted = 0
            LIMIT 1
        `;
        
        const result = await sequelize.query(query, {
            type: QueryTypes.SELECT
        });
        
        return result.length > 0;
    } catch (error) {
        console.error('Error checking cron priority flag:', error);
        throw error;
    }
}

module.exports = makeReadOnly({
    getAllAgencyUserList,
    checkCronPriorityFlagActiveOrNotForAnyAgencyUser
});


