# Memory — Daybook Project

## What This Is
Multi-tenant SaaS daily operations app for Nigerian water businesses (and others).
React 18 + Vite frontend, Node/Express + PostgreSQL backend. Deployed as PWA.

## Key Projects / Codenames
| Name | What |
|------|------|
| **Daybook** | The new SaaS system we are building (`/Users/user1/Documents/Claude/Projects/Daybook`) |
| **tor-pos-backend** | OLD Fido backend in MongoDB (`/Users/user1/projects/tor-pos-backend`) |
| **fido.torama.ng** | OLD Fido frontend (`/Users/user1/projects/fido.torama.ng`) |
| **Fido Water** | The first/main tenant — sells bagged & bottled water in Lagos |

## Key People
| Who | Role |
|-----|------|
| **Torama** | Owner / client (filatei@gtsng.com) |

## Architecture
- Frontend: `frontend/src/` — Vite root, builds to `frontend/dist/`
- Backend: `backend/` — Express, pg (PostgreSQL), JWT auth, Google SSO
- State: React Context + useReducer (`store.jsx`)
- API helper: `api.js` — `scoped(path)` appends `?tenant=<id>`
- Styles: single `frontend/src/styles.css` with CSS variables
- PWA: `sw.js` (cache `daybook-v4`) + `manifest.webmanifest`, auto-update via `controllerchange`; Web Push via VAPID (`backend/push.js`, `frontend/src/push.js`)

## Completed Work (Phase 4 React Rewrite)
- [x] Vite + React scaffold, Docker, pg migration
- [x] Auth (Google SSO), store, Nav (top tabs desktop / bottom nav mobile)
- [x] Dashboard (KPI cards — This week / This month / 90 days)
- [x] Sell (POS) — typed qty, Cash/Transfer/POS payment, BT thermal receipt
- [x] useBTPrinter hook — Xprinter/Epson ESC/POS, Code 128 barcode on receipt
- [x] Gate.jsx — barcode scan + manual entry, PENDING→LOADED→EXITED flow
- [x] Admin — Sites, Members (fixed blank bug), Products tabs
- [x] Expenses view with Typeahead for vendor
- [x] Typeahead component — debounced, keyboard nav, closes on outside click
- [x] Unique customers (case-insensitive DB index), suggest/customers + suggest/vendors
- [x] PWA auto-update (controllerchange reload) + install prompt (beforeinstallprompt)
- [x] Responsive nav — bottom nav mobile (<768px), top tabs desktop (≥768px)
- [x] Safe-area fix — viewport-fit=cover + env(safe-area-inset-bottom) on .main-content
- [x] Backend: loaded_at migration, /pos/sales/:id/loaded route
- [x] Backend: gate routes (GET /pos/gate/:receiptNo, POST /pos/sales/:id/exit)

## Recently Completed (verified 2026-08-17)
- [x] **Daily-report email fix** (`301c61d`) — Emails went quiet after ~Aug 13 because auto-submit used only per-site / all-sites addresses; the company distribution list (`recipients`) was only used on manual re-email; lists never merged. Fix: every send path merges distribution list + per-site/all-sites + generator (`backend/reportmail.js` → `resolveReportRecipients`). Admin → Report emails **"Always send to"**; comma-separated emails save (`type=text`). SMTP outbox retries via `deliver()`, trim/normalize addresses. Submit failures log the real To: list. Health: `GET /api/email/health`, `POST /api/email/test`. Ensure `MAIL_DISABLED` is not `1` in prod.
- [x] **PWA push notifications** (same deploy family as email fix) — Banner after login (`PushPrompt`) + More → Notifications. SW cache `daybook-v4`. Server needs `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` in `/opt/daybook/backend/.env` (generate with `npx web-push generate-vapid-keys`). Without private key, in-app notifications still work but no native phone push. See `DEPLOYMENT.md` §4b.
- [x] **Tenant ID in UI** (`85e199e`) — Shown under header workspace switcher (ID + Copy), and Admin → Settings **Workspace ID** card (for API curls `?tenant=`).

### Earlier (Phase 4/5 — 2026-06-27)
- [x] Dashboard — real data from `/pos/range` (cash/transfer/POS, by-day/site/product/customer/hour), incentive, POS-by-owner drill
- [x] Reports view — date-range filters, daily-report archive, ✨ Generate daily report, 📝 Manual daily report (tenant-wide, email+archive), POS Moniepoint/GTB split by owner
- [x] Staff view — badge clock-in/out (`/attendance/badge`), face liveness (useFaceLiveness, face_descriptor enrol, match_score, tenant face_match_threshold), payroll linkage (Payroll.jsx)
- [x] Documents view — categories incl. incident reports / daily logs, attachments, per-site/company-wide
- [x] Staff typeahead — `/suggest/staff` (+ customers, vendors, expense-items)
- [x] CSV exports — `/activity/all.csv`, `/timesheets/summary.csv`
- [x] App-shell fixed top/bottom nav (content scrolls under); ETL tooling for Fido Mongo→Postgres (`backend/etl.js`, supports `--verify`, batching)

## Pending Work (Priority Order) — accurate as of 2026-08-17
1. **Run the Fido data migration** — the ETL is BUILT (`backend/etl.js`); what's pending is EXECUTION: set `SALES_MONGO_URL` (read-only) + `SALES_DB`, run the import into Postgres under Fido's tenant_id, then `--verify` (reconcile counts + ₦ per site). Needs SSH/Mongo access to the old `fido.torama.ng` server.
2. **Reports sales+expenses CSV/range export** — Reports has the on-screen view; a downloadable sales+expenses export for a date range is not yet built (only activity + timesheets CSVs exist).
3. **TypeScript migration** — still deferred (optional; JS works in prod).
4. **(Backlog) Staff face-liveness polish** — core enrol/match works; optional UX hardening (re-enrol flow, threshold tuning UI) if needed.

## Key Technical Notes
- All backend updates use `router.patch()` not `router.put()`
- `scoped(path)` appends `?tenant=<id>` to every API call
- Products: soft delete only — PATCH with `{ status: 'INACTIVE' }`, never hard delete
- Idempotent POS sales via `client_uid` field
- Unique customers: `CREATE UNIQUE INDEX ON customers(tenant_id, lower(name))`
- Postgres: use `ILIKE` not `LIKE` for case-insensitive search
- Git lock files: run `rm -f .git/HEAD.lock .git/index.lock 2>/dev/null; true` before every commit
- Vite root is `frontend/src/` — not `frontend/`
- `color-scheme: light` set in `:root` to prevent dark mode bleed
- Report email recipients: always merge `recipients` + site/all-sites + sender (`resolveReportRecipients`); do not regress to site-only auto-submit
- Prod mail/push env (`/opt/daybook/backend/.env`): `MAIL_DISABLED` must not be `1`; VAPID pair required for native push (CI does not rewrite `.env`)
- Deploy git remote: HTTPS may need auth fix for pushes; SSH was used successfully
- Look up tenant UUIDs on the server (defaults user/db `daybook`; check `.env` if different; container `daybook-postgres`, deploy path `/opt/daybook/backend`):
```
docker exec -it daybook-postgres psql -U daybook -d daybook -c "SELECT id, name, slug, status FROM tenants ORDER BY name;"
docker exec -it daybook-postgres psql -U daybook -d daybook -c "SELECT id, name, slug FROM tenants WHERE name ILIKE '%fido%';"
# or: cd /opt/daybook/backend && docker compose exec postgres psql -U daybook -d daybook -c "..."
```

## Standard Push Command
```bash
rm -f .git/HEAD.lock .git/index.lock 2>/dev/null; true
git add -A
git commit -m "feat: <description>"
git push
```

## Data Migration (TODO)
- Source: MongoDB on `fido.torama.ng` server (SSH tunnel, read-only)
- Old backend code: `/Users/user1/projects/tor-pos-backend` (Mongoose models define schema)
- Old frontend code: `/Users/user1/projects/fido.torama.ng`
- Symlinks inside Daybook folder: `Daybook/tor-pos-backend` and `Daybook/fido.torama.ng`
- Use Read tool on symlink paths — bash sandbox cannot follow symlinks outside mount
- Target: Daybook PostgreSQL, Fido Water tenant_id
- Collections likely: sales/orders, expenses, customers, staff, products
- Script to write once old schema is confirmed
→ Details: memory/data-migration.md

## Mobile shell layout (fixed 2026-08-01 — do not regress)
- #root height uses `var(--appvh)` set from window.innerHeight in main.jsx
  (refreshed on resize/visualViewport). 100vh/100dvh over-measure in in-app
  webviews and edge-to-edge standalone — never size the shell with them alone.
- .bottom-nav is IN-FLOW (position: static, order: 99, flex-shrink: 0) inside
  the #root flex column, NOT position: fixed — fixed pinned it below the
  visible edge in WhatsApp/IG webviews.
- Standalone PWA floors (Android edge-to-edge reports env() = 0 on many
  devices): header padding-top max(28px, env(safe-area-inset-top)); bottom-nav
  padding-bottom max(24px, env(safe-area-inset-bottom)); offline-pill likewise.
- After deploy, phone QA needs a full app close/reopen (sw.js caches CSS/JS).
