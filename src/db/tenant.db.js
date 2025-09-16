const { query, setDatabase } = require('./mysql');
const logger = require('../utils/logger');
const { tables, db } = require('../config/env.config');

/**
 * Mirrors PHP loadDatabase($userId):
 * - userId = 0 → select primary (root) DB
 * - userId > 0 → query master for user DB name, switch pool to that DB, set timezone
 */
async function loadDatabase(userId = 0) {
    if (!userId || Number(userId) === 0) {
        // Connect to root database for userId = 0
        logger.info('Connecting to root database (userId = 0)');
        setDatabase(db.database); // Root database: dev_dash_applications
        return;
    }

    // For userId > 0: First connect to root database to query user mapping
    logger.info('Connecting to root database to query user mapping');
    setDatabase(db.database); // Root database where users table exists

    // Query the users table from root database
    const sql = `
        SELECT DB.DB_Name AS dbName, timezones.Timezone AS tz
        FROM ${tables.users} AS user
        LEFT JOIN ${tables.userDbMap} AS map ON map.UserID = user.ID
        LEFT JOIN ${tables.userDbs} AS DB ON map.MappedDB_ID = DB.DB_ID
        LEFT JOIN ${tables.timezones} AS timezones ON timezones.ID = user.iTimezoneID
        WHERE user.isDeleted = '0' AND DB.DB_AppType = '1' AND user.ID = ?
        LIMIT 1
    `;
    const rows = await query(sql, [Number(userId)]);
    if (!rows || rows.length === 0 || !rows[0].dbName) {
        logger.warn({ userId }, 'User DB mapping not found; staying on root');
        return;
    }
    
    // Switch to the user's tenant database
    logger.info({ tenantDb: rows[0].dbName }, 'Switching to tenant database');
    setDatabase(rows[0].dbName);
    
    if (rows[0].tz) {
        try { process.env.TZ = rows[0].tz; } catch (_) {}
        logger.info({ tz: rows[0].tz }, 'Timezone set from tenant');
    }
}

module.exports = { loadDatabase };


