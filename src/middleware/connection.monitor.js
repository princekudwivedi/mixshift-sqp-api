const logger = require('../utils/logger.utils');
const { getCurrentSequelize } = require('../db/tenant.db');
const { closeAllSequelizeInstances } = require('../config/sequelize.factory');

class ConnectionMonitor {
    constructor() {
        this.connectionStats = {
            totalConnections: 0,
            activeConnections: 0,
            idleConnections: 0,
            queuedConnections: 0,
            lastChecked: null
        };

        // Start monitoring only once
        if (!ConnectionMonitor.monitorInterval) {
            ConnectionMonitor.monitorInterval = setInterval(() => {
                this.checkConnectionHealth();
            }, 30000);
        }

        // Register shutdown handlers only once
        if (!ConnectionMonitor.handlersRegistered) {
            ConnectionMonitor.handlersRegistered = true;

            const handleSignal = async (signal) => {
                try {
                    logger.info({ signal }, 'Shutdown signal received - cleaning up connection monitor');
                    await ConnectionMonitor.cleanupAll();
                    process.exit(0);
                } catch (error) {
                    logger.error({ error: error.message }, 'Error during shutdown cleanup');
                    process.exit(1);
                }
            };

            process.once('SIGINT', handleSignal);
            process.once('SIGTERM', handleSignal);
        }
    }
    
    async checkConnectionHealth() {
        try {
            const sequelize = getCurrentSequelize();
            if (sequelize && sequelize.connectionManager) {
                const pool = sequelize.connectionManager.pool;
                if (pool) {
                    const toNumber = (value) => {
                        if (typeof value === 'function') {
                            try {
                                return Number(value.call(pool)) || 0;
                            } catch {
                                return 0;
                            }
                        }
                        if (typeof value === 'number') return value;
                        if (value && typeof value.length === 'number') return value.length;
                        return Number(value) || 0;
                    };

                    const totalConnections = toNumber(pool.size);
                    const activeConnections = toNumber(pool.borrowed || pool.used);
                    const idleConnections = toNumber(pool.available || pool.idle);
                    const queuedConnections = toNumber(pool.pending);
                    
                    this.connectionStats = {
                        totalConnections,
                        activeConnections,
                        idleConnections,
                        queuedConnections,
                        lastChecked: new Date().toISOString()
                    };
                    
                    const connectionLimit = Number.parseInt(process.env.DB_CONNECTION_LIMIT, 10) || 5;

                    if (totalConnections > connectionLimit) {
                        logger.warn({
                            connectionStats: this.connectionStats,
                            connectionLimit
                        }, 'Database connection usage exceeds configured limit');
                    }
                    
                    if (queuedConnections > 0) {
                        logger.warn({
                            queuedConnections,
                            connectionStats: this.connectionStats
                        }, 'Database connections are queueing');
                    }
                }
            }
        } catch (error) {
            logger.error({ error: error.message }, 'Error checking connection health');
        }
    }
    
    getConnectionStats() {
        return this.connectionStats;
    }
    
    async cleanup() {
        await ConnectionMonitor.cleanupAll();
    }

    static async cleanupAll() {
        try {
            if (ConnectionMonitor.monitorInterval) {
                clearInterval(ConnectionMonitor.monitorInterval);
                ConnectionMonitor.monitorInterval = null;
            }

            await closeAllSequelizeInstances();

            logger.info('Connection monitor cleanup completed');
        } catch (error) {
            logger.error({ error: error.message }, 'Error during connection monitor cleanup');
        }
    }
}

ConnectionMonitor.monitorInterval = null;
ConnectionMonitor.handlersRegistered = false;

// Create singleton instance
const connectionMonitor = new ConnectionMonitor();

// Middleware to add connection stats to response
function addConnectionStats(req, res, next) {
    res.locals.connectionStats = connectionMonitor.getConnectionStats();
    next();
}

// Health check endpoint data
function getHealthCheckData() {
    const stats = connectionMonitor.getConnectionStats();
    const sequelize = getCurrentSequelize();
    
    return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        database: {
            connected: !!sequelize,
            connectionStats: stats,
            connectionLimit: Number.parseInt(process.env.DB_CONNECTION_LIMIT, 10) || 5,
            connectionUsage: stats.totalConnections ? 
                Math.round((stats.totalConnections / (Number.parseInt(process.env.DB_CONNECTION_LIMIT, 10) || 5)) * 100) : 0
        },
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
            external: Math.round(process.memoryUsage().external / 1024 / 1024)
        },
        uptime: process.uptime()
    };
}

module.exports = {
    connectionMonitor,
    addConnectionStats,
    getHealthCheckData
};
