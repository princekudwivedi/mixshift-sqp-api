const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { TBL_USERS } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_USERS; // 'users'

const User = sequelize.define(table, {
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
}, {
    tableName: table,
    timestamps: false
});

module.exports = makeReadOnly(User);


