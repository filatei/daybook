# Two-stage build: stage 1 compiles the React PWA, stage 2 runs the API.
# pg is pure JS so no native compilation needed in stage 2.

# ── Stage 1: build the React frontend ────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm install
COPY frontend/ ./frontend/
COPY vite.config.js ./
RUN npm run build
# Output is in /build/frontend/dist

# ── Stage 2: production API server ───────────────────────────────────────────
FROM node:20-bookworm-slim
RUN mkdir -p /data/uploads && chown -R node:node /data
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --chown=node:node backend/ ./backend/
# Ship only the compiled frontend assets (not the React source)
COPY --chown=node:node --from=builder /build/frontend/dist ./frontend/dist/
COPY --chown=node:node package.json ./
RUN chmod -R u+rwX,go-w /app
USER node

ENV PORT=8090 \
    NODE_ENV=production \
    UPLOAD_DIR=/data/uploads

EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8090/healthz',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

ENTRYPOINT ["node", "backend/server.js"]
