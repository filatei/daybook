/**
 * Daybook — Postgres data layer (multi-client SaaS)
 *
 * Hierarchy (Zendesk-style):
 *   tenant      = a client company / workspace (the isolation + billing unit)
 *   user        = a global identity (Google account, by email)
 *   membership  = (user <-> tenant) with a role and, for site managers, a site
 *   site        = a physical location within a tenant
 *
 * Roles (per membership): ADMIN | GENERAL_MANAGER | SITE_MANAGER
 * A user may belong to several tenants (e.g. a GM over both Fido and Fiafia).
 * users.is_superadmin = the platform operator (Torama / you): sees every tenant.
 *
 * Uses `pg` (pure-JS Postgres driver). Call initDb() once at startup; after that
 * getDb() returns the pool synchronously, and qone/qall/qrun are async helpers.
 */
'use strict';

const { Pool } = require('pg');

let pool = null;

// Convert ? placeholders to $1, $2, … (pg uses positional params)
function pq(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function initDb() {
  if (pool) return pool;
  pool = new Pool({
    connectionString: process.env.DATABASE_URL ||
      `postgresql://${process.env.PG_USER || 'daybook'}:${process.env.PG_PASSWORD || 'daybook'}@${process.env.PG_HOST || 'localhost'}:${process.env.PG_PORT || 5432}/${process.env.PG_DB || 'daybook'}`,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  // Don't let a dropped idle connection (e.g. Postgres restarted) crash the
  // process with an unhandled 'error' event — pg reconnects on the next query.
  pool.on('error', (err) => { console.error('[db] pool error (will reconnect):', err.message); });
  // Verify connectivity
  const client = await pool.connect();
  client.release();
  await migrate();
  return pool;
}

function getDb() {
  if (!pool) throw new Error('DB not initialized — call initDb() first');
  return pool;
}

// ── Async query helpers ────────────────────────────────────────────────────────

/** Return first row or null. */
async function qone(sql, params = []) {
  const r = await pool.query(pq(sql), params);
  return r.rows[0] || null;
}

/** Return all rows. */
async function qall(sql, params = []) {
  const r = await pool.query(pq(sql), params);
  return r.rows;
}

/** Execute (INSERT/UPDATE/DELETE). Returns pg result. */
async function qrun(sql, params = []) {
  return pool.query(pq(sql), params);
}

/** Execute raw DDL (no placeholder translation needed). */
async function qexec(sql) {
  return pool.query(sql);
}

/** Run fn(client) inside a transaction; rolls back on error. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── Schema migrations (idempotent) ────────────────────────────────────────────
async function migrate() {
  await pool.query(`
    -- TENANTS — one per client company / workspace
    CREATE TABLE IF NOT EXISTS tenants (
      id                     TEXT PRIMARY KEY,
      slug                   TEXT UNIQUE NOT NULL,
      name                   TEXT NOT NULL,
      brand_color            TEXT DEFAULT '#0ea5e9',
      currency               TEXT DEFAULT 'NGN',
      industry               TEXT,
      plan                   TEXT CHECK(plan IN ('FREE','STANDARD','PRO','OWNER')) DEFAULT 'FREE',
      status                 TEXT CHECK(status IN ('ACTIVE','SUSPENDED')) DEFAULT 'ACTIVE',
      trial_ends_at          BIGINT,
      paid_until             BIGINT,
      pos_source             TEXT,
      ls_subscription_id     TEXT,
      subscription_status    TEXT,
      subscription_ends_at   BIGINT,
      subscription_renews_at BIGINT,
      customer_portal_url    TEXT,
      ps_customer_code       TEXT,
      ps_subscription_code   TEXT,
      created_by             TEXT,
      created_at             BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    -- USERS — global identities (one row per Google email)
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      google_sub    TEXT,
      name          TEXT,
      photo_url     TEXT,
      is_superadmin INTEGER DEFAULT 0,
      status        TEXT CHECK(status IN ('ACTIVE','DISABLED')) DEFAULT 'ACTIVE',
      last_login    BIGINT,
      created_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    -- SITES — physical locations within a tenant (before memberships for FK)
    CREATE TABLE IF NOT EXISTS sites (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      code        TEXT NOT NULL,
      name        TEXT NOT NULL,
      address     TEXT,
      is_hq       INTEGER DEFAULT 0,
      status      TEXT CHECK(status IN ('ACTIVE','CLOSED')) DEFAULT 'ACTIVE',
      created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(tenant_id, code)
    );

    -- MEMBERSHIPS — a user's role inside a tenant
    CREATE TABLE IF NOT EXISTS memberships (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      role        TEXT CHECK(role IN ('ADMIN','GENERAL_MANAGER','SITE_MANAGER','SNR_ACCOUNTANT','ACCOUNTANT','SECRETARY','SUPERVISOR','GATEMAN','GATE')) NOT NULL,
      site_id     TEXT REFERENCES sites(id),
      status      TEXT CHECK(status IN ('ACTIVE','DISABLED')) DEFAULT 'ACTIVE',
      created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(user_id, tenant_id)
    );

    -- DAILY REPORTS — one per site per day
    CREATE TABLE IF NOT EXISTS daily_reports (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL REFERENCES tenants(id),
      site_id         TEXT NOT NULL REFERENCES sites(id),
      report_date     TEXT NOT NULL,
      total_sales     DOUBLE PRECISION DEFAULT 0,
      total_cash      DOUBLE PRECISION DEFAULT 0,
      total_deposit   DOUBLE PRECISION DEFAULT 0,
      diesel          DOUBLE PRECISION DEFAULT 0,
      expenses        DOUBLE PRECISION DEFAULT 0,
      balance         DOUBLE PRECISION DEFAULT 0,
      sales_json      TEXT,
      production_json TEXT,
      notes           TEXT,
      status          TEXT CHECK(status IN ('DRAFT','SUBMITTED','EMAILED')) DEFAULT 'DRAFT',
      created_by      TEXT REFERENCES users(id),
      created_at      BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      submitted_at    BIGINT,
      emailed_at      BIGINT,
      UNIQUE(tenant_id, site_id, report_date)
    );

    -- DOCUMENTS — uploads of any kind, categorised
    CREATE TABLE IF NOT EXISTS documents (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id),
      site_id       TEXT REFERENCES sites(id),
      report_id     TEXT REFERENCES daily_reports(id),
      category      TEXT CHECK(category IN
                      ('DAILY_REPORT','CORRESPONDENCE','LEGAL','INVENTORY','INCIDENT','OTHER'))
                      DEFAULT 'OTHER',
      title         TEXT,
      description   TEXT,
      file_name     TEXT NOT NULL,
      stored_name   TEXT NOT NULL,
      mime          TEXT,
      size          INTEGER,
      uploaded_by   TEXT REFERENCES users(id),
      created_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    -- REPORT RECIPIENTS — per-tenant email distribution list
    CREATE TABLE IF NOT EXISTS recipients (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      email       TEXT NOT NULL,
      name        TEXT,
      active      INTEGER DEFAULT 1,
      created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(tenant_id, email)
    );

    -- INVITES — pending memberships for emails not yet signed in
    CREATE TABLE IF NOT EXISTS invites (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      email       TEXT NOT NULL,
      role        TEXT CHECK(role IN ('ADMIN','GENERAL_MANAGER','SITE_MANAGER','SNR_ACCOUNTANT','ACCOUNTANT','SECRETARY','SUPERVISOR','GATEMAN','GATE')) NOT NULL,
      site_id     TEXT REFERENCES sites(id),
      invited_by  TEXT REFERENCES users(id),
      created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(tenant_id, email)
    );

    -- STAFF — a worker at a site
    CREATE TABLE IF NOT EXISTS staff (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id),
      site_id       TEXT REFERENCES sites(id),
      full_name     TEXT NOT NULL,
      role_title    TEXT,
      phone         TEXT,
      pay_type      TEXT CHECK(pay_type IN ('HOURLY','DAILY','MONTHLY','PIECE')) DEFAULT 'DAILY',
      ext_people_id TEXT,
      status        TEXT CHECK(status IN ('ACTIVE','INACTIVE')) DEFAULT 'ACTIVE',
      created_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(tenant_id, site_id, full_name)
    );

    -- TIMESHEETS — one row per staff per day
    CREATE TABLE IF NOT EXISTS timesheets (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL REFERENCES tenants(id),
      site_id      TEXT NOT NULL REFERENCES sites(id),
      staff_id     TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      work_date    TEXT NOT NULL,
      present      INTEGER DEFAULT 1,
      hours        DOUBLE PRECISION,
      bags_bagged  INTEGER,
      bags_loaded  INTEGER,
      note         TEXT,
      recorded_by  TEXT REFERENCES users(id),
      created_at   BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(staff_id, work_date)
    );

    -- GENERATORS — a power generator asset at a site
    CREATE TABLE IF NOT EXISTS generators (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id),
      site_id       TEXT REFERENCES sites(id),
      name          TEXT NOT NULL,
      fuel_type     TEXT CHECK(fuel_type IN ('DIESEL','PETROL','GAS')) DEFAULT 'DIESEL',
      make_model    TEXT,
      capacity_kva  DOUBLE PRECISION,
      serial_no     TEXT,
      purchase_date TEXT,
      purchase_cost DOUBLE PRECISION,
      status        TEXT CHECK(status IN ('ACTIVE','RETIRED')) DEFAULT 'ACTIVE',
      notes         TEXT,
      created_by    TEXT REFERENCES users(id),
      created_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    -- GENERATOR LOGS — diesel fills + maintenance
    CREATE TABLE IF NOT EXISTS generator_logs (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id),
      generator_id  TEXT NOT NULL REFERENCES generators(id) ON DELETE CASCADE,
      site_id       TEXT REFERENCES sites(id),
      log_date      TEXT NOT NULL,
      type          TEXT CHECK(type IN ('DIESEL','MAINTENANCE','NOTE')) NOT NULL,
      litres        DOUBLE PRECISION,
      cost          DOUBLE PRECISION,
      runtime_hours DOUBLE PRECISION,
      detail        TEXT,
      recorded_by   TEXT REFERENCES users(id),
      created_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    -- PRODUCTS
    CREATE TABLE IF NOT EXISTS products (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      name        TEXT NOT NULL,
      category    TEXT,
      price       DOUBLE PRECISION NOT NULL DEFAULT 0,
      cost        DOUBLE PRECISION DEFAULT 0,
      sku         TEXT,
      unit        TEXT DEFAULT 'unit',
      track_stock INTEGER DEFAULT 1,
      stock_qty   DOUBLE PRECISION DEFAULT 0,
      status      TEXT CHECK(status IN ('ACTIVE','INACTIVE')) DEFAULT 'ACTIVE',
      created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(tenant_id, name)
    );

    -- CUSTOMERS
    CREATE TABLE IF NOT EXISTS customers (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      name        TEXT NOT NULL,
      phone       TEXT,
      email       TEXT,
      note        TEXT,
      created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    -- POS SALES
    CREATE TABLE IF NOT EXISTS pos_sales (
      id             TEXT PRIMARY KEY,
      tenant_id      TEXT NOT NULL REFERENCES tenants(id),
      site_id        TEXT REFERENCES sites(id),
      receipt_no     INTEGER,
      customer_id    TEXT REFERENCES customers(id),
      customer_name  TEXT,
      items_json     TEXT,
      subtotal       DOUBLE PRECISION DEFAULT 0,
      discount       DOUBLE PRECISION DEFAULT 0,
      total          DOUBLE PRECISION DEFAULT 0,
      payment_method TEXT,
      amount_paid    DOUBLE PRECISION DEFAULT 0,
      balance        DOUBLE PRECISION DEFAULT 0,
      status         TEXT CHECK(status IN ('PAID','PART','UNPAID')) DEFAULT 'PAID',
      sale_date      TEXT,
      client_uid     TEXT,
      sold_by        TEXT REFERENCES users(id),
      created_at     BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    -- INVENTORY MOVES
    CREATE TABLE IF NOT EXISTS inventory_moves (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      site_id     TEXT REFERENCES sites(id),
      type        TEXT CHECK(type IN ('PURCHASE','SALE','ADJUST')) NOT NULL,
      qty         DOUBLE PRECISION NOT NULL,
      unit_cost   DOUBLE PRECISION,
      ref         TEXT,
      note        TEXT,
      created_by  TEXT REFERENCES users(id),
      created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    -- STAFF CHAT
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      channel     TEXT NOT NULL,
      user_id     TEXT REFERENCES users(id),
      user_name   TEXT,
      body        TEXT NOT NULL,
      client_uid  TEXT,
      created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    -- IN-APP NOTIFICATIONS
    CREATE TABLE IF NOT EXISTS notifications (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT REFERENCES tenants(id),
      user_id     TEXT NOT NULL REFERENCES users(id),
      type        TEXT,
      title       TEXT,
      body        TEXT,
      link        TEXT,
      read        INTEGER DEFAULT 0,
      created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    -- FEATURE REQUESTS
    CREATE TABLE IF NOT EXISTS feature_requests (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT REFERENCES tenants(id),
      user_id     TEXT REFERENCES users(id),
      user_name   TEXT,
      title       TEXT NOT NULL,
      body        TEXT,
      status      TEXT DEFAULT 'NEW',
      votes       INTEGER DEFAULT 0,
      created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      updated_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    -- PAYMENTS
    CREATE TABLE IF NOT EXISTS payments (
      id                 TEXT PRIMARY KEY,
      tenant_id          TEXT NOT NULL REFERENCES tenants(id),
      reference          TEXT UNIQUE NOT NULL,
      plan               TEXT,
      months             INTEGER,
      amount             INTEGER,
      currency           TEXT,
      provider           TEXT,
      provider_reference TEXT,
      status             TEXT DEFAULT 'PENDING',
      email              TEXT,
      created_by         TEXT REFERENCES users(id),
      created_at         BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      paid_at            BIGINT,
      raw                TEXT
    );

    -- ATTENDANCE
    CREATE TABLE IF NOT EXISTS attendance (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      site_id     TEXT REFERENCES sites(id),
      staff_id    TEXT NOT NULL REFERENCES staff(id),
      work_date   TEXT NOT NULL,
      clock_in    BIGINT,
      clock_out   BIGINT,
      photo_in    TEXT,
      photo_out   TEXT,
      signature   TEXT,
      in_lat      DOUBLE PRECISION, in_lng DOUBLE PRECISION, in_acc DOUBLE PRECISION,
      out_lat     DOUBLE PRECISION, out_lng DOUBLE PRECISION, out_acc DOUBLE PRECISION,
      captured_by TEXT REFERENCES users(id),
      created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      updated_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(tenant_id, staff_id, work_date)
    );

    -- PAYMENT PLANS (cached gateway plan codes)
    CREATE TABLE IF NOT EXISTS payment_plans (
      id          TEXT PRIMARY KEY,
      code        TEXT UNIQUE NOT NULL,
      provider    TEXT,
      plan_code   TEXT,
      interval    TEXT,
      amount      INTEGER,
      created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    CREATE TABLE IF NOT EXISTS email_log (
      id TEXT PRIMARY KEY, tenant_id TEXT, report_id TEXT, to_addrs TEXT,
      subject TEXT, status TEXT, error TEXT,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, action TEXT,
      entity TEXT, entity_id TEXT, meta TEXT,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_member_user   ON memberships(user_id);
    CREATE INDEX IF NOT EXISTS idx_member_tenant ON memberships(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_reports_td    ON daily_reports(tenant_id, report_date);
    CREATE INDEX IF NOT EXISTS idx_docs_tc       ON documents(tenant_id, category);
    CREATE INDEX IF NOT EXISTS idx_sites_tenant  ON sites(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_genlogs       ON generator_logs(tenant_id, generator_id, log_date);
    CREATE INDEX IF NOT EXISTS idx_products_t    ON products(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_possales_td   ON pos_sales(tenant_id, sale_date);
    CREATE INDEX IF NOT EXISTS idx_invmoves      ON inventory_moves(tenant_id, product_id);
  `);

  // Partial unique index (separate statement — Postgres parses the WHERE clause)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_possales_uid
      ON pos_sales(tenant_id, client_uid)
      WHERE client_uid IS NOT NULL
  `);

  // ── Phase 2 additions (ETL: Mongo → Postgres) ─────────────────────────────

  // ext_id columns for idempotent ETL upserts
  await pool.query(`
    ALTER TABLE pos_sales  ADD COLUMN IF NOT EXISTS ext_id TEXT;
    ALTER TABLE customers  ADD COLUMN IF NOT EXISTS ext_id TEXT;
    ALTER TABLE sites      ADD COLUMN IF NOT EXISTS ext_mongo_id TEXT;
  `);

  // Widen the role CHECK to the full ladder: Gateman/Supervisor (gate-only),
  // Secretary, Accountant, Snr Accountant, (Site) Manager, General Manager, Admin.
  const ROLE_LIST = "'ADMIN','GENERAL_MANAGER','SITE_MANAGER','SNR_ACCOUNTANT','ACCOUNTANT','SECRETARY','SUPERVISOR','GATEMAN','GATE'";
  await pool.query(`
    ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
    ALTER TABLE memberships ADD  CONSTRAINT memberships_role_check CHECK (role IN (${ROLE_LIST}));
    ALTER TABLE invites     DROP CONSTRAINT IF EXISTS invites_role_check;
    ALTER TABLE invites     ADD  CONSTRAINT invites_role_check CHECK (role IN (${ROLE_LIST}));
  `);

  // ext_id columns + idempotency indexes for generator ETL
  await pool.query(`
    ALTER TABLE generators     ADD COLUMN IF NOT EXISTS ext_id TEXT;
    ALTER TABLE generator_logs ADD COLUMN IF NOT EXISTS ext_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_generators_extid ON generators(tenant_id, ext_id) WHERE ext_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_genlogs_extid    ON generator_logs(tenant_id, ext_id) WHERE ext_id IS NOT NULL;
  `);

  // Face recognition: a 128-D descriptor enrolled per staff; match score on clock.
  await pool.query(`
    ALTER TABLE staff      ADD COLUMN IF NOT EXISTS face_descriptor TEXT;
    ALTER TABLE staff      ADD COLUMN IF NOT EXISTS face_enrolled_at BIGINT;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS match_score DOUBLE PRECISION;
    ALTER TABLE tenants    ADD COLUMN IF NOT EXISTS face_match_threshold DOUBLE PRECISION DEFAULT 0.55;
  `);

  // Payroll v2 — pay config per staff (pay_type already exists: DAILY | PIECE | …).
  // Piece workers earn per bag loaded and/or bagged; regular staff a daily rate.
  // staff_type classifies the worker: REGULAR (with a role_title like Secretary,
  // Operator, Cleaner …), or a piece worker — BAGGER / LOADER.
  await pool.query(`
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS daily_rate  DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS rate_loaded DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS rate_bagged DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS staff_type  TEXT DEFAULT 'REGULAR';
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS department  TEXT;
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS bank_name   TEXT;
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS bank_account TEXT;
    -- Passport-style staff photo (small JPEG data URL) for the ID badge.
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS photo TEXT;
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS photo_at BIGINT;
    -- Scannable badge code (printed on the staff ID card) for badge clock-in.
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS badge_code TEXT;
    UPDATE staff SET badge_code = UPPER(SUBSTRING(MD5(id) FROM 1 FOR 8)) WHERE badge_code IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_badge ON staff(tenant_id, badge_code) WHERE badge_code IS NOT NULL;
    CREATE TABLE IF NOT EXISTS production (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      site_id     TEXT REFERENCES sites(id),
      staff_id    TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      work_date   TEXT NOT NULL,
      bags_loaded DOUBLE PRECISION DEFAULT 0,
      bags_bagged DOUBLE PRECISION DEFAULT 0,
      recorded_by TEXT,
      updated_at  BIGINT,
      created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(tenant_id, staff_id, work_date)
    );
    CREATE INDEX IF NOT EXISTS idx_production_td ON production(tenant_id, work_date);

    -- Advances / deductions given to a worker; settled (run_id set) at payroll time.
    CREATE TABLE IF NOT EXISTS staff_advances (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      staff_id    TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      adv_date    TEXT NOT NULL,
      amount      DOUBLE PRECISION NOT NULL DEFAULT 0,
      reason      TEXT,
      run_id      TEXT,
      created_by  TEXT,
      created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_adv_staff ON staff_advances(tenant_id, staff_id, run_id);

    -- Saved payroll runs + their per-staff payslip lines.
    CREATE TABLE IF NOT EXISTS pay_runs (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      site_id     TEXT,
      period_from TEXT NOT NULL,
      period_to   TEXT NOT NULL,
      status      TEXT DEFAULT 'DRAFT',
      total_gross DOUBLE PRECISION DEFAULT 0,
      total_deductions DOUBLE PRECISION DEFAULT 0,
      total_net   DOUBLE PRECISION DEFAULT 0,
      created_by  TEXT, approved_by TEXT, approved_at BIGINT, paid_at BIGINT,
      created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE TABLE IF NOT EXISTS pay_run_lines (
      id          TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
      tenant_id   TEXT NOT NULL,
      staff_id    TEXT, staff_name TEXT, pay_type TEXT,
      days_present DOUBLE PRECISION, bags_loaded DOUBLE PRECISION, bags_bagged DOUBLE PRECISION,
      gross DOUBLE PRECISION, deductions DOUBLE PRECISION, net DOUBLE PRECISION
    );
    CREATE INDEX IF NOT EXISTS idx_payruns_td ON pay_runs(tenant_id, period_from);
  `);

  // ETL EXPENSES — from fido `expenses` collection
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL REFERENCES tenants(id),
      site_id      TEXT REFERENCES sites(id),
      ext_id       TEXT,
      expense_date TEXT NOT NULL,
      category     TEXT,
      description  TEXT,
      amount       DOUBLE PRECISION DEFAULT 0,
      recorded_by  TEXT,
      created_at   BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )
  `);
  // Expenses carry a vendor/payee (distinct from sales customers) + line items.
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS vendor TEXT`);
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS items_json TEXT`);
  // Expense tickets get paid incrementally → track amount_paid + status, plus a
  // payment ledger. Vendor "what we owe" = Σ amount − Σ amount_paid per vendor.
  await pool.query(`
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS amount_paid DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'UNPAID';
    -- Workflow lifecycle (Fido): DRAFT→REVIEWED→APPROVED→PAID→DELIVERED, plus DECLINED.
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS wf_state TEXT;`);
  // One-time backfill: seed lifecycle from payment status for migrated tickets.
  await pool.query(`UPDATE expenses SET wf_state = CASE WHEN status='PAID' THEN 'PAID' ELSE 'DRAFT' END WHERE wf_state IS NULL`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expense_wf_log (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      expense_id  TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      action      TEXT,
      from_state  TEXT,
      to_state    TEXT,
      note        TEXT,
      actor       TEXT,
      actor_name  TEXT,
      created_at  BIGINT DEFAULT (EXTRACT(EPOCH FROM now())::BIGINT)
    );
    CREATE INDEX IF NOT EXISTS idx_exp_wf ON expense_wf_log(expense_id);
    CREATE TABLE IF NOT EXISTS expense_payments (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      pay_date   TEXT NOT NULL,
      amount     DOUBLE PRECISION NOT NULL,
      method     TEXT,
      bank       TEXT,
      memo       TEXT,
      paid_by    TEXT,
      ext_id     TEXT,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM now())::BIGINT)
    );
    CREATE INDEX IF NOT EXISTS idx_exp_pay_expense ON expense_payments(expense_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_exp_pay_ext ON expense_payments(tenant_id, ext_id) WHERE ext_id IS NOT NULL;

    -- Receipts/notes attached to an expense ticket (files on disk + a note each).
    CREATE TABLE IF NOT EXISTS expense_attachments (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      expense_id  TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      note        TEXT,
      file_name   TEXT,
      stored_name TEXT,
      mime        TEXT,
      size        INTEGER,
      uploaded_by TEXT,
      created_at  BIGINT DEFAULT (EXTRACT(EPOCH FROM now())::BIGINT)
    );
    CREATE INDEX IF NOT EXISTS idx_exp_att ON expense_attachments(expense_id);
  `);

  // VENDORS — suppliers/payees, imported from fido `contacts`.  A global pool
  // per tenant (no site), deduped on lower(name).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendors (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      name        TEXT NOT NULL,
      phone       TEXT,
      email       TEXT,
      bank        TEXT,
      account_no  TEXT,
      category    TEXT,
      ext_id      TEXT,
      status      TEXT DEFAULT 'ACTIVE',
      created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_name ON vendors(tenant_id, lower(name));
    CREATE INDEX IF NOT EXISTS idx_vendors_td ON vendors(tenant_id);
  `);

  // ETL PAYROLL — from fido `payrolls` collection
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id),
      site_id       TEXT REFERENCES sites(id),
      staff_id      TEXT REFERENCES staff(id),
      ext_id        TEXT,
      ext_staff_id  TEXT,
      staff_name    TEXT,
      month         TEXT NOT NULL,
      year          TEXT NOT NULL,
      gross_pay     DOUBLE PRECISION DEFAULT 0,
      net_pay       DOUBLE PRECISION DEFAULT 0,
      deductions    DOUBLE PRECISION DEFAULT 0,
      days_worked   DOUBLE PRECISION DEFAULT 0,
      bags_bagged   DOUBLE PRECISION DEFAULT 0,
      status        TEXT,
      created_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )
  `);

  // RECONCILIATIONS — non-cash payment confirmations (fido `recuploads`) + cash
  // bankings (fido `cashdeposits`). One ledger: confirm money reached the bank.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reconciliations (
      id               TEXT PRIMARY KEY,
      tenant_id        TEXT NOT NULL REFERENCES tenants(id),
      site_id          TEXT REFERENCES sites(id),
      customer_id      TEXT REFERENCES customers(id),
      ext_id           TEXT,
      kind             TEXT NOT NULL,                       -- TRANSFER | POS | CARD | CASH_DEPOSIT
      txn_date         TEXT,                                -- YYYY-MM-DD
      amount           DOUBLE PRECISION DEFAULT 0,          -- sale / deposit amount
      amount_confirmed DOUBLE PRECISION,                    -- bank-confirmed (amt_teller)
      bank             TEXT,                                -- transfer_from_bank / payeeAcct
      account_name     TEXT,                                -- account name / depositor
      ref              TEXT,                                -- rrn / stan / tx_ref
      status           TEXT DEFAULT 'PENDING',              -- PENDING | CONFIRMED | FLAGGED
      action_taken     TEXT,
      remarks          TEXT,
      image            TEXT,                                -- proof: external URL (imported) or stored filename
      recorded_by      TEXT REFERENCES users(id),
      created_at       BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )
  `);

  // REALTIME EVENTS — durable, monotonically-ordered event log. The WebSocket
  // gateway broadcasts each new event; a reconnecting client replays everything
  // since its last_seq (the MT5 resume protocol). One global sequence via BIGSERIAL.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      seq         BIGSERIAL PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      site_id     TEXT,
      type        TEXT NOT NULL,
      payload     JSONB,
      created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_events_tenant_seq ON events(tenant_id, seq)');

  // Unique indexes for ETL idempotency (separate statements for WHERE clause)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_possales_extid
      ON pos_sales(tenant_id, ext_id) WHERE ext_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_extid
      ON customers(tenant_id, ext_id) WHERE ext_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_extid
      ON expenses(tenant_id, ext_id) WHERE ext_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_extid
      ON payroll(tenant_id, ext_id) WHERE ext_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_expenses_td
      ON expenses(tenant_id, expense_date);
    CREATE INDEX IF NOT EXISTS idx_payroll_t
      ON payroll(tenant_id, year, month);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_recon_extid
      ON reconciliations(tenant_id, ext_id) WHERE ext_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_recon_td
      ON reconciliations(tenant_id, txn_date, kind, status);
  `);

  // ── Phase 3: Fido feature parity ──────────────────────────────────────────

  await pool.query(`
    -- DISTRIBUTORS — agents/companies that collect product from sites
    CREATE TABLE IF NOT EXISTS distributors (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id),
      site_id       TEXT REFERENCES sites(id),
      name          TEXT NOT NULL,
      phone         TEXT,
      bank_name     TEXT,
      account_no    TEXT,
      account_name  TEXT,
      cashback_rate DOUBLE PRECISION DEFAULT 0,
      status        TEXT CHECK(status IN ('ACTIVE','INACTIVE')) DEFAULT 'ACTIVE',
      ext_id        TEXT,
      created_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(tenant_id, name)
    );

    -- VEHICLES — trucks belonging to distributors
    CREATE TABLE IF NOT EXISTS vehicles (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL REFERENCES tenants(id),
      distributor_id  TEXT REFERENCES distributors(id),
      plate           TEXT NOT NULL,
      capacity        DOUBLE PRECISION,
      model           TEXT,
      status          TEXT CHECK(status IN ('ACTIVE','INACTIVE')) DEFAULT 'ACTIVE',
      created_at      BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(tenant_id, plate)
    );

    -- LOADING ORDERS — one gate dispatch session
    CREATE TABLE IF NOT EXISTS loading_orders (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL REFERENCES tenants(id),
      site_id         TEXT REFERENCES sites(id),
      vehicle_id      TEXT REFERENCES vehicles(id),
      distributor_id  TEXT REFERENCES distributors(id),
      load_date       TEXT NOT NULL,
      status          TEXT CHECK(status IN
                        ('PENDING','LOADED','DISPATCHED','DELIVERED','SETTLED','CANCELLED'))
                        DEFAULT 'PENDING',
      total_bags      DOUBLE PRECISION DEFAULT 0,
      total_amount    DOUBLE PRECISION DEFAULT 0,
      cashback_amount DOUBLE PRECISION DEFAULT 0,
      notes           TEXT,
      approved_by     TEXT REFERENCES users(id),
      created_by      TEXT REFERENCES users(id),
      ext_id          TEXT,
      created_at      BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      dispatched_at   BIGINT,
      delivered_at    BIGINT
    );

    -- LOADING ITEMS — products in a loading order
    CREATE TABLE IF NOT EXISTS loading_items (
      id               TEXT PRIMARY KEY,
      loading_order_id TEXT NOT NULL REFERENCES loading_orders(id) ON DELETE CASCADE,
      tenant_id        TEXT NOT NULL REFERENCES tenants(id),
      product_id       TEXT REFERENCES products(id),
      product_name     TEXT NOT NULL,
      qty              DOUBLE PRECISION NOT NULL,
      unit_price       DOUBLE PRECISION DEFAULT 0,
      amount           DOUBLE PRECISION DEFAULT 0
    );

    -- CASHBACK LEDGER — distributor rebates per loading order
    CREATE TABLE IF NOT EXISTS cashbacks (
      id               TEXT PRIMARY KEY,
      tenant_id        TEXT NOT NULL REFERENCES tenants(id),
      distributor_id   TEXT NOT NULL REFERENCES distributors(id),
      site_id          TEXT REFERENCES sites(id),
      loading_order_id TEXT REFERENCES loading_orders(id),
      period_date      TEXT NOT NULL,
      bags             DOUBLE PRECISION DEFAULT 0,
      rate             DOUBLE PRECISION DEFAULT 0,
      amount           DOUBLE PRECISION DEFAULT 0,
      status           TEXT CHECK(status IN ('PENDING','PAID','CANCELLED')) DEFAULT 'PENDING',
      paid_at          BIGINT,
      notes            TEXT,
      created_at       BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    -- STAFF PAY RATES — what each staff member earns (versioned by effective date)
    CREATE TABLE IF NOT EXISTS staff_pay_rates (
      id             TEXT PRIMARY KEY,
      staff_id       TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      tenant_id      TEXT NOT NULL REFERENCES tenants(id),
      pay_type       TEXT CHECK(pay_type IN ('DAILY','MONTHLY','PIECE')) DEFAULT 'DAILY',
      daily_rate     DOUBLE PRECISION DEFAULT 0,
      monthly_rate   DOUBLE PRECISION DEFAULT 0,
      piece_rate     DOUBLE PRECISION DEFAULT 0,
      effective_from TEXT NOT NULL,
      created_at     BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(staff_id, effective_from)
    );

    -- PAYROLL RUNS — computed payroll batches
    CREATE TABLE IF NOT EXISTS payroll_runs (
      id                TEXT PRIMARY KEY,
      tenant_id         TEXT NOT NULL REFERENCES tenants(id),
      site_id           TEXT REFERENCES sites(id),
      period_start      TEXT NOT NULL,
      period_end        TEXT NOT NULL,
      status            TEXT CHECK(status IN ('DRAFT','APPROVED','PAID')) DEFAULT 'DRAFT',
      total_gross       DOUBLE PRECISION DEFAULT 0,
      total_net         DOUBLE PRECISION DEFAULT 0,
      total_deductions  DOUBLE PRECISION DEFAULT 0,
      headcount         INTEGER DEFAULT 0,
      notes             TEXT,
      computed_by       TEXT REFERENCES users(id),
      approved_by       TEXT REFERENCES users(id),
      created_at        BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(tenant_id, site_id, period_start, period_end)
    );

    -- PAYROLL RUN LINES — one row per staff member per run
    CREATE TABLE IF NOT EXISTS payroll_run_lines (
      id           TEXT PRIMARY KEY,
      run_id       TEXT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
      tenant_id    TEXT NOT NULL REFERENCES tenants(id),
      staff_id     TEXT REFERENCES staff(id),
      staff_name   TEXT NOT NULL,
      days_present INTEGER DEFAULT 0,
      hours        DOUBLE PRECISION DEFAULT 0,
      bags_bagged  INTEGER DEFAULT 0,
      bags_loaded  INTEGER DEFAULT 0,
      pay_type     TEXT,
      rate         DOUBLE PRECISION DEFAULT 0,
      gross_pay    DOUBLE PRECISION DEFAULT 0,
      deductions   DOUBLE PRECISION DEFAULT 0,
      net_pay      DOUBLE PRECISION DEFAULT 0,
      notes        TEXT
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_distributors_t  ON distributors(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_vehicles_dist   ON vehicles(distributor_id);
    CREATE INDEX IF NOT EXISTS idx_loadord_td      ON loading_orders(tenant_id, load_date);
    CREATE INDEX IF NOT EXISTS idx_loaditems_ord   ON loading_items(loading_order_id);
    CREATE INDEX IF NOT EXISTS idx_cashbacks_td    ON cashbacks(tenant_id, distributor_id);
    CREATE INDEX IF NOT EXISTS idx_payrates_staff  ON staff_pay_rates(staff_id);
    CREATE INDEX IF NOT EXISTS idx_payruns_t       ON payroll_runs(tenant_id, period_start);
    CREATE INDEX IF NOT EXISTS idx_paylines_run    ON payroll_run_lines(run_id);
  `);

  // ── Phase 4: Gate verification + unique customers ──────────────────────────
  await pool.query(`
    ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS exited_at BIGINT;
  `);
  // Unique customers per tenant (case-sensitive; ETL may have dupes so use IF NOT EXISTS)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_name
      ON customers(tenant_id, lower(name));
  `);

  // ── Phase 5: Loading point tracking ───────────────────────────────────────
  await pool.query(`
    ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS loaded_at BIGINT;
  `);

  // ── Phase 6: POS terminal / bank capture ──────────────────────────────────
  // Which bank/terminal a non-cash payment went through (Moniepoint vs GTB …).
  // `bank` = acquirer/source bank, `terminal` = a human label (location / SN).
  await pool.query(`
    ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS bank TEXT;
    ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS terminal TEXT;
    CREATE TABLE IF NOT EXISTS pos_terminals (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      site_id     TEXT,
      ext_id      TEXT,
      terminal_id TEXT,
      bank        TEXT,
      location    TEXT,
      sn          TEXT,
      company     TEXT,
      label       TEXT,
      status      TEXT DEFAULT 'ACTIVE',
      created_at  BIGINT DEFAULT (EXTRACT(EPOCH FROM now())::BIGINT)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_terminals_ext
      ON pos_terminals(tenant_id, ext_id) WHERE ext_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_pos_terminals_tenant ON pos_terminals(tenant_id);
  `);

  // ── Phase 7: Site messages (private note from a site user to the admin) ───────
  // Visible only to the sender and to admins. Each side can hide its own copy
  // (deleted_by_sender / deleted_by_admin) without removing the other's.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_messages (
      id               TEXT PRIMARY KEY,
      tenant_id        TEXT NOT NULL,
      site_id          TEXT,
      sender_id        TEXT NOT NULL,
      body             TEXT NOT NULL,
      deleted_by_sender BOOLEAN DEFAULT false,
      deleted_by_admin  BOOLEAN DEFAULT false,
      created_at       BIGINT DEFAULT (EXTRACT(EPOCH FROM now())::BIGINT)
    );
    CREATE INDEX IF NOT EXISTS idx_site_messages_tenant ON site_messages(tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_site_messages_sender ON site_messages(sender_id);
  `);

  // ── Phase 8: payroll run kind (REGULAR vs MIDMONTH piece-worker commission) ───
  await pool.query(`
    ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'REGULAR';
  `);

  // ── Phase 9: Inventory — raw-material/stock catalogue + signed movements ──────
  // on-hand = SUM(stock_moves.qty). RECEIVE = +qty, ISSUE = -qty, ADJUST = signed.
  // A receive may link to an expense_id (vendor payable) created at the same time.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_items (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL,
      name          TEXT NOT NULL,
      category      TEXT,
      unit          TEXT DEFAULT 'unit',
      sku           TEXT,
      barcode       TEXT,
      reorder_level DOUBLE PRECISION DEFAULT 0,
      status        TEXT DEFAULT 'ACTIVE',
      ext_id        TEXT,
      created_at    BIGINT DEFAULT (EXTRACT(EPOCH FROM now())::BIGINT)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_items_name ON stock_items(tenant_id, lower(name));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_items_ext ON stock_items(tenant_id, ext_id) WHERE ext_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS stock_moves (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      item_id     TEXT NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
      site_id     TEXT,
      type        TEXT NOT NULL,                 -- RECEIVE | ISSUE | ADJUST
      qty         DOUBLE PRECISION NOT NULL,     -- signed: + in, - out
      unit_cost   DOUBLE PRECISION DEFAULT 0,
      vendor      TEXT,
      ref         TEXT,
      note        TEXT,
      move_date   TEXT NOT NULL,
      expense_id  TEXT,
      created_by  TEXT,
      ext_id      TEXT,
      created_at  BIGINT DEFAULT (EXTRACT(EPOCH FROM now())::BIGINT)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_moves_item ON stock_moves(tenant_id, item_id);
    CREATE INDEX IF NOT EXISTS idx_stock_moves_site ON stock_moves(tenant_id, site_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_moves_ext ON stock_moves(tenant_id, ext_id) WHERE ext_id IS NOT NULL;
  `);

  // ── Phase 10: finished-goods — which product the daily "bagged" count produces.
  // Finished on-hand per site = Σ bags_bagged (produced) − Σ that product sold.
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bagged_product_id TEXT`);

  // Manual finished-goods production log — for products without an auto count
  // source (e.g. preform → 50cl/75cl bottles). Produced per site per day.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fg_production (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      site_id     TEXT,
      product_id  TEXT NOT NULL,
      qty         DOUBLE PRECISION NOT NULL,
      prod_date   TEXT NOT NULL,
      note        TEXT,
      created_by  TEXT,
      created_at  BIGINT DEFAULT (EXTRACT(EPOCH FROM now())::BIGINT)
    );
    CREATE INDEX IF NOT EXISTS idx_fg_prod ON fg_production(tenant_id, product_id);
  `);
}

module.exports = { initDb, getDb, pq, qone, qall, qrun, qexec, withTransaction };
