const { DataTypes } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');
const { TBL_USER_DATABASE_CREDENTIALS } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_USER_DATABASE_CREDENTIALS;

let cachedModel = null;
let cachedUserId = null;

const modelDefinition = {
    ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    AgencyUserID: { type: DataTypes.INTEGER, allowNull: false },
    DatabaseID: { type: DataTypes.INTEGER, allowNull: false },
    Hostname: { type: DataTypes.STRING(300), allowNull: false },
    Username: { type: DataTypes.STRING(200), allowNull: false },
    PortNumber: { type: DataTypes.INTEGER, allowNull: false },
    Password: { type: DataTypes.TEXT, allowNull: true },
    dtCreatedOn: { type: DataTypes.DATE, allowNull: false },
    dtUpdatedOn: { type: DataTypes.DATE, allowNull: false }
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


