-- Everything Mbiama actually has, unfiltered — including rows with zero bags,
-- which the payroll diagnostics deliberately exclude.

\echo ''
\echo '=== 1. EVERY production row Mbiama has ever had ==='
SELECT p.work_date, s.full_name,
       COALESCE(NULLIF(s.staff_type,''),'(none)') staff_type,
       COALESCE(NULLIF(s.pay_type,''),'(none)')   pay_type,
       COALESCE(p.bags_bagged,0) bagged, COALESCE(p.bags_loaded,0) loaded,
       COALESCE(p.hours,0) hours, u.name recorded_by
  FROM production p
  JOIN staff s   ON s.id = p.staff_id
  JOIN sites si  ON si.id = p.site_id
  LEFT JOIN users u ON u.id = p.recorded_by
 WHERE UPPER(si.name) LIKE '%MBIAMA%'
 ORDER BY p.work_date DESC, s.full_name;

\echo ''
\echo '=== 2. Mbiama baggers/loaders on the roster (first 25) ==='
SELECT s.full_name,
       COALESCE(NULLIF(s.staff_type,''),'(none)') staff_type,
       COALESCE(NULLIF(s.pay_type,''),'(none)')   pay_type,
       s.status, COALESCE(s.payroll_eligible,TRUE) eligible,
       (s.bank_account IS NOT NULL AND s.bank_account <> '') has_bank
  FROM staff s JOIN sites si ON si.id = s.site_id
 WHERE UPPER(si.name) LIKE '%MBIAMA%'
   AND (UPPER(COALESCE(s.staff_type,'')) IN ('BAGGER','LOADER')
        OR UPPER(COALESCE(s.pay_type,'')) = 'PIECE')
 ORDER BY s.full_name LIMIT 25;

\echo ''
\echo '=== 3. has ANY Mbiama staff EVER had a bag recorded, at ANY site? ==='
SELECT s.full_name, si2.name AS site_where_recorded,
       COUNT(*) rows, COALESCE(SUM(p.bags_bagged),0) bagged,
       COALESCE(SUM(p.bags_loaded),0) loaded,
       MIN(p.work_date) first_day, MAX(p.work_date) last_day
  FROM staff s
  JOIN sites si  ON si.id = s.site_id
  JOIN production p ON p.staff_id = s.id
  JOIN sites si2 ON si2.id = p.site_id
 WHERE UPPER(si.name) LIKE '%MBIAMA%'
   AND (COALESCE(p.bags_bagged,0) > 0 OR COALESCE(p.bags_loaded,0) > 0)
 GROUP BY 1,2
 ORDER BY 3 DESC LIMIT 30;

\echo ''
\echo '=== 4. who records at Mbiama vs Akenfa (are staff even using the app?) ==='
SELECT si.name site, u.name recorded_by, COUNT(*) rows,
       MIN(p.work_date) first_day, MAX(p.work_date) last_day
  FROM production p
  JOIN sites si ON si.id = p.site_id
  JOIN tenants t ON t.id = si.tenant_id
  LEFT JOIN users u ON u.id = p.recorded_by
 WHERE UPPER(t.name) LIKE '%FIAFIA%'
 GROUP BY 1,2 ORDER BY 1,3 DESC;
