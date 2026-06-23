# Stage 1: Build client PWA
FROM node:20 AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
# app.config.json lives at the repo root but is imported by src/main.js via
# ../../app.config.json (resolves to /app/app.config.json from WORKDIR).
COPY app.config.json /app/app.config.json
RUN npm run build

# Stage 2: Run server
FROM node:20
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

COPY server/ ./server/
# app.config.json lives at the repo root but is required by server.js via
# ../app.config.json (resolves to /app/app.config.json from /app/server).
COPY app.config.json /app/app.config.json
COPY --from=client-builder /app/client/dist ./server/public

ENV PORT=3000
ENV NODE_ENV=production
ENV DB_PATH=/data/psycle.db

EXPOSE 3000
CMD ["node", "server/server.js"]
