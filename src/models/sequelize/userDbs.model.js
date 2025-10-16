const { DataTypes } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');
const { TBL_USER_DATABASES } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_USER_DATABASES;

let cachedModel = null;
let cachedUserId = null;

const modelDefinition = {
    DB_ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    DB_Name: { type: DataTypes.STRING(255), allowNull: false },
    DB_AppType: { type: DataTypes.INTEGER, allowNull: true },
    DomainName: { type: DataTypes.STRING(255), allowNull: false },
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


