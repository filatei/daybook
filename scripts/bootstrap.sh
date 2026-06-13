#!/usr/bin/env bash
# bootstrap.sh — run on your MAC. One command to provision + deploy Daybook on
# the server over your existing `ssh otuburu` connection (same box as otuburu).
#
#   bash scripts/bootstrap.sh
#
# It rsyncs this repo to the server and runs remote-install.sh there. Re-runnable
# — it preserves the server's .env (and JWT secret) on subsequent runs.
set -euo pipefail

SSH_ALIAS="${DAYBOOK_SSH:-otuburu}"     # your working SSH host alias for the box
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "▶ Deploying Daybook from ${REPO_DIR}"
echo "  via: ssh ${SSH_ALIAS}"
command -v rsync >/dev/null || { echo "rsync not found on your Mac"; exit 1; }

# 1. Sanity: can we reach the box?
ssh -o BatchMode=yes "${SSH_ALIAS}" 'echo ok' >/dev/null 2>&1 \
  || { echo "✗ Cannot 'ssh ${SSH_ALIAS}'. Fix that first (or set DAYBOOK_SSH=<alias>)."; exit 1; }

# 2. Sync source to /tmp/daybook-src on the server
echo "▶ Uploading source…"
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .git --exclude '.env' \
  "${REPO_DIR}/" "${SSH_ALIAS}:/tmp/daybook-src/"

# 3. Run the installer (asks for your sudo password once)
echo "▶ Running remote installer (you may be prompted for the server sudo password)…"
ssh -t "${SSH_ALIAS}" "sudo bash /tmp/daybook-src/scripts/remote-install.sh"

echo "✓ Done. Visit https://daybook.torama.money"
