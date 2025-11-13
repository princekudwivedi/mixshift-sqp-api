const { DataTypes } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');
const { TBL_TIMEZONES } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_TIMEZONES; // 'timezones'

let cachedModel = null;
let cachedUserId = null;

const modelDefinition = {
    ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    CountryRegion: { type: DataTypes.STRING(255), allowNull: false },
    Timezone: { type: DataTypes.STRING(255), allowNull: false },
    GMT_Value: { type: DataTypes.DECIMAL(10,2), allowNull: false },
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

module.exports = { getModel };


