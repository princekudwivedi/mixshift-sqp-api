const { Sequelize } = require('sequelize');
const { DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME } = require('./env.config');
const logger = require('../utils/logger.utils');

// Cache for Sequelize instances to prevent connection leaks
const sequelizeInstances = new Map();

// Flag to track if cleanup handlers are registered
let cleanupHandlersRegistered = false;

// Register cleanup handlers once for all instances
function registerCleanupHandlers() {
    if (cleanupHandlersRegistered) {
        return;
    }
    
    cleanupHandlersRegistered = true;
    
    // Use process.once to ensure handlers are only registered once
    process.once('SIGINT', async () => {
        logger.info('SIGINT received, closing all database connections...');
        await closeAllSequelizeInstances();
        process.exit(0);
    });
    
    process.once('SIGTERM', async () => {
        logger.info('SIGTERM received, closing all database connections...');
        await closeAllSequelizeInstances();
        process.exit(0);
    });
    
    logger.info('Database cleanup handlers registered');
}

function createSequelize({ host, port, user, pass, db }) {
    const key = `${host}:${port}:${user}:${db}`;
    
    // Return existing instance if available
    if (sequelizeInstances.has(key)) {
        return sequelizeInstances.get(key);
    }
    
    // Register cleanup handlers once for all instances
    registerCleanupHandlers();
    
    const sequelize = new Sequelize(db, user, pass, {
        host,
        port,
        dialect: 'mysql',
        logging: false,
        define: { timestamps: false, freezeTableName: true },
        pool: {
            max: 3, // Maximum number of connections in pool
            min: 0, // Minimum number of connections in pool
            acquire: 30000, // Maximum time to get connection
            idle: 10000, // Maximum time connection can be idle
            evict: 1000, // Check for idle connections every 1 second
        },
        dialectOptions: {
            connectTimeout: 60000,
        },
        retry: {
            match: [
                /ETIMEDOUT/,
                /EHOSTUNREACH/,
                /ECONNRESET/,
                /ECONNREFUSED/,
                /ETIMEDOUT/,
                /ESOCKETTIMEDOUT/,
                /EHOSTUNREACH/,
                /EPIPE/,
                /EAI_AGAIN/,
                /SequelizeConnectionError/,
                /SequelizeConnectionRefusedError/,
                /SequelizeHostNotFoundError/,
                /SequelizeHostNotReachableError/,
                /SequelizeInvalidConnectionError/,
                /SequelizeConnectionTimedOutError/
            ],
            max: 3
        }
    });
    
    // Cache the instance
    sequelizeInstances.set(key, sequelize);
    
    logger.info({ key }, 'New Sequelize instance created');
    
    return sequelize;
}

function getRootSequelize() {
    return createSequelize({ host: DB_HOST, port: DB_PORT, user: DB_USER, pass: DB_PASS, db: DB_NAME });
}

function getTenantSequelize(tenant) {
    // tenant: { host, port, user, pass, db }
    return createSequelize({
        host: tenant.host || DB_HOST,
        port: tenant.port || DB_PORT,
        user: tenant.user,
        pass: tenant.pass,
        db: tenant.db
    });
}

// Function to close all Sequelize instances
async function closeAllSequelizeInstances() {
    const closePromises = Array.from(sequelizeInstances.values()).map(sequelize => 
        sequelize.close().catch(error => 
            logger.error({ error: error.message }, 'Error closing Sequelize instance')
        )
    );
    
    await Promise.all(closePromises);
    sequelizeInstances.clear();
    logger.info('All Sequelize instances closed');
}

module.exports = { getRootSequelize, getTenantSequelize, closeAllSequelizeInstances };


