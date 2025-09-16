const { env } = require('../config/env.config');
const logger = require('../utils/logger.utils');

function parseAllowedIps(raw) {
    if (!raw) return [];
    return raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

function isPrivate(ip) {
    // Basic private ranges check (IPv4)
    return (
        ip.startsWith('10.') ||
        ip.startsWith('192.168.') ||
        ip.startsWith('172.16.') || ip.startsWith('172.17.') || ip.startsWith('172.18.') || ip.startsWith('172.19.') ||
        ip.startsWith('172.2') // covers 172.20. - 172.29.
    );
}

function normalizeIp(ip) {
    if (!ip) return '';
    // Remove IPv6 prefix for IPv4-mapped addresses
    if (ip.startsWith('::ffff:')) return ip.replace('::ffff:', '');
    return ip;
}

module.exports = function ipAllowlistMiddleware(req, res, next) {
    try {
        const nodeEnv = (env.NODE_ENV || 'development').toLowerCase();
        const allowedRaw = env.CRON_ALLOWED_IPS || '';
        const allowed = parseAllowedIps(allowedRaw);

        const clientIp = normalizeIp(req.ip || req.connection?.remoteAddress || '');

        // In development/local, allow localhost and private ranges by default
        if (nodeEnv !== 'production') {
            if (clientIp === '127.0.0.1' || clientIp === '::1' || isPrivate(clientIp)) {
                return next();
            }
        }

        // If allowlist not configured, deny by default in production
        if (nodeEnv === 'production' && allowed.length === 0) {
            logger.warn({ clientIp }, 'Cron request blocked: empty allowlist in production');
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        // Wildcard support
        if (allowed.includes('*')) {
            return next();
        }

        // Exact match check
        if (allowed.includes(clientIp)) {
            return next();
        }

        logger.warn({ clientIp, allowed }, 'Cron request blocked: IP not allowed');
        return res.status(403).json({ success: false, message: 'Forbidden' });
    } catch (error) {
        logger.error({ error: error.message }, 'IP allowlist error');
        return res.status(500).json({ success: false, message: 'IP filter error' });
    }
};


