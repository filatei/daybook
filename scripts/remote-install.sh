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

# ── 6. Install managed Apache vhost ───────────────────────────────────────────
log "Installing Apache vhost…"
cp "${BACKEND}/infra/apache/${DOMAIN}.conf" /etc/apache2/sites-available/daybook.conf
a2ensite daybook.conf >/dev/null
apache2ctl configtest || die "apache config test failed"
systemctl reload apache2

# ── 7. Build image + start container ──────────────────────────────────────────
log "Building image + starting container…"
cd "${BACKEND}"
docker compose up -d --build
systemctl enable daybook >/dev/null 2>&1 || true

# ── 8. Health check ───────────────────────────────────────────────────────────
log "Waiting for health…"
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:8090/healthz" >/dev/null 2>&1; then
    ok "Container healthy on :8090"; break
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
