-- Duplicate staff: the same person as two+ ACTIVE records, so they get two payslips.
-- Read-only. Groups by normalised name (case/space-insensitive) within a tenant.
\set win_from '2026-06-16'
\set win_to   '2026-07-15'

\echo '=== Duplicate ACTIVE staff by normalised name, with bags in the window ==='
\echo '    Each group = one human paid more than once. Review before the next run.'
WITH norm AS (
  SELECT s.id, s.tenant_id, s.full_name, s.role_title, s.staff_type,
         LOWER(REGEXP_REPLACE(TRIM(s.full_name), '\s+', ' ', 'g')) AS key
  FROM staff s
  WHERE s.status = 'ACTIVE' AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'
), prod AS (
  SELECT staff_id, SUM(bags_loaded + bags_bagged) AS bags
  FROM production WHERE work_date BETWEEN :'win_from' AND :'win_to' GROUP BY staff_id
), dups AS (
  SELECT tenant_id, key FROM norm GROUP BY tenant_id, key HAVING COUNT(*) > 1
)
SELECT t.name AS tenant, n.full_name, n.role_title, n.staff_type,
       COALESCE(p.bags,0) AS bags_in_window, n.id AS staff_id
FROM norm n
  JOIN dups d ON d.tenant_id = n.tenant_id AND d.key = n.key
  JOIN tenants t ON t.id = n.tenant_id
  LEFT JOIN prod p ON p.staff_id = n.id
ORDER BY t.name, n.key, bags_in_window DESC;

\echo ''
\echo '=== Count of duplicate groups per tenant ==='
WITH norm AS (
  SELECT tenant_id, LOWER(REGEXP_REPLACE(TRIM(full_name), '\s+', ' ', 'g')) AS key
  FROM staff WHERE status='ACTIVE' AND UPPER(COALESCE(full_name,'')) NOT LIKE '%HIRED%'
)
SELECT t.name AS tenant, COUNT(*) AS duplicate_people
FROM (SELECT tenant_id, key FROM norm GROUP BY tenant_id, key HAVING COUNT(*) > 1) g
JOIN tenants t ON t.id = g.tenant_id
GROUP BY t.name ORDER BY t.name;
