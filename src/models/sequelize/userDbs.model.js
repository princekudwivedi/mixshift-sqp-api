const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { TBL_USER_DATABASES } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_USER_DATABASES;

const UserDbs = sequelize.define(table, {
    DB_ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    DB_Name: { type: DataTypes.STRING(255), allowNull: false },
    DB_AppType: { type: DataTypes.INTEGER, allowNull: true },
    DomainName: { type: DataTypes.STRING(255), allowNull: false },
    dtCreatedOn: { type: DataTypes.DATE, allowNull: false }
}, {
    tableName: table,
    timestamps: false
});

module.exports = makeReadOnly(UserDbs);


