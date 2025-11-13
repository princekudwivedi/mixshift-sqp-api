const { DataTypes, Op, literal } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');
const { TBL_USERS } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');
const { getModel: getTimezoneModel } = require('./timezones.model');

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
        // Association with timezones
        const timezoneModel = getTimezoneModel();
        cachedModel.belongsTo(timezoneModel, {
            foreignKey: 'iTimezoneID',
            targetKey: 'ID',
            as: 'timezone'
        });
    }
    
    return makeReadOnly(cachedModel);
}

// Get all agency user list
async function getAllAgencyUserList() {
    const hasPriorityUsers = await checkCronPriorityFlagActiveOrNotForAnyAgencyUser();
    const userModel = getModel();
    const timezoneModel = getTimezoneModel();
  
    const order = hasPriorityUsers
      ? [
          ['iMwsCronPriorityFlag', 'DESC'],
          ['dtMwsUpdatedOn', 'ASC'],
          ['ID', 'ASC']
        ]
      : [
          [timezoneModel, 'GMT_Value', 'DESC'],
          ['ID', 'ASC']
        ];
  
    const users = await userModel.findAll({
      attributes: [
        'ID',
        'AgencyName',
        'FirstName',
        'LastName',
        'Email',
        'iTimezoneID',
        'iMwsCronPriorityFlag',
        'dtMwsUpdatedOn',
        [literal('timezone.Timezone'), 'Timezone'],
        [literal('timezone.GMT_Value'), 'GMT_Value']
      ],
      where: {
        iActive: 1,
        iParentID: 0,
        iUserType: { [Op.ne]: 4 },
        isDeleted: 0,
        isDemoUser: 0
      },
      include: [
        {
          model: timezoneModel,
          as: 'timezone',
          attributes: ['Timezone', 'GMT_Value'],
          required: false
        }
      ],
      order
    });
  
    return users;
}
  
async function checkCronPriorityFlagActiveOrNotForAnyAgencyUser() {
    const userModel = getModel();
    const priorityUser = await userModel.findOne({
        attributes: ['ID'],
        where: {
            iMwsCronPriorityFlag: 1,
            iParentID: 0,
            iUserType: { [Op.ne]: 4 },
            iActive: 1,
            isDeleted: 0
        }
    });
    return Boolean(priorityUser);
}

module.exports = makeReadOnly({
    getAllAgencyUserList,
    checkCronPriorityFlagActiveOrNotForAnyAgencyUser
});


