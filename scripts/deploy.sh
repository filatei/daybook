#!/usr/bin/env bash
# /opt/daybook/backend/scripts/deploy.sh
# Pull the latest image, (re)install the Apache vhost, restart the container.
# Safe to run by user1 or via the GitHub Actions SSH step.
set -euo pipefail

BACKEND=/opt/daybook/backend
DOMAIN=daybook.torama.money
VHOST_SRC="${BACKEND}/infra/apache/${DOMAIN}.conf"
VHOST_DST="/etc/apache2/sites-available/daybook.conf"

log() { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

cd "${BACKEND}" || die "missing ${BACKEND}"
[ -f .env ] || die "missing ${BACKEND}/.env (copy .env.example and fill JWT_SECRET)"

# ── 1. Pull newest image (CI pushes to GHCR) ──────────────────────────────────
log "Pulling latest image…"
docker compose pull --quiet || log "pull skipped (building locally?)"

# ── 2. Restart container ──────────────────────────────────────────────────────
log "Starting daybook…"
docker compose up -d --force-recreate --remove-orphans

# Host port chosen by remote-install.sh and pinned in .env (default 8091).
HOST_PORT="$(grep -E '^DAYBOOK_HOST_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2-)"
HOST_PORT="${HOST_PORT:-8091}"

# ── 3. Install / refresh Apache vhost (substitute the real proxy port) ────────
if [ -f "${VHOST_SRC}" ]; then
  TMP_VHOST="$(mktemp)"; sed "s#127\.0\.0\.1:8091#127.0.0.1:${HOST_PORT}#g" "${VHOST_SRC}" > "${TMP_VHOST}"
  if ! diff -q "${TMP_VHOST}" "${VHOST_DST}" >/dev/null 2>&1; then
    log "Updating Apache vhost (→ 127.0.0.1:${HOST_PORT})…"
    sudo -n cp "${TMP_VHOST}" "${VHOST_DST}" || log "WARN: couldn't copy vhost (run server-setup.sh?)"
    sudo -n a2ensite daybook >/dev/null 2>&1 || true
    sudo -n apache2ctl -t && sudo -n systemctl reload apache2 || log "WARN: apache reload failed"
  fi
  rm -f "${TMP_VHOST}"
fi

# ── 4. Prune dangling images ──────────────────────────────────────────────────
docker image prune -f --filter "until=24h" >/dev/null 2>&1 || true

# ── 5. Health check ───────────────────────────────────────────────────────────
sleep 3
for i in $(seq 1 10); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/healthz" >/dev/null 2>&1; then ok "daybook healthy"; exit 0; fi
  sleep 2
done
die "daybook did not become healthy — check: docker logs daybook"
