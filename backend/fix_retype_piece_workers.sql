-- FIX: staff whose job title is BAGGER/LOADER but who are typed REGULAR.
-- They are invisible to mid-month (which filters on staff_type/pay_type) and earn
-- nothing at month-end (their daily_rate is 0), so they are paid for none of the
-- bags they carry.
--
-- Verified before writing this (backend/diag_retype.sql, cycle 2026-06-16→07-15):
--   * ALL 1,925 have daily_rate = 0 — nobody is on a daily wage, so no pay is cut.
--   * 52 of them have bags and are owed N1,215,024.81 at N6/bag. Every delta positive.
--   * The other ~1,873 have no bags: commission <= 0 is skipped, so they stay unpaid.
--     Re-typing them moves no money — it only files them under the right heading.
--
-- Excluded on purpose:
--   * %HIRED% placeholders — casual day-labour, paid cash on the day, never payroll.
--   * Anyone not titled BAGGER/LOADER — so the SECRETARY with 2,200 bags, the MANAGER,
--     the QC ANALYST and the CLEANER are left for a human to look at.
--
-- RUN IT TWICE. Dry run first (rolls back, shows you everything), then commit:
--
--   D="ssh user1@otuburu docker exec -i daybook-postgres"
--   # 1. dry run — changes nothing
--   ssh user1@otuburu 'docker exec -i daybook-postgres sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -v go=0"' < backend/fix_retype_piece_workers.sql
--   # 2. for real
--   ssh user1@otuburu 'docker exec -i daybook-postgres sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -v go=1"' < backend/fix_retype_piece_workers.sql
--
-- Defaults to a DRY RUN if -v go=1 is not passed, so a mistyped command is harmless.

\if :{?go}
\else
  \set go 0
\endif
\set ON_ERROR_STOP on

BEGIN;

\echo '=== BEFORE ==='
SELECT t.name AS tenant, s.staff_type, s.pay_type, COUNT(*)
FROM staff s JOIN tenants t ON t.id = s.tenant_id
WHERE s.status = 'ACTIVE' GROUP BY 1,2,3 ORDER BY 1,2,3;

UPDATE staff SET
  staff_type = UPPER(TRIM(role_title)),
  pay_type   = 'PIECE'
WHERE status = 'ACTIVE'
  AND UPPER(COALESCE(full_name,'')) NOT LIKE '%HIRED%'
  AND UPPER(TRIM(COALESCE(role_title,''))) IN ('BAGGER','LOADER')
  AND UPPER(COALESCE(staff_type,'')) NOT IN ('BAGGER','LOADER');

\echo ''
\echo '=== AFTER (BAGGER/LOADER now hold the piece workers; REGULAR only real office staff) ==='
SELECT t.name AS tenant, s.staff_type, s.pay_type, COUNT(*)
FROM staff s JOIN tenants t ON t.id = s.tenant_id
WHERE s.status = 'ACTIVE' GROUP BY 1,2,3 ORDER BY 1,2,3;

\echo ''
\echo '=== CHECK: nobody with bags is dropped any more (expect NO "DROPPED" row) ==='
SELECT t.name AS tenant,
  CASE WHEN UPPER(COALESCE(s.staff_type,'')) IN ('BAGGER','LOADER')
            OR UPPER(COALESCE(s.pay_type,'')) = 'PIECE'
       THEN 'PAID' ELSE 'DROPPED' END AS outcome,
  COUNT(DISTINCT s.id) AS workers, SUM(p.bags_loaded + p.bags_bagged) AS bags
FROM production p JOIN staff s ON s.id = p.staff_id JOIN tenants t ON t.id = s.tenant_id
WHERE p.work_date BETWEEN '2026-06-16' AND '2026-07-15'
  AND s.status = 'ACTIVE'
  AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'
GROUP BY 1,2 ORDER BY 1,2;

\echo ''
\if :go
  \echo '*** COMMITTING — the change is now live. ***'
  COMMIT;
\else
  \echo '*** DRY RUN — nothing saved. Re-run with -v go=1 to apply. ***'
  ROLLBACK;
\endif
