const { Sequelize } = require('sequelize');
const logger = require('../utils/logger.utils');

// Cache for Sequelize instances to prevent connection leaks
const sequelizeInstances = new Map();

// Flag to track if signal handlers have been registered
let signalHandlersRegistered = false;

// Register signal handlers only once for all instances
function registerSignalHandlers() {
    if (signalHandlersRegistered) {
        return;
    }
    
    signalHandlersRegistered = true;
    
    // Single SIGINT handler for all instances
    process.on('SIGINT', async () => {
        try {
            await closeAllSequelizeInstances();
            process.exit(0);
        } catch (error) {
            logger.error({ error: error.message }, 'Error closing Sequelize connections on SIGINT');
            process.exit(1);
        }
    });
    
    // Single SIGTERM handler for all instances
    process.on('SIGTERM', async () => {
        try {
            await closeAllSequelizeInstances();
            process.exit(0);
        } catch (error) {
            logger.error({ error: error.message }, 'Error closing Sequelize connections on SIGTERM');
            process.exit(1);
        }
    });
}

function createSequelize({ host, port, user, pass, db }) {
    const key = `${host}:${port}:${user}:${db}`;
    
    // Return existing instance if available
    if (sequelizeInstances.has(key)) {
        return sequelizeInstances.get(key);
    }
    
    // Register signal handlers on first instance creation
    registerSignalHandlers();
    
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
    
    return sequelize;
}

function getRootSequelize() {
    return createSequelize({
        host: process.env.DEFAULT_DB_HOSTNAME,
        port: process.env.DB_PORT_NUMBER,
        user: process.env.DEFAULT_DB_USERNAME,
        pass: process.env.DEFAULT_DB_PASSWORD,
        db: process.env.DEFAULT_DB_NAME
    });
}

function getTenantSequelize(tenant) {
    // tenant: { host, port, user, pass, db }
    return createSequelize({
        host: tenant.host || process.env.DEFAULT_DB_HOSTNAME,
        port: tenant.port || process.env.DB_PORT_NUMBER,
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


