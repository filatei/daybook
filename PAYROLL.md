# Daybook — Staff Hours & Payroll (design sketch)

A future module that layers cleanly onto the existing model. **No existing table
changes** — everything hangs off `tenants` and `sites`, and access reuses the
same roles (Site Manager / General Manager / Admin / Superadmin).

## Concept

- A **staff** member belongs to a tenant and (usually) a site.
- **Time** is captured per staff per day — either clock in/out or a plain hours
  figure — by the Site Manager who already files the daily report.
- A **pay rate** (hourly, daily, or monthly salary) is attached to each staff
  member, effective-dated so raises don't rewrite history.
- A **payroll run** covers a pay period for a tenant; it freezes the timesheets
  in range and produces a **payslip** per staff member with gross, deductions,
  and net.

This mirrors how the daily report already works: site-level data entry rolls up
to company-level review and a finalised, emailable artifact.

## Tables (additive migration in `backend/db.js`)

```
staff
  id, tenant_id, site_id?, full_name, phone?, role_title?,
  pay_type (HOURLY|DAILY|MONTHLY), status (ACTIVE|INACTIVE),
  bank_name?, bank_account?, created_at

pay_rates                      -- effective-dated; never edit, always insert
  id, staff_id, pay_type, amount, currency, effective_from, created_by

timesheets                     -- one row per staff per day
  id, tenant_id, site_id, staff_id, work_date,
  hours?, clock_in?, clock_out?,         -- either hours OR in/out
  status (DRAFT|SUBMITTED|APPROVED|LOCKED),
  note?, recorded_by, created_at
  UNIQUE(staff_id, work_date)

payroll_runs
  id, tenant_id, period_start, period_end, status (OPEN|FINALISED|PAID),
  run_by, finalised_at, created_at

payslips                       -- one per staff per run (snapshot, immutable once finalised)
  id, run_id, staff_id, tenant_id,
  hours_total, gross, deductions_json, net,
  status (DRAFT|FINALISED|PAID), created_at
```

## Roles

| Action | Site Manager | General Manager | Admin |
|---|---|---|---|
| Record/submit timesheets for own site | ✅ | ✅ (any site) | ✅ |
| Manage staff & pay rates | — | view | ✅ |
| Approve timesheets | — | ✅ | ✅ |
| Run / finalise payroll | — | ✅ | ✅ |
| Mark payslips paid | — | — | ✅ |

(Superadmin can do all of the above in any tenant.)

## API outline (mirrors existing `needTenant(minRole)` guards)

```
GET    /api/staff?tenant=                 list (GM+; SITE_MANAGER → own site)
POST   /api/staff                         ADMIN — add staff
PATCH  /api/staff/:id                     ADMIN — edit / deactivate
POST   /api/staff/:id/rate                ADMIN — set a new effective-dated rate

GET    /api/timesheets?tenant=&site=&from=&to=
POST   /api/timesheets                    SITE_MANAGER (own site) / GM / ADMIN — upsert by (staff, date)
POST   /api/timesheets/approve            GM+ — approve a date range

GET    /api/payroll/runs?tenant=          GM+
POST   /api/payroll/runs                  GM+ — create run for a period (pulls approved timesheets)
POST   /api/payroll/runs/:id/finalise     GM+ — compute & freeze payslips
GET    /api/payroll/runs/:id/payslips     GM+
POST   /api/payroll/runs/:id/pay          ADMIN — mark paid; optionally email payslips
```

## Calculation

For each staff member in the run's period:

```
HOURLY  : gross = Σ(timesheet.hours) × rate.amount
DAILY   : gross = (count of days worked) × rate.amount
MONTHLY : gross = rate.amount × (period_days / month_days)   # pro-rated
net     = gross − Σ(deductions)        # deductions are a simple editable list
```

Rates are resolved by picking the `pay_rates` row with the latest
`effective_from <= work_date`, so historical runs stay correct after a raise.

## UI (adds one tab + admin entries)

- New bottom-nav tab **Staff** (visible to Site Managers and up):
  - Site Manager: a simple daily grid — staff × today — to enter hours, submit.
  - GM/Admin: staff list, approve timesheets, **Payroll** screen to create a run,
    review computed payslips, finalise, and email payslips via the existing mailer.
- Admin → **Staff & pay rates** for onboarding staff and setting rates.

## Reuse / why it's low-risk

- Same tenant isolation, same `contextFor`/`needTenant` guards, same mailer, same
  PWA shell, toasts, and modals.
- Purely additive tables → no migration risk to reports/documents.
- Payslip emailing reuses `sendDailyReport`'s pattern (a `sendPayslip` sibling).

> Status: **design only.** Say the word and I'll implement the tables, routes,
> calculation, and the Staff/Payroll UI, with smoke tests, the same way the
> reporting module was built.
