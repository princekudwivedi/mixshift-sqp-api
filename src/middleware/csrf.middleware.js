const crypto = require('crypto');
const env = require('../config/env.config');

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS', 'TRACE'];
const CSRF_COOKIE_NAME = env.CSRF_COOKIE_NAME || 'csrf_token';
const CSRF_HEADER_NAME = env.CSRF_HEADER_NAME || 'x-csrf-token';

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function timingSafeEqual(a, b) {
    try {
        const bufferA = Buffer.from(String(a));
        const bufferB = Buffer.from(String(b));
        if (bufferA.length !== bufferB.length) {
            return false;
        }
        return crypto.timingSafeEqual(bufferA, bufferB);
    } catch (_) {
        return false;
    }
}

function ensureCsrfToken(req, res) {
    let token = req.cookies?.[CSRF_COOKIE_NAME];

    if (!token) {
        token = generateToken();
        res.cookie(CSRF_COOKIE_NAME, token, {
            httpOnly: false, // required for double submit pattern
            sameSite: 'strict',
            secure: (env.NODE_ENV || '').toLowerCase() === 'production',
            maxAge: 24 * 60 * 60 * 1000, // 1 day
            path: '/',
            signed: false,
        });
    }

    res.setHeader(CSRF_HEADER_NAME, token);
    return token;
}

function csrfProtection(req, res, next) {
    const method = (req.method || '').toUpperCase();
    const token = ensureCsrfToken(req, res);

    if (SAFE_METHODS.includes(method)) {
        return next();
    }

    const headerToken = req.get(CSRF_HEADER_NAME);

    if (!headerToken || !timingSafeEqual(token, headerToken)) {
        return res.status(403).json({
            success: false,
            message: 'CSRF validation failed',
        });
    }

    return next();
}

module.exports = {
    csrfProtection,
};


