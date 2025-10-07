const { DataTypes } = require('sequelize');
const { getCurrentSequelize } = require('../../db/tenant.db');
const { TBL_USER_DB_MAP } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_USER_DB_MAP;

const UserDbMap = getCurrentSequelize().define(table, {
    ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    UserID: { type: DataTypes.INTEGER, allowNull: false },
    MappedDB_ID: { type: DataTypes.INTEGER, allowNull: false },
    dtCreatedOn: { type: DataTypes.DATE, allowNull: false }
}, {
    tableName: table,
    timestamps: false
});

module.exports = makeReadOnly(UserDbMap);


