const { DataTypes } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');
const { TBL_SELLER_MARKET_PLACES_MAPPING } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_SELLER_MARKET_PLACES_MAPPING;

let cachedModel = null;
let cachedUserId = null;

const modelDefinition = {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    SellerId: { type: DataTypes.INTEGER, allowNull: false },
    AmazonSellerID: { type: DataTypes.STRING(100), allowNull: false },
    MarketId: { type: DataTypes.INTEGER, allowNull: false }
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


