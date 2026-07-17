-- Decision support BEFORE re-typing titled baggers/loaders as piece workers.
-- Read-only. Answers: would the re-type PAY people, or CUT their pay?
--
--   ssh user1@otuburu 'docker exec -i daybook-postgres sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB"' < backend/diag_retype.sql
--
-- Window = the mid-month cycle just closed. Keep in step with diag_midmonth.sql.
\set win_from '2026-06-16'
\set win_to   '2026-07-15'

\echo '=== A. The re-type population: titled BAGGER/LOADER but typed REGULAR ==='
\echo '    daily_rate > 0 means they are on a DAILY WAGE today — re-typing them to'
\echo '    PIECE replaces that wage with per-bag commission. Those are the risky ones.'
SELECT t.name AS tenant,
  CASE WHEN COALESCE(s.daily_rate,0) > 0 THEN 'on a daily wage (daily_rate > 0)'
       ELSE 'earning nothing (daily_rate = 0)' END AS pay_today,
  COUNT(*) AS staff,
  MIN(s.daily_rate) AS min_rate, MAX(s.daily_rate) AS max_rate
FROM staff s JOIN tenants t ON t.id = s.tenant_id
WHERE s.status = 'ACTIVE'
  AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'
  AND UPPER(COALESCE(s.role_title,'')) IN ('BAGGER','LOADER')
  AND UPPER(COALESCE(s.staff_type,'')) NOT IN ('BAGGER','LOADER')
GROUP BY 1,2 ORDER BY 1,2;

\echo ''
\echo '=== B. Of those, the ones WITH bags in the window — the people actually affected ==='
SELECT t.name AS tenant,
  CASE WHEN COALESCE(s.daily_rate,0) > 0 THEN 'on a daily wage' ELSE 'earning nothing' END AS pay_today,
  COUNT(DISTINCT s.id) AS workers,
  SUM(p.bags_loaded + p.bags_bagged) AS bags
FROM production p
  JOIN staff s   ON s.id = p.staff_id
  JOIN tenants t ON t.id = s.tenant_id
WHERE p.work_date BETWEEN :'win_from' AND :'win_to'
  AND s.status = 'ACTIVE'
  AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'
  AND UPPER(COALESCE(s.role_title,'')) IN ('BAGGER','LOADER')
  AND UPPER(COALESCE(s.staff_type,'')) NOT IN ('BAGGER','LOADER')
GROUP BY 1,2 ORDER BY 1,2;

\echo ''
\echo '=== C. MONEY: what each affected person earns now (daily wage) vs after re-type (bags x 6) ==='
\echo '    delta < 0 means the re-type would CUT their pay. Nobody should be worse off.'
WITH att AS (
  SELECT staff_id, COUNT(DISTINCT work_date) days FROM attendance
  WHERE clock_in IS NOT NULL AND work_date BETWEEN :'win_from' AND :'win_to' GROUP BY staff_id
), prod AS (
  SELECT staff_id, SUM(bags_loaded) l, SUM(bags_bagged) g FROM production
  WHERE work_date BETWEEN :'win_from' AND :'win_to' GROUP BY staff_id
)
SELECT t.name AS tenant, s.full_name, s.role_title,
  COALESCE(s.daily_rate,0)                                  AS daily_rate,
  COALESCE(a.days,0)                                        AS days,
  ROUND((COALESCE(a.days,0) * COALESCE(s.daily_rate,0))::numeric, 2) AS earns_now_daily_wage,
  ROUND(((COALESCE(pr.l,0) + COALESCE(pr.g,0)) * 6)::numeric, 2)     AS after_retype_at_6,
  ROUND((((COALESCE(pr.l,0) + COALESCE(pr.g,0)) * 6)
         - (COALESCE(a.days,0) * COALESCE(s.daily_rate,0)))::numeric, 2) AS delta
FROM staff s
  JOIN tenants t ON t.id = s.tenant_id
  LEFT JOIN att  a  ON a.staff_id  = s.id
  LEFT JOIN prod pr ON pr.staff_id = s.id
WHERE s.status = 'ACTIVE'
  AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'
  AND UPPER(COALESCE(s.role_title,'')) IN ('BAGGER','LOADER')
  AND UPPER(COALESCE(s.staff_type,'')) NOT IN ('BAGGER','LOADER')
  AND (COALESCE(pr.l,0) + COALESCE(pr.g,0)) > 0
ORDER BY delta ASC;

\echo ''
\echo '=== D. Stale roster check: how many of the re-type population have NO bags and NO clock-ins? ==='
\echo '    Almost certainly ex-staff nobody deactivated. Mark them LEFT rather than re-type them.'
SELECT t.name AS tenant, COUNT(*) AS never_worked_this_window
FROM staff s JOIN tenants t ON t.id = s.tenant_id
WHERE s.status = 'ACTIVE'
  AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'
  AND UPPER(COALESCE(s.role_title,'')) IN ('BAGGER','LOADER')
  AND UPPER(COALESCE(s.staff_type,'')) NOT IN ('BAGGER','LOADER')
  AND NOT EXISTS (SELECT 1 FROM production p WHERE p.staff_id = s.id
                    AND p.work_date BETWEEN :'win_from' AND :'win_to')
  AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.staff_id = s.id
                    AND a.work_date BETWEEN :'win_from' AND :'win_to')
GROUP BY 1 ORDER BY 1;

\echo ''
\echo '=== E. Data quality: bags recorded against people who are NOT baggers/loaders ==='
\echo '    A SECRETARY with 2,200 bags is a mis-keyed entry, not a payroll case.'
SELECT t.name AS tenant, s.full_name, s.role_title,
  SUM(p.bags_loaded + p.bags_bagged) AS bags
FROM production p
  JOIN staff s   ON s.id = p.staff_id
  JOIN tenants t ON t.id = s.tenant_id
WHERE p.work_date BETWEEN :'win_from' AND :'win_to'
  AND UPPER(COALESCE(s.role_title,'')) NOT IN ('BAGGER','LOADER')
GROUP BY 1,2,3
HAVING SUM(p.bags_loaded + p.bags_bagged) > 0
ORDER BY 4 DESC;
