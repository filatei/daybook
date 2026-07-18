-- Consolidate duplicate staff records into ONE multi-site worker.
-- Some "duplicates" are real: a bagger/loader who works at more than one site was
-- entered once per site. Daybook already pays a single record across many sites
-- (production keys on (staff, work_date, site); payroll sums them, shows the split),
-- so the fix is to fold the extra records into one canonical record.
--
-- SAFE SET ONLY: groups where every record shares the same tenant AND the same
-- staff_type (both BAGGER, or both LOADER). Mixed-role look-alikes
-- (Erepamo BAGGER+OPERATOR, Nancy CLEANER+BAGGER) are LEFT ALONE for a human.
--
-- Canonical = the record with a numeric ext_people_id if any, else the one with the
-- most production, else the lexically-first id (deterministic).
--
-- Handles the same-day+site collision (the Samuel Sara case): overlapping cells are
-- summed onto the canonical, the duplicate cell removed — so no bags are lost or
-- double-counted.
--
-- DRY RUN by default. Apply with -v go=1.
--   ssh user1@otuburu 'docker exec -i daybook-postgres sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -v go=0"' < backend/fix_merge_multisite_dupes.sql   # preview
--   ssh user1@otuburu 'docker exec -i daybook-postgres sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -v go=1"' < backend/fix_merge_multisite_dupes.sql   # apply

\if :{?go} \else \set go 0 \endif
\set ON_ERROR_STOP on
BEGIN;

-- 1. Duplicate groups that are SAFE to merge (one tenant, one staff_type).
CREATE TEMP TABLE _grp ON COMMIT DROP AS
WITH norm AS (
  SELECT s.id, s.tenant_id, s.ext_people_id, s.staff_type,
         LOWER(REGEXP_REPLACE(TRIM(s.full_name), '\s+', ' ', 'g')) AS key
  FROM staff s
  WHERE s.status='ACTIVE' AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'
)
SELECT tenant_id, key
FROM norm
GROUP BY tenant_id, key
HAVING COUNT(*) > 1
   AND COUNT(DISTINCT UPPER(COALESCE(staff_type,''))) = 1;   -- same role only

-- 2. Rank records within each safe group; rn=1 is canonical.
CREATE TEMP TABLE _rank ON COMMIT DROP AS
WITH norm AS (
  SELECT s.id, s.tenant_id, s.ext_people_id,
         LOWER(REGEXP_REPLACE(TRIM(s.full_name), '\s+', ' ', 'g')) AS key
  FROM staff s
  WHERE s.status='ACTIVE' AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'
), pb AS (
  SELECT staff_id, SUM(bags_loaded + bags_bagged) AS bags FROM production GROUP BY staff_id
)
SELECT n.id, n.tenant_id, n.key,
  ROW_NUMBER() OVER (PARTITION BY n.tenant_id, n.key
    ORDER BY (n.ext_people_id IS NOT NULL) DESC, COALESCE(pb.bags,0) DESC, n.id) AS rn
FROM norm n
JOIN _grp g ON g.tenant_id=n.tenant_id AND g.key=n.key
LEFT JOIN pb ON pb.staff_id = n.id;

-- 3. Map each non-canonical record to its canonical id.
CREATE TEMP TABLE _map ON COMMIT DROP AS
SELECT o.id AS from_id, c.id AS to_id
FROM _rank o
JOIN _rank c ON c.tenant_id=o.tenant_id AND c.key=o.key AND c.rn=1
WHERE o.rn > 1;

\echo '=== Records to merge (from_id folds into to_id) ==='
SELECT (SELECT full_name FROM staff WHERE id=m.to_id) AS canonical,
       COUNT(*) AS extra_records_folding_in
FROM _map m GROUP BY m.to_id ORDER BY 1;

-- 4. Production: sum overlapping (work_date, site) cells onto canonical, then
--    re-point the rest. Order matters — resolve collisions BEFORE the UPDATE.
UPDATE production p
SET bags_loaded = p.bags_loaded + d.bags_loaded,
    bags_bagged = p.bags_bagged + d.bags_bagged
FROM production d JOIN _map m ON d.staff_id = m.from_id
WHERE p.staff_id = m.to_id AND p.work_date = d.work_date
  AND COALESCE(p.site_id,'') = COALESCE(d.site_id,'');
-- remove the now-absorbed duplicate cells
DELETE FROM production d USING _map m, production p
WHERE d.staff_id = m.from_id AND p.staff_id = m.to_id
  AND p.work_date = d.work_date AND COALESCE(p.site_id,'') = COALESCE(d.site_id,'');
-- re-point the non-colliding remainder
UPDATE production SET staff_id = m.to_id FROM _map m WHERE production.staff_id = m.from_id;

-- 5. Attendance (unique on tenant,staff,work_date): keep canonical's, move the rest.
DELETE FROM attendance a USING _map m, attendance c
WHERE a.staff_id = m.from_id AND c.staff_id = m.to_id AND c.work_date = a.work_date;
UPDATE attendance SET staff_id = m.to_id FROM _map m WHERE attendance.staff_id = m.from_id;

-- 6. Outstanding advances follow the person.
UPDATE staff_advances SET staff_id = m.to_id FROM _map m WHERE staff_advances.staff_id = m.from_id;

-- 7. Retire the folded records (kept, not deleted — preserves history & ids).
--    INACTIVE, not LEFT: a merged duplicate did not "leave the company", and
--    INACTIVE is accepted by staff_status_check regardless of migration order.
UPDATE staff SET status='INACTIVE', payroll_eligible=FALSE,
  exit_reason = 'Merged into canonical ' || m.to_id, eligibility_at = EXTRACT(EPOCH FROM NOW())::BIGINT
FROM _map m WHERE staff.id = m.from_id;

\echo ''
\echo '=== AFTER: any duplicate names still active? (expect only the mixed-role ones) ==='
WITH norm AS (
  SELECT tenant_id, LOWER(REGEXP_REPLACE(TRIM(full_name),'\s+',' ','g')) AS key
  FROM staff WHERE status='ACTIVE' AND UPPER(COALESCE(full_name,'')) NOT LIKE '%HIRED%'
)
SELECT t.name AS tenant, COUNT(*) AS duplicate_names_left
FROM (SELECT tenant_id,key FROM norm GROUP BY tenant_id,key HAVING COUNT(*)>1) g
JOIN tenants t ON t.id=g.tenant_id GROUP BY t.name ORDER BY t.name;

\echo ''
\if :go
  \echo '*** COMMITTING merge. ***'
  COMMIT;
\else
  \echo '*** DRY RUN — nothing saved. Re-run with -v go=1 to apply. ***'
  ROLLBACK;
\endif
