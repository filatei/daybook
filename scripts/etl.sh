#!/usr/bin/env bash
# Daybook — Fido Mongo → Postgres ETL runner.
#
# Runs the ETL as a ONE-OFF container via `docker compose run`, NOT inside the
# live app container. Why: a deploy (`docker compose up`) recreates the app
# container, which would kill an ETL attached to it via `docker exec` mid-import.
# A one-off container is independent of the app's lifecycle, so long imports
# (the ~596k orders run) survive a redeploy.
#
# `docker compose run daybook` inherits the service's image, env_file (.env),
# the DATABASE_URL built from POSTGRES_* and the host.docker.internal mapping for
# the fido Mongo tunnel — so nothing needs to be passed by hand.
#
# Usage (from /opt/daybook/backend, where docker-compose.yml lives):
#   scripts/etl.sh --dry-run                  # counts only, no writes
#   scripts/etl.sh --collection staff
#   scripts/etl.sh --collection customers
#   scripts/etl.sh --collection expenses
#   scripts/etl.sh --collection payroll
#   scripts/etl.sh --collection orders        # ~596k rows, several minutes
#   scripts/etl.sh                            # full run: all collections, in order
#   scripts/etl.sh --verify                   # reconcile Mongo ↔ Postgres
set -euo pipefail
cd "$(dirname "$0")/.."   # → the dir containing docker-compose.yml (/opt/daybook/backend)

# The image ENTRYPOINT is `node backend/server.js`; override it so we run the ETL
# (otherwise the passed command is appended as ignored args and the SERVER starts).
exec docker compose run --rm --entrypoint node daybook backend/etl.js "$@"
