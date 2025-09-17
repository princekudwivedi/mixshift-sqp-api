const pino = require('pino');
const { LOG_LEVEL } = require('../config/env.config');

const logger = pino({ level: LOG_LEVEL || 'info' });

module.exports = logger;


