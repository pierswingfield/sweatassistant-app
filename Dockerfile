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
RUN cd server && npm ci --omit=dev

COPY server/ ./server/
COPY client/src ./client/src
COPY --from=client-builder /app/client/dist ./server/public

ENV PORT=3000
ENV NODE_ENV=production
ENV DB_PATH=/data/app.db

EXPOSE 3000
CMD ["node", "server/server.js"]
