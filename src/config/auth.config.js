const { env } = require('./env.config');

/**
 * Authentication Configuration
 * JWT and security settings
 */
const authConfig = {
    // JWT Configuration
    secret: env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production',
    expiresIn: env.JWT_EXPIRES_IN || '24h',
    refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN || '7d',
    
    // Token types
    tokenTypes: {
        ACCESS: 'access',
        REFRESH: 'refresh',
        RESET_PASSWORD: 'reset_password',
        VERIFY_EMAIL: 'verify_email'
    },
    
    // Password configuration
    password: {
        minLength: 8,
        requireUppercase: true,
        requireLowercase: true,
        requireNumbers: true,
        requireSpecialChars: true,
        bcryptRounds: 12
    },
    
    // Rate limiting
    rateLimit: {
        windowMs: 15 * 60 * 1000, // 15 minutes
        maxAttempts: 5, // 5 attempts per window
        blockDuration: 30 * 60 * 1000 // 30 minutes block
    },
    
    // Session configuration
    session: {
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        secure: env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'strict'
    },
    
    // CORS configuration
    cors: {
        origin: env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000'],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
    },
    
    // Security headers
    security: {
        helmet: {
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    scriptSrc: ["'self'"],
                    imgSrc: ["'self'", "data:", "https:"]
                }
            }
        }
    }
};

module.exports = authConfig;
