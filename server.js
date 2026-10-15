require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { createRateLimiter } = require('./rateLimiter');
const { authMiddleware, generateToken } = require('./authMiddleware');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize rate limiter (e.g. 10 burst capacity, 2 tokens refilled per second)
const proxyLimiter = createRateLimiter({
  capacity: parseInt(process.env.RATE_LIMIT_CAPACITY || '10', 10),
  refillRate: parseFloat(process.env.RATE_LIMIT_REFILL_RATE || '2')
});

// Enable Cross-Origin Resource Sharing (CORS) and JSON request parsing
app.use(cors());
app.use(express.json());

// Health check endpoint (unlimited to ensure monitoring availability)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Helper route to issue a test JWT token (/api/v1/auth/token)
// Accepts optional userId and role via query params or request body
app.all('/api/v1/auth/token', (req, res) => {
  const userId = req.body?.userId || req.query?.userId || 'user_scaleguard_01';
  const role = req.body?.role || req.query?.role || 'engineer';
  const expiresIn = req.body?.expiresIn || req.query?.expiresIn || '1h';

  const token = generateToken({ userId, role }, expiresIn);

  res.status(200).json({
    status: 'success',
    token,
    tokenType: 'Bearer',
    expiresIn,
    user: {
      userId,
      role
    }
  });
});

// Mock downstream service proxy route (/api/v1/service/*)
// Protected by JWT authentication and Token Bucket rate limiting
// In Express 5, wildcard routes require a parameter name (e.g., *splat)
app.all(['/api/v1/service', '/api/v1/service/*splat'], authMiddleware, proxyLimiter, (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Mock downstream service response',
    timestamp: new Date().toISOString(),
    path: req.originalUrl,
    injectedHeaders: {
      'x-user-id': req.headers['x-user-id'],
      'x-user-role': req.headers['x-user-role']
    },
    authenticatedUser: req.user
  });
});

// Start the gateway server
app.listen(PORT, () => {
  console.log(`ScaleGuard API Gateway running on port ${PORT}`);
});
