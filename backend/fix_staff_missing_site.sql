-- Give every staff member a primary site.
--
-- All four creation paths (routes.js /staff, the payroll XLS import, the POS
-- import, and etl.js) already refuse to create staff without a site — these
-- rows predate that. A staff member with no site shows as "(no site)" in
-- payroll, cannot be grouped or reported per-site, and cannot be reconciled.
--
-- Inference: the site where they have actually worked most often. Someone may
-- bag at several sites; the primary is simply where they work most. Ties break
-- on total bags, then on the most recent day worked.
--
-- USAGE:  psql -v go=0 -f this.sql   -- dry run
--         psql -v go=1 -f this.sql   -- apply

\if :{?go} \else \set go 0 \endif

\echo ''
\echo '=== A. staff with no primary site, and where they actually work ==='
WITH ranked AS (
  SELECT p.staff_id, p.site_id,
         COUNT(*) rows,
         COALESCE(SUM(p.bags_bagged),0) + COALESCE(SUM(p.bags_loaded),0) bags,
         MAX(p.work_date) last_day,
         ROW_NUMBER() OVER (PARTITION BY p.staff_id
                            ORDER BY COUNT(*) DESC,
                                     COALESCE(SUM(p.bags_bagged),0) + COALESCE(SUM(p.bags_loaded),0) DESC,
                                     MAX(p.work_date) DESC) rn
    FROM production p
   GROUP BY p.staff_id, p.site_id
)
SELECT t.name tenant, s.full_name,
       COALESCE(NULLIF(s.staff_type,''),'(none)') staff_type,
       si.name AS will_be_set_to, r.rows, r.bags, r.last_day
  FROM staff s
  JOIN ranked r  ON r.staff_id = s.id AND r.rn = 1
  JOIN sites si  ON si.id = r.site_id
  JOIN tenants t ON t.id = s.tenant_id
 WHERE s.site_id IS NULL
 ORDER BY t.name, r.rows DESC;

\echo ''
\echo '=== B. staff with no site AND no production — must be assigned by hand ==='
SELECT t.name tenant, s.full_name,
       COALESCE(NULLIF(s.staff_type,''),'(none)') staff_type,
       COALESCE(NULLIF(s.pay_type,''),'(none)')   pay_type,
       s.status, COALESCE(s.payroll_eligible,TRUE) eligible
  FROM staff s
  JOIN tenants t ON t.id = s.tenant_id
 WHERE s.site_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM production p WHERE p.staff_id = s.id)
 ORDER BY t.name, s.full_name;

\echo ''
\if :go
  WITH ranked AS (
    SELECT p.staff_id, p.site_id,
           ROW_NUMBER() OVER (PARTITION BY p.staff_id
                              ORDER BY COUNT(*) DESC,
                                       COALESCE(SUM(p.bags_bagged),0) + COALESCE(SUM(p.bags_loaded),0) DESC,
                                       MAX(p.work_date) DESC) rn
      FROM production p
     GROUP BY p.staff_id, p.site_id
  )
  UPDATE staff s SET site_id = r.site_id
    FROM ranked r
   WHERE r.staff_id = s.id AND r.rn = 1 AND s.site_id IS NULL;
  \echo '>>> APPLIED. Section B staff still need a site set manually in Admin > Staff.'
\else
  \echo '>>> DRY RUN - nothing changed. Re-run with -v go=1 to apply.'
\endif
