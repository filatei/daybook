# pg is pure JS — no native compilation needed; single-stage build.
FROM node:20-bookworm-slim
# /data holds uploaded files (volume-mounted in production)
RUN mkdir -p /data/uploads && chown -R node:node /data
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --chown=node:node backend/ ./backend/
COPY --chown=node:node frontend/ ./frontend/
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
