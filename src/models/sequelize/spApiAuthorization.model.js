const { DataTypes } = require('sequelize');
const { getCurrentSequelize } = require('../../db/tenant.db');

// Using default table name; if you add a constant later, switch to it
const table = 'tbl_sp_api_authorization';

// Cache for the model to prevent recreating it
let cachedModel = null;

let BaseModel = getCurrentSequelize().define(table, {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    AmazonSellerID: { type: DataTypes.STRING(255), allowNull: false },
    access_token: { type: DataTypes.TEXT, allowNull: true },
    refresh_token: { type: DataTypes.TEXT, allowNull: true },
    expires_in: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true }
}, {
    tableName: table,
    timestamps: false
});

function getModel() {
    if (!cachedModel) {
        const sequelize = getCurrentSequelize();
        cachedModel = sequelize.define(table, {
            ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            SellerID: DataTypes.STRING,
            AuthorizationCode: DataTypes.TEXT,
            AccessToken: DataTypes.TEXT,
            RefreshToken: DataTypes.TEXT,
            TokenType: DataTypes.STRING,
            ExpiresIn: DataTypes.INTEGER,
            Scope: DataTypes.TEXT,
            dtCreatedOn: DataTypes.DATE,
            dtUpdatedOn: DataTypes.DATE
        }, {
            tableName: table,
            timestamps: false
        });
    }
    return cachedModel;
}

module.exports = { getModel };

