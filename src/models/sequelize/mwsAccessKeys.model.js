const { DataTypes } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');
const { TBL_MWS_ACCESS_KEYS } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_MWS_ACCESS_KEYS;

let cachedModel = null;
let cachedUserId = null;

const modelDefinition = {
    ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    MerchantRegion: { type: DataTypes.STRING(150), allowNull: false },
    accessKey: { type: DataTypes.STRING(250), allowNull: false },
    secretKey: { type: DataTypes.STRING(250), allowNull: false },
    developerId: { type: DataTypes.STRING(250), allowNull: false }
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


