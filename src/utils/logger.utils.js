const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { LOG_LEVEL } = require('../config/env.config');

const LOG_TO_FILE = process.env.LOG_TO_FILE === 'true';
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const LOG_FILE = process.env.LOG_FILE || 'app.log';

// Ensure logs directory exists if file logging is enabled
if (LOG_TO_FILE) {
	try {
		if (!fs.existsSync(LOG_DIR)) {
			fs.mkdirSync(LOG_DIR, { recursive: true });
		}
	} catch (err) {
		console.error('Failed to create log directory:', err.message);
	}
}

// Pretty transport for console; file stream for logs
const targets = [
	{ target: 'pino-pretty', options: { colorize: true } }
];

if (LOG_TO_FILE) {
	targets.push({
		target: 'pino/file',
		options: { destination: path.join(LOG_DIR, LOG_FILE), mkdir: true }
	});
}

const logger = pino({ level: LOG_LEVEL || 'info' }, pino.transport({ targets }));

module.exports = logger;


