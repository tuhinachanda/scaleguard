const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'scaleguard-default-dev-secret-key-12345';

/**
 * Helper to generate a signed JWT token for development and testing
 * @param {Object} payload Claims to include in the token
 * @param {string} [expiresIn='1h'] Token expiration period
 * @returns {string} Signed JWT token
 */
function generateToken(payload = {}, expiresIn = '1h') {
  const defaultPayload = {
    userId: payload.userId || 'user_scaleguard_01',
    role: payload.role || 'engineer',
    permissions: payload.permissions || ['service:read', 'service:write'],
    ...payload
  };

  return jwt.sign(defaultPayload, JWT_SECRET, { expiresIn });
}

/**
 * Authentication middleware that verifies JWT tokens from Authorization header
 * and injects extracted identity claims (X-User-Id, X-User-Role) into request headers.
 */
function authMiddleware(req, res, next) {
  // 1. Extract the Authorization header from the incoming request
  const authHeader = req.headers['authorization'];

  // 2. Validate header presence and Bearer scheme format
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      status: 'error',
      code: 401,
      message: 'Unauthorized: Missing or malformed Authorization header. Expected format: Bearer <token>'
    });
  }

  // 3. Extract the token string after the 'Bearer ' prefix
  const token = authHeader.split(' ')[1];
  if (!token || token.trim() === '') {
    return res.status(401).json({
      status: 'error',
      code: 401,
      message: 'Unauthorized: Bearer token is empty'
    });
  }

  // 4. Verify token cryptographic signature and expiration against JWT_SECRET
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      const isExpired = err.name === 'TokenExpiredError';
      return res.status(401).json({
        status: 'error',
        code: 401,
        message: isExpired
          ? 'Unauthorized: Token has expired'
          : 'Unauthorized: Invalid token signature or format',
        error: err.name
      });
    }

    // 5. Extract user claims from decoded payload
    const userId = String(decoded.userId || decoded.sub || 'anonymous');
    const role = String(decoded.role || 'user');

    // 6. Header injection: inject verified claims into request headers for downstream microservices
    req.headers['x-user-id'] = userId;
    req.headers['x-user-role'] = role;

    // 7. Attach decoded payload to req.user for downstream middleware
    req.user = decoded;

    // 8. Forward request to next middleware or route handler
    next();
  });
}

module.exports = {
  authMiddleware,
  generateToken,
  JWT_SECRET
};
