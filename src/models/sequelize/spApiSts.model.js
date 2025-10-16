const { DataTypes } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');
const { TBL_STS_TOKENS } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_STS_TOKENS;

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
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            accessKeyId: { type: DataTypes.TEXT, allowNull: false },
            secretAccessKey: { type: DataTypes.TEXT, allowNull: false },
            SessionToken: { type: DataTypes.TEXT, allowNull: false },
            expire_at: { type: DataTypes.DATE, allowNull: false }
        }, {
            tableName: table,
            timestamps: false
        });
    }
    return makeReadOnly(cachedModel);
}

module.exports = { getModel };

