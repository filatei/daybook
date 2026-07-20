-- Who has bags recorded in a pay period, and whether payroll will pay them.
-- Mirrors computePieceLines(): paid if you bagged or loaded, WHATEVER your job
-- title, unless you are a %HIRED% day-labour placeholder or parked/LEFT.
-- Section A's "included" count should equal what a real compute produces.
--
-- Change the period here. Mid-month = 16th prev -> 15th; month-end = 28th -> 27th.
\set pfrom '2026-06-16'
\set pto   '2026-07-15'

\echo ''
\echo '════════════════════════════════════════════════════════════════'
\echo 'PAY PERIOD:' :pfrom '->' :pto
\echo '════════════════════════════════════════════════════════════════'

\echo ''
\echo '=== A. SUMMARY — staff with bags in the period, by payroll outcome ==='
WITH w AS (
  SELECT s.id,
         COALESCE(SUM(p.bags_bagged),0) bagged, COALESCE(SUM(p.bags_loaded),0) loaded,
         (UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%') AS not_hired,
         (COALESCE(s.payroll_eligible,TRUE) = TRUE
            AND COALESCE(s.status,'') <> 'LEFT')          AS is_eligible
    FROM production p
    JOIN staff s ON s.id = p.staff_id
   WHERE p.work_date BETWEEN :'pfrom' AND :'pto'
     AND (COALESCE(p.bags_bagged,0) > 0 OR COALESCE(p.bags_loaded,0) > 0)
   GROUP BY s.id, s.staff_type, s.pay_type, s.payroll_eligible, s.status
)
SELECT CASE WHEN NOT not_hired   THEN 'excluded - HIRED day labour (paid cash)'
            WHEN NOT is_eligible THEN 'MISSED - parked or marked LEFT'
            ELSE 'included in payroll' END AS outcome,
       COUNT(*) staff, SUM(bagged) bagged, SUM(loaded) loaded
  FROM w GROUP BY 1 ORDER BY 1;

\echo ''
\echo '=== B. has bags but payroll SKIPS them — expect only HIRED placeholders ==='
SELECT t.name tenant, si.name site, s.full_name,
       COALESCE(NULLIF(s.staff_type,''),'(none)') staff_type,
       COALESCE(NULLIF(s.pay_type,''),'(none)')   pay_type,
       COALESCE(s.status,'') status,
       COALESCE(s.payroll_eligible,TRUE) eligible,
       COALESCE(SUM(p.bags_bagged),0) bagged, COALESCE(SUM(p.bags_loaded),0) loaded,
       COUNT(*) days, MIN(p.work_date) first_day, MAX(p.work_date) last_day
  FROM production p
  JOIN staff s   ON s.id  = p.staff_id
  JOIN sites si  ON si.id = p.site_id
  JOIN tenants t ON t.id  = si.tenant_id
 WHERE p.work_date BETWEEN :'pfrom' AND :'pto'
   AND (COALESCE(p.bags_bagged,0) > 0 OR COALESCE(p.bags_loaded,0) > 0)
   AND NOT ( UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'
            AND COALESCE(s.payroll_eligible,TRUE) = TRUE
            AND COALESCE(s.status,'') <> 'LEFT' )
 GROUP BY 1,2,3,4,5,6,7
 ORDER BY bagged + loaded DESC;

\echo ''
\echo '=== C. bags per site in the period, with dates covered ==='
SELECT t.name tenant, si.name site,
       COUNT(DISTINCT p.staff_id) staff, COUNT(*) rows,
       COALESCE(SUM(p.bags_bagged),0) bagged, COALESCE(SUM(p.bags_loaded),0) loaded,
       MIN(p.work_date) first_day, MAX(p.work_date) last_day,
       COUNT(DISTINCT p.work_date) days_recorded
  FROM production p
  JOIN sites si  ON si.id = p.site_id
  JOIN tenants t ON t.id  = si.tenant_id
 WHERE p.work_date BETWEEN :'pfrom' AND :'pto'
   AND (COALESCE(p.bags_bagged,0) > 0 OR COALESCE(p.bags_loaded,0) > 0)
 GROUP BY 1,2 ORDER BY 1,2;
