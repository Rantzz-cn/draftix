# Dockerfile for DRAFTIX
# Multi-stage build: small final image, no dev tooling, runs as a non-root user.

# ─── Stage 1: install deps with a clean lockfile ─────────
FROM node:22-alpine AS deps
WORKDIR /app
# Only the manifest first → caches the npm install layer across code changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ─── Stage 2: runtime image ───────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Bring in production node_modules
COPY --from=deps /app/node_modules ./node_modules
# Application code
COPY package.json server.js ./
COPY public ./public

# Persistent data directory (codes.log lives here). Compose mounts a volume
# onto this path so codes survive container restarts.
RUN mkdir -p /app/data && \
    addgroup -S draftix && adduser -S draftix -G draftix && \
    chown -R draftix:draftix /app

USER draftix

# Healthcheck hits the JSON endpoint so Docker / orchestrators can restart
# the container if it goes unresponsive.
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD wget -q --spider --tries=1 http://127.0.0.1:3000/healthz || exit 1

EXPOSE 3000
CMD ["node", "server.js"]
