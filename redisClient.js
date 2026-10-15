const Redis = require('ioredis');

// Configure Redis connection with environment variables and local defaults
const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  // Disables command queuing when disconnected so requests fail-fast to fallback
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 2000,
  retryStrategy(times) {
    // Reconnect backoff strategy with a maximum interval of 10 seconds
    const delay = Math.min(times * 1000, 10000);
    return delay;
  }
};

const redis = new Redis(redisConfig);

let redisReady = false;

redis.on('connect', () => {
  console.log(`[Redis] Connecting to ${redisConfig.host}:${redisConfig.port}...`);
});

redis.on('ready', () => {
  redisReady = true;
  console.log('[Redis] Connected and ready to process commands');
});

redis.on('close', () => {
  redisReady = false;
});

redis.on('reconnecting', () => {
  redisReady = false;
});

// Attach error handler to prevent unhandled error event exceptions if Redis is down
redis.on('error', (err) => {
  redisReady = false;
  // Gracefully log connection issues without terminating the process
  console.warn(`[Redis Notice] Redis is not reachable (${err.code || err.message}). Using in-memory fallback.`);
});

/**
 * Returns whether Redis is connected and ready for traffic
 * @returns {boolean}
 */
function isRedisAvailable() {
  return redisReady && redis.status === 'ready';
}

module.exports = {
  redis,
  isRedisAvailable
};
