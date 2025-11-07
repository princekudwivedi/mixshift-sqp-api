const { RateLimiterRedis, RateLimiterMemory } = require('rate-limiter-flexible');
const Redis = require('ioredis');
const env = require('../config/env.config');
const logger = require('../utils/logger.utils');

const points = env.RATE_LIMIT_MAX_REQUESTS || 100;
const durationSeconds = Math.max(1, Math.floor((env.RATE_LIMIT_WINDOW_MS || 900000) / 1000));

let redisClient;
let rateLimiter;

function initRateLimiter() {
    if (rateLimiter) {
        return rateLimiter;
    }

    try {
        const redisUrl = env.REDIS_URL || process.env.REDIS_URL || null;

        if (redisUrl) {
            redisClient = new Redis(redisUrl, {
                enableOfflineQueue: false,
                maxRetriesPerRequest: 2,
            });

            rateLimiter = new RateLimiterRedis({
                storeClient: redisClient,
                points,
                duration: durationSeconds,
                keyPrefix: 'sqp_rl',
            });

            logger.info({ redisUrl }, 'Initialized Redis-backed rate limiter');
        } else {
            rateLimiter = new RateLimiterMemory({
                points,
                duration: durationSeconds,
                keyPrefix: 'sqp_rl',
            });

            logger.warn('Initialized in-memory rate limiter (Redis not configured)');
        }
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to initialize Redis rate limiter; falling back to memory store');
        rateLimiter = new RateLimiterMemory({
            points,
            duration: durationSeconds,
            keyPrefix: 'sqp_rl',
        });
    }

    return rateLimiter;
}

function setRateLimitHeaders(res, rateLimiterRes) {
    if (!rateLimiterRes) return;

    res.setHeader('X-RateLimit-Limit', points);

    if (typeof rateLimiterRes.remainingPoints === 'number') {
        res.setHeader('X-RateLimit-Remaining', Math.max(0, rateLimiterRes.remainingPoints));
    }

    if (typeof rateLimiterRes.msBeforeNext === 'number') {
        const resetDate = new Date(Date.now() + rateLimiterRes.msBeforeNext).toISOString();
        res.setHeader('X-RateLimit-Reset', resetDate);
    }
}

function getClientKey(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.ip || req.connection?.remoteAddress || 'unknown';
}

async function consumeRateLimit(key) {
    const limiter = initRateLimiter();
    return limiter.consume(key);
}

function rateLimitMiddleware(req, res, next) {
    const key = getClientKey(req);

    consumeRateLimit(key)
        .then((rateLimiterRes) => {
            setRateLimitHeaders(res, rateLimiterRes);
            next();
        })
        .catch((rejRes) => {
            setRateLimitHeaders(res, rejRes);
            const retryAfterSeconds = Math.round((rejRes.msBeforeNext || 1000) / 1000) || 1;
            res.setHeader('Retry-After', retryAfterSeconds);
            res.status(429).json({
                success: false,
                message: 'Too many requests, please try again later.',
            });
        });
}

async function shutdownRateLimiter() {
    if (redisClient) {
        try {
            await redisClient.quit();
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to close Redis client');
        }
    }
}

module.exports = {
    rateLimitMiddleware,
    shutdownRateLimiter,
};


