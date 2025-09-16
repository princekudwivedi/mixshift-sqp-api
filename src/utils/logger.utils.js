const pino = require('pino');
const { logLevel } = require('../config/env.config');

const logger = pino({ level: logLevel });

module.exports = logger;


