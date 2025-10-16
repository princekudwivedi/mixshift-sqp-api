const { DataTypes } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');
const { TBL_USER_DB_MAP } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_USER_DB_MAP;

let cachedModel = null;
let cachedUserId = null;

const modelDefinition = {
    ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    UserID: { type: DataTypes.INTEGER, allowNull: false },
    MappedDB_ID: { type: DataTypes.INTEGER, allowNull: false },
    dtCreatedOn: { type: DataTypes.DATE, allowNull: false }
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


