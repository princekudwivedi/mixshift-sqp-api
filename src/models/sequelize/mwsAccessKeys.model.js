const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { TBL_MWS_ACCESS_KEYS } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = TBL_MWS_ACCESS_KEYS;

const MwsAccessKeys = sequelize.define(table, {
    ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    MerchantRegion: { type: DataTypes.STRING(150), allowNull: false },
    accessKey: { type: DataTypes.STRING(250), allowNull: false },
    secretKey: { type: DataTypes.STRING(250), allowNull: false },
    developerId: { type: DataTypes.STRING(250), allowNull: false }
}, {
    tableName: table,
    timestamps: false
});

module.exports = makeReadOnly(MwsAccessKeys);


