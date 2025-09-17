const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { TBL_STS_TOKENS } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');
const { getTenantSequelizeForCurrentDb } = require('../../db/tenant.db');

const table = TBL_STS_TOKENS;

let BaseModel = sequelize.define(table, {
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
    const tenantSequelize = getTenantSequelizeForCurrentDb();
    const model = tenantSequelize.models[table] || tenantSequelize.define(table, BaseModel.getAttributes(), { tableName: table, timestamps: false, freezeTableName: true });
    return makeReadOnly(model);
}

module.exports = { getModel };


