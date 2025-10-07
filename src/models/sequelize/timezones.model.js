const { DataTypes } = require('sequelize');
const { getCurrentSequelize } = require('../../db/tenant.db');
const { TBL_TIMEZONES } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_TIMEZONES; // 'timezones'

const Timezones = getCurrentSequelize().define(table, {
    ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    CountryRegion: { type: DataTypes.STRING(255), allowNull: false },
    Timezone: { type: DataTypes.STRING(255), allowNull: false },
    GMT_Value: { type: DataTypes.DECIMAL(10,2), allowNull: false },
    dtCreatedOn: { type: DataTypes.DATE, allowNull: false }
}, {
    tableName: table,
    timestamps: false
});

module.exports = makeReadOnly(Timezones);


