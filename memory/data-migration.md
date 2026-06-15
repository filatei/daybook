# Data Migration — Fido Water (MongoDB → PostgreSQL)

## Source
- **Server:** fido.torama.ng
- **DB engine:** MongoDB
- **Old backend code:** `/Users/user1/projects/tor-pos-backend`
- **Old frontend code:** `/Users/user1/projects/fido.torama.ng`
- **Access:** SSH tunnel (read-only)

## Target
- **DB engine:** PostgreSQL (Daybook new system)
- **Tenant:** Fido Water — get tenant_id from `SELECT id FROM tenants WHERE name ILIKE '%fido%'`

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
