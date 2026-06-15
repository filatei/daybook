#!/usr/bin/env bash
# Daybook — one-command reconciliation (Fido Mongo ↔ Daybook Postgres).
#
# Compares row counts per collection and total ₦ per site for orders, so you can
# confirm Daybook matches Fido to the kobo before cutover. Read-only (no writes).
#
# Usage (from /opt/daybook/backend):
#   scripts/reconcile.sh                       # full-history reconciliation
#   scripts/reconcile.sh --from 2026-06-01     # from a date
#   scripts/reconcile.sh --from 2026-06-15 --to 2026-06-15   # a single day
set -euo pipefail
cd "$(dirname "$0")/.."
exec docker compose run --rm --entrypoint node daybook backend/etl.js --verify "$@"
