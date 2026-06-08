/**
 * Auth Middleware — JWT verification
 * Attaches req.user = { id, email, name } to every protected request
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production');
}

const SECRET = JWT_SECRET || 'dev-secret-change-in-production';

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, SECRET);
    req.user = { id: payload.sub, email: payload.email, name: payload.name };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired — please log in again' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name },
    SECRET,
    { expiresIn: '30d' }
  );
}

module.exports = { requireAuth, signToken };
