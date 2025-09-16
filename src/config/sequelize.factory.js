const { Sequelize } = require('sequelize');
const { DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME } = require('./env.config');

function createSequelize({ host, port, user, pass, db }) {
    return new Sequelize(db, user, pass, {
        host,
        port,
        dialect: 'mysql',
        logging: false,
        define: { timestamps: false, freezeTableName: true }
    });
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

module.exports = { getRootSequelize, getTenantSequelize };


