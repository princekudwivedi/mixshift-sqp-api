const { ErrorHandler } = require('./response.handlers');

function requireRole(allowedRoles = []) {
    return (req, res, next) => {
        try {
            const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
            if (allowedRoles.length === 0) return next();
            if (roles.some(r => allowedRoles.includes(r))) return next();
            return ErrorHandler.sendAuthzError(res, 'Insufficient permissions');
        } catch (e) {
            return ErrorHandler.sendAuthzError(res, 'Permission validation failed');
        }
    };
}

module.exports = { requireRole };


