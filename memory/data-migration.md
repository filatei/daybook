# Data Migration — Fido Water (MongoDB → PostgreSQL)

## Source
- **Server:** fido.torama.ng
- **DB engine:** MongoDB
- **Old backend code:** `/Users/user1/projects/tor-pos-backend`
- **Old frontend code:** `/Users/user1/projects/fido.torama.ng`
- **Access:** SSH tunnel (read-only)

## Target
- **DB engine:** PostgreSQL (Daybook new system)
- **Tenant:** Fido Water — look up `tenant_id` on the server (UI also shows Workspace ID under the header switcher + Admin → Settings):
```
docker exec -it daybook-postgres psql -U daybook -d daybook -c "SELECT id, name, slug FROM tenants WHERE name ILIKE '%fido%';"
# or: cd /opt/daybook/backend && docker compose exec postgres psql -U daybook -d daybook -c "..."
```
Defaults user/db `daybook`; check `.env` if different.

## Status
- [ ] SSH into fido.torama.ng and identify MongoDB collections
- [ ] Read model schemas from `/Users/user1/projects/tor-pos-backend/models/`
- [ ] Write ETL script (Node.js: mongoose read → pg insert)
- [ ] Run dry-run (count check, no insert)
- [ ] Run live migration
- [ ] Verify dashboard shows historical data

## Notes
- Use `--dry-run` flag on migration script before committing
- Idempotent: use `ON CONFLICT DO NOTHING` or check existing records
- Map old Mongo `_id` to a `legacy_id` column where possible for traceability
- Collections likely: orders/sales, expenses, customers, staff/employees, products
