# Daybook ⟵ Fido Cutover Runbook

Goal: switch the business from **fido.torama.ng (Mongo)** to **Daybook (Postgres)** with
zero data loss and a clean rollback path. **Hard gate: ≥ 2 days of clean parallel
testing before the final switch.**

All server commands run from `/opt/daybook/backend` (where `docker-compose.yml` lives).

---

## 0. How data flows today (pre-cutover)

- **Live sales** → the `livefeed` poller upserts every new Fido order into Daybook
  `pos_sales` in real time (idempotent on the Fido order id). Look-back on restart:
  `LIVEFEED_LOOKBACK_MIN` (default 180 min).
- **Everything else** (expenses, customers, vendors, staff, generators, products,
  payroll) → the **scheduled ETL** (`ETL_ENABLED=1`, nightly `ETL_CRON`, delta window
  `ETL_BACKFILL_DAYS`). Manual run any time: `scripts/etl.sh --collection all`.
- Dashboards/Reports for Fido tenants still **read live from Fido Mongo** until cutover;
  the persisted rows are durable history. At cutover we flip reads to Postgres.

Enable the automation (in `.env`, then redeploy):

```
LIVE_PERSIST=1            # live-persist sales (on by default)
LIVEFEED_LOOKBACK_MIN=180
ETL_ENABLED=1            # nightly full/delta ETL
ETL_CRON=0 1 * * *      # 01:00
ETL_BACKFILL_DAYS=2
```

---

## 1. Parallel testing window (≥ 2 days)

1. Confirm the SSH tunnel to Fido Mongo is up and `SALES_MONGO_URL` is set.
2. Keep Fido running as the system of record. Staff use it normally.
3. Each morning, reconcile the previous day:

   ```
   scripts/reconcile.sh --from <YYYY-MM-DD> --to <YYYY-MM-DD>
   ```

   Expect counts Δ = 0 and `TOTAL … ✓ EXACT` (or 100.00% imported). Investigate any gap.
4. Spot-check in the app: Reports → Orders, Expenses, Staff attendance, Generators.
5. Only proceed when **two consecutive days reconcile clean**.

---

## 2. Cutover day

1. **Announce a short freeze** to staff (e.g. 15 min); stop new sales in Fido.
2. **Final delta ETL + reconcile:**

   ```
   scripts/etl.sh --collection all          # catch any stragglers
   scripts/reconcile.sh                     # must be EXACT
   ```

3. **Migrate proof images** (attendance/reconciliation/expense uploads) off the old
   Fido server into Daybook's `UPLOAD_DIR` if not already synced.
4. **Flip Daybook reads to Postgres** for the Fido/Fiafia tenants (remove the live-Fido
   branch in `/pos/range`, `/pos/orders`, dashboards) — ship the "post-cutover" build.
5. **Point users to Daybook** (`daybook.torama.money`) and have all staff sign in.
6. **Take Fido (`fido.torama.ng`) OFFLINE but keep it fully intact** — do not delete or
   wipe it. It stays a dormant, complete backup until Daybook has been used
   successfully for a sustained period. This is the rollback insurance.

> **Scope note — payroll is excluded from this migration.** Payroll data has NOT been
> moved yet, pending a review and a likely **new payroll system built in Daybook**
> (attendance-driven). Do not treat payroll as migrated at cutover; it is a separate
> workstream. Fido's payroll history remains in the offline Fido backup until then.

---

## 3. Rollback (if something is wrong)

- Daybook is additive; Fido is untouched and still authoritative during the window.
- To roll back: point staff back to Fido, disable `LIVE_PERSIST`, keep Daybook for
  analysis. No data is lost because Fido never stopped being the source of truth until
  step 2.4.

---

## 4. Post-cutover

- Turn off the livefeed/ETL once Fido is decommissioned.
- Keep one final Fido Mongo dump archived.
- Remove the SSH tunnel and `SALES_MONGO_URL`.
