const { DataTypes } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');
const { TBL_MARKET_PLACE } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_MARKET_PLACE;

let cachedModel = null;
let cachedUserId = null;

const modelDefinition = {
    ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    Name: { type: DataTypes.STRING(150), allowNull: false },
    AmazonMarketplaceId: { type: DataTypes.STRING(30), allowNull: false },
    CountryCode: { type: DataTypes.STRING(30), allowNull: false },
    CurrencyCode: { type: DataTypes.STRING(30), allowNull: false },
    SalesChannel: { type: DataTypes.STRING(255), allowNull: false }
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


