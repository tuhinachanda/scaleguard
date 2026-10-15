FROM node:20-alpine

WORKDIR /app

# Copy dependency specifications
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Expose gateway port
EXPOSE 3000

# Start ScaleGuard API Gateway
CMD ["node", "server.js"]
