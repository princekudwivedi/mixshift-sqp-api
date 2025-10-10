const { DataTypes } = require('sequelize');
const { getCurrentSequelize, getCurrentUserId } = require('../../db/tenant.db');

// Using default table name; if you add a constant later, switch to it
const table = 'tbl_sp_api_authorization';

// Cache for the model to prevent recreating it
let cachedModel = null;
let cachedUserId = null;

let BaseModel = getCurrentSequelize().define(table, {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    AmazonSellerID: { type: DataTypes.STRING(255), allowNull: false },
    access_token: { type: DataTypes.TEXT, allowNull: true },
    refresh_token: { type: DataTypes.TEXT, allowNull: true },
    expires_in: { type: DataTypes.DATE, allowNull: true },
    iLostAccess: { type: DataTypes.TINYINT, allowNull: true },
    dtLostAccessOn: { type: DataTypes.DATE, allowNull: true }
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
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            AmazonSellerID: { type: DataTypes.STRING(255), allowNull: false },
            access_token: { type: DataTypes.TEXT, allowNull: true },
            refresh_token: { type: DataTypes.TEXT, allowNull: true },
            expires_in: { type: DataTypes.DATE, allowNull: true },
            iLostAccess: { type: DataTypes.TINYINT, allowNull: true },
            dtLostAccessOn: { type: DataTypes.DATE, allowNull: true }
        }, {
            tableName: table,
            timestamps: false
        });
    }
    return cachedModel;
}

module.exports = { getModel };

