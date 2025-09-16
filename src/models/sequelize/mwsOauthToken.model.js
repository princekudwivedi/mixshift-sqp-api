const { DataTypes } = require('sequelize');
const sequelize = require('../../config/sequelize.config');
const { env } = require('../../config/env.config');
const { makeReadOnly } = require('./utils');

const table = env('TBL_MWS_OAUTH_TOKEN', 'tbl_mws_oauth_token');

const MwsOauthToken = sequelize.define(table, {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    AmazonSellerID: { type: DataTypes.STRING(250), allowNull: false },
    auth_token: { type: DataTypes.TEXT, allowNull: false },
    idAccessKey: { type: DataTypes.INTEGER, allowNull: false },
    isActive: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    dtCreatedOn: { type: DataTypes.DATE, allowNull: false },
    dtUpdatedOn: { type: DataTypes.DATE, allowNull: true },
    scriptStartTime: { type: DataTypes.DATE, allowNull: true },
    scriptEndTime: { type: DataTypes.DATE, allowNull: true },
    iRunningStatus: { type: DataTypes.TINYINT, allowNull: false },
    iLostAccess: { type: DataTypes.TINYINT, allowNull: false },
    dtLostAccessOn: { type: DataTypes.DATE, allowNull: false }
}, {
    tableName: table,
    timestamps: false
});

module.exports = makeReadOnly(MwsOauthToken);


