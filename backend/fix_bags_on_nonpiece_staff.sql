-- Bags recorded against staff who do not bag or load.
--
-- The Snr Accountant confirmed (2026-07-20) that no salaried or daily staff
-- does this work, so every such row is a mis-keying. routes_payroll.js now
-- rejects these at entry; this cleans up the rows already in the table.
--
-- USAGE:  psql -v go=0 -f this.sql    -- dry run, shows what would change
--         psql -v go=1 -f this.sql    -- actually apply
-- (-it cannot pipe stdin through docker exec; use -i and the -v flag.)

\if :{?go} \else \set go 0 \endif

\echo ''
\echo '=== rows affected (bags against non-bagger/loader staff, all time) ==='
SELECT t.name tenant, si.name site, s.full_name,
       COALESCE(NULLIF(s.staff_type,''),'(none)') staff_type,
       COALESCE(NULLIF(s.pay_type,''),'(none)')   pay_type,
       COUNT(*) rows,
       COALESCE(SUM(p.bags_bagged),0) bagged, COALESCE(SUM(p.bags_loaded),0) loaded,
       MIN(p.work_date) first_day, MAX(p.work_date) last_day
  FROM production p
  JOIN staff s   ON s.id  = p.staff_id
  JOIN sites si  ON si.id = p.site_id
  JOIN tenants t ON t.id  = si.tenant_id
 WHERE (COALESCE(p.bags_bagged,0) > 0 OR COALESCE(p.bags_loaded,0) > 0)
   AND NOT (UPPER(COALESCE(s.staff_type,'')) IN ('BAGGER','LOADER')
            OR UPPER(COALESCE(s.pay_type,'')) = 'PIECE')
   AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'
 GROUP BY 1,2,3,4,5
 ORDER BY COALESCE(SUM(p.bags_bagged),0) + COALESCE(SUM(p.bags_loaded),0) DESC;

\echo ''
\echo 'Set go=1 to zero the bag counts on these rows. The rows themselves are'
\echo 'KEPT (attendance and history stay intact) — only the bag numbers clear.'
\echo ''

\if :go
  UPDATE production p
     SET bags_bagged = 0, bags_loaded = 0
    FROM staff s
   WHERE s.id = p.staff_id
     AND (COALESCE(p.bags_bagged,0) > 0 OR COALESCE(p.bags_loaded,0) > 0)
     AND NOT (UPPER(COALESCE(s.staff_type,'')) IN ('BAGGER','LOADER')
              OR UPPER(COALESCE(s.pay_type,'')) = 'PIECE')
     AND UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%';
  \echo '>>> APPLIED. Recompute any DRAFT payroll run for an affected period.'
\else
  \echo '>>> DRY RUN — nothing changed.'
\endif
