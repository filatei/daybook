#!/usr/bin/env bash
# remote-install.sh — runs ON the server (as a sudo-capable user, e.g. user1).
# Idempotent first-time provisioning + (re)deploy of Daybook. Mirrors otuburu:
# /opt/daybook owned by the no-login daybookuser, Apache reverse-proxy + TLS,
# the app in its own container. Safe to re-run.
#
# Driven by scripts/bootstrap.sh from your Mac, or run directly after rsyncing
# the repo to /tmp/daybook-src:
#   sudo bash /tmp/daybook-src/scripts/remote-install.sh
set -euo pipefail

DOMAIN="${DAYBOOK_DOMAIN:-daybook.torama.money}"
EMAIL="${CERTBOT_EMAIL:-filatei@gtsng.com}"
SRC="${DAYBOOK_SRC:-/tmp/daybook-src}"
OPT=/opt/daybook
BACKEND="${OPT}/backend"
GOOGLE_CLIENT_ID_DEFAULT="763064592541-afo8b3po66bmo04q9ecselk9prske4l0.apps.googleusercontent.com"
SUPERADMINS_DEFAULT="filatei@gmail.com,filatei@torama.money"

log() { printf '\033[1;36m[daybook]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[daybook]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[daybook]\033[0m %s\n' "$*" >&2; exit 1; }
[[ $EUID -ne 0 ]] && die "Run with sudo: sudo bash $0"
[[ -d "$SRC" ]] || die "source not found at $SRC (run bootstrap.sh from your Mac, or rsync the repo there)"

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
log "Checking prerequisites…"
command -v docker >/dev/null  || die "docker not installed (otuburu uses it — install docker.io + compose plugin)"
docker compose version >/dev/null 2>&1 || die "docker compose v2 plugin missing"
if ! command -v certbot >/dev/null; then
  log "Installing certbot…"; apt-get update -qq && apt-get install -y -qq certbot python3-certbot-apache
fi
a2enmod ssl rewrite headers proxy proxy_http >/dev/null 2>&1 || true

# ── 2. Copy source into /opt/daybook/backend ──────────────────────────────────
log "Staging source into ${BACKEND}…"
mkdir -p "${BACKEND}"
rsync -a --delete \
  --exclude node_modules --exclude data --exclude .git --exclude '.env' \
  "${SRC}/" "${BACKEND}/"

# ── 3. Provision user, dirs, sudoers, systemd, wrappers ───────────────────────
log "Running server-setup.sh…"
bash "${BACKEND}/scripts/server-setup.sh"

# ── 4. .env (written once; preserves JWT_SECRET across redeploys) ──────────────
ENV_FILE="${BACKEND}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  log "Writing ${ENV_FILE} (first time)…"
  JWT="$(openssl rand -hex 32)"
  cat > "${ENV_FILE}" <<EOF
PORT=8090
NODE_ENV=production
PUBLIC_URL=https://${DOMAIN}
JWT_SECRET=${JWT}
GOOGLE_CLIENT_ID=${DAYBOOK_GOOGLE_CLIENT_ID:-${GOOGLE_CLIENT_ID_DEFAULT}}
SUPERADMIN_EMAILS=${DAYBOOK_SUPERADMIN_EMAILS:-${SUPERADMINS_DEFAULT}}
DAYBOOK_DB_PATH=/data/daybook.db
UPLOAD_DIR=/data/uploads
MAX_UPLOAD_MB=25
DAYBOOK_ALLOW_DEV_LOGIN=0
AI_API_KEY=${DAYBOOK_AI_API_KEY:-}
AI_API_URL=${DAYBOOK_AI_API_URL:-https://api.anthropic.com/v1/messages}
AI_MODEL=${DAYBOOK_AI_MODEL:-claude-haiku-4-5-20251001}
SMTP_HOST=smtp-relay.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_FROM=Daybook <noreply@torama.money>
DEFAULT_REPORT_RECIPIENTS=dailyreports@gtsng.com
EOF
  ok ".env created (JWT secret generated)"
else
  log ".env already exists — keeping it"
fi
chown daybookuser:daybookuser "${ENV_FILE}" 2>/dev/null || true
chmod 640 "${ENV_FILE}"

# ── 4b. Pick a stable, FREE loopback host port (persisted in .env) ────────────
# Auto-select the first free port so we never collide with otuburu/vote/etc.
# Once chosen it's pinned in .env so Apache + clients keep hitting the same one.
port_busy() { ss -ltn 2>/dev/null | grep -q "127.0.0.1:$1 " || ss -ltn 2>/dev/null | grep -q "0.0.0.0:$1 " || ss -ltn 2>/dev/null | grep -q "\*:$1 "; }
HOST_PORT="$(grep -E '^DAYBOOK_HOST_PORT=' "${ENV_FILE}" 2>/dev/null | head -1 | cut -d= -f2- || true)"
# If a previously-pinned port is now taken by a NON-daybook process, drop it.
if [[ -n "${HOST_PORT}" ]]; then
  docker rm -f daybook >/dev/null 2>&1 || true   # free our own old mapping first
  if port_busy "${HOST_PORT}"; then log "pinned port ${HOST_PORT} is occupied — choosing another"; HOST_PORT=""; fi
fi
if [[ -z "${HOST_PORT}" ]]; then
  for p in 8091 8092 8093 8094 8095 8096 8097 8098 8099 8190 8191 8192 8193 8194 8195; do
    if ! port_busy "$p"; then HOST_PORT="$p"; break; fi
  done
  [[ -n "${HOST_PORT}" ]] || die "no free loopback port found in 8091-8195 — free one and re-run"
  # write/replace the pin in .env
  sed -i '/^DAYBOOK_HOST_PORT=/d' "${ENV_FILE}"
  echo "DAYBOOK_HOST_PORT=${HOST_PORT}" >> "${ENV_FILE}"
  chown daybookuser:daybookuser "${ENV_FILE}" 2>/dev/null || true
  ok "Using free host port ${HOST_PORT}"
else
  log "Using pinned host port ${HOST_PORT}"
fi
export DAYBOOK_HOST_PORT="${HOST_PORT}"

# ── 4c. Backfill any newer keys into an existing .env (preserves your values) ──
ensure_env() { grep -qE "^$1=" "${ENV_FILE}" 2>/dev/null || echo "$1=$2" >> "${ENV_FILE}"; }
ensure_env AI_API_KEY "${DAYBOOK_AI_API_KEY:-}"
ensure_env AI_API_URL "https://api.anthropic.com/v1/messages"
ensure_env AI_MODEL "claude-haiku-4-5-20251001"
chown daybookuser:daybookuser "${ENV_FILE}" 2>/dev/null || true

# ── 5. TLS — temporary HTTP vhost → certbot → managed vhost ───────────────────
LE_DIR="/etc/letsencrypt/live/${DOMAIN}"
if [[ ! -d "${LE_DIR}" ]]; then
  log "Issuing Let's Encrypt certificate for ${DOMAIN}…"
  mkdir -p /var/www/daybook
  cat > /etc/apache2/sites-available/daybook-http.conf <<EOF
<VirtualHost *:80>
    ServerName ${DOMAIN}
    DocumentRoot /var/www/daybook
    <Directory /var/www/daybook>
        Require all granted
        Options -Indexes
    </Directory>
</VirtualHost>
EOF
  a2ensite daybook-http.conf >/dev/null
  apache2ctl configtest && systemctl reload apache2
  certbot certonly --apache -d "${DOMAIN}" --non-interactive --agree-tos -m "${EMAIL}" \
    || die "certbot failed — check DNS (${DOMAIN} must resolve to this server) and port 80"
  a2dissite daybook-http.conf >/dev/null || true
  ok "Certificate issued"
else
  log "Certificate already present — skipping issuance"
fi

# ── 6. Install managed Apache vhost (proxy target = chosen HOST_PORT) ─────────
log "Installing Apache vhost (→ 127.0.0.1:${HOST_PORT})…"
a2enmod ssl proxy proxy_http headers rewrite >/dev/null 2>&1 || true
cp "${BACKEND}/infra/apache/${DOMAIN}.conf" /etc/apache2/sites-available/daybook.conf
# The committed vhost uses 8091 as a placeholder; point it at the real port.
sed -i "s#127\.0\.0\.1:8091#127.0.0.1:${HOST_PORT}#g" /etc/apache2/sites-available/daybook.conf
a2ensite daybook.conf >/dev/null
# Drop certbot's auto-generated shadow vhost if it ever appears — it can win the
# ServerName match and shadow our managed config (lesson from otuburu).
a2dissite "${DOMAIN}-le-ssl.conf" >/dev/null 2>&1 || true
a2dissite daybook-http.conf >/dev/null 2>&1 || true
apache2ctl configtest || die "apache config test failed"
systemctl reload apache2
# Confirm our vhost actually owns daybook.torama.money on :443.
if apache2ctl -S 2>/dev/null | grep -q "${DOMAIN}"; then
  ok "Apache vhost active for ${DOMAIN}"
else
  log "WARN: ${DOMAIN} not shown in 'apache2ctl -S' — another vhost may be shadowing it"
fi

# ── 7. Build image + start container ──────────────────────────────────────────
cd "${BACKEND}"
# Clear any stale daybook container from an interrupted prior run (frees its port).
if docker ps -aq -f name='^daybook$' | grep -q .; then
  log "Removing stale daybook container…"; docker rm -f daybook >/dev/null 2>&1 || true
fi
# Remove a stale 'daybook' network left mislabeled by an earlier (project=backend)
# run so compose can recreate it cleanly under this project.
if docker network inspect daybook >/dev/null 2>&1; then
  if [ -z "$(docker network inspect daybook -f '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null)" ]; then
    docker network rm daybook >/dev/null 2>&1 || true
  fi
fi
# Final guard: the chosen port must be free now.
if port_busy "${HOST_PORT}"; then
  die "127.0.0.1:${HOST_PORT} is in use. Find it: sudo ss -ltnp | grep ${HOST_PORT}"
fi
log "Building image + starting container on host port ${HOST_PORT}…"
docker compose up -d --build
systemctl enable daybook >/dev/null 2>&1 || true

# ── 8. Health check ───────────────────────────────────────────────────────────
log "Waiting for health…"
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/healthz" >/dev/null 2>&1; then
    ok "Container healthy on :${HOST_PORT}"; break
  fi
  [[ $i -eq 20 ]] && die "container did not become healthy — check: docker logs daybook"
  sleep 2
done
sleep 1
if curl -fsS "https://${DOMAIN}/healthz" >/dev/null 2>&1; then
  ok "LIVE → https://${DOMAIN}"
else
  log "Local health OK but public HTTPS check failed — verify DNS/Apache. Try: curl -i https://${DOMAIN}/healthz"
fi

cat <<DONE

──────────────────────────────────────────────────────────────
 Daybook is deployed.
   • Open https://${DOMAIN} and Sign in with Google as a superadmin
     (${DAYBOOK_SUPERADMIN_EMAILS:-${SUPERADMINS_DEFAULT}}).
   • One-time: add https://${DOMAIN} to the Google OAuth client's
     "Authorized JavaScript origins" (Google Cloud Console → Credentials).
   • Email: confirm THIS server's public IP is whitelisted in
     Google Admin → Apps → Gmail → Routing → SMTP relay.
 Manage:  daybook-status · daybook-logs · daybook-deploy
──────────────────────────────────────────────────────────────
DONE
