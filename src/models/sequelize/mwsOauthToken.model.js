const { DataTypes } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');
const { TBL_MWS_OAUTH_TOKEN } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_MWS_OAUTH_TOKEN;

let cachedModel = null;
let cachedUserId = null;

const modelDefinition = {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    AmazonSellerID: { type: DataTypes.STRING(250), allowNull: false },
    auth_token: { type: DataTypes.TEXT, allowNull: false },
    idAccessKey: { type: DataTypes.INTEGER, allowNull: false },
    isActive: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    dtCreatedOn: { type: DataTypes.DATE, allowNull: false },
    dtUpdatedOn: { type: DataTypes.DATE, allowNull: true },
    scriptStartTime: { type: DataTypes.DATE, allowNull: true },
    scriptEndTime: { type: DataTypes.DATE, allowNull: true },
    iRunningStatus: { type: DataTypes.TINYINT, allowNull: false },
    iLostAccess: { type: DataTypes.TINYINT, allowNull: false },
    dtLostAccessOn: { type: DataTypes.DATE, allowNull: false }
};

function getModel() {
    const currentUserId = getCurrentUserId();
    
    if (cachedUserId !== currentUserId) {
        cachedModel = null;
        cachedUserId = currentUserId;
    }
    
    if (!cachedModel) {
        const sequelize = getCurrentSequelize();
        cachedModel = sequelize.define(table, modelDefinition, {
            tableName: table,
            timestamps: false
        });
    }
    
    return makeReadOnly(cachedModel);
}

module.exports = getModel();


