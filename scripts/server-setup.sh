#!/usr/bin/env bash
# server-setup.sh — run ONCE as a sudo-capable user (user1) to provision the
# server so subsequent deploys need no interactive sudo. Mirrors otuburu.
#
# Usage:  sudo bash /opt/daybook/backend/scripts/server-setup.sh
# After:  daybook-deploy, daybook-logs, daybook-status work without sudo.
set -euo pipefail

OPT=/opt/daybook
BIN=/usr/local/bin
DOMAIN=daybook.torama.money

log() { printf '\033[1;36m[setup]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[setup]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[setup]\033[0m %s\n' "$*" >&2; exit 1; }
[[ $EUID -ne 0 ]] && die "Run with sudo: sudo bash $0"

# ── 1. Service account (no login shell, never logs in) ────────────────────────
if ! id daybookuser &>/dev/null; then
  log "Creating daybookuser (system account, no login)…"
  useradd -r -s /usr/sbin/nologin -d "${OPT}" daybookuser
fi

# ── 2. Let user1 read/write the deploy tree + run docker ──────────────────────
log "Adding user1 to daybookuser + docker groups…"
usermod -aG daybookuser user1
usermod -aG docker user1 || true
usermod -aG docker daybookuser || true

# ── 3. /opt/daybook ownership + perms (group-writable for user1) ───────────
log "Creating ${OPT} layout…"
mkdir -p "${OPT}/backend/infra/apache" "${OPT}/backend/scripts" "${OPT}/frontend"
chown -R daybookuser:daybookuser "${OPT}"
chmod -R g+rwX "${OPT}"

# ── 4. Sudoers — passwordless for just the Apache ops the deploy needs ─────────
log "Installing sudoers entries…"
cat > /etc/sudoers.d/daybook-ops <<'EOF'
user1   ALL=(ALL) NOPASSWD: /bin/systemctl reload apache2
user1   ALL=(ALL) NOPASSWD: /bin/systemctl status apache2
user1   ALL=(ALL) NOPASSWD: /usr/sbin/apache2ctl -t
user1   ALL=(ALL) NOPASSWD: /bin/cp /opt/daybook/backend/infra/apache/daybook.torama.money.conf /etc/apache2/sites-available/daybook.conf
user1   ALL=(ALL) NOPASSWD: /usr/sbin/a2enmod *
user1   ALL=(ALL) NOPASSWD: /usr/sbin/a2ensite *
user1   ALL=(ALL) NOPASSWD: /bin/systemctl restart daybook
user1   ALL=(ALL) NOPASSWD: /bin/systemctl status daybook
EOF
chmod 440 /etc/sudoers.d/daybook-ops

# ── 5. Enable required Apache modules + vhost ─────────────────────────────────
log "Enabling Apache modules…"
a2enmod proxy proxy_http headers rewrite ssl >/dev/null 2>&1 || true

# ── 6. systemd unit ───────────────────────────────────────────────────────────
if [ -f "${OPT}/backend/infra/systemd/daybook.service" ]; then
  log "Installing systemd unit…"
  cp "${OPT}/backend/infra/systemd/daybook.service" /etc/systemd/system/daybook.service
  systemctl daemon-reload
  systemctl enable daybook >/dev/null 2>&1 || true
fi

# ── 7. Wrapper commands ───────────────────────────────────────────────────────
log "Installing wrapper commands…"
cat > "${BIN}/daybook-deploy" <<'SCRIPT'
#!/usr/bin/env bash
exec bash /opt/daybook/backend/scripts/deploy.sh "$@"
SCRIPT
cat > "${BIN}/daybook-logs" <<'SCRIPT'
#!/usr/bin/env bash
exec docker logs -f --tail "${1:-200}" daybook
SCRIPT
cat > "${BIN}/daybook-status" <<'SCRIPT'
#!/usr/bin/env bash
echo "── Daybook ────────────────────────────────"
docker ps --filter name=daybook --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo
curl -fsS https://daybook.torama.money/healthz && echo " ✓ public health OK" || echo " ✗ public health FAILED"
SCRIPT
chmod +x "${BIN}/daybook-deploy" "${BIN}/daybook-logs" "${BIN}/daybook-status"

ok "Done. Next:"
echo "   1. Point DNS A record ${DOMAIN} → this server"
echo "   2. sudo certbot --apache -d ${DOMAIN}      # issue Let's Encrypt cert"
echo "   3. daybook-deploy                        # build/pull + start"
