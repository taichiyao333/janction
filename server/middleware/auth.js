const jwt = require('jsonwebtoken');
const config = require('../config');

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, config.jwt.secret);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function adminOnly(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

function providerOrAdmin(req, res, next) {
    if (req.user.role !== 'admin' && req.user.role !== 'provider') {
        return res.status(403).json({ error: 'Provider or admin access required' });
    }
    next();
}

module.exports = { authMiddleware, adminOnly, providerOrAdmin };
