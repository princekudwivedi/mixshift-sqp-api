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
        
        // Monitor connections every 30 seconds
        this.monitorInterval = setInterval(() => {
            this.checkConnectionHealth();
        }, 30000);
        
        // Register cleanup handlers only once using process.once
        // Note: Actual database cleanup is handled by sequelize.factory.js
        process.once('SIGINT', () => {
            logger.info('Connection monitor received SIGINT');
            this.cleanup();
        });
        
        process.once('SIGTERM', () => {
            logger.info('Connection monitor received SIGTERM');
            this.cleanup();
        });
    }
    
    async checkConnectionHealth() {
        try {
            const sequelize = getCurrentSequelize();
            if (sequelize && sequelize.connectionManager) {
                const pool = sequelize.connectionManager.pool;
                const stats = pool ? pool.size : 0;
                const active = pool ? pool.used : 0;
                const idle = pool ? pool.pending : 0;
                
                this.connectionStats = {
                    totalConnections: stats,
                    activeConnections: active,
                    idleConnections: idle,
                    queuedConnections: 0, // Sequelize doesn't expose queue length directly
                    lastChecked: new Date().toISOString()
                };
                
                // Log warning if connections are high
                if (stats > 8) {
                    logger.warn({
                        connectionStats: this.connectionStats
                    }, 'High database connection usage detected');
                }
                
                // Log if connections are at limit
                if (stats >= (parseInt(process.env.DB_CONNECTION_LIMIT) || 5)) {
                    logger.error({
                        connectionStats: this.connectionStats
                    }, 'Database connection limit reached');
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
        try {
            if (this.monitorInterval) {
                clearInterval(this.monitorInterval);
            }
            
            // Close all Sequelize instances
            await closeAllSequelizeInstances();
            
            logger.info('Connection monitor cleanup completed');
        } catch (error) {
            logger.error({ error: error.message }, 'Error during connection monitor cleanup');
        }
    }
}

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
            connected: sequelize ? true : false,
            connectionStats: stats,
            connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 5,
            connectionUsage: stats.totalConnections ? 
                Math.round((stats.totalConnections / (parseInt(process.env.DB_CONNECTION_LIMIT) || 5)) * 100) : 0
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
