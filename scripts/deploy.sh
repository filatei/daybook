#!/usr/bin/env bash
# /opt/daybook/backend/scripts/deploy.sh
# Pull the latest image and restart the app container. Ingress is Cloudflare →
# the daybook-caddy container (:2083) → app (:8090); Apache is NOT in the path.
# Safe to run by user1 or via the GitHub Actions SSH step.
set -euo pipefail

BACKEND=/opt/daybook/backend

log() { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

cd "${BACKEND}" || die "missing ${BACKEND}"
[ -f .env ] || die "missing ${BACKEND}/.env (copy .env.example and fill JWT_SECRET)"

# ── 1. Pull newest image (CI pushes to GHCR) ──────────────────────────────────
log "Pulling latest image…"
docker compose pull --quiet || log "pull skipped (building locally?)"

# ── 2. Restart the APP container only ─────────────────────────────────────────
# --no-deps + naming the service so Postgres is NOT recreated. Recreating the DB
# (the old `up --force-recreate` did) terminates every live connection — which
# kills any long-running job (e.g. a Mongo→Postgres ETL) mid-flight with
# "terminating connection due to administrator command". Postgres is restart:always
# so it stays up on its own; we only ever cycle the app on deploy.
log "Starting daybook (app only; Postgres left running)…"
docker compose up -d --no-deps --force-recreate daybook

# App host port (published for the local health check), pinned in .env (default 8091).
HOST_PORT="$(grep -E '^DAYBOOK_HOST_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- || true)"
HOST_PORT="${HOST_PORT:-8091}"

# ── 3. Prune dangling images ──────────────────────────────────────────────────
docker image prune -f --filter "until=24h" >/dev/null 2>&1 || true

# ── 4. Health check ───────────────────────────────────────────────────────────
sleep 3
for i in $(seq 1 10); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/healthz" >/dev/null 2>&1; then ok "daybook healthy"; exit 0; fi
  sleep 2
done
die "daybook did not become healthy — check: docker logs daybook"
