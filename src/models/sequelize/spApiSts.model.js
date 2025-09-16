const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { env } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = env('TBL_SPAPI_STS_TOKEN', 'sp_api_sts');

const SpApiSts = sequelize.define(table, {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    accessKeyId: { type: DataTypes.TEXT, allowNull: false },
    secretAccessKey: { type: DataTypes.TEXT, allowNull: false },
    SessionToken: { type: DataTypes.TEXT, allowNull: false },
    expire_at: { type: DataTypes.DATE, allowNull: false }
}, {
    tableName: table,
    timestamps: false
});

module.exports = makeReadOnly(SpApiSts);


