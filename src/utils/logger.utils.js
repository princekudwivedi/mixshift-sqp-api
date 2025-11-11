const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { LOG_LEVEL } = require('../config/env.config');

const LOG_TO_FILE = process.env.LOG_TO_FILE === 'true';
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');

function getDateFolder() {
	const now = new Date();
	const day = String(now.getDate()).padStart(2, '0');
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const year = now.getFullYear();
	return `${year}-${month}-${day}`;
}

function ensureDirectory(dirPath) {
	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true });
	}
}

let currentUserId = null;

function resolveLogDir() {
	const dateFolder = getDateFolder();
	if (currentUserId && Number(currentUserId) !== 0) {
		return path.join(LOG_DIR, 'api_logs', `user__${currentUserId}`, dateFolder);
	}
	return path.join(LOG_DIR, dateFolder);
}

function createLevelStream(fileName) {
	return {
		write(chunk) {
			if (!LOG_TO_FILE || !chunk) return;
			try {
				const dir = resolveLogDir();
				ensureDirectory(dir);
				fs.appendFileSync(path.join(dir, fileName), chunk);
			} catch (err) {
				console.error(`❌ Failed to append log for ${fileName}:`, err.message);
			}
		}
	};
}

const prettyStream = pino.transport({
	target: 'pino-pretty',
	options: { colorize: true }
});

const streams = [{ stream: prettyStream }];

if (LOG_TO_FILE) {
	const levelStreams = [
		{ level: 'info', fileName: 'info.log' },
		{ level: 'warn', fileName: 'warning.log' },
		{ level: 'error', fileName: 'error.log' },
		{ level: 'fatal', fileName: 'fatal.log' }
	];

	levelStreams.forEach(({ level, fileName }) => {
		streams.push({ level, stream: createLevelStream(fileName) });
	});
}

const logger = pino(
	{
		level: LOG_LEVEL || 'info',
		timestamp: pino.stdTimeFunctions.isoTime
	},
	pino.multistream(streams)
);

logger.setUserContext = (userId) => {
	if (userId === null || userId === undefined || Number(userId) === 0 || userId === '') {
		currentUserId = null;
		return;
	}
	currentUserId = userId;
};

logger.clearUserContext = () => {
	currentUserId = null;
};

if (LOG_TO_FILE) {
	const initialDir = resolveLogDir();
	ensureDirectory(initialDir);
	console.log(`✅ Logger configured with file output in: ${initialDir}`);
	console.log('   - info.log, warning.log, error.log, fatal.log');
} else {
	console.log('🖥️ Logger running in console-only mode');
}

module.exports = logger;
