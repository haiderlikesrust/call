# syntax=docker/dockerfile:1
# One Node server: the site, the API and the payout worker. Dokploy runs it as a Swarm service and updates
# it start-first, so the new version is already serving before the old one stops (docs/DOKPLOY.md).
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
COPY . .
RUN npm run typecheck && npm run build && mv web/dist/assets static-build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim AS app
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 TRUST_PROXY=true DB_PATH=/app/data/callout.db
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node deploy ./deploy
COPY --from=build --chown=node:node /app/web/dist ./web/dist
COPY --from=build --chown=node:node /app/static-build ./static-build
# data: the ledger, on a volume. web/dist/assets: filled at start, on a volume that keeps earlier builds' files.
RUN mkdir -p data web/dist/assets && chown node:node data web/dist/assets
USER node
EXPOSE 3000
# Healthy includes "standby": during an update the new server serves the site while it waits for the worker.
HEALTHCHECK --interval=5s --timeout=3s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["sh", "deploy/start.sh"]
