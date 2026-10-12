# syntax=docker/dockerfile:1

# Production image of the Usage Metering and Quota Service.
#   build                    installs all dependencies and compiles TypeScript to dist/
#   production-dependencies  installs runtime dependencies only
#   runtime                  minimal final image: compiled code + runtime dependencies, non-root

ARG NODE_IMAGE=node:22.23.3-bookworm-slim

FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM base AS production-dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM base AS runtime
ENV NODE_ENV=production
# Application files stay owned by root and read-only for the unprivileged runtime user.
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
# Healthy = database reachable and migrations current (uses Node's built-in fetch; no extra tools).
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '8080') + '/health/ready').then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]
# Node runs as the main process and handles SIGTERM/SIGINT itself (graceful shutdown).
CMD ["node", "dist/main.js"]
