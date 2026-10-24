# Node 22.23.4 includes the Node2Shell remediation. Keep both stages pinned to
# this exact supported release so a future tag update cannot silently change the
# runtime that is built and deployed.
# Stage 1: Build client PWA
FROM node:22.23.4-bookworm-slim AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Run server
FROM node:22.23.4-bookworm-slim
WORKDIR /app
COPY server/package*.json ./server/
# better-sqlite3 currently has no Node 22.23.4 ARM64 prebuild, so node-gyp
# compiles it during npm ci. Remove the toolchain before this layer completes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && cd server && npm_config_python=/usr/bin/python3 npm ci --omit=dev \
 && apt-get purge -y --auto-remove python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY server/ ./server/
COPY client/src ./client/src
COPY --from=client-builder /app/client/dist ./server/public

ENV PORT=3000
ENV NODE_ENV=production
ENV DB_PATH=/data/app.db

EXPOSE 3000
CMD ["node", "server/server.js"]
