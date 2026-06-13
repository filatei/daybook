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

# ── 3. Install / refresh Apache vhost ─────────────────────────────────────────
if [ -f "${VHOST_SRC}" ]; then
  if ! diff -q "${VHOST_SRC}" "${VHOST_DST}" >/dev/null 2>&1; then
    log "Updating Apache vhost…"
    sudo -n cp "${VHOST_SRC}" "${VHOST_DST}" || log "WARN: couldn't copy vhost (run server-setup.sh?)"
    sudo -n a2ensite daybook >/dev/null 2>&1 || true
    sudo -n apache2ctl -t && sudo -n systemctl reload apache2 || log "WARN: apache reload failed"
  fi
fi

# ── 4. Prune dangling images ──────────────────────────────────────────────────
docker image prune -f --filter "until=24h" >/dev/null 2>&1 || true

# ── 5. Health check ───────────────────────────────────────────────────────────
sleep 3
for i in $(seq 1 10); do
  if curl -fsS "http://127.0.0.1:8090/healthz" >/dev/null 2>&1; then ok "daybook healthy"; exit 0; fi
  sleep 2
done
die "daybook did not become healthy — check: docker logs daybook"
