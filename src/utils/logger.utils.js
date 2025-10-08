const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { LOG_LEVEL } = require('../config/env.config');

const LOG_TO_FILE = process.env.LOG_TO_FILE === 'true';
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const SEPARATE_LOG_LEVELS = process.env.SEPARATE_LOG_LEVELS === 'true';

/**
 * Get current date in DD-MM-YYYY format for log folder
 */
function getDateFolder() {
	const now = new Date();
	const day = String(now.getDate()).padStart(2, '0');
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const year = now.getFullYear();
	return `${day}-${month}-${year}`;
}

/**
 * Ensure log directory exists for today
 */
function ensureLogDirectory() {
	if (!LOG_TO_FILE) return null;
	
	try {
		const dateFolder = getDateFolder();
		const logPath = path.join(LOG_DIR, dateFolder);
		
		if (!fs.existsSync(logPath)) {
			fs.mkdirSync(logPath, { recursive: true });
			console.log(`Created log directory: ${logPath}`);
		}
		
		return logPath;
	} catch (err) {
		console.error('Failed to create log directory:', err.message);
		return null;
	}
}

// Create logger
let logger;

if (LOG_TO_FILE && SEPARATE_LOG_LEVELS) {
	// Separate log files by level
	const logPath = ensureLogDirectory();
	
	if (logPath) {
		// Create file streams for each level
		const infoStream = fs.createWriteStream(path.join(logPath, 'info.log'), { flags: 'a' });
		const warnStream = fs.createWriteStream(path.join(logPath, 'warning.log'), { flags: 'a' });
		const errorStream = fs.createWriteStream(path.join(logPath, 'error.log'), { flags: 'a' });
		const fatalStream = fs.createWriteStream(path.join(logPath, 'fatal.log'), { flags: 'a' });
		
		// Create base logger with console output
		logger = pino({ 
			level: LOG_LEVEL || 'info',
		}, pino.transport({ target: 'pino-pretty', options: { colorize: true } }));
		
		// Override logging methods to write to separate files
		const originalInfo = logger.info.bind(logger);
		const originalWarn = logger.warn.bind(logger);
		const originalError = logger.error.bind(logger);
		const originalFatal = logger.fatal.bind(logger);
		
		logger.info = function(...args) {
			const result = originalInfo(...args);
			const logEntry = JSON.stringify({ level: 'INFO', time: new Date().toISOString(), ...args[0], msg: args[1] }) + '\n';
			infoStream.write(logEntry);
			return result;
		};
		
		logger.warn = function(...args) {
			const result = originalWarn(...args);
			const logEntry = JSON.stringify({ level: 'WARN', time: new Date().toISOString(), ...args[0], msg: args[1] }) + '\n';
			warnStream.write(logEntry);
			return result;
		};
		
		logger.error = function(...args) {
			const result = originalError(...args);
			const logEntry = JSON.stringify({ level: 'ERROR', time: new Date().toISOString(), ...args[0], msg: args[1] }) + '\n';
			errorStream.write(logEntry);
			return result;
		};
		
		logger.fatal = function(...args) {
			const result = originalFatal(...args);
			const logEntry = JSON.stringify({ level: 'FATAL', time: new Date().toISOString(), ...args[0], msg: args[1] }) + '\n';
			fatalStream.write(logEntry);
			return result;
		};
		
		console.log(`✅ Logger configured with separate files in: ${logPath}`);
		console.log(`   - info.log, warning.log, error.log, fatal.log`);
	} else {
		// Fallback to console only
		logger = pino({ level: LOG_LEVEL || 'info' }, pino.transport({ target: 'pino-pretty', options: { colorize: true } }));
	}
} else if (LOG_TO_FILE) {
	// Single combined log file
	const logPath = ensureLogDirectory();
	const logFile = process.env.LOG_FILE || 'sqp-api.log';
	
	if (logPath) {
		const targets = [
			{ target: 'pino-pretty', options: { colorize: true } },
			{ target: 'pino/file', options: { destination: path.join(logPath, logFile), mkdir: true } }
		];
		
		logger = pino({ 
			level: LOG_LEVEL || 'info',
		}, pino.transport({ targets }));
		
		console.log(`✅ Logger configured with combined file: ${path.join(logPath, logFile)}`);
	} else {
		// Fallback to console only
		logger = pino({ level: LOG_LEVEL || 'info' }, pino.transport({ target: 'pino-pretty', options: { colorize: true } }));
	}
} else {
	// Console only
	logger = pino({ level: LOG_LEVEL || 'info' }, pino.transport({ target: 'pino-pretty', options: { colorize: true } }));
}

module.exports = logger;


