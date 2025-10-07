const { DataTypes } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');
const { TBL_STS_TOKENS } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_STS_TOKENS;

// Cache for the model to prevent recreating it
let cachedModel = null;
let cachedUserId = null;

let BaseModel = getCurrentSequelize().define(table, {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    accessKeyId: { type: DataTypes.TEXT, allowNull: false },
    secretAccessKey: { type: DataTypes.TEXT, allowNull: false },
    SessionToken: { type: DataTypes.TEXT, allowNull: false },
    expire_at: { type: DataTypes.DATE, allowNull: false }
}, {
    tableName: table,
    timestamps: false
});

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
            ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            SellerID: DataTypes.STRING,
            AccessKeyId: DataTypes.STRING,
            SecretAccessKey: DataTypes.STRING,
            SessionToken: DataTypes.TEXT,
            Expiration: DataTypes.DATE,
            dtCreatedOn: DataTypes.DATE,
            dtUpdatedOn: DataTypes.DATE
        }, {
            tableName: table,
            timestamps: false
        });
    }
    return makeReadOnly(cachedModel);
}

module.exports = { getModel };

