-- Duplicate staff: the same person as two+ ACTIVE records, so they get two payslips.
-- Read-only. Groups by normalised name (case/space-insensitive) within a tenant.
-- Now shows the SITE each record sits on, to help decide which is canonical.
\set win_from '2026-06-16'
\set win_to   '2026-07-15'

\echo '=== 1. WORST FIRST: duplicates paid on BOTH records (real double-pay in the window) ==='
\echo '    bags on two records for one person = paid twice. Keep the canonical record,'
\echo '    move its production onto it, mark the other not-eligible.'
WITH norm AS (
  SELECT s.id, s.tenant_id, s.full_name, s.role_title, s.staff_type, s.site_id,
         LOWER(REGEXP_REPLACE(TRIM(s.full_name), '\s+', ' ', 'g')) AS key
  FROM staff s
  WHERE s.status = 'ACTIVE' AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'
), prod AS (
  SELECT staff_id, SUM(bags_loaded + bags_bagged) AS bags
  FROM production WHERE work_date BETWEEN :'win_from' AND :'win_to' GROUP BY staff_id
), grp AS (
  SELECT tenant_id, key,
         COUNT(*) AS records,
         COUNT(*) FILTER (WHERE COALESCE(p.bags,0) > 0) AS records_with_bags,
         SUM(COALESCE(p.bags,0)) AS total_bags
  FROM norm n LEFT JOIN prod p ON p.staff_id = n.id
  GROUP BY tenant_id, key
)
SELECT t.name AS tenant, n.full_name, COALESCE(si.name,'—') AS site,
       n.staff_type, COALESCE(p.bags,0) AS bags_in_window, n.id AS staff_id
FROM norm n
  JOIN grp g   ON g.tenant_id = n.tenant_id AND g.key = n.key AND g.records_with_bags >= 2
  JOIN tenants t ON t.id = n.tenant_id
  LEFT JOIN sites si ON si.id = n.site_id
  LEFT JOIN prod p  ON p.staff_id = n.id
ORDER BY t.name, n.full_name, bags_in_window DESC;

\echo ''
\echo '=== 2. ALL duplicate records, with site (review the rest at leisure) ==='
WITH norm AS (
  SELECT s.id, s.tenant_id, s.full_name, s.role_title, s.staff_type, s.site_id,
         LOWER(REGEXP_REPLACE(TRIM(s.full_name), '\s+', ' ', 'g')) AS key
  FROM staff s
  WHERE s.status = 'ACTIVE' AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'
), prod AS (
  SELECT staff_id, SUM(bags_loaded + bags_bagged) AS bags
  FROM production WHERE work_date BETWEEN :'win_from' AND :'win_to' GROUP BY staff_id
), dups AS (
  SELECT tenant_id, key FROM norm GROUP BY tenant_id, key HAVING COUNT(*) > 1
)
SELECT t.name AS tenant, n.full_name, COALESCE(si.name,'—') AS site,
       n.role_title, n.staff_type, COALESCE(p.bags,0) AS bags_in_window, n.id AS staff_id
FROM norm n
  JOIN dups d ON d.tenant_id = n.tenant_id AND d.key = n.key
  JOIN tenants t ON t.id = n.tenant_id
  LEFT JOIN sites si ON si.id = n.site_id
  LEFT JOIN prod p  ON p.staff_id = n.id
ORDER BY t.name, n.full_name, bags_in_window DESC;

\echo ''
\echo '=== 3. Money at risk: extra bags being paid to duplicates (all but the largest record per person) ==='
WITH norm AS (
  SELECT s.id, s.tenant_id,
         LOWER(REGEXP_REPLACE(TRIM(s.full_name), '\s+', ' ', 'g')) AS key
  FROM staff s WHERE s.status='ACTIVE' AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'
), prod AS (
  SELECT staff_id, SUM(bags_loaded + bags_bagged) AS bags
  FROM production WHERE work_date BETWEEN :'win_from' AND :'win_to' GROUP BY staff_id
), ranked AS (
  SELECT n.tenant_id, n.key, COALESCE(p.bags,0) AS bags,
         ROW_NUMBER() OVER (PARTITION BY n.tenant_id, n.key ORDER BY COALESCE(p.bags,0) DESC) AS rn
  FROM norm n
  JOIN (SELECT tenant_id, key FROM norm GROUP BY tenant_id, key HAVING COUNT(*)>1) d
       ON d.tenant_id=n.tenant_id AND d.key=n.key
  LEFT JOIN prod p ON p.staff_id = n.id
)
SELECT t.name AS tenant,
  SUM(bags) FILTER (WHERE rn > 1)                 AS extra_bags_paid_to_dupes,
  ROUND((SUM(bags) FILTER (WHERE rn > 1))::numeric, 2) AS naira_at_1_per_bag_midmonth,
  ROUND((SUM(bags) FILTER (WHERE rn > 1) * 6)::numeric, 2) AS naira_at_6_per_bag_monthend
FROM ranked r JOIN tenants t ON t.id = r.tenant_id
GROUP BY t.name ORDER BY t.name;
