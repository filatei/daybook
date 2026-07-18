-- Precisely separate TRUE double-pay from merely-split records among duplicate staff.
-- True overpay = the same person's two ids both have production on the SAME day+site
-- (the same work keyed twice). Split = different days, correct total, just two payslips.
-- Read-only.
\set win_from '2026-06-16'
\set win_to   '2026-07-15'

WITH norm AS (
  SELECT s.id, s.tenant_id, s.full_name,
         LOWER(REGEXP_REPLACE(TRIM(s.full_name), '\s+', ' ', 'g')) AS key
  FROM staff s
  WHERE s.status='ACTIVE' AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'
), dup AS (
  SELECT tenant_id, key FROM norm GROUP BY tenant_id, key HAVING COUNT(*) > 1
),
-- All production rows belonging to a duplicated person, in the window.
p AS (
  SELECT n.tenant_id, n.key, pr.work_date, pr.site_id,
         (pr.bags_loaded + pr.bags_bagged) AS bags
  FROM norm n
  JOIN dup d ON d.tenant_id=n.tenant_id AND d.key=n.key
  JOIN production pr ON pr.staff_id = n.id
  WHERE pr.work_date BETWEEN :'win_from' AND :'win_to'
),
-- Per person-day-site: how many of their ids logged it, and total vs max bags.
cell AS (
  SELECT tenant_id, key, work_date, site_id,
         COUNT(*) AS ids_that_day,
         SUM(bags) AS bags_summed,     -- what payroll pays (all ids)
         MAX(bags) AS bags_one         -- what one merged record would show
  FROM p GROUP BY tenant_id, key, work_date, site_id
)
\echo '=== TRUE double-pay: same person, same day+site, logged under two ids ==='
\echo '    overpay_bags = the duplicated portion actually being paid twice.'
SELECT t.name AS tenant,
  COUNT(*) FILTER (WHERE ids_that_day > 1)                       AS double_keyed_day_cells,
  ROUND(SUM(bags_summed - bags_one)::numeric, 2)                 AS overpay_bags,
  ROUND(SUM(bags_summed - bags_one)::numeric, 2)                 AS naira_overpay_midmonth_at_1,
  ROUND((SUM(bags_summed - bags_one) * 6)::numeric, 2)           AS naira_overpay_monthend_at_6
FROM cell c JOIN tenants t ON t.id = c.tenant_id
GROUP BY t.name ORDER BY t.name;

\echo ''
\echo '=== The specific people double-keyed on the same day (fix these first) ==='
WITH norm AS (
  SELECT s.id, s.tenant_id, s.full_name,
         LOWER(REGEXP_REPLACE(TRIM(s.full_name), '\s+', ' ', 'g')) AS key
  FROM staff s WHERE s.status='ACTIVE' AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'
), dup AS (
  SELECT tenant_id, key FROM norm GROUP BY tenant_id, key HAVING COUNT(*)>1
), p AS (
  SELECT n.tenant_id, n.key, n.full_name, pr.work_date, pr.site_id, (pr.bags_loaded+pr.bags_bagged) AS bags
  FROM norm n JOIN dup d ON d.tenant_id=n.tenant_id AND d.key=n.key
  JOIN production pr ON pr.staff_id=n.id
  WHERE pr.work_date BETWEEN :'win_from' AND :'win_to'
)
SELECT t.name AS tenant, MIN(p.full_name) AS name, p.work_date, si.name AS site,
       COUNT(*) AS ids_logging_this_day, ROUND(SUM(p.bags)::numeric,2) AS bags_paid,
       ROUND((SUM(p.bags)-MAX(p.bags))::numeric,2) AS overpaid_bags
FROM p JOIN tenants t ON t.id=p.tenant_id LEFT JOIN sites si ON si.id=p.site_id
GROUP BY t.name, p.key, p.work_date, si.name
HAVING COUNT(*) > 1
ORDER BY overpaid_bags DESC;
