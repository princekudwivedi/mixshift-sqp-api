const mysql = require('mysql2/promise');
const { env } = require('./env.config');
const logger = require('../utils/logger.utils');

/**
 * Database Configuration
 * Manages MySQL connection pool and provides ORM-like interface
 */
class DatabaseConfig {
    constructor() {
        this.pool = null;
        this.connection = null;
    }

    /**
     * Initialize database connection pool
     */
    async initialize() {
        try {
            this.pool = mysql.createPool({
                host: env.DB_HOST,
                port: env.DB_PORT,
                user: env.DB_USER,
                password: env.DB_PASS,
                database: env.DB_NAME,
                waitForConnections: true,
                connectionLimit: 10,
                queueLimit: 0,
                charset: 'utf8mb4',
                connectTimeout: 60000
            });

            // Test connection
            const connection = await this.pool.getConnection();
            await connection.ping();
            connection.release();

            logger.info({ 
                host: env.DB_HOST, 
                database: env.DB_NAME 
            }, 'Database connection pool initialized successfully');

            return this.pool;
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to initialize database connection');
            throw error;
        }
    }

    /**
     * Get connection from pool
     */
    async getConnection() {
        if (!this.pool) {
            await this.initialize();
        }
        return await this.pool.getConnection();
    }

    /**
     * Execute query with connection management
     */
    async query(sql, params = []) {
        const start = Date.now();
        let connection;
        
        try {
            connection = await this.getConnection();
            const [rows] = await connection.execute(sql, params);
            const ms = Date.now() - start;
            
            logger.debug({ 
                ms, 
                sql: sql.substring(0, 100) + '...', 
                params: params.length 
            }, 'Database query executed');
            
            return rows;
        } catch (error) {
            logger.error({ 
                error: error.message, 
                sql: sql.substring(0, 100) + '...', 
                params 
            }, 'Database query failed');
            throw error;
        } finally {
            if (connection) {
                connection.release();
            }
        }
    }

    /**
     * Execute transaction
     */
    async transaction(callback) {
        const connection = await this.getConnection();
        
        try {
            await connection.beginTransaction();
            const result = await callback(connection);
            await connection.commit();
            return result;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    /**
     * Close all connections
     */
    async close() {
        if (this.pool) {
            await this.pool.end();
            logger.info('Database connection pool closed');
        }
    }

    /**
     * Health check
     */
    async healthCheck() {
        try {
            const connection = await this.getConnection();
            await connection.ping();
            connection.release();
            return { status: 'healthy', timestamp: new Date().toISOString() };
        } catch (error) {
            return { status: 'unhealthy', error: error.message, timestamp: new Date().toISOString() };
        }
    }
}

// Create singleton instance
const dbConfig = new DatabaseConfig();

module.exports = dbConfig;
