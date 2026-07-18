-- Re-check Mbiama production for 16 Jun–15 Jul, from several angles, since the
-- site reports it recorded bags. Read-only.
\set win_from '2026-06-16'
\set win_to   '2026-07-15'

\echo '=== A. Production rows whose SITE is Mbiama (by production.site_id) ==='
SELECT COUNT(*) rows, COUNT(DISTINCT p.staff_id) workers,
  SUM(p.bags_loaded) loaded, SUM(p.bags_bagged) bagged, MIN(work_date) first, MAX(work_date) last
FROM production p JOIN sites si ON si.id=p.site_id
WHERE si.name ILIKE '%mbiam%' AND p.work_date BETWEEN :'win_from' AND :'win_to';

\echo ''
\echo '=== B. Production by staff whose HOME site is Mbiama (regardless of where logged) ==='
SELECT COALESCE(ws.name,'(prod site null)') AS logged_at_site,
  COUNT(*) rows, SUM(p.bags_loaded) loaded, SUM(p.bags_bagged) bagged
FROM staff s JOIN sites hs ON hs.id=s.site_id
JOIN production p ON p.staff_id=s.id AND p.work_date BETWEEN :'win_from' AND :'win_to'
LEFT JOIN sites ws ON ws.id=p.site_id
WHERE hs.name ILIKE '%mbiam%'
GROUP BY 1 ORDER BY 1;

\echo ''
\echo '=== C. ANY production at Mbiama, ALL dates (is the window just empty?) ==='
SELECT MIN(work_date) first, MAX(work_date) last, COUNT(*) rows,
  SUM(bags_loaded) loaded, SUM(bags_bagged) bagged
FROM production p JOIN sites si ON si.id=p.site_id WHERE si.name ILIKE '%mbiam%';

\echo ''
\echo '=== D. Attendance at Mbiama in the window (clock-ins ≠ bags, but shows activity) ==='
SELECT COUNT(*) clockins, COUNT(DISTINCT a.staff_id) staff, MIN(work_date) first, MAX(work_date) last
FROM attendance a JOIN sites si ON si.id=a.site_id
WHERE si.name ILIKE '%mbiam%' AND a.work_date BETWEEN :'win_from' AND :'win_to';

\echo ''
\echo '=== E. Recent production anywhere for the merged-canonical Mbiama names (last 40 days) ==='
SELECT s.full_name, MAX(p.work_date) most_recent, SUM(p.bags_loaded+p.bags_bagged) bags_recent
FROM staff s JOIN sites hs ON hs.id=s.site_id
JOIN production p ON p.staff_id=s.id AND p.work_date >= (CURRENT_DATE - 40)
WHERE hs.name ILIKE '%mbiam%' AND s.status='ACTIVE'
GROUP BY s.full_name HAVING SUM(p.bags_loaded+p.bags_bagged) > 0
ORDER BY 2 DESC LIMIT 20;
