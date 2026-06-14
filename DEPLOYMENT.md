# Daybook — Deployment Runbook

Daybook is a multi-tenant daily sales & incident reporting PWA. It runs in
**its own container** on the same Linode server as `otuburu` and `vote`, behind
Apache with a Let's Encrypt certificate for `https://daybook.torama.money`.
It is administered by `user1` but the container runs as the no-login service
account `daybookuser`. Everything mirrors the otuburu conventions so
`ssh daybook` works exactly like `ssh otuburu`.

```
Browser ──► Apache (:443 TLS, daybook.torama.money)
                 └─ reverse proxy ─► 127.0.0.1:8090  (daybook container)
                                          └─ SQLite + uploads on the `daybookdata` volume
```

---

## 0. One-time: GitHub Secrets

Secrets are **never committed**. CI writes `.env` on the server from GitHub
Secrets on every deploy. Add these in the repo: **Settings → Secrets and
variables → Actions**.

Server access (same values as otuburu — reuse them):

| Secret | Example | Notes |
|---|---|---|
| `LINODE_HOST` | `104.237.157.53` | server IP/host |
| `LINODE_USER` | `user1` | deploy user |
| `LINODE_SSH_KEY` | *(private key)* | the deploy key's private half |
| `LINODE_SSH_PORT` | `22` | |
| `GHCR_TOKEN` | *(PAT)* | GHCR pull token (read:packages) |

App secrets (daybook-specific):

| Secret | Required | Default if unset |
|---|---|---|
| `DAYBOOK_JWT_SECRET` | ✅ yes | — (`openssl rand -hex 32`) |
| `DAYBOOK_GOOGLE_CLIENT_ID` | no | otuburu's client (reused) |
| `DAYBOOK_SUPERADMIN_EMAILS` | no | `filatei@gmail.com,filatei@torama.money` |
| `DAYBOOK_DEFAULT_RECIPIENTS` | no | `dailyreports@gtsng.com` |
| `DAYBOOK_SMTP_FROM` | no | `Daybook <noreply@torama.money>` |
| `SMTP_USER` / `SMTP_PASS` | no | blank → IP-based relay (see §4) |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` | no | Google relay defaults |

> Generate the JWT secret: `openssl rand -hex 32`

### Google Sign-In (one-time)

Everyone logs in with Google — there are no passwords. Daybook reuses otuburu's
OAuth client. In **Google Cloud Console → APIs & Services → Credentials**, open
that OAuth client and add to **Authorized JavaScript origins**:

```
https://daybook.torama.money
```

No client secret is needed — Daybook verifies Google ID tokens server-side
against Google's public certs using the Client ID only.

---

## 1. DNS

Add an **A record**: `daybook.torama.money` → the server IP (same as
otuburu). Wait for it to resolve (`dig +short daybook.torama.money`).

## 2. First-time server provisioning

```bash
ssh daybook                    # = ssh otuburu (run ./scripts/setup-ssh.sh on your Mac first)

# clone or pull the repo somewhere, then bootstrap /opt/daybook:
sudo mkdir -p /opt/daybook/backend
sudo bash /path/to/repo/scripts/server-setup.sh
```

`server-setup.sh` creates `daybookuser`, the `/opt/daybook` tree, the sudoers
rules, enables the Apache modules, installs the systemd unit, and the
`daybook-deploy` / `daybook-logs` / `daybook-status` commands.

## 3. TLS certificate (Let's Encrypt)

```bash
sudo certbot --apache -d daybook.torama.money
```

This issues the cert and wires renewal. The vhost in
`infra/apache/daybook.torama.money.conf` already references
`/etc/letsencrypt/live/daybook.torama.money/…`.

## 4. Email (Google Workspace SMTP relay)

Identical to otuburu. The server IP is already whitelisted in
**Google Admin → Apps → Gmail → Routing → SMTP relay**, so **no password is
needed** — leave `SMTP_USER`/`SMTP_PASS` blank. (If you prefer an App Password,
set both and it switches to credential auth automatically.)

## 5. Deploy

Push to `main` → GitHub Actions builds the image, pushes to GHCR, SSHes in,
writes `.env` from Secrets, pulls, and restarts. Or deploy manually:

```bash
ssh daybook
daybook-deploy        # pull + restart + reload Apache + health check
daybook-status        # container + public health
daybook-logs          # tail logs
```

## 6. First login

Open `https://daybook.torama.money` and **Sign in with Google** using one of the
superadmin emails (`filatei@gmail.com` or `filatei@torama.money`). On first boot
the two companies (Fido Water, Fiafia Water), their sites, and the default report
recipient are seeded. As superadmin you see both companies and can add Admins,
General Managers, and Site Managers under each (People → Add person). Any new
business can also self-onboard: a Google user with no workspace is offered "Create
a company" and becomes its Admin.

### Roles

- **Superadmin** (you) — every company; manage all.
- **Admin** — full control within one company (sites, people, recipients, reports).
- **General Manager** — all sites in the company; view/submit/email reports.
- **Site Manager** — one site; produces that site's report.

---

## Local development

```bash
npm install
cp .env.example .env        # set JWT_SECRET; set DAYBOOK_ALLOW_DEV_LOGIN=1 for tests
npm start                   # http://localhost:8090
DAYBOOK_ALLOW_DEV_LOGIN=1 NODE_ENV=development npm run smoke   # end-to-end test
```

> Real sign-in needs `GOOGLE_CLIENT_ID` set and the local origin added to the
> OAuth client. For automated tests, `DAYBOOK_ALLOW_DEV_LOGIN=1` enables a
> password-less `/api/auth/dev-login` (disabled in production).

## CI/CD (GitHub Actions)

Two workflows on `github.com/filatei/daybook`:

- **CI** (`ci.yml`) — lint + smoke test on every push/PR. No secrets needed.
- **Deploy** (`deploy.yml`) — on push to `main`: builds a multi-arch image,
  pushes it to GHCR, then SSHes in and runs `scripts/deploy.sh` (pull + restart).
  The server's `/opt/daybook/backend/.env` stays the single source of truth — CI
  never rewrites it.

The Deploy job only runs when you opt in. Set it up once with the GitHub CLI:

```bash
cd ~/Documents/Claude/Projects/Daybook
PORT=$(ssh -G otuburu | awk '/^port /{print $2}')
KEY=$(ssh -G otuburu | awk '/^identityfile /{print $2; exit}')

gh variable set DEPLOY_ON_PUSH --body true            # enables the deploy job
gh secret set LINODE_HOST     --body 139.162.170.253
gh secret set LINODE_USER     --body user1
gh secret set LINODE_SSH_PORT --body "$PORT"
gh secret set LINODE_SSH_KEY  < "${KEY/#\~/$HOME}"     # PRIVATE key file
gh secret set GHCR_TOKEN      --body "<classic PAT with read:packages>"
```

> **GHCR_TOKEN must be a *classic* PAT with `read:packages`.** Fine-grained
> tokens or missing-scope tokens fail with `denied: denied` at `docker login`.
> Alternatively, make the `ghcr.io/filatei/daybook` package **public** (one click
> in the package settings) and the server pulls without a token.

Prerequisite: the server must already be provisioned once with
`scripts/bootstrap.sh` (creates `/opt/daybook`, `.env`, the container). After
that, `git push` (or `gh workflow run Deploy`) ships each change automatically.

## Backups

Everything lives in the `daybookdata` Docker volume (`/data` inside the container):
the SQLite DB and all uploaded files. Back it up with:

```bash
docker run --rm -v daybook_daybookdata:/data -v "$PWD":/backup alpine \
  tar czf /backup/daybook-$(date +%F).tar.gz -C /data .
```

## Upgrading SQLite → PostgreSQL (future, for the SaaS scale-out)

`backend/db.js` is the only data-layer module. When tenant volume grows, swap
it for a Postgres-backed implementation (same exported `getDb()` surface) and
add a `postgres` service to `docker-compose.yml` — no route changes required.
