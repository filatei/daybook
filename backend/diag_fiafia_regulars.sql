-- Why are REGULAR (non-piece) staff computing to zero for a pay period?
-- A regular staffer's pay = clock-in days x daily rate, so zero means one
-- (or both) of those is missing. This buckets every active, payroll-eligible
-- regular staffer by tenant into the four possible states.
--
-- Usage on the server:
--   docker exec -i daybook-postgres psql -U daybook -d daybook \
--     -v from=2026-06-28 -v to=2026-07-27 < /opt/daybook/backend/diag_fiafia_regulars.sql
SELECT t.name AS tenant,
       CASE WHEN COALESCE(s.daily_rate, 0) > 0 THEN 'rate set'      ELSE 'NO RATE'      END AS rate,
       CASE WHEN a.staff_id IS NOT NULL       THEN 'has clock-ins' ELSE 'NO CLOCK-INS' END AS attendance,
       COUNT(*) AS staff
FROM staff s
JOIN tenants t ON t.id = s.tenant_id
LEFT JOIN (
  SELECT DISTINCT staff_id FROM attendance
  WHERE clock_in IS NOT NULL AND work_date BETWEEN :'from' AND :'to'
) a ON a.staff_id = s.id
WHERE s.status = 'ACTIVE'
  AND COALESCE(s.payroll_eligible, TRUE) = TRUE
  AND UPPER(COALESCE(s.staff_type, 'REGULAR')) NOT IN ('BAGGER', 'LOADER')
  AND UPPER(COALESCE(s.pay_type, '')) <> 'PIECE'
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
