/**
 * Daybook — SQLite data layer (multi-client SaaS)
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
 * Drop-in SQLite; no external DB service. Upgrade path -> PostgreSQL by swapping
 * this module (same exported getDb() surface).
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DAYBOOK_DB_PATH || path.join(__dirname, '../data/daybook.db');

let db;
function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    -- TENANTS — one per client company / workspace
    CREATE TABLE IF NOT EXISTS tenants (
      id           TEXT PRIMARY KEY,
      slug         TEXT UNIQUE NOT NULL,
      name         TEXT NOT NULL,
      brand_color  TEXT DEFAULT '#0ea5e9',
      currency     TEXT DEFAULT 'NGN',
      industry     TEXT,
      plan         TEXT CHECK(plan IN ('FREE','STANDARD','PRO','OWNER')) DEFAULT 'FREE',
      status       TEXT CHECK(status IN ('ACTIVE','SUSPENDED')) DEFAULT 'ACTIVE',
      trial_ends_at INTEGER,                               -- end of 30-day trial (NULL = OWNER, no trial)
      paid_until    INTEGER,                               -- subscription paid through (epoch)
      pos_source    TEXT,                                  -- e.g. 'FIDO' → connect to fido POS; NULL = self-contained
      created_by   TEXT,
      created_at   INTEGER DEFAULT (unixepoch())
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
      last_login    INTEGER,
      created_at    INTEGER DEFAULT (unixepoch())
    );

    -- MEMBERSHIPS — a user's role inside a tenant
    CREATE TABLE IF NOT EXISTS memberships (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      role        TEXT CHECK(role IN ('ADMIN','GENERAL_MANAGER','SITE_MANAGER')) NOT NULL,
      site_id     TEXT REFERENCES sites(id),
      status      TEXT CHECK(status IN ('ACTIVE','DISABLED')) DEFAULT 'ACTIVE',
      created_at  INTEGER DEFAULT (unixepoch()),
      UNIQUE(user_id, tenant_id)
    );

    -- SITES — physical locations within a tenant
    CREATE TABLE IF NOT EXISTS sites (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      code        TEXT NOT NULL,
      name        TEXT NOT NULL,
      address     TEXT,
      is_hq       INTEGER DEFAULT 0,
      status      TEXT CHECK(status IN ('ACTIVE','CLOSED')) DEFAULT 'ACTIVE',
      created_at  INTEGER DEFAULT (unixepoch()),
      UNIQUE(tenant_id, code)
    );

    -- DAILY REPORTS — one per site per day
    CREATE TABLE IF NOT EXISTS daily_reports (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id),
      site_id       TEXT NOT NULL REFERENCES sites(id),
      report_date   TEXT NOT NULL,
      total_sales   REAL DEFAULT 0,
      total_cash    REAL DEFAULT 0,
      total_deposit REAL DEFAULT 0,
      diesel        REAL DEFAULT 0,
      expenses      REAL DEFAULT 0,
      balance       REAL DEFAULT 0,
      sales_json      TEXT,
      production_json TEXT,
      notes         TEXT,
      status        TEXT CHECK(status IN ('DRAFT','SUBMITTED','EMAILED')) DEFAULT 'DRAFT',
      created_by    TEXT REFERENCES users(id),
      created_at    INTEGER DEFAULT (unixepoch()),
      submitted_at  INTEGER,
      emailed_at    INTEGER,
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
      created_at    INTEGER DEFAULT (unixepoch())
    );

    -- REPORT RECIPIENTS — per-tenant email distribution list
    CREATE TABLE IF NOT EXISTS recipients (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      email       TEXT NOT NULL,
      name        TEXT,
      active      INTEGER DEFAULT 1,
      created_at  INTEGER DEFAULT (unixepoch()),
      UNIQUE(tenant_id, email)
    );

    -- INVITES — pending memberships for emails not yet signed in
    CREATE TABLE IF NOT EXISTS invites (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      email       TEXT NOT NULL,
      role        TEXT CHECK(role IN ('ADMIN','GENERAL_MANAGER','SITE_MANAGER')) NOT NULL,
      site_id     TEXT REFERENCES sites(id),
      invited_by  TEXT REFERENCES users(id),
      created_at  INTEGER DEFAULT (unixepoch()),
      UNIQUE(tenant_id, email)
    );

    -- STAFF — a worker at a site (Daybook-owned; optionally linked to a POS person)
    CREATE TABLE IF NOT EXISTS staff (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id),
      site_id       TEXT REFERENCES sites(id),
      full_name     TEXT NOT NULL,
      role_title    TEXT,
      phone         TEXT,
      pay_type      TEXT CHECK(pay_type IN ('HOURLY','DAILY','MONTHLY','PIECE')) DEFAULT 'DAILY',
      ext_people_id TEXT,                                  -- fido peoples _id when imported
      status        TEXT CHECK(status IN ('ACTIVE','INACTIVE')) DEFAULT 'ACTIVE',
      created_at    INTEGER DEFAULT (unixepoch()),
      UNIQUE(tenant_id, site_id, full_name)
    );

    -- TIMESHEETS — one row per staff per day (the live hours fido lacks)
    CREATE TABLE IF NOT EXISTS timesheets (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL REFERENCES tenants(id),
      site_id      TEXT NOT NULL REFERENCES sites(id),
      staff_id     TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      work_date    TEXT NOT NULL,                          -- YYYY-MM-DD
      present      INTEGER DEFAULT 1,
      hours        REAL,
      bags_bagged  INTEGER,
      bags_loaded  INTEGER,
      note         TEXT,
      recorded_by  TEXT REFERENCES users(id),
      created_at   INTEGER DEFAULT (unixepoch()),
      UNIQUE(staff_id, work_date)
    );

    -- GENERATORS — a power generator asset at a site (spec registered once)
    CREATE TABLE IF NOT EXISTS generators (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id),
      site_id       TEXT REFERENCES sites(id),
      name          TEXT NOT NULL,
      fuel_type     TEXT CHECK(fuel_type IN ('DIESEL','PETROL','GAS')) DEFAULT 'DIESEL',
      make_model    TEXT,
      capacity_kva  REAL,
      serial_no     TEXT,
      purchase_date TEXT,
      purchase_cost REAL,
      status        TEXT CHECK(status IN ('ACTIVE','RETIRED')) DEFAULT 'ACTIVE',
      notes         TEXT,
      created_by    TEXT REFERENCES users(id),
      created_at    INTEGER DEFAULT (unixepoch())
    );

    -- GENERATOR LOGS — periodic diesel fills + maintenance entries
    CREATE TABLE IF NOT EXISTS generator_logs (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id),
      generator_id  TEXT NOT NULL REFERENCES generators(id) ON DELETE CASCADE,
      site_id       TEXT REFERENCES sites(id),
      log_date      TEXT NOT NULL,
      type          TEXT CHECK(type IN ('DIESEL','MAINTENANCE','NOTE')) NOT NULL,
      litres        REAL,                                  -- for DIESEL
      cost          REAL,                                  -- diesel or maintenance cost
      runtime_hours REAL,
      detail        TEXT,                                  -- maintenance/note detail
      recorded_by   TEXT REFERENCES users(id),
      created_at    INTEGER DEFAULT (unixepoch())
    );

    -- ── In-app POS (self-contained tenants: live sales + receipts) ────────────
    CREATE TABLE IF NOT EXISTS products (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      name        TEXT NOT NULL,
      category    TEXT,
      price       REAL NOT NULL DEFAULT 0,
      cost        REAL DEFAULT 0,
      sku         TEXT,
      unit        TEXT DEFAULT 'unit',
      track_stock INTEGER DEFAULT 1,
      stock_qty   REAL DEFAULT 0,
      status      TEXT CHECK(status IN ('ACTIVE','INACTIVE')) DEFAULT 'ACTIVE',
      created_at  INTEGER DEFAULT (unixepoch()),
      UNIQUE(tenant_id, name)
    );

    CREATE TABLE IF NOT EXISTS customers (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      name        TEXT NOT NULL,
      phone       TEXT,
      email       TEXT,
      note        TEXT,
      created_at  INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS pos_sales (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id),
      site_id       TEXT REFERENCES sites(id),
      receipt_no    INTEGER,
      customer_id   TEXT REFERENCES customers(id),
      customer_name TEXT,
      items_json    TEXT,                                  -- [{product_id,name,qty,price,amount}]
      subtotal      REAL DEFAULT 0,
      discount      REAL DEFAULT 0,
      total         REAL DEFAULT 0,
      payment_method TEXT,
      amount_paid   REAL DEFAULT 0,
      balance       REAL DEFAULT 0,
      status        TEXT CHECK(status IN ('PAID','PART','UNPAID')) DEFAULT 'PAID',
      sale_date     TEXT,
      client_uid    TEXT,                                  -- client-generated; dedupes offline re-sends
      sold_by       TEXT REFERENCES users(id),
      created_at    INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS inventory_moves (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      site_id     TEXT REFERENCES sites(id),
      type        TEXT CHECK(type IN ('PURCHASE','SALE','ADJUST')) NOT NULL,
      qty         REAL NOT NULL,                           -- signed: + in, - out
      unit_cost   REAL,
      ref         TEXT,
      note        TEXT,
      created_by  TEXT REFERENCES users(id),
      created_at  INTEGER DEFAULT (unixepoch())
    );

    -- ── Staff chat (WhatsApp-style channels per company) ──────────────────────
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      channel     TEXT NOT NULL,                           -- 'team' or a site_id
      user_id     TEXT REFERENCES users(id),
      user_name   TEXT,
      body        TEXT NOT NULL,
      client_uid  TEXT,
      created_at  INTEGER DEFAULT (unixepoch())
    );

    -- ── In-app notifications ──────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS notifications (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT REFERENCES tenants(id),
      user_id     TEXT NOT NULL REFERENCES users(id),
      type        TEXT,
      title       TEXT,
      body        TEXT,
      link        TEXT,
      read        INTEGER DEFAULT 0,
      created_at  INTEGER DEFAULT (unixepoch())
    );

    -- ── Feature requests (clients submit ideas; admins/superadmin triage) ──────
    CREATE TABLE IF NOT EXISTS feature_requests (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT REFERENCES tenants(id),
      user_id     TEXT REFERENCES users(id),
      user_name   TEXT,
      title       TEXT NOT NULL,
      body        TEXT,
      status      TEXT DEFAULT 'NEW',          -- NEW | PLANNED | IN_PROGRESS | DONE | DECLINED
      votes       INTEGER DEFAULT 0,
      created_at  INTEGER DEFAULT (unixepoch()),
      updated_at  INTEGER DEFAULT (unixepoch())
    );

    -- ── Subscription payments (Paystack) ──────────────────────────────────────
    CREATE TABLE IF NOT EXISTS payments (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      reference   TEXT UNIQUE NOT NULL,
      plan        TEXT,
      months      INTEGER,
      amount      INTEGER,                                 -- major unit (₦)
      currency    TEXT,
      status      TEXT DEFAULT 'PENDING',                  -- PENDING | SUCCESS | FAILED
      email       TEXT,
      created_by  TEXT REFERENCES users(id),
      created_at  INTEGER DEFAULT (unixepoch()),
      paid_at     INTEGER,
      raw         TEXT
    );

    CREATE TABLE IF NOT EXISTS email_log (
      id TEXT PRIMARY KEY, tenant_id TEXT, report_id TEXT, to_addrs TEXT,
      subject TEXT, status TEXT, error TEXT, created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, action TEXT,
      entity TEXT, entity_id TEXT, meta TEXT, created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_member_user   ON memberships(user_id);
    CREATE INDEX IF NOT EXISTS idx_member_tenant ON memberships(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_reports_td    ON daily_reports(tenant_id, report_date);
    CREATE INDEX IF NOT EXISTS idx_docs_tc       ON documents(tenant_id, category);
    CREATE INDEX IF NOT EXISTS idx_sites_tenant  ON sites(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_genlogs       ON generator_logs(tenant_id, generator_id, log_date);
    CREATE INDEX IF NOT EXISTS idx_products_t    ON products(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_possales_td   ON pos_sales(tenant_id, sale_date);
    CREATE INDEX IF NOT EXISTS idx_invmoves      ON inventory_moves(tenant_id, product_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_possales_uid ON pos_sales(tenant_id, client_uid) WHERE client_uid IS NOT NULL;
  `);

  // Idempotent column adds for databases created before these columns existed.
  const addCol = (table, col, def) => { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (e) { /* already exists */ } };
  addCol('tenants', 'trial_ends_at', 'INTEGER');
  addCol('tenants', 'paid_until', 'INTEGER');
  addCol('tenants', 'pos_source', 'TEXT');
  addCol('pos_sales', 'client_uid', 'TEXT');
  // multi-provider payments (Monnify / Paystack) — provider + gateway reference
  addCol('payments', 'provider', 'TEXT');
  addCol('payments', 'provider_reference', 'TEXT');
  // Lemon Squeezy recurring subscription (per tenant)
  addCol('tenants', 'ls_subscription_id', 'TEXT');
  addCol('tenants', 'subscription_status', 'TEXT');
  addCol('tenants', 'subscription_ends_at', 'INTEGER');
  addCol('tenants', 'subscription_renews_at', 'INTEGER');
  addCol('tenants', 'customer_portal_url', 'TEXT');
}

module.exports = { getDb };
