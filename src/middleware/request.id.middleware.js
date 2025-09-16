const crypto = require('crypto');

module.exports = function requestIdMiddleware(req, res, next) {
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
};


