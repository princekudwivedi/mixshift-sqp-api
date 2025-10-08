const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { LOG_LEVEL } = require('../config/env.config');

const LOG_TO_FILE = process.env.LOG_TO_FILE === 'true';
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');

/**
 * Get current date folder (DD-MM-YYYY)
 */
function getDateFolder() {
	const now = new Date();
	const day = String(now.getDate()).padStart(2, '0');
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const year = now.getFullYear();
	return `${day}-${month}-${year}`;
}

/**
 * Ensure daily log directory exists
 */
function ensureLogDirectory() {
	if (!LOG_TO_FILE) return null;

	try {
		const dateFolder = getDateFolder();
		const logPath = path.join(LOG_DIR, dateFolder);
		if (!fs.existsSync(logPath)) {
			fs.mkdirSync(logPath, { recursive: true });
			console.log(`📁 Created log directory: ${logPath}`);
		}
		return logPath;
	} catch (err) {
		console.error('❌ Failed to create log directory:', err.message);
		return null;
	}
}

let logger;

if (LOG_TO_FILE) {
	const logPath = ensureLogDirectory();

	// Define separate destinations for each log level
	const targets = [
		{
			target: 'pino-pretty',
			options: { colorize: true }, // pretty console output
		},
		{
			target: 'pino/file',
			level: 'info',
			options: { destination: path.join(logPath, 'info.log'), mkdir: true },
		},
		{
			target: 'pino/file',
			level: 'warn',
			options: { destination: path.join(logPath, 'warning.log'), mkdir: true },
		},
		{
			target: 'pino/file',
			level: 'error',
			options: { destination: path.join(logPath, 'error.log'), mkdir: true },
		},
		{
			target: 'pino/file',
			level: 'fatal',
			options: { destination: path.join(logPath, 'fatal.log'), mkdir: true },
		},
	];

	const transport = pino.transport({ targets });

	logger = pino(
		{
			level: LOG_LEVEL || 'info',
			timestamp: pino.stdTimeFunctions.isoTime,
		},
		transport
	);

	console.log(`✅ Logger configured with separate files in: ${logPath}`);
	console.log(`   - info.log, warning.log, error.log, fatal.log`);
} else {
	logger = pino(
		{ level: LOG_LEVEL || 'info' },
		pino.transport({
			target: 'pino-pretty',
			options: { colorize: true },
		})
	);
	console.log(`🖥️ Logger running in console-only mode`);
}

module.exports = logger;
