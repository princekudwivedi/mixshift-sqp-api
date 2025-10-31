# Security Implementation Guide

## Overview
This document outlines the security measures implemented in the SQP API to address identified vulnerabilities.

---

## 🔒 Security Issues Fixed

### 1. **Insufficient Logging Security** ✅ FIXED
**Issue**: Logs may contain sensitive data like access tokens, passwords, and API keys.

**Risk Level**: LOW-MEDIUM - Potential data leakage in logs

**Solution Implemented**:
- Created `security.utils.js` with automatic log sanitization
- Sensitive fields automatically redacted: `accessToken`, `password`, `secret`, `apiKey`, etc.
- Partial masking for identifiable data: `email`, `phone`, `amazonSellerID`
- Safe logger wrapper function `safeLog()`

**Files Changed**:
- ✅ `src/utils/security.utils.js` (NEW)
- ✅ `src/middleware/response.handlers.js`
- ✅ `src/controllers/cron/asin-sync.controller.js`

**Example**:
```javascript
// Before (INSECURE):
logger.info({ amazonSellerID, accessToken }, 'Token validated');

// After (SECURE):
logger.info(sanitizeForLogging({ amazonSellerID, accessToken }), 'Token validated');
// Logs: { amazonSellerID: "A1***40", accessToken: "[REDACTED]" }
```

---

### 2. **Missing Input Validation on Route Parameters** ✅ FIXED
**Issue**: Direct use of `req.params` without validation could lead to injection attacks.

**Risk Level**: MEDIUM - Could lead to SQL injection or XSS attacks

**Solution Implemented**:
- Added `validateSellerID()` function with regex pattern validation
- Amazon Seller ID pattern: `A[0-9A-Z]{12,14}`
- XSS prevention through HTML tag stripping
- Input sanitization before processing

**Files Changed**:
- ✅ `src/utils/security.utils.js`
- ✅ `src/controllers/cron/asin-sync.controller.js`

**Example**:
```javascript
// Before (INSECURE):
const { amazonSellerID } = req.params;
// Direct use without validation

// After (SECURE):
const { amazonSellerID } = req.params;
const validation = validateSellerID(amazonSellerID);
if (!validation.valid) {
    return ErrorHandler.sendValidationError(res, [validation.error]);
}
```

---

### 3. **Information Disclosure in Error Responses** ✅ FIXED
**Issue**: Stack traces exposed in development mode leak sensitive file paths and application structure.

**Risk Level**: MEDIUM - Could leak sensitive information about system architecture

**Solution Implemented**:
- Stack traces NEVER sent to client by default
- Added `ENABLE_STACK_TRACES` env flag for explicit enablement
- File paths sanitized from stack traces
- Database error details completely hidden from client
- All errors sanitized through `sanitizeError()` function

**Files Changed**:
- ✅ `src/middleware/response.handlers.js`
- ✅ `src/utils/security.utils.js`

**Example**:
```javascript
// Before (INSECURE):
{
  error: "Something failed",
  stack: "Error: Something failed\n    at /home/user/app/src/controller.js:42:10\n..."
}

// After (SECURE - Production):
{
  error: "Something failed"
  // NO stack trace
}

// After (SECURE - Development with flag):
{
  error: "Something failed",
  stack: "Error: Something failed\n    at (controller.js:42:10)\n..."
  // Sanitized paths
}
```

---

### 4. **CORS Configuration Risk** ✅ FIXED
**Issue**: Wildcard (`*`) origins allowed in development, creating security risk if deployed incorrectly.

**Risk Level**: MEDIUM - Could allow unauthorized cross-origin requests

**Solution Implemented**:
- **Production**: NEVER allows wildcard - REQUIRED explicit origins or app fails to start
- **Development**: Uses configured origins or safe localhost defaults
- Dynamic origin checking function
- Proper credentials handling
- Logging of unauthorized CORS attempts

**Files Changed**:
- ✅ `src/server.js`
- ✅ `src/utils/security.utils.js`

**Example**:
```javascript
// Before (INSECURE):
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*', // WILDCARD FALLBACK
    credentials: true
}));

// After (SECURE):
const corsConfig = generateCorsConfig(process.env.ALLOWED_ORIGINS);
app.use(cors(corsConfig)); 
// In production: FAILS if ALLOWED_ORIGINS not set
// In development: Uses safe localhost defaults
```

---

## 🔧 Environment Variables Required

### Production (REQUIRED):
```env
NODE_ENV=production
ALLOWED_ORIGINS=https://yourdomain.com,https://app.yourdomain.com
```

### Development (OPTIONAL):
```env
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001
ENABLE_STACK_TRACES=true  # Only if you want stack traces
```

---

## 📋 Security Checklist

### Before Deployment:
- [ ] Set `NODE_ENV=production`
- [ ] Configure `ALLOWED_ORIGINS` with explicit domains
- [ ] Remove or set `ENABLE_STACK_TRACES=false`
- [ ] Verify no sensitive data in logs
- [ ] Test CORS with unauthorized origins
- [ ] Review all route parameter validations

### Regular Security Audits:
- [ ] Review logs for sensitive data leakage
- [ ] Audit new route handlers for input validation
- [ ] Check CORS configuration changes
- [ ] Verify error response sanitization
- [ ] Test injection attack vectors

---

## 🛡️ Security Utilities API

### `sanitizeForLogging(obj, deep = true)`
Removes or masks sensitive data from objects before logging.

**Usage**:
```javascript
const { sanitizeForLogging } = require('./utils/security.utils');

logger.info(sanitizeForLogging({ 
    user: 'john', 
    password: 'secret123',
    amazonSellerID: 'A1234567890ABC'
}));
// Logs: { user: 'john', password: '[REDACTED]', amazonSellerID: 'A1***BC' }
```

### `sanitizeError(error, includeStack = false)`
Sanitizes error objects for client responses.

**Usage**:
```javascript
const { sanitizeError } = require('./utils/security.utils');

const sanitized = sanitizeError(error, process.env.NODE_ENV !== 'production');
res.json({ error: sanitized });
```

### `validateSellerID(sellerID)`
Validates Amazon Seller ID format.

**Usage**:
```javascript
const { validateSellerID } = require('./utils/security.utils');

const validation = validateSellerID(req.params.amazonSellerID);
if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
}
```

### `generateCorsConfig(allowedOrigins)`
Generates secure CORS configuration.

**Usage**:
```javascript
const { generateCorsConfig } = require('./utils/security.utils');

const corsConfig = generateCorsConfig(process.env.ALLOWED_ORIGINS);
app.use(cors(corsConfig));
```

---

## 🚨 Security Incident Response

If you discover a security vulnerability:

1. **DO NOT** create a public GitHub issue
2. Contact the security team immediately
3. Document the vulnerability details
4. Follow responsible disclosure practices

---

## 📚 Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [Express Security Best Practices](https://expressjs.com/en/advanced/best-practice-security.html)

---

## 🔍 Testing Security

### Test Log Sanitization:
```bash
# Check logs for sensitive data
grep -r "accessToken" logs/
grep -r "password" logs/
# Should find NO plain text sensitive data
```

### Test CORS:
```bash
# Test unauthorized origin
curl -H "Origin: https://unauthorized-domain.com" \
     -H "Access-Control-Request-Method: POST" \
     -X OPTIONS http://localhost:3001/api/v1/main-cron

# Should return CORS error
```

### Test Input Validation:
```bash
# Test invalid Seller ID
curl http://localhost:3001/api/v1/cron/asin/syncSellerAsins/1/INVALID-ID

# Should return 400 validation error
```

### Test Error Responses:
```bash
# Trigger an error and check response
# Should NOT include stack traces in production
```

---

## ✅ Security Compliance

This implementation addresses:
- ✅ OWASP A01:2021 - Broken Access Control
- ✅ OWASP A03:2021 - Injection
- ✅ OWASP A05:2021 - Security Misconfiguration
- ✅ OWASP A09:2021 - Security Logging and Monitoring Failures

---

**Last Updated**: October 29, 2025
**Version**: 1.0.0

