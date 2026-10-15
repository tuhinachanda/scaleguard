const { redis, isRedisAvailable } = require('./redisClient');

/**
 * Redis Lua script implementing the Token Bucket algorithm atomically.
 * Ensures concurrent requests across multiple gateway instances update state safely.
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

-- Retrieve current token balance and last refill time from Redis hash
local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local current_tokens = tonumber(data[1])
local last_refill = tonumber(data[2])

if current_tokens == nil or last_refill == nil then
  -- First access: initialize bucket to full capacity
  current_tokens = capacity
  last_refill = now
else
  -- Calculate tokens replenished based on elapsed time
  local elapsed_seconds = math.max(0, (now - last_refill) / 1000.0)
  current_tokens = math.min(capacity, current_tokens + (elapsed_seconds * refill_rate))
  last_refill = now
end

local allowed = 0
local remaining = current_tokens
local retry_after = 0

if current_tokens >= cost then
  allowed = 1
  current_tokens = current_tokens - cost
  remaining = current_tokens
else
  allowed = 0
  local needed = cost - current_tokens
  retry_after = math.ceil(needed / refill_rate)
end

-- Save updated token state atomically
redis.call('HSET', key, 'tokens', tostring(current_tokens), 'last_refill', tostring(last_refill))

-- Set dynamic TTL based on time required to refill bucket completely (minimum 60s)
local ttl = math.ceil(capacity / refill_rate) * 2
if ttl < 60 then
  ttl = 60
end
redis.call('EXPIRE', key, ttl)

return { allowed, tostring(remaining), retry_after }
`;

// Register custom command on ioredis client
redis.defineCommand('tokenBucketRateLimit', {
  numberOfKeys: 1,
  lua: TOKEN_BUCKET_LUA
});

// In-memory fallback map for when Redis is unavailable
const memoryBuckets = new Map();

/**
 * Fallback token bucket logic running in Node memory if Redis is offline
 */
function evaluateInMemory(key, capacity, refillRate, cost, now) {
  let bucket = memoryBuckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, lastRefill: now };
  } else {
    const elapsedSeconds = Math.max(0, (now - bucket.lastRefill) / 1000.0);
    bucket.tokens = Math.min(capacity, bucket.tokens + (elapsedSeconds * refillRate));
    bucket.lastRefill = now;
  }

  let allowed = 0;
  let remaining = bucket.tokens;
  let retryAfter = 0;

  if (bucket.tokens >= cost) {
    allowed = 1;
    bucket.tokens -= cost;
    remaining = bucket.tokens;
  } else {
    allowed = 0;
    const needed = cost - bucket.tokens;
    retryAfter = Math.ceil(needed / refillRate);
  }

  memoryBuckets.set(key, bucket);

  // Periodic pruning of stale in-memory buckets
  if (memoryBuckets.size > 2000) {
    for (const [k, v] of memoryBuckets.entries()) {
      if (now - v.lastRefill > 120000) {
        memoryBuckets.delete(k);
      }
    }
  }

  return [allowed, String(remaining), retryAfter];
}

/**
 * Factory creating rate-limiting middleware for Express
 * @param {Object} options
 * @param {number} [options.capacity=10] Maximum burst token capacity
 * @param {number} [options.refillRate=2] Tokens replenished per second
 * @param {number} [options.cost=1] Tokens consumed per request
 */
function createRateLimiter(options = {}) {
  const capacity = options.capacity || parseInt(process.env.RATE_LIMIT_CAPACITY || '10', 10);
  const refillRate = options.refillRate || parseFloat(process.env.RATE_LIMIT_REFILL_RATE || '2');
  const cost = options.cost || 1;

  return async function rateLimiterMiddleware(req, res, next) {
    // Identify client by verified User ID, API Key, or client IP address
    const clientId = req.headers['x-user-id'] || req.headers['x-api-key'] || req.ip || req.socket.remoteAddress || 'unknown';
    const key = `ratelimit:${clientId}`;
    const now = Date.now();

    let allowed = 0;
    let remaining = 0;
    let retryAfter = 0;

    try {
      if (isRedisAvailable()) {
        const result = await redis.tokenBucketRateLimit(key, capacity, refillRate, cost, now);
        allowed = Number(result[0]);
        remaining = parseFloat(result[1]);
        retryAfter = Number(result[2]);
      } else {
        const result = evaluateInMemory(key, capacity, refillRate, cost, now);
        allowed = Number(result[0]);
        remaining = parseFloat(result[1]);
        retryAfter = Number(result[2]);
      }
    } catch (err) {
      // In case of any unexpected Redis runtime error, gracefully fallback to in-memory
      console.warn(`[RateLimiter Warning] Redis execution failed (${err.message}), falling back to in-memory.`);
      const result = evaluateInMemory(key, capacity, refillRate, cost, now);
      allowed = Number(result[0]);
      remaining = parseFloat(result[1]);
      retryAfter = Number(result[2]);
    }

    // Set standard rate limit headers
    res.setHeader('X-RateLimit-Limit', capacity);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, Math.floor(remaining)));

    if (allowed === 1) {
      return next();
    }

    // Rate limit exceeded: return HTTP 429 Too Many Requests
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({
      status: 'error',
      code: 429,
      message: 'Too Many Requests: Rate limit exceeded',
      retryAfter,
      limit: capacity,
      remaining: 0
    });
  };
}

module.exports = {
  createRateLimiter,
  TOKEN_BUCKET_LUA
};
