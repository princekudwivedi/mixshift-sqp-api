const pino = require('pino');
const fs = require('node:fs');
const path = require('node:path');
const envConfig = require('../config/env.config');
const LOG_TO_FILE = process.env.LOG_TO_FILE === 'true';
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');

let currentUserId = null;
let currentUserTimezone = null;

function resolveTimezone() {
	if (currentUserTimezone && currentUserTimezone.trim().length > 0) {
		return currentUserTimezone.trim();
	}
	if (process.env.TZ && process.env.TZ.trim().length > 0) {
		return process.env.TZ.trim();
	}
	try {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (tz && tz.trim().length > 0) {
			return tz.trim();
		}
	} catch (error) {
		logger.error({ error: error.message }, 'Error resolving timezone');
	}
	return 'UTC';
}

function formatDateInTimezone(date, timeZone) {
	const formatter = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	});
	const parts = formatter.formatToParts(date).reduce((acc, part) => {
		if (part.type === 'year') acc.year = part.value;
		if (part.type === 'month') acc.month = part.value;
		if (part.type === 'day') acc.day = part.value;
		return acc;
	}, {});
	return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDateFolder() {
	const timeZone = resolveTimezone();
	return formatDateInTimezone(new Date(), timeZone);
}

function ensureDirectory(dirPath) {
	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true });
	}
}

function sanitizeValue(value, visited = new WeakSet()) {
	if (value === null || value === undefined) {
		return value;
	}

	if (typeof value === 'string') {
		return value
			.replaceAll(/(tenantDb|tenant_Db|daysToKeep|logCleanupDays|validatedUserId|userId|hasToken|token|access_token|refresh_token|id_token)=([^&\s]+)/gi, '$1=[REDACTED]')
			.replaceAll(/(api[_-]?key|secret|password)=([^&\s]+)/gi, '$1=[REDACTED]');
	}

	if (typeof value !== 'object') {
		return value;
	}

	if (visited.has(value)) {
		return value;
	}

	visited.add(value);

	if (Array.isArray(value)) {
		return value.map((item) => sanitizeValue(item, visited));
	}

	if (value instanceof Date) {
		return value;
	}

	if (value instanceof Error) {
		return {
			name: value.name,
			message: sanitizeValue(value.message, visited),
			stack: value.stack
		};
	}

	const redacted = {};
	for (const [key, val] of Object.entries(value)) {
		const lowerKey = key.toLowerCase();
		const shouldRedact =
			lowerKey === 'userid' ||
			lowerKey === 'user_id' ||
			lowerKey === 'userId' ||
			lowerKey === 'currentUserId' ||	
			lowerKey === 'SellerID' ||	
			lowerKey === 'seller_id' ||
			lowerKey === 'sellerId' ||
			lowerKey === 'amazonSellerID' ||
			lowerKey === 'amazonSellerId' ||
			lowerKey === 'user' ||
			lowerKey === 'contextId' ||
			lowerKey === 'validatedUserId' ||
			lowerKey === 'validatedSellerId' ||
			lowerKey === 'db' ||
			lowerKey === 'dbname' ||
			lowerKey === 'dbName' ||
			lowerKey === 'currentDbName' ||
			lowerKey === 'database' ||
			lowerKey === 'daysToKeep' ||
			lowerKey.endsWith('token') ||
			lowerKey.includes('token') ||
			lowerKey === 'key' ||
			lowerKey.endsWith('key') ||
			lowerKey.includes('apikey') ||
			lowerKey.includes('secret') ||
			lowerKey.includes('password');

		if (shouldRedact) {
			redacted[key] = '[REDACTED]';
		} else {
			redacted[key] = sanitizeValue(val, visited);
		}
	}

	return redacted;
}

function sanitizeLogArguments(args) {
	return args.map((arg) => sanitizeValue(arg));
}

function resolveLogDir() {	
	let dateFolder = getDateFolder();
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

	for (const { level, fileName } of levelStreams) {
		streams.push({ level, stream: createLevelStream(fileName) });
	}
}

const logger = pino(
	{
		level: envConfig.LOG_LEVEL || 'info',
		timestamp: pino.stdTimeFunctions.isoTime,
		hooks: {
			logMethod(args, method) {
				const sanitizedArgs = sanitizeLogArguments(args);
				method.apply(this, sanitizedArgs);
			}
		}
	},
	pino.multistream(streams)
);

logger.setUserContext = (userId, timezone = null) => {
	if (userId === null || userId === undefined || Number(userId) === 0 || userId === '') {
		currentUserId = null;
		currentUserTimezone = null;
		return;
	}
	currentUserId = userId;
	currentUserTimezone = timezone;
};

logger.clearUserContext = () => {
	currentUserId = null;
	currentUserTimezone = null;
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
