const { query, setDatabase } = require('./mysql.db');
const logger = require('../utils/logger.utils');
const env = require('../config/env.config');
const { getTenantSequelize } = require('../config/sequelize.factory');
const User = require('../models/sequelize/user.model');
const UserDbMap = require('../models/sequelize/userDbMap.model');
const UserDbs = require('../models/sequelize/userDbs.model');
const Timezones = require('../models/sequelize/timezones.model');
const { TBL_USERS } = require('../config/env.config');

/**
 * Mirrors PHP loadDatabase($userId):
 * - userId = 0 → select primary (root) DB
 * - userId > 0 → query master for user DB name, switch pool to that DB, set timezone
 */
let currentDbName = env.DB_NAME;

async function loadDatabase(userId = 0) {
    if (!userId || Number(userId) === 0) {
        // Connect to root database for userId = 0
        logger.info('Connecting to root database (userId = 0)');
        currentDbName = env.DB_NAME;
        setDatabase(env.DB_NAME); // Root database
        return;
    }

    // For userId > 0: First connect to root database to query user mapping
    logger.info('Connecting to root database to query user mapping');
    currentDbName = env.DB_NAME;
    setDatabase(env.DB_NAME); // Root database where users table exists

    const rows = await query(
        `SELECT DB.DB_Name AS dbName, tz.Timezone AS tz
         FROM ${TBL_USERS} AS user
         LEFT JOIN ${UserDbMap.getTableName()} AS map ON map.UserID = user.ID
         LEFT JOIN ${UserDbs.getTableName()} AS DB ON map.MappedDB_ID = DB.DB_ID
         LEFT JOIN ${Timezones.getTableName()} AS tz ON tz.ID = user.iTimezoneID
         WHERE user.isDeleted = '0' AND DB.DB_AppType = '1' AND user.ID = ?
         LIMIT 1`,
        [Number(userId)]
    );
    if (!rows || rows.length === 0 || !rows[0].dbName) {
        logger.warn({ userId }, 'User DB mapping not found; staying on root');
        return;
    }
    
    // Switch to the user's tenant database
    logger.info({ tenantDb: rows[0].dbName }, 'Switching to tenant database');
    currentDbName = rows[0].dbName;
    setDatabase(rows[0].dbName);
    
    if (rows[0].tz) {
        try { process.env.TZ = rows[0].tz; } catch (_) {}
        logger.info({ tz: rows[0].tz }, 'Timezone set from tenant');
    }
}

function getCurrentDbName() { return currentDbName; }

function getTenantSequelizeForCurrentDb() {
    return getTenantSequelize({ db: currentDbName, user: env.DB_USER, pass: env.DB_PASS });
}

module.exports = { loadDatabase, getCurrentDbName, getTenantSequelizeForCurrentDb };


