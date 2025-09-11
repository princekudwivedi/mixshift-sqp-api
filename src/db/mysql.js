const mysql = require('mysql2/promise');
const config = require('../config/env');
const logger = require('../utils/logger');

let pool = mysql.createPool(config.db);

function setDatabase(databaseName) {
    const cfg = { ...config.db, database: databaseName };
    pool = mysql.createPool(cfg);
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


