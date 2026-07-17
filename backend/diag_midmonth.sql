-- Why is a tenant's bagger/loader missing from mid-month?
-- Walks the EXACT funnel computePieceLines() applies, per tenant, so the step
-- that drops the workers is visible rather than guessed at.
--
--   docker compose exec -T postgres psql -U daybook -d daybook -f - < backend/diag_midmonth.sql
--
-- Edit the window below to the cycle you're checking (16th prev -> 15th current).
\set win_from '2026-06-16'
\set win_to   '2026-07-15'

\echo '=== 1. Staff funnel per tenant (each column is one filter, applied in order) ==='
SELECT t.name AS tenant,
  COUNT(*)                                                                       AS staff_rows,
  COUNT(*) FILTER (WHERE s.status = 'ACTIVE')                                    AS active,
  COUNT(*) FILTER (WHERE s.status = 'ACTIVE'
    AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%')                      AS not_hired,
  COUNT(*) FILTER (WHERE s.status = 'ACTIVE'
    AND COALESCE(s.payroll_eligible, TRUE) = TRUE
    AND COALESCE(s.status,'') <> 'LEFT')                                         AS payroll_eligible,
  -- THE filter that most likely zeroes a tenant out:
  COUNT(*) FILTER (WHERE s.status = 'ACTIVE'
    AND (UPPER(COALESCE(s.staff_type,'')) IN ('BAGGER','LOADER')
         OR UPPER(COALESCE(s.pay_type,'')) = 'PIECE'))                           AS passes_piece_filter
FROM staff s JOIN tenants t ON t.id = s.tenant_id
GROUP BY t.name ORDER BY t.name;

\echo ''
\echo '=== 2. How each tenant classifies its people (staff_type/pay_type vs the job title) ==='
\echo '    A tenant whose baggers sit in staff_type=REGULAR can never appear in mid-month.'
SELECT t.name AS tenant,
  COALESCE(NULLIF(UPPER(COALESCE(s.staff_type,'')),''), '(unset)') AS staff_type,
  COALESCE(NULLIF(UPPER(COALESCE(s.pay_type,'')),''),   '(unset)') AS pay_type,
  COUNT(*) AS staff,
  COUNT(*) FILTER (WHERE UPPER(COALESCE(s.role_title,'')) IN ('BAGGER','LOADER')) AS titled_bagger_or_loader
FROM staff s JOIN tenants t ON t.id = s.tenant_id
WHERE s.status = 'ACTIVE'
GROUP BY 1,2,3 ORDER BY 1,2,3;

\echo ''
\echo '=== 3. Production actually recorded in the window, per tenant ==='
\echo '    Zero here means nobody logged bags — a data-entry gap, not a payroll bug.'
SELECT t.name AS tenant,
  COUNT(*)                     AS production_rows,
  COUNT(DISTINCT p.staff_id)   AS workers,
  SUM(p.bags_loaded)           AS bags_loaded,
  SUM(p.bags_bagged)           AS bags_bagged,
  MIN(p.work_date)             AS first_day,
  MAX(p.work_date)             AS last_day
FROM production p JOIN tenants t ON t.id = p.tenant_id
WHERE p.work_date BETWEEN :'win_from' AND :'win_to'
GROUP BY t.name ORDER BY t.name;

\echo ''
\echo '=== 4. THE ANSWER: workers WITH bags in the window, split by whether the filter keeps them ==='
SELECT t.name AS tenant,
  CASE WHEN UPPER(COALESCE(s.staff_type,'')) IN ('BAGGER','LOADER')
            OR UPPER(COALESCE(s.pay_type,'')) = 'PIECE'
       THEN 'PAID - passes filter' ELSE 'DROPPED - not typed as a piece worker' END AS outcome,
  COUNT(DISTINCT s.id)                        AS workers,
  SUM(p.bags_loaded + p.bags_bagged)          AS bags
FROM production p
  JOIN staff s   ON s.id = p.staff_id
  JOIN tenants t ON t.id = s.tenant_id
WHERE p.work_date BETWEEN :'win_from' AND :'win_to'
  AND s.status = 'ACTIVE'
  AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'
GROUP BY 1,2 ORDER BY 1,2;

\echo ''
\echo '=== 5. Named list of the dropped workers (these people would be underpaid) ==='
SELECT t.name AS tenant, s.full_name, s.role_title,
  COALESCE(s.staff_type,'(unset)') AS staff_type,
  COALESCE(s.pay_type,'(unset)')   AS pay_type,
  SUM(p.bags_loaded + p.bags_bagged) AS bags
FROM production p
  JOIN staff s   ON s.id = p.staff_id
  JOIN tenants t ON t.id = s.tenant_id
WHERE p.work_date BETWEEN :'win_from' AND :'win_to'
  AND s.status = 'ACTIVE'
  AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'
  AND NOT (UPPER(COALESCE(s.staff_type,'')) IN ('BAGGER','LOADER')
           OR UPPER(COALESCE(s.pay_type,'')) = 'PIECE')
GROUP BY 1,2,3,4,5
HAVING SUM(p.bags_loaded + p.bags_bagged) > 0
ORDER BY 1, 6 DESC;

\echo ''
\echo '=== 6. Global per-bag rates (mid-month pays the _mid pair; 0 there = everyone drops out) ==='
SELECT key, value FROM payroll_settings
WHERE key IN ('rate_loaded','rate_bagged','rate_loaded_mid','rate_bagged_mid') ORDER BY key;
