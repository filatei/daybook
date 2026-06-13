# ── Stage 1: install + compile native deps (better-sqlite3 needs gcc) ─────────
FROM node:20-bookworm-slim AS builder
WORKDIR /build
COPY package.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm install --omit=dev \
 && apt-get purge -y python3 make g++ && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-bookworm-slim
# /data holds the SQLite DB + uploaded files (volume-mounted in production)
RUN mkdir -p /data/uploads && chown -R node:node /data
WORKDIR /app
COPY --from=builder /build/node_modules ./node_modules/
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY package.json ./
USER node

ENV PORT=8090 \
    NODE_ENV=production \
    DAYBOOK_DB_PATH=/data/daybook.db \
    UPLOAD_DIR=/data/uploads

EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8090/healthz',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

ENTRYPOINT ["node", "backend/server.js"]
