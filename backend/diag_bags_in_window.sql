-- Who has bags recorded in a pay period, and whether payroll will pay them.
-- Predicates copied verbatim from routes_payroll.js (PIECE_WORKER /
-- PAYROLL_ELIGIBLE) so section A's "included" count should equal what a real
-- compute produces. If it does not, the compute has a bug.
--
-- Bags against non-bagger/loader staff are a DATA ERROR, not unpaid work: no
-- salaried staff does this job (confirmed by the Snr Accountant, 2026-07-20).
-- Section B is therefore a mis-keying report, and the fix is to correct the
-- row or the person's staff_type — not to pay it.
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
         (UPPER(COALESCE(s.staff_type,'')) IN ('BAGGER','LOADER')
            OR UPPER(COALESCE(s.pay_type,'')) = 'PIECE')  AS is_piece,
         (COALESCE(s.payroll_eligible,TRUE) = TRUE
            AND COALESCE(s.status,'') <> 'LEFT')          AS is_eligible
    FROM production p
    JOIN staff s ON s.id = p.staff_id
   WHERE p.work_date BETWEEN :'pfrom' AND :'pto'
     AND (COALESCE(p.bags_bagged,0) > 0 OR COALESCE(p.bags_loaded,0) > 0)
   GROUP BY s.id, s.staff_type, s.pay_type, s.payroll_eligible, s.status
)
SELECT CASE WHEN NOT is_piece    THEN 'NOT PAID - not a bagger/loader (check the data)'
            WHEN NOT is_eligible THEN 'NOT PAID - parked or marked LEFT'
            ELSE 'included in payroll' END AS outcome,
       COUNT(*) staff, SUM(bagged) bagged, SUM(loaded) loaded
  FROM w GROUP BY 1 ORDER BY 1;

\echo ''
\echo '=== B. MIS-KEYED ROWS — bags logged against people who do not do this job ==='
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
   AND NOT ( (UPPER(COALESCE(s.staff_type,'')) IN ('BAGGER','LOADER')
              OR UPPER(COALESCE(s.pay_type,'')) = 'PIECE')
            AND COALESCE(s.payroll_eligible,TRUE) = TRUE
            AND COALESCE(s.status,'') <> 'LEFT' )
 GROUP BY 1,2,3,4,5,6,7
 ORDER BY COALESCE(SUM(p.bags_bagged),0) + COALESCE(SUM(p.bags_loaded),0) DESC;

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
