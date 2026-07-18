-- Why is Mbiama not in the mid-month run? Three possible reasons, checked in order.
-- Read-only. Window = the mid-month cycle just closed.
\set win_from '2026-06-16'
\set win_to   '2026-07-15'

\echo '=== 1. Does a site literally named Mbiama exist, and under which tenant? ==='
SELECT t.name AS tenant, si.id AS site_id, si.name AS site
FROM sites si JOIN tenants t ON t.id = si.tenant_id
WHERE si.name ILIKE '%mbiam%' ORDER BY t.name;

\echo ''
\echo '=== 2. Baggers/loaders on Mbiamas roster now (after the re-type) ==='
SELECT t.name AS tenant, s.staff_type, COUNT(*) AS staff
FROM staff s JOIN sites si ON si.id = s.site_id JOIN tenants t ON t.id = s.tenant_id
WHERE si.name ILIKE '%mbiam%' AND s.status='ACTIVE'
GROUP BY 1,2 ORDER BY 1,2;

\echo ''
\echo '=== 3. THE ANSWER: production logged at Mbiama in the window ==='
\echo '    Zero rows here = nobody recorded bags for Mbiama -> nothing to pay -> absent.'
\echo '    That is a data-entry gap at the site, not a payroll bug.'
SELECT t.name AS tenant, si.name AS site,
  COUNT(*) AS production_rows, COUNT(DISTINCT p.staff_id) AS workers,
  SUM(p.bags_loaded) AS loaded, SUM(p.bags_bagged) AS bagged,
  MIN(p.work_date) AS first_day, MAX(p.work_date) AS last_day
FROM production p JOIN sites si ON si.id = p.site_id JOIN tenants t ON t.id = p.tenant_id
WHERE si.name ILIKE '%mbiam%' AND p.work_date BETWEEN :'win_from' AND :'win_to'
GROUP BY 1,2 ORDER BY 1,2;

\echo ''
\echo '=== 4. For contrast: latest production EVER logged at Mbiama (any date) ==='
\echo '    Tells you whether the site ever records bags, or if the window is just empty.'
SELECT t.name AS tenant, si.name AS site,
  MAX(p.work_date) AS most_recent_entry, COUNT(*) AS rows_all_time
FROM production p JOIN sites si ON si.id = p.site_id JOIN tenants t ON t.id = p.tenant_id
WHERE si.name ILIKE '%mbiam%'
GROUP BY 1,2 ORDER BY 1,2;
