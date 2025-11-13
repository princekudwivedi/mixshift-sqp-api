const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(process.env.DEFAULT_DB_NAME, process.env.DEFAULT_DB_USERNAME, process.env.DEFAULT_DB_PASSWORD, {
    host: process.env.DEFAULT_DB_HOSTNAME,
    port: process.env.DB_PORT_NUMBER,
    dialect: 'mysql',
    logging: false,
    define: {
        timestamps: false,
        freezeTableName: true
    }
});

module.exports = sequelize;


