const pino = require('pino');
const { logLevel } = require('../config/env');

const logger = pino({ level: logLevel });

module.exports = logger;


