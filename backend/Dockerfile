# ═══════════════════════════════════════════════════════════════
# PP Exchange Backend - Production Dockerfile
# Multi-stage build for security and smaller image
# ═══════════════════════════════════════════════════════════════

# Stage 1: Dependencies (with build tools for better-sqlite3)
FROM node:20-alpine AS deps
WORKDIR /app

# Install build tools for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Install dependencies only (for layer caching)
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Stage 2: Production image
FROM node:20-alpine AS runner
WORKDIR /app

# Security: create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nodejs

# Install wget for healthcheck
RUN apk add --no-cache wget

# Copy dependencies from deps stage
COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules

# Copy source code
COPY --chown=nodejs:nodejs src ./src
COPY --chown=nodejs:nodejs package.json ./

# Create data directory for SQLite
RUN mkdir -p /app/data && chown nodejs:nodejs /app/data

# Environment
ENV NODE_ENV=production
ENV TZ=Europe/Kyiv
ENV LOCAL_DB_PATH=/app/data/pp-exchange.db

# Set non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start with proper signal handling
CMD ["node", "src/index.js"]
