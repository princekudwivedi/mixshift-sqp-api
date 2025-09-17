const mysql = require('mysql2/promise');
const env = require('../config/env.config');
const logger = require('../utils/logger.utils');

function buildPoolConfig(databaseOverride) {
    return {
        host: env.DB_HOST,
        port: env.DB_PORT || 3306,
        user: env.DB_USER,
        password: env.DB_PASS,
        database: databaseOverride || env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    };
}

let pool = mysql.createPool(buildPoolConfig());

function setDatabase(databaseName) {
    pool = mysql.createPool(buildPoolConfig(databaseName));
    logger.info({ database: databaseName }, 'DB pool switched');
}

async function query(sql, params) {
    const start = Date.now();
    const [rows] = await pool.execute(sql, params);
    const ms = Date.now() - start;
    logger.debug({ ms, sql }, 'db.query');
    return rows;
}

async function getConnection() {
    return pool.getConnection();
}

function getPool() { return pool; }

module.exports = { query, getConnection, setDatabase, getPool };


