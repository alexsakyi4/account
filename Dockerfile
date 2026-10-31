# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# LedgerLine — single-image build that serves the API and the built web app.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
ENV npm_config_update_notifier=false
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json vite.config.ts ./
COPY server ./server
COPY web ./web
COPY shared ./shared
COPY scripts ./scripts
COPY docs ./docs
RUN npm run build:web && npm run build:api

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    UPLOAD_DIR=/data/uploads \
    DATABASE_URL=sqlite:/data/ledgerline.db
RUN addgroup -S ledgerline && adduser -S -G ledgerline ledgerline \
  && mkdir -p /data/uploads && chown -R ledgerline:ledgerline /data
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/docs ./docs
COPY package.json ./
COPY db ./db
COPY server/src/db ./server/src/db
USER ledgerline
EXPOSE 4000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/v1/health || exit 1
CMD ["node", "dist/server.js"]
