const logger = require('../utils/logger.utils');
const env = require('../config/env.config');
const { getRootSequelize, getTenantSequelize } = require('../config/sequelize.factory');
const { Op } = require('sequelize');

/**
 * - userId = 0 → select primary (root) DB
 * - userId > 0 → query master for user DB name, switch to that DB
 */
let currentDbName = env.DB_NAME;
let currentSequelize = null;
let currentUserId = null;

async function loadDatabase(userId = 0) {
    // Check if we're already connected to the same user's database
    if (currentUserId === userId) {
        return currentSequelize;
    }
    
    if (!userId || Number(userId) === 0) {
        // Connect to root database for userId = 0
        logger.info('Connecting to root database (userId = 0)');
        currentDbName = env.DB_NAME;
        currentSequelize = getRootSequelize();
        currentUserId = 0;
        return currentSequelize;
    }

    // For userId > 0: First connect to root database to query user mapping
    logger.info('Connecting to root database to query user mapping');
    const rootSequelize = getRootSequelize();
    
    try {
        // Use Sequelize to query user mapping
        const userMapping = await rootSequelize.query(`
            SELECT DB.DB_Name AS dbName, tz.Timezone AS tz
            FROM users AS user
            LEFT JOIN user_database_mapping AS map ON map.UserID = user.ID
            LEFT JOIN user_databases AS DB ON map.MappedDB_ID = DB.DB_ID
            LEFT JOIN timezones AS tz ON tz.ID = user.iTimezoneID
            WHERE user.isDeleted = '0' AND DB.DB_AppType = '1' AND user.ID = :userId
            LIMIT 1
        `, {
            replacements: { userId: Number(userId) },
            type: rootSequelize.QueryTypes.SELECT
        });

        if (!userMapping || userMapping.length === 0 || !userMapping[0].dbName) {
            logger.warn({ userId }, 'User DB mapping not found; staying on root');
            currentDbName = env.DB_NAME;
            currentSequelize = rootSequelize;
            currentUserId = userId;
            return currentSequelize;
        }
        
        // Switch to the user's tenant database
        logger.info({ tenantDb: userMapping[0].dbName }, 'Switching to tenant database');
        currentDbName = userMapping[0].dbName;
        currentSequelize = getTenantSequelize({ 
            db: userMapping[0].dbName, 
            user: env.DB_USER, 
            pass: env.DB_PASS 
        });
        currentUserId = userId;
        return currentSequelize;
    } catch (error) {
        logger.error({ error: error.message, userId }, 'Error loading tenant database');
        currentDbName = env.DB_NAME;
        currentSequelize = rootSequelize;
        return currentSequelize;
    }
}

function getCurrentDbName() { 
    return currentDbName; 
}

function getCurrentSequelize() { 
    return currentSequelize || getRootSequelize(); 
}

function getCurrentUserId() {
    return currentUserId;
}

function clearModelCaches() {
    // This function will be used to clear model caches when database changes
    // We'll implement this by requiring all model files to check for database changes
    logger.info({ currentUserId, currentDbName }, 'Database changed - model caches should be cleared');
}

function getTenantSequelizeForCurrentDb() {
    return getTenantSequelize({ db: currentDbName, user: env.DB_USER, pass: env.DB_PASS });
}

module.exports = { 
    loadDatabase, 
    getCurrentDbName, 
    getCurrentSequelize, 
    getCurrentUserId,
    clearModelCaches,
    getTenantSequelizeForCurrentDb 
};



