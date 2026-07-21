-- ═══════════════════════════════════════════════════════════════════════════
--  DUPLICATE PEOPLE ON THE ROSTER
-- ═══════════════════════════════════════════════════════════════════════════
--
--  Found 2026-07-21 while reconciling the July mid-month run (₦823,743) against
--  the Snr Accountant's workbook (₦622,983). 29 people are on the roster TWICE:
--
--    FAITH SELEKE  id=4252                       (legacy numeric ext id)
--    FAITH SELEKE  id=69c7cd5d05ef8a6708961cbb   (Mongo ObjectId — from the ETL)
--
--  Both records carry their own production, so both were paid: ₦140,492 of
--  double payment in one fortnight. The accountant's sheet matches the numeric
--  id, overrides that record, and leaves the ObjectId twin still drawing its own
--  recorded bags.
--
--  computePieceLines now merges them at compute time (name + bank account), so
--  nobody is paid twice today. This finds them so the roster itself gets fixed —
--  merging at compute time is a safety net, not a substitute for one record per
--  person.
--
--  Run:  ssh user1@otuburu 'docker exec -i daybook-postgres psql -U daybook -d daybook' < diag_duplicate_people.sql
-- ═══════════════════════════════════════════════════════════════════════════

\echo '── People with more than one ACTIVE staff record ──────────────────────'

WITH norm AS (
  SELECT s.id, s.tenant_id, s.site_id, s.full_name, s.ext_people_id,
         s.staff_type, s.pay_type, s.bank_name, s.bank_account, s.status,
         lower(regexp_replace(btrim(s.full_name), '\s+', ' ', 'g')) AS nkey,
         -- An ObjectId-shaped ext id means the record came from the Fido ETL;
         -- a short numeric one is the legacy roster the accountant works from.
         (s.ext_people_id ~ '^[0-9a-f]{24}$')                        AS from_etl
  FROM staff s
  WHERE s.status = 'ACTIVE'
    AND COALESCE(s.payroll_eligible, TRUE) = TRUE
    AND upper(COALESCE(s.full_name, '')) NOT LIKE '%HIRED%'
),
dups AS (
  SELECT nkey FROM norm GROUP BY nkey HAVING COUNT(*) > 1
)
SELECT n.nkey                                        AS person,
       n.id                                          AS staff_id,
       n.ext_people_id,
       CASE WHEN n.from_etl THEN 'ETL twin' ELSE 'legacy' END AS origin,
       t.name                                        AS workspace,
       COALESCE(si.name, '— no site —')               AS site,
       n.staff_type,
       COALESCE(n.bank_name, '') || '-' || COALESCE(n.bank_account, '') AS account,
       COALESCE(p.bags, 0)                           AS bags_in_window,
       COALESCE(p.days, 0)                           AS days
FROM norm n
JOIN dups d ON d.nkey = n.nkey
LEFT JOIN tenants t ON t.id = n.tenant_id
LEFT JOIN sites si ON si.id = n.site_id
LEFT JOIN (
  SELECT staff_id,
         SUM(COALESCE(bags_loaded, 0) + COALESCE(bags_bagged, 0)) AS bags,
         COUNT(DISTINCT work_date)                                AS days
  FROM production
  WHERE work_date BETWEEN '2026-06-16' AND '2026-07-15'
  GROUP BY staff_id
) p ON p.staff_id = n.id
ORDER BY n.nkey, n.from_etl;

\echo ''
\echo '── What the duplication is worth in the July mid-month window ─────────'

WITH norm AS (
  SELECT s.id, lower(regexp_replace(btrim(s.full_name), '\s+', ' ', 'g')) AS nkey
  FROM staff s
  WHERE s.status = 'ACTIVE' AND COALESCE(s.payroll_eligible, TRUE) = TRUE
    AND upper(COALESCE(s.full_name, '')) NOT LIKE '%HIRED%'
),
bags AS (
  SELECT n.nkey, n.id,
         SUM(COALESCE(p.bags_loaded, 0) + COALESCE(p.bags_bagged, 0)) AS b
  FROM norm n
  JOIN production p ON p.staff_id = n.id
  WHERE p.work_date BETWEEN '2026-06-16' AND '2026-07-15'
  GROUP BY n.nkey, n.id
),
per_person AS (
  SELECT nkey, COUNT(*) AS records, SUM(b) AS total_bags, MAX(b) AS biggest
  FROM bags GROUP BY nkey
)
SELECT COUNT(*)                                  AS people_with_two_records,
       ROUND(SUM(total_bags - biggest)::numeric, 2) AS duplicated_bags,
       -- mid-month pays ₦1/bag, so bags and naira are the same number here
       ROUND(SUM(total_bags - biggest)::numeric, 2) AS naira_at_midmonth_rate,
       ROUND(SUM(total_bags - biggest)::numeric * 6, 2) AS naira_at_monthend_rate
FROM per_person
WHERE records > 1;
