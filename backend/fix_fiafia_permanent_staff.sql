-- Fiafia permanent staff missing from payroll (Aug 2026)
--
-- Root cause: each person exists twice — a Fiafia ETL row (DAILY @ ₦0) where
-- they badge-clock in, and a Fido import row (MONTHLY salary) with no attendance.
-- Combined payroll was picking the wrong duplicate as "head", paying ₦0.
--
-- Code fix: pickPayrollHead + name-based merge in computeCombinedLines (deploy first).
-- This script cleans the roster so duplicates stop confusing imports/reports.
--
-- DRY RUN:  psql -v go=0 -f fix_fiafia_permanent_staff.sql
-- APPLY:    psql -v go=1 -f fix_fiafia_permanent_staff.sql
--
-- Run on server:
--   ssh user1@otuburu 'docker exec -i daybook-postgres psql -U daybook -d daybook -v go=0' < backend/fix_fiafia_permanent_staff.sql

\if :{?go} \else \set go 0 \endif
\set ON_ERROR_STOP on
BEGIN;

\echo '=== A. Five reported names — current state ==='
SELECT s.full_name, t.slug, s.pay_type, s.daily_rate, si.name site,
       COALESCE(s.payroll_eligible, TRUE) eligible, s.badge_code,
       (SELECT COUNT(*) FROM attendance a WHERE a.staff_id=s.id AND a.clock_in IS NOT NULL) att_total
FROM staff s
JOIN tenants t ON t.id=s.tenant_id
LEFT JOIN sites si ON si.id=s.site_id
WHERE LOWER(REGEXP_REPLACE(TRIM(s.full_name), '\s+', ' ', 'g')) IN (
  LOWER('OTASOWIE SAMUEL ISOKEN'),
  LOWER('WARIOWEI YOUNA'),
  LOWER('KROBOH OWEIBIA'),
  LOWER('AYIBAKIYE SPECIAL ROMEO'),
  LOWER('SALIHU DAHIRU ADOGU')
)
ORDER BY 1, t.slug;

\echo ''
\echo '=== B. Park Fiafia DAILY @ ₦0 twins when a Fido MONTHLY salary twin exists ==='
CREATE TEMP TABLE _park ON COMMIT DROP AS
SELECT f.id AS fiafia_id, f.full_name, d.id AS fido_id, d.daily_rate AS fido_salary
FROM staff f
JOIN tenants tf ON tf.id=f.tenant_id AND tf.slug='fiafia'
JOIN staff d ON LOWER(REGEXP_REPLACE(TRIM(d.full_name), '\s+', ' ', 'g'))
              = LOWER(REGEXP_REPLACE(TRIM(f.full_name), '\s+', ' ', 'g'))
JOIN tenants td ON td.id=d.tenant_id AND td.slug='fido'
WHERE f.status='ACTIVE' AND COALESCE(f.payroll_eligible, TRUE)
  AND UPPER(COALESCE(f.pay_type,''))='DAILY' AND COALESCE(f.daily_rate,0)=0
  AND d.status='ACTIVE' AND UPPER(COALESCE(d.pay_type,''))='MONTHLY' AND COALESCE(d.daily_rate,0)>0;

SELECT full_name, fiafia_id, fido_id, fido_salary FROM _park ORDER BY 1;

\echo ''
\echo '=== C. Salihu — align Fido bank to Fiafia (accounts drifted; blocks merge) ==='
SELECT f.full_name, t.slug, f.bank_name, f.bank_account
FROM staff f JOIN tenants t ON t.id=f.tenant_id
WHERE LOWER(TRIM(f.full_name))=LOWER('SALIHU DAHIRU ADOGU')
ORDER BY t.slug;

\if :go
  UPDATE staff SET payroll_eligible=FALSE,
    eligibility_note='Fiafia ETL twin — pay via combined Fido MONTHLY record',
    eligibility_at=EXTRACT(EPOCH FROM NOW())::BIGINT
  FROM _park p WHERE staff.id=p.fiafia_id;

  UPDATE staff d SET bank_name=f.bank_name, bank_account=f.bank_account
  FROM staff f
  JOIN tenants tf ON tf.id=f.tenant_id AND tf.slug='fiafia'
  JOIN tenants td ON td.id=d.tenant_id AND td.slug='fido'
  WHERE LOWER(REGEXP_REPLACE(TRIM(d.full_name), '\s+', ' ', 'g'))
      = LOWER(REGEXP_REPLACE(TRIM(f.full_name), '\s+', ' ', 'g'))
    AND LOWER(TRIM(f.full_name))=LOWER('SALIHU DAHIRU ADOGU')
    AND f.bank_account IS NOT NULL AND f.bank_account <> COALESCE(d.bank_account,'');

  \echo '*** COMMITTED roster cleanup. ***'
  COMMIT;
\else
  \echo '*** DRY RUN — re-run with -v go=1 to apply. Deploy code fix first. ***'
  ROLLBACK;
\endif
