const { AsyncLocalStorage } = require('async_hooks');
const logger = require('../utils/logger.utils');
const env = require('../config/env.config');
const { getRootSequelize, getTenantSequelize } = require('../config/sequelize.factory');
const { Op } = require('sequelize');

const asyncLocalStorage = new AsyncLocalStorage();

/**
 * Initialize a new database context for this async operation
 * MUST be called at the start of each cron/API request
 */
function initDatabaseContext(callback) {
    const context = {
        dbName: env.DB_NAME,
        sequelize: null,
        userId: null
    };
    return asyncLocalStorage.run(context, callback);
}

/**
 * Load database for a specific user within the current async context
 * - userId = 0 → select primary (root) DB
 * - userId > 0 → query master for user DB name, switch to that DB
 */
async function loadDatabase(userId = 0) {
    const context = asyncLocalStorage.getStore();
    
    if (!context) {
        logger.error('Database context not initialized! Call initDatabaseContext() first');
        throw new Error('Database context not initialized. This is a critical bug - contact support immediately.');
    }
    
    // Check if we're already connected to the same user's database in this context
    if (context.userId === userId && context.sequelize) {
        logger.debug({ userId, contextUserId: context.userId }, 'Already connected to correct database in this context');
        return context.sequelize;
    }
    
    if (!userId || Number(userId) === 0) {
        // Connect to root database for userId = 0
        logger.info({ contextId: getContextId() }, 'Connecting to root database (userId = 0)');
        context.dbName = env.DB_NAME;
        context.sequelize = getRootSequelize();
        context.userId = 0;
        return context.sequelize;
    }

    // For userId > 0: First connect to root database to query user mapping
    logger.info({ contextId: getContextId(), userId }, 'Connecting to root database to query user mapping');
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
            logger.warn({ userId, contextId: getContextId() }, 'User DB mapping not found; staying on root');
            context.dbName = env.DB_NAME;
            context.sequelize = rootSequelize;
            context.userId = userId;
            return context.sequelize;
        }
        
        // Switch to the user's tenant database
        logger.info({ 
            tenantDb: userMapping[0].dbName, 
            userId, 
            contextId: getContextId() 
        }, 'Switching to tenant database');
        
        context.dbName = userMapping[0].dbName;
        context.sequelize = getTenantSequelize({ 
            db: userMapping[0].dbName, 
            user: env.DB_USER, 
            pass: env.DB_PASS 
        });
        context.userId = userId;
        
        logger.info({ 
            userId, 
            dbName: context.dbName, 
            contextId: getContextId() 
        }, 'Database context switched successfully');
        
        return context.sequelize;
    } catch (error) {
        logger.error({ 
            error: error.message, 
            userId, 
            contextId: getContextId() 
        }, 'Error loading tenant database');
        context.dbName = env.DB_NAME;
        context.sequelize = rootSequelize;
        return context.sequelize;
    }
}

function getCurrentDbName() {
    const context = asyncLocalStorage.getStore();
    if (!context) {
        logger.warn('No database context - returning default DB name');
        return env.DB_NAME;
    }
    return context.dbName || env.DB_NAME;
}

function getCurrentSequelize() {
    const context = asyncLocalStorage.getStore();
    if (!context || !context.sequelize) {
        logger.warn({ contextId: getContextId() }, 'No sequelize in context - returning root');
        return getRootSequelize();
    }
    return context.sequelize;
}

function getCurrentUserId() {
    const context = asyncLocalStorage.getStore();
    if (!context) {
        logger.warn('No database context - returning null userId');
        return null;
    }
    return context.userId;
}

function clearModelCaches() {
    const context = asyncLocalStorage.getStore();
    if (context) {
        logger.info({ 
            currentUserId: context.userId, 
            currentDbName: context.dbName,
            contextId: getContextId()
        }, 'Database changed - model caches should be cleared');
    }
}

function getTenantSequelizeForCurrentDb() {
    const context = asyncLocalStorage.getStore();
    const dbName = context?.dbName || env.DB_NAME;
    return getTenantSequelize({ db: dbName, user: env.DB_USER, pass: env.DB_PASS });
}

/**
 * Get a unique identifier for the current async context (for debugging)
 */
function getContextId() {
    const context = asyncLocalStorage.getStore();
    if (!context) return 'NO_CONTEXT';
    
    // Create a simple hash from the context object reference
    return `ctx_${context.userId || 'unknown'}_${Date.now().toString(36)}`;
}

/**
 * Verify database context integrity (for debugging/testing)
 */
function verifyDatabaseContext(expectedUserId) {
    const context = asyncLocalStorage.getStore();
    if (!context) {
        logger.error({ expectedUserId }, 'CRITICAL: No database context found!');
        return false;
    }
    
    if (context.userId !== expectedUserId) {
        logger.error({ 
            expectedUserId, 
            actualUserId: context.userId,
            contextId: getContextId()
        }, 'CRITICAL: Database context mismatch - possible tenant isolation breach!');
        return false;
    }
    
    return true;
}

module.exports = { 
    initDatabaseContext,
    loadDatabase, 
    getCurrentDbName, 
    getCurrentSequelize, 
    getCurrentUserId,
    clearModelCaches,
    getTenantSequelizeForCurrentDb,
    verifyDatabaseContext,
    getContextId
};

