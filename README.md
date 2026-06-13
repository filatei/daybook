# Daybook

A **multi-client (multi-tenant) SaaS** PWA for daily business reporting — like a
Zendesk for daybooks. Any company with multiple sites can sign in with Google,
get an isolated workspace, and have each site's manager file a daily report.
Torama's own businesses (**Fido Water**, **Fiafia Water**) are the first tenants.

Lives at **https://daybook.torama.money**, on the same server as
`otuburu` and `vote`, in its own isolated container.

## What it does

- **Google sign-in** — everyone authenticates with their Google account; no
  passwords. Access is by invitation (an admin adds your email with a role).
- **Self-serve onboarding** — a new business signs in and creates its own company
  workspace, becoming its Admin. Each workspace's data is fully isolated.
- **Per-site daily reports** — sales by product & payment method, cash/deposit
  totals, diesel & expenses, bag production/inventory, notes & incidents. Totals
  compute automatically. Submit as draft or final.
- **Document vault** — upload Excel, PDF, images, and Word files, categorised as
  Daily report, Correspondence, Legal, Inventory/receipts, Incident, or Other.
- **Email distribution** — email any submitted report (with attachments) to a
  per-company recipient list, default `dailyreports@gtsng.com`, via the same
  Google Workspace relay otuburu uses.
- **Dashboard** — sales totals, sales-by-site and daily-trend charts; superadmins
  get an all-companies view.
- **Installable PWA** — installs to the phone home screen, offline app shell,
  custom toasts/modals, animated UI, form validation.

## Tenancy & roles

The **tenant = a client company** (the isolation + billing unit). Users are global
Google identities; a `membership` grants a user a **role in a company**, so one
person can hold roles across several companies.

- **Superadmin** (platform operator — you) — sees and manages every company.
- **Admin** — full control within one company (sites, people, recipients, reports).
- **General Manager** — all sites in the company; view/submit/email reports.
- **Site Manager** — assigned one site; produces that site's daily report.

Fido Water and Fiafia Water are seeded as two companies; you are superadmin over
both. New companies self-onboard. Future modules (subscriptions, staff hours,
payroll) attach to a tenant without reshaping existing tables.

## Stack

Node 20 · Express · better-sqlite3 · nodemailer (Google SMTP relay) · vanilla
PWA frontend with Chart.js. Same conventions as otuburu: Docker container,
Apache reverse proxy, Let's Encrypt, systemd, `/opt/daybook`, `daybookuser`
service account, GitHub Actions → GHCR deploy.

## Quick start

```bash
npm install
cp .env.example .env      # set JWT_SECRET; GOOGLE_CLIENT_ID is pre-filled
npm start                 # http://localhost:8090
DAYBOOK_ALLOW_DEV_LOGIN=1 NODE_ENV=development npm run smoke   # end-to-end check
```

See **DEPLOYMENT.md** for the full server runbook (DNS, TLS, secrets, deploy).

## Layout

```
backend/    Express API, SQLite layer, auth, mailer, seed, smoke test
frontend/   PWA: index.html, app.js, styles.css, service worker, manifest, icons
infra/      Apache vhost, systemd unit
scripts/    server-setup.sh, deploy.sh, setup-ssh.sh
.github/    CI (lint + smoke) and Deploy (build → GHCR → SSH) workflows
```
